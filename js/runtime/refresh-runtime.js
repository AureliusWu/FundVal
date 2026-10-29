// Internal page coordinator for the two closed production consumers only.
// The full public coordinator remains unchanged; characterization tests bind
// every common method and context member to it to prevent implementation drift.
import { createRefreshGeneration, isRefreshAbort } from './refresh-generation.js';
import {
  canAttemptSource,
  claimSourceAttempt,
  createBuiltinSourceRegistry,
  getSourceHealth,
  isAbortedSourceFailure,
  recordSourceFailure,
  recordSourcePartial,
  recordSourceSuccess,
  releaseSourceAttempt,
} from './source-registry.js';

function nowFrom(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function safeCallback(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch (_) { /* diagnostics callbacks cannot break refresh */ }
}

function errorKind(error) {
  return String(error?.code || error?.name || 'refresh_failed').slice(0, 80);
}

function diagnosticText(value, fallback = '', maximum = 120) {
  const text = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maximum);
  return text || fallback;
}

function requestKey(value, fallback = 'unknown') {
  return diagnosticText(value, fallback, 80);
}

export class RefreshCoordinator {
  constructor({
    execute,
    withBuiltinSources = false,
    now = Date.now,
    AbortControllerClass,
    onPartial,
    onStateChange,
    onError,
    onDiagnostic,
  } = {}) {
    if (typeof execute !== 'function') throw new TypeError('RefreshCoordinator execute must be a function.');
    if (typeof now !== 'function') throw new TypeError('RefreshCoordinator now must be a function.');
    this.execute = execute;
    this.clock = now;
    this.AbortControllerClass = AbortControllerClass;
    this.onPartial = onPartial;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onDiagnostic = onDiagnostic;
    this.sequence = 0;
    this.current = null;
    this.active = null;
    this.activeKey = null;
    this.activePromise = null;
    this.lastCompleted = null;
    this.lastFailure = null;
    this.lastDiagnostic = null;
    this.diagnosticCount = 0;
    this.registry = createBuiltinSourceRegistry(withBuiltinSources);
  }

  isCurrent(generation) {
    const number = typeof generation === 'number' ? generation : generation?.generation;
    return Boolean(this.current && this.current.generation === number && !this.current.signal.aborted);
  }

  snapshot() {
    return Object.freeze({
      active: this.active ? Object.freeze({
        generation: this.active.generation,
        requestId: this.active.requestId,
        startedAt: this.active.startedAt,
        trigger: this.active.trigger,
      }) : null,
      currentGeneration: this.current?.generation || null,
      lastCompleted: this.lastCompleted,
      lastFailure: this.lastFailure,
      lastDiagnostic: this.lastDiagnostic,
      diagnosticCount: this.diagnosticCount,
      sourceRegistry: this.registry,
    });
  }

  emitState() {
    safeCallback(this.onStateChange, this.snapshot());
  }

  recordDiagnostic(refresh, type, details = {}) {
    const entry = Object.freeze({
      generation: refresh.generation,
      requestId: refresh.requestId,
      trigger: refresh.trigger,
      recordedAt: new Date(nowFrom(this.clock)).toISOString(),
      type: diagnosticText(type, 'refresh_diagnostic', 80),
      key: diagnosticText(details.key, '', 80) || null,
      sourceId: diagnosticText(details.sourceId, '', 80) || null,
      reason: diagnosticText(details.reason, '', 120) || null,
    });
    this.lastDiagnostic = entry;
    this.diagnosticCount += 1;
    safeCallback(this.onDiagnostic, entry);
    this.emitState();
    return entry;
  }

