import test from 'node:test';
import assert from 'node:assert/strict';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { getSourceHealth, SOURCE_HEALTH } from '../js/runtime/source-registry.js';

const STARTED_AT = Date.parse('2026-08-25T02:00:00.000Z');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function descriptor(id) {
  return {
    id,
    markets: ['cn'],
    capabilities: ['estimate'],
    priority: 10,
    timeoutMs: 1_000,
    freshnessPolicy: 'intraday',
    requiresProxy: false,
  };
}

test('same trigger is folded into one refresh with complete generation metadata', async () => {
  const pending = deferred();
  const contexts = [];
  let executions = 0;
  const coordinator = new RefreshCoordinator({
    now: () => STARTED_AT,
    execute(context) {
      executions += 1;
      contexts.push(context);
      return pending.promise;
    },
  });

  const first = coordinator.request({ trigger: 'timer', coalesce: true });
  const duplicate = coordinator.request({ trigger: 'timer', coalesce: true });
  assert.strictEqual(duplicate, first);
  await flushTasks();
  assert.equal(executions, 1);
  assert.equal(contexts[0].generation, 1);
  assert.match(contexts[0].requestId, /^refresh-1-\d+$/);
  assert.equal(contexts[0].startedAt, '2026-08-25T02:00:00.000Z');
  assert.equal(contexts[0].trigger, 'timer');

  pending.resolve({ refreshed: true });
  assert.deepEqual(await first, {
    status: 'completed', generation: 1, result: { refreshed: true },
  });
});

test('a late superseded generation may update diagnostics and source health but cannot commit UI or cache', async () => {
  const oldResult = deferred();
  const currentResult = deferred();
  const contexts = [];
  const commits = [];
  const partials = [];
  const diagnostics = [];
  let invocation = 0;
  const coordinator = new RefreshCoordinator({
    now: () => STARTED_AT,
    sources: [descriptor('primary')],
    onPartial(entry) { partials.push(entry); },
    onDiagnostic(entry) { diagnostics.push(entry); },
    execute(context) {
      contexts.push(context);
      const result = invocation++ === 0 ? oldResult : currentResult;
      return result.promise.then((value) => {
        if (value.version === 'old') {
          context.recordDiagnostic('late_source_result', {
            key: '000001', sourceId: 'primary', reason: 'timeout',
          });
          context.recordSourceFailure('primary', { reason: 'timeout' });
        }
        const cacheCommit = context.commit(() => {
          commits.push(value.version);
          return value.version;
        });
        const uiCommit = context.commitPartial('000001', value);
        return { cacheCommit, uiCommit };
      });
    },
  });

  const oldTask = coordinator.request({ trigger: 'timer' });
  await flushTasks();
  const currentTask = coordinator.request({ trigger: 'manual' });
  assert.equal(contexts[0].signal.aborted, true);

  oldResult.resolve({ version: 'old' });
  assert.deepEqual(await oldTask, { status: 'superseded', generation: 1, result: null });
  assert.deepEqual(commits, []);
  assert.deepEqual(partials, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].generation, 1);
  assert.equal(diagnostics[0].type, 'late_source_result');
  assert.equal(getSourceHealth(coordinator.snapshot().sourceRegistry, 'primary').status, SOURCE_HEALTH.DEGRADED);

  currentResult.resolve({ version: 'current' });
  assert.deepEqual(await currentTask, {
    status: 'completed', generation: 2, result: {
      cacheCommit: { committed: true, value: 'current' }, uiCommit: true,
    },
  });
  assert.deepEqual(commits, ['current']);
  assert.deepEqual(partials.map(entry => entry.value.version), ['current']);
});

test('an AbortError never becomes a source failure or a refresh error', async () => {
  const errors = [];
  let invocation = 0;
  const coordinator = new RefreshCoordinator({
    now: () => STARTED_AT,
    sources: [descriptor('primary')],
    onError(entry) { errors.push(entry); },
    execute(context) {
      if (invocation++ > 0) return Promise.resolve('new-value');
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          const error = new Error('superseded request');
          error.name = 'AbortError';
          context.recordSourceFailure('primary', error);
          reject(error);
        }, { once: true });
      });
    },
  });

  const oldTask = coordinator.request({ trigger: 'timer' });
  await flushTasks();
  const newTask = coordinator.request({ trigger: 'manual' });
  assert.deepEqual(await oldTask, { status: 'aborted', generation: 1, result: null });
  assert.deepEqual(await newTask, { status: 'completed', generation: 2, result: 'new-value' });
  assert.equal(getSourceHealth(coordinator.snapshot().sourceRegistry, 'primary').status, SOURCE_HEALTH.HEALTHY);
  assert.deepEqual(errors, []);
});

