function abortControllerClass(value) {
  const Controller = value || globalThis.AbortController;
  if (typeof Controller !== 'function') throw new Error('AbortController is required for refresh coordination.');
  return Controller;
}

function clockValue(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

export function isRefreshAbort(error, signal) {
  return Boolean(signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.aborted === true);
}

export function createRefreshGeneration({
  generation,
  trigger = 'unknown',
  startedAt = Date.now(),
  AbortControllerClass,
} = {}) {
  const number = Number(generation);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError('Refresh generation must be a positive safe integer.');
  const startedAtMs = clockValue(startedAt);
  const Controller = abortControllerClass(AbortControllerClass);
  const controller = new Controller();
  const metadata = Object.freeze({
    generation: number,
    requestId: `refresh-${number}-${startedAtMs}`,
    startedAt: new Date(startedAtMs).toISOString(),
    trigger: String(trigger || 'unknown').slice(0, 40),
  });

  return Object.freeze({
    ...metadata,
    signal: controller.signal,
    abort(reason = 'superseded') {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    get aborted() { return controller.signal.aborted; },
    get abortReason() { return controller.signal.reason || null; },
  });
}

// Bounded, private diagnostics only: observation is not a refresh success or a
// persistence record. A missing measurement must never become a measured zero.
export function createRefreshDiagnosticsStore() {
  const kinds = ['estimates', 'nav', 'holdings', 'meta', 'indices', 'gold', 'securities', 'model-quotes'];
  const providers = ['sinan-estimate-proxy', 'sinan-holdings-proxy', 'eastmoney-official-nav',
    'eastmoney-security-quote', 'tencent-market-quote', 'gold', 'model-config'];
  const counterKeys = ['generation', 'planned', 'staged', 'cacheHits', 'deduped', 'requests',
    'abortedRequests', 'failedRequests', 'cancelledResources', 'writeAttempts', 'cacheWrites'];
  const phases = ['started', 'resources_settled', 'final'];
  const statuses = ['running', 'completed', 'cancelled', 'failed'];
  const planReasonKeys = ['fresh_cache', 'cache_miss', 'cache_metadata_invalid', 'cache_quality_unusable',
    'cache_expired', 'force_live', 'force_stable', 'market_ineligible', 'phase_pending', 'no_active_holdings'];
  const executionSkipKeys = ['estimate_claim_denied', 'holdings_claim_denied', 'holdings_probe_used',
    'model_claim_denied', 'model_probe_used'];
  let current = null, lastSettled = null, lastCancelled = null, highWater = 0;
  // Lifecycle finalization and the last real executor report are independent:
  // a stopped generation may still report actual drain/abort counts later.
  let currentReportPhase = -1, settledReportPhase = -1, cancelledReportPhase = -1;

  function object(value) {
    try { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    catch (_) { return false; }
  }
  function own(value, key) {
    try {
      if (value === null || typeof value !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch (_) { return undefined; }
  }
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const generation = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const nestedGeneration = value => object(value) ? generation(own(value, 'generation')) : null;
  const terminal = value => value.status !== 'running';

  function copyCounters(value, expectedGeneration) {
    if (!object(value)) return null;
    const suppliedGeneration = own(value, 'generation');
    if (suppliedGeneration !== undefined && suppliedGeneration !== expectedGeneration) return null;
    const result = {};
    for (const key of counterKeys) result[key] = integer(own(value, key));
    const sourceProviders = own(value, 'providers'), copiedProviders = {};
    for (const provider of providers) copiedProviders[provider] = integer(own(sourceProviders, provider));
    result.providers = Object.freeze(copiedProviders);
    return Object.freeze(result);
  }
  function copyPlan(value) {
    try { if (!Array.isArray(value)) return null; } catch (_) { return null; }
    const length = integer(own(value, 'length'));
    if (length === null || length > kinds.length) return null;
    const rows = new Map();
    for (let index = 0; index < length; index++) {
      const row = own(value, String(index));
      if (!object(row)) continue;
      const kind = own(row, 'kind');
      if (!kinds.includes(kind) || rows.has(kind)) continue;
      rows.set(kind, Object.freeze({ kind, cache: integer(own(row, 'cache')),
        fetch: integer(own(row, 'fetch')), skip: integer(own(row, 'skip')) }));
    }
    return Object.freeze(kinds.filter(kind => rows.has(kind)).map(kind => rows.get(kind)));
  }
  function copySkipReasons(value) {
    if (!object(value)) return null;
    return Object.freeze({ market_ineligible: integer(own(value, 'market_ineligible')),
      no_active_holdings: integer(own(value, 'no_active_holdings')) });
  }
  function copyPlanReasons(value) {
    if (!object(value)) return null;
    const result = {};
    for (const key of planReasonKeys) result[key] = integer(own(value, key));
    return Object.freeze(result);
  }
  function copyExecutionSkips(report) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(report, 'executionSkips'); }
    catch (_) { return undefined; }
    // Absence keeps legacy records unchanged; an explicit invalid measurement
    // opts in as null. Accessors and inherited values are not measurements.
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
    if (!object(descriptor.value)) return null;
    const result = {};
    for (const key of executionSkipKeys) result[key] = integer(own(descriptor.value, key));
    return Object.freeze(result);
  }
  function blank(number) {
    return Object.freeze({ generation: number, phase: null, status: 'running', observed: false,
      counters: null, plan: null, skipReasons: null });
  }
  function find(number) {
    return [current, lastSettled, lastCancelled].find(value => value?.generation === number) || null;
  }
  function reportPhase(number) {
    if (current?.generation === number) return currentReportPhase;
    if (lastSettled?.generation === number) return settledReportPhase;
    if (lastCancelled?.generation === number) return cancelledReportPhase;
    return -1;
  }
  function remember(value, rank) {
    if (current?.generation === value.generation) { current = value; currentReportPhase = rank; }
    if (lastSettled?.generation === value.generation) { lastSettled = value; settledReportPhase = rank; }
    if (lastCancelled?.generation === value.generation) { lastCancelled = value; cancelledReportPhase = rank; }
    if (value.status === 'cancelled' && (!lastCancelled || value.generation >= lastCancelled.generation)) {
      lastCancelled = value; cancelledReportPhase = rank;
    }
    if (['completed', 'failed'].includes(value.status) && (!lastSettled || value.generation >= lastSettled.generation)) {
      lastSettled = value; settledReportPhase = rank;
    }
  }
  function settle(value, status) {
    if (terminal(value)) return;
    const rank = reportPhase(value.generation);
    remember(Object.freeze({ ...value, phase: 'final', status,
      // Started counts describe scope creation, not all work before an early
      // throw/stop. Only a real drain/final report qualifies terminal counts.
      counters: rank < 1 ? null : value.counters,
      ...(Object.hasOwn(value, 'executionSkips')
        ? { executionSkips: rank < 1 ? null : value.executionSkips } : {}) }), rank);
  }
  function advance(number) {
    if (number <= highWater) return;
    if (current && !terminal(current)) settle(current, 'cancelled');
    highWater = number;
    current = blank(number);
    currentReportPhase = -1;
  }
  function history(number, status) {
    if (number === null) return;
    if (number > highWater) advance(number);
    const known = find(number);
    if (known) settle(known, status);
    else if (!lastSettled || number > lastSettled.generation) {
      remember(Object.freeze({ ...blank(number), phase: 'final', status }), -1);
    }
  }

  function observeState(snapshot) {
    if (!object(snapshot)) return;
    const activeValue = own(snapshot, 'active');
    const activeGeneration = nestedGeneration(activeValue);
    const currentValue = own(snapshot, 'currentGeneration');
    const currentGeneration = generation(currentValue);
    if (activeGeneration === null && activeValue !== null) return;
    if (currentGeneration === null && currentValue !== null) return;
    if (activeGeneration !== null && currentGeneration !== null && activeGeneration !== currentGeneration) return;
    const completed = nestedGeneration(own(snapshot, 'lastCompleted'));
    const failed = nestedGeneration(own(snapshot, 'lastFailure'));
    // Process explicit historical identities without allowing an old finish to
    // replace a newer current. Active health events never finalize that active.
    // A synchronous onError callback can start the next generation before the
    // failed one's final emitState. Its explicit failure must win over the
    // provisional cancellation otherwise inferred by advance(new).
    const explicitGeneration = activeGeneration ?? currentGeneration;
    const endings = [[completed, 'completed'], [failed, 'failed']]
      .filter(([number]) => number !== null && number !== activeGeneration
        && (explicitGeneration === null || number <= explicitGeneration))
      .sort(([left], [right]) => left - right);
    for (const [number, status] of endings) history(number, status);
    if (activeGeneration !== null) advance(activeGeneration);
    else if (currentGeneration !== null) advance(currentGeneration);
    if (activeGeneration !== null || !current || terminal(current)) return;
    if (currentGeneration !== null && currentGeneration < current.generation) return;
    // This consumes the coordinator's SYNCHRONOUS onStateChange sequence.
    // An idle stop snapshot has no sequence/generation: it cannot safely be
    // asynchronously replayed after a newer start via an event bus.
    settle(current, completed === current.generation ? 'completed'
      : failed === current.generation ? 'failed' : 'cancelled');
  }
  function observe(report) {
    if (!object(report)) return;
    const number = generation(own(report, 'generation'));
    const phase = own(report, 'phase'), status = own(report, 'status');
    const rank = phases.indexOf(phase);
    if (number === null || rank < 0 || !statuses.includes(status) || (phase === 'final' && status === 'running')) return;
    advance(number);
    const known = find(number);
    // Forgotten old results cannot resurrect a cancelled generation. Only an
    // explicitly cancelled old report may improve the bounded cancel summary.
    if (!known && (status !== 'cancelled' || (lastCancelled && number <= lastCancelled.generation))) return;
    const before = known || blank(number), beforeRank = reportPhase(number);
    if (rank < beforeRank) return;
    const finalStatus = terminal(before) ? before.status : status;
    const counters = copyCounters(own(report, 'counters'), number);
    const planReasons = copyPlanReasons(own(report, 'planReasons')) ?? before.planReasons;
    const executionSkips = copyExecutionSkips(report);
    remember(Object.freeze({ generation: number,
      phase: finalStatus === 'running' ? phase : 'final', status: finalStatus, observed: true,
      counters: finalStatus !== 'running' && rank < 1 ? null : counters,
      plan: copyPlan(own(report, 'plan')) ?? before.plan,
      skipReasons: copySkipReasons(own(report, 'skipReasons')) ?? before.skipReasons,
      ...(planReasons ? { planReasons } : {}),
      ...(executionSkips !== undefined || Object.hasOwn(before, 'executionSkips')
        ? { executionSkips: finalStatus !== 'running' && rank < 1 ? null : executionSkips ?? null } : {}) }), rank);
  }
  return Object.freeze({ observeState, observe,
    snapshot() { return Object.freeze({ current, lastSettled, lastCancelled }); },
  });
}