  contextFor(refresh) {
    const coordinator = this;
    let context;
    context = Object.freeze({
      generation: refresh.generation,
      requestId: refresh.requestId,
      startedAt: refresh.startedAt,
      trigger: refresh.trigger,
      signal: refresh.signal,
      isCurrent() { return coordinator.isCurrent(refresh); },
      commit(operation) {
        if (!coordinator.isCurrent(refresh) || typeof operation !== 'function') return Object.freeze({ committed: false, value: undefined });
        if (operation.constructor?.name === 'AsyncFunction') {
          return Object.freeze({ committed: false, value: undefined, reason: 'async_commit_not_allowed' });
        }
        const value = operation();
        if (value && typeof value.then === 'function') {
          return Object.freeze({ committed: false, value: undefined, reason: 'async_commit_not_allowed' });
        }
        return Object.freeze({ committed: true, value });
      },
      recordDiagnostic(type, details = {}) {
        return coordinator.recordDiagnostic(refresh, type, details);
      },
      sourceHealth(sourceId) { return getSourceHealth(coordinator.registry, sourceId); },
      canAttemptSource(sourceId) { return canAttemptSource(coordinator.registry, sourceId, nowFrom(coordinator.clock)); },
      claimSourceAttempt(sourceId) {
        const claim = claimSourceAttempt(coordinator.registry, sourceId, nowFrom(coordinator.clock));
        coordinator.registry = claim.registry;
        coordinator.emitState();
        return Object.freeze({ allowed: claim.allowed, halfOpen: claim.halfOpen });
      },
      recordSourceSuccess(sourceId, details = {}) {
        // Health describes the upstream, not whether this generation may
        // still update UI. A late real response remains useful evidence.
        coordinator.registry = recordSourceSuccess(coordinator.registry, sourceId, details, nowFrom(coordinator.clock));
        coordinator.emitState();
        return getSourceHealth(coordinator.registry, sourceId);
      },
      recordSourcePartial(sourceId, details = {}) {
        if (!coordinator.isCurrent(refresh) || refresh.signal.aborted) return false;
        coordinator.registry = recordSourcePartial(coordinator.registry, sourceId, details, nowFrom(coordinator.clock));
        coordinator.emitState();
        return true;
      },
      recordSourceFailure(sourceId, failure = {}) {
        if (isAbortedSourceFailure(failure)) {
          coordinator.registry = releaseSourceAttempt(coordinator.registry, sourceId);
          coordinator.emitState();
          return getSourceHealth(coordinator.registry, sourceId);
        }
        coordinator.registry = recordSourceFailure(coordinator.registry, sourceId, failure, nowFrom(coordinator.clock));
        coordinator.emitState();
        return getSourceHealth(coordinator.registry, sourceId);
      },
      releaseSourceAttempt(sourceId) {
        coordinator.registry = releaseSourceAttempt(coordinator.registry, sourceId);
        coordinator.emitState();
        return getSourceHealth(coordinator.registry, sourceId);
      },
    });
    return context;
  }

  request({ trigger = 'unknown', payload, coalesce = false, coalesceKey } = {}) {
    const key = requestKey(coalesceKey ?? trigger);
    if (coalesce && this.active && !this.active.signal.aborted && this.activeKey === key && this.activePromise) {
      return this.activePromise;
    }
    if (this.current) this.current.abort('superseded');
    const startedAt = nowFrom(this.clock);
    const refresh = createRefreshGeneration({
      generation: ++this.sequence,
      trigger,
      startedAt,
      AbortControllerClass: this.AbortControllerClass,
    });
    this.current = refresh;
    this.active = refresh;
    this.activeKey = key;
    const context = this.contextFor(refresh);

    const task = Promise.resolve()
      .then(() => this.isCurrent(refresh) ? this.execute(context, payload) : undefined)
      .then(result => {
        if (!this.isCurrent(refresh)) {
          return Object.freeze({ status: 'superseded', generation: refresh.generation, result: null });
        }
        this.lastCompleted = Object.freeze({
          generation: refresh.generation,
          requestId: refresh.requestId,
          trigger: refresh.trigger,
          completedAt: new Date(nowFrom(this.clock)).toISOString(),
        });
        this.lastFailure = null;
        return Object.freeze({ status: 'completed', generation: refresh.generation, result });
      })
      .catch(error => {
        if (isRefreshAbort(error, refresh.signal) || !this.isCurrent(refresh)) {
          return Object.freeze({ status: 'aborted', generation: refresh.generation, result: null });
        }
        this.lastFailure = Object.freeze({
          generation: refresh.generation,
          requestId: refresh.requestId,
          trigger: refresh.trigger,
          failedAt: new Date(nowFrom(this.clock)).toISOString(),
          errorKind: errorKind(error),
        });
        refresh.abort('failed');
        if (this.current === refresh) this.current = null;
        safeCallback(this.onError, Object.freeze({ ...this.lastFailure, error }));
        return Object.freeze({ status: 'failed', generation: refresh.generation, error });
      })
      .finally(() => {
        if (this.active === refresh) {
          this.active = null;
          this.activeKey = null;
          this.activePromise = null;
          this.emitState();
        }
      });

    this.activePromise = task;
    this.emitState();
    return task;
  }

  stop(reason = 'stopped') {
    const current = this.current;
    this.sequence += 1;
    this.current = null;
    this.active = null;
    this.activeKey = null;
    this.activePromise = null;
    if (current) current.abort(reason);
    this.emitState();
    return Boolean(current);
  }

  async stopAndDrain(reason = 'stopped') {
    const task = this.activePromise;
    this.stop(reason);
    if (task) await task.catch(() => undefined);
    return true;
  }
}