test('per-fund execution isolates a failure, records source health, and restores it after recovery', async () => {
  const partials = [];
  const diagnostics = [];
  let cycle = 0;
  const coordinator = new RefreshCoordinator({
    now: () => STARTED_AT,
    sources: [descriptor('primary'), descriptor('secondary')],
    sourceHealthPolicy: { failureThreshold: 2, cooldownMs: 100 },
    onPartial(entry) { partials.push(entry); },
    onDiagnostic(entry) { diagnostics.push(entry); },
    async execute(context) {
      if (cycle++ === 0) {
        return Promise.all([
          context.runFund('000001', async () => ({ changePct: 0 }), { sourceId: 'primary' }),
          context.runFund('000002', async () => {
            const error = new Error('secondary failed');
            error.code = 'HTTP_503';
            throw error;
          }, { sourceId: 'secondary' }),
        ]);
      }
      return [await context.runFund('000002', async () => ({ changePct: 1.25 }), { sourceId: 'secondary' })];
    },
  });

  const first = await coordinator.request({ trigger: 'manual' });
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.result.map(item => item.status), ['fulfilled', 'failed']);
  assert.deepEqual(partials.map(item => item.key), ['000001']);
  assert.equal(getSourceHealth(coordinator.snapshot().sourceRegistry, 'primary').status, SOURCE_HEALTH.HEALTHY);
  assert.equal(getSourceHealth(coordinator.snapshot().sourceRegistry, 'secondary').status, SOURCE_HEALTH.DEGRADED);
  assert.deepEqual(diagnostics.map(item => [item.type, item.key, item.reason]), [['fund_failed', '000002', 'HTTP_503']]);

  const recovered = await coordinator.request({ trigger: 'manual' });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result[0].status, 'fulfilled');
  assert.deepEqual(partials.map(item => item.key), ['000001', '000002']);
  const secondary = getSourceHealth(coordinator.snapshot().sourceRegistry, 'secondary');
  assert.equal(secondary.status, SOURCE_HEALTH.HEALTHY);
  assert.equal(secondary.consecutiveFailures, 0);
});

test('a completed generation accepts detached enrichment only until superseded', async () => {
  let firstContext;
  const commits = [];
  const coordinator = new RefreshCoordinator({
    execute(context) {
      if (!firstContext) firstContext = context;
      return 'initial-list-ready';
    },
  });

  assert.equal((await coordinator.request({ trigger: 'startup' })).status, 'completed');
  assert.equal(coordinator.snapshot().active, null);
  assert.equal(coordinator.snapshot().currentGeneration, 1);
  assert.equal(firstContext.commit(() => commits.push('holdings-enrichment')).committed, true);

  assert.equal((await coordinator.request({ trigger: 'manual' })).status, 'completed');
  assert.equal(firstContext.commit(() => commits.push('late-old-result')).committed, false);
  assert.deepEqual(commits, ['holdings-enrichment']);
});

test('stop aborts the current generation and blocks every later commit', async () => {
  const pending = deferred();
  let context;
  const coordinator = new RefreshCoordinator({
    execute(current) {
      context = current;
      return pending.promise;
    },
  });

  const task = coordinator.request({ trigger: 'service-worker-update' });
  await flushTasks();
  assert.equal(coordinator.stop('service-worker-update'), true);
  assert.equal(context.signal.aborted, true);
  assert.equal(context.commit(() => 'late').committed, false);
  pending.resolve('ignored');
  assert.equal((await task).status, 'superseded');
  assert.equal(coordinator.snapshot().currentGeneration, null);
});

test('manual requests do not coalesce by default and async commit callbacks are refused', async () => {
  const gates = [deferred(), deferred()];
  const contexts = [];
  let calls = 0;
  const coordinator = new RefreshCoordinator({
    execute(context) {
      contexts.push(context);
      return gates[calls++].promise;
    },
  });

  const first = coordinator.request({ trigger: 'manual', payload: { force: false } });
  await flushTasks();
  const second = coordinator.request({ trigger: 'manual', payload: { force: true } });
  await flushTasks();
  assert.notStrictEqual(first, second);
  assert.equal(calls, 2);
  let executed = false;
  const rejected = contexts[1].commit(async () => { executed = true; });
  assert.equal(rejected.committed, false);
  assert.equal(rejected.reason, 'async_commit_not_allowed');
  assert.equal(executed, false);

  gates[0].resolve();
  gates[1].resolve();
  assert.equal((await first).status, 'superseded');
  assert.equal((await second).status, 'completed');
});

test('runFund skips a source in cooldown without invoking its operation', async () => {
  let calls = 0;
  let cycle = 0;
  const coordinator = new RefreshCoordinator({
    now: () => STARTED_AT,
    sources: [descriptor('primary')],
    sourceHealthPolicy: { failureThreshold: 1, cooldownMs: 1000 },
    async execute(context) {
      if (cycle++ === 0) {
        return context.runFund('000001', async () => {
          calls += 1;
          throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' });
        }, { sourceId: 'primary' });
      }
      return context.runFund('000001', async () => {
        calls += 1;
        return { changePct: 1 };
      }, { sourceId: 'primary' });
    },
  });

  assert.equal((await coordinator.request({ trigger: 'timer' })).result.status, 'failed');
  const skipped = await coordinator.request({ trigger: 'manual' });
  assert.equal(skipped.result.status, 'skipped');
  assert.equal(calls, 1);
});

test('partial callback failures are reported as uncommitted results', async () => {
  const coordinator = new RefreshCoordinator({
    sources: [descriptor('primary')],
    onPartial() { throw Object.assign(new Error('render failed'), { code: 'RENDER_FAILED' }); },
    execute(context) {
      return context.runFund('000001', async () => ({ changePct: 1 }), { sourceId: 'primary' });
    },
  });

  const result = await coordinator.request({ trigger: 'manual' });
  assert.equal(result.result.status, 'commit_failed');
  assert.equal(result.result.committed, false);
  assert.equal(coordinator.snapshot().lastDiagnostic.type, 'partial_commit_failed');
});

test('stopAndDrain waits for the aborted active task to settle', async () => {
  let settled = false;
  const coordinator = new RefreshCoordinator({
    execute(context) {
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          queueMicrotask(() => {
            settled = true;
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          });
        }, { once: true });
      });
    },
  });

  const task = coordinator.request({ trigger: 'manual' });
  await flushTasks();
  await coordinator.stopAndDrain('service-worker-update');
  assert.equal(settled, true);
  assert.equal((await task).status, 'aborted');
  assert.equal(coordinator.snapshot().active, null);
});
