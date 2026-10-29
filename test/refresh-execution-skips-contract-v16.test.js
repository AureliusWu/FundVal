import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseSync } from 'rolldown/utils';
import { executeRefreshPlan } from '../js/runtime/refresh-execution.js';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';

const appSource = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const executorSource = (await readFile(new URL('../js/runtime/refresh-execution.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const appProgram = parseSync('app.js', appSource).program;
const executorProgram = parseSync('refresh-execution.js', executorSource).program;
const appGate = appProgram.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'fetchRefreshEstimateRows');
const KEYS = ['estimate_claim_denied', 'holdings_claim_denied', 'holdings_probe_used', 'model_claim_denied', 'model_probe_used'];

// Frozen before the observation seam was implemented. This independent legacy
// reference is deliberately not derived from the current production function.
const LEGACY_APP = String.raw`
async function fetchRefreshEstimateRows(snapshot, options, context, dispatch) {
  var sourceId = 'sinan-estimate-proxy';
  var claim = context.claimSourceAttempt(sourceId);
  if (!claim.allowed) {
    context.recordDiagnostic('source_cooldown', { sourceId: sourceId, reason: 'circuit_breaker_open' });
    return new Map();
  }
  var startedAt = Date.now();
  try {
    var rows = await dispatch(() => fetchEstimateRows(
      snapshot.map(function(h) { return h.code; }),
      { force: options.force !== false, signal: context.signal }
    ));
    var usableCount = Array.from(rows.values()).filter(function(row) {
      return row && row.status === 'ok' && row.source_quote && !['stale', 'unavailable'].includes(row.source_quote.status);
    }).length;
    var responseMs = Math.max(0, Date.now() - startedAt);
    if (usableCount === snapshot.length) {
      context.recordSourceSuccess(sourceId, { responseMs: responseMs });
    } else if (usableCount > 0) {
      context.recordSourcePartial(sourceId, {
        responseMs: responseMs,
        reason: 'partial_coverage_' + usableCount + '_of_' + snapshot.length,
      });
      context.recordDiagnostic('source_partial', {
        sourceId: sourceId, usable: usableCount, requested: snapshot.length,
      });
    } else {
      context.recordSourceFailure(sourceId, {
        code: 'BUSINESS_EMPTY', reason: 'no_usable_quotes', responseMs: responseMs,
      });
      context.recordDiagnostic('source_empty', { sourceId: sourceId, requested: snapshot.length });
    }
    return rows;
  } catch (error) {
    if (isRefreshAbort(error, context.signal)) {
      // A cancelled half-open probe is released without treating cancellation
      // as another upstream failure.
      context.recordSourceFailure(sourceId, { name: 'AbortError', aborted: true });
      throw error;
    }
    context.recordSourceFailure(sourceId, { error: error, responseMs: Math.max(0, Date.now() - startedAt) });
    context.recordDiagnostic('source_failed', { sourceId: sourceId, reason: error.name || error.message || 'request_failed' });
    return new Map();
  }
}
`;

function visit(node, callback, parent = null, key = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') callback(node, parent, key);
  for (const [childKey, value] of Object.entries(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback, node, childKey));
    else if (value && typeof value === 'object') visit(value, callback, node, childKey);
  }
}

function ast(value) {
  if (Array.isArray(value)) return value.map(ast);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'ParenthesizedExpression') return ast(value.expression);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key))
    .map(([key, child]) => [key, ast(child)]));
}

const parsed = source => parseSync('synthetic-contract.js', source).program;
const expression = source => ast(parsed(`(${source})`).body[0].expression);
const originalGate = parsed(LEGACY_APP).body[0];
const gateText = appSource.slice(appGate.start, appGate.end);
const LEGACY_ESTIMATE_CALL = `clients.estimates(snapshot.filter(holding => estimateResource.codes.includes(holding.code)), options, context,
  operation => scope.dispatch('sinan-estimate-proxy', operation))`;
const member = (node, receiver, property) => node?.type === 'MemberExpression'
  && !node.computed && node.object?.name === receiver && node.property?.name === property;

test('App reads claim.allowed once, emits only that scalar and keeps the entire legacy path AST', () => {
  const reads = [], claims = [];
  visit(appGate, node => {
    if (member(node, 'claim', 'allowed')) reads.push(node);
    if (node.type === 'CallExpression' && member(node.callee, 'context', 'claimSourceAttempt')) claims.push(node);
  });
  assert.equal(reads.length, 1, 'Accessor-backed gate values must not be read twice.');
  assert.equal(claims.length, 1, 'Observation must not re-claim or re-probe source health.');
  const body = appGate.body.body;
  assert.deepEqual(ast(body[2]), ast(parsed('var allowed = claim.allowed;').body[0]));
  assert.deepEqual(ast(body[3]), ast(parsed(`if (typeof observeGate === 'function') {
    try { Promise.resolve(observeGate(allowed)).catch(() => {}); } catch (_) {}
  }`).body[0]), 'No observer payload, claim object or error may escape this scalar seam.');
  const restored = ast(appGate);
  restored.params = restored.params.slice(0, 4);
  restored.body.body.splice(2, 2);
  assert.deepEqual(restored.body.body[2].test, expression('!allowed'));
  restored.body.body[2].test = expression('!claim.allowed');
  assert.deepEqual(restored, ast(originalGate), 'Dispatch, health/log calls, zero/null returns and Date reads remain legacy AST.');
});

test('real App exposes only the optional fifth observation seam', () => {
  assert.ok(appGate);
  assert.equal(appGate.params.length, 5);
  assert.deepEqual(appGate.params.slice(0, 4).map(node => node.name), ['snapshot', 'options', 'context', 'dispatch']);
  assert.equal(appGate.params[4].type, 'AssignmentPattern');
  assert.equal(appGate.params[4].left.name, 'observeGate');
  assert.equal(appGate.params[4].right.name, 'undefined');
});

test('executor estimates call has a conditional fifth seam, not an unconditional arity change', () => {
  const calls = [], parents = new WeakMap(), estimateUses = [];
  visit(executorProgram, (node, parent, key) => {
    if (parent) parents.set(node, parent);
    if (member(node, 'clients', 'estimates')) estimateUses.push({ parent, key });
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.name === 'clients' && node.callee.property.name === 'estimates') calls.push(node);
  });
  assert.equal(calls.length, 1);
  assert.equal(estimateUses.length, 1, 'The estimates client cannot be aliased or exported.');
  assert.equal(estimateUses[0].key, 'callee');
  const call = calls[0];
  const oldCall = parsed(`${LEGACY_ESTIMATE_CALL};`).body[0].expression;
  assert.deepEqual(ast(call.arguments.slice(0, 4)), ast(oldCall.arguments), 'All four business argument ASTs are frozen independently.');
  assert.equal(call.arguments.length, 5);
  const expectedCall = parsed(`client(...(observing ? [allowed => {
    if (synchronous && !seen && typeof allowed === 'boolean') {
      seen = true; estimateObserved++; if (!allowed) estimateDenied++;
    }
  }] : []));`).body[0].expression;
  assert.deepEqual(ast(call.arguments[4]), ast(expectedCall.arguments[0]), 'Only a first synchronous boolean reaches local scalar counters.');
  let enclosingTry = parents.get(call);
  while (enclosingTry && enclosingTry.type !== 'TryStatement') enclosingTry = parents.get(enclosingTry);
  assert.ok(enclosingTry, 'The synchronous window must close even when the client throws.');
  assert.deepEqual(ast(enclosingTry.finalizer), ast(parsed('try {} finally { synchronous = false; }').body[0].finalizer));
  assert.notEqual(parents.get(call).type, 'AwaitExpression', 'Close the window before awaiting or assimilating a thenable.');
  let loader = parents.get(enclosingTry);
  while (loader && loader.type !== 'ArrowFunctionExpression') loader = parents.get(loader);
  assert.ok(loader?.async);
  const localCollectors = [];
  visit(loader, (node, parent, key) => {
    if (node.type === 'Identifier' && ['synchronous', 'seen'].includes(node.name)) {
      const allowed = parent.type === 'VariableDeclarator' && key === 'id'
        || parent.type === 'AssignmentExpression' && key === 'left'
        || parent.type === 'LogicalExpression' || parent.type === 'UnaryExpression';
      assert.ok(allowed, `Private collector escaped via ${parent.type}.${key}`);
      localCollectors.push(node.name);
    }
  });
  assert.deepEqual(localCollectors.sort(), ['seen', 'seen', 'seen', 'synchronous', 'synchronous', 'synchronous'].sort());
  const observing = [];
  visit(executorProgram, node => {
    if (node.type === 'VariableDeclarator' && node.id?.name === 'observing') observing.push(node.init);
  });
  assert.deepEqual(observing.map(ast), [expression("typeof onDiagnostics === 'function'")]);
});

const NOW = Date.parse('2026-09-30T06:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
const counts = estimate => ({ estimate_claim_denied: estimate, holdings_claim_denied: 0,
  holdings_probe_used: 0, model_claim_denied: 0, model_probe_used: 0 });

// Run the complete private production function in a VM, without loading App's
// DOM, storage or network side effects. Legacy and current use fresh identical
// accessor-backed fixtures; this is an independent old-versus-new reference.
async function gateRun(source, { allowed = true, kind = 'ok', observer, force = false } = {}) {
  const trace = [], observed = [], signal = { aborted: false };
  const sentinel = Object.assign(new Error('synthetic sentinel'), { name: kind === 'abort' ? 'AbortError' : 'SyntheticError' });
  const log = (name, ...args) => trace.push([name, ...args.map(value => value instanceof Error
    ? { name: value.name, message: value.message } : value)]);
  const snapshot = [0, 1].map(index => Object.defineProperty({ shares: 0, cost: null }, 'code', {
    get() { log('holding.code', index); return String(index + 1).padStart(6, '0'); },
  }));
  const options = Object.defineProperty({}, 'force', { get() {
    log('options.force'); if (kind === 'force_getter') throw sentinel; return force;
  } });
  const quote = Object.defineProperty({ changePct: 0, optional: null }, 'status', { get() { log('quote.status'); return 'realtime'; } });
  const row = Object.defineProperties({ est_change: 0, optional: null }, {
    status: { get() { log('row.status'); return 'ok'; } },
    source_quote: { get() { log('row.source_quote'); if (kind === 'row_getter') throw sentinel; return quote; } },
  });
  const rows = new Map(kind === 'empty' ? [] : [['000001', row], ...(kind === 'partial' ? [] : [['000002', row]])]);
  Object.defineProperty(rows, 'values', { get() { log('rows.values'); return Map.prototype.values; } });
  const claim = Object.defineProperty({}, 'allowed', { get() {
    log('claim.allowed'); if (kind === 'claim_getter') throw sentinel; return allowed;
  } });
  const context = Object.defineProperty({
    claimSourceAttempt(id) { log('claim', id); return claim; },
    recordDiagnostic(...args) { log('diagnostic', ...args); },
    recordSourceSuccess(...args) { log('success', ...args); },
    recordSourcePartial(...args) { log('partial', ...args); },
    recordSourceFailure(id, details) { log('failure', id, { ...details,
      ...(details.error ? { error: { name: details.error.name, message: details.error.message } } : {}) }); },
  }, 'signal', { get() { log('context.signal'); return signal; } });
  let clockReads = 0;
  const fn = runInNewContext(`(${source})`, {
    Map, Array, Promise, Date: { now() {
      log('Date.now'); if (kind === 'clock_getter') throw sentinel; return NOW + 17 * clockReads++;
    } },
    fetchEstimateRows(codes, config) { log('fetch', codes, config.force, config.signal === signal);
      if (kind === 'fetch_error' || kind === 'abort') return Promise.reject(sentinel);
      return Promise.resolve(rows);
    },
    isRefreshAbort(error, candidate) { log('isAbort', error === sentinel, candidate === signal); return error.name === 'AbortError'; },
  });
  const dispatch = operation => { log('dispatch'); if (kind === 'dispatch_error') throw sentinel; return operation(); };
  const observeGate = typeof observer === 'function' ? function(...args) {
    observed.push(args); return observer(...args);
  } : observer;
  let returned, thrown;
  try { returned = await fn(snapshot, options, context, dispatch, observeGate); }
  catch (error) { thrown = error; }
  // Materialize trace values in this realm; VM-created object prototypes are
  // not business behavior and must not produce false deep-strict mismatches.
  return { trace: structuredClone(trace), observed, returned, thrown, sentinel, rows, row, clockReads, snapshot, fn };
}

function equivalentGate(reference, current) {
  assert.deepEqual(current.trace, reference.trace, 'Every legacy getter, dispatch, diagnostic and clock read keeps its order.');
  assert.equal(Boolean(current.thrown), Boolean(reference.thrown));
  if (reference.thrown) {
    assert.strictEqual(reference.thrown, reference.sentinel);
    assert.strictEqual(current.thrown, current.sentinel, 'The original sentinel rejection cannot be replaced.');
  } else {
    assert.equal(current.returned === current.rows, reference.returned === reference.rows);
    assert.deepEqual([...current.returned.keys()], [...reference.returned.keys()]);
    if (current.returned === current.rows && current.returned.size) {
      assert.equal(current.row.est_change, 0); assert.equal(current.row.optional, null);
      assert.equal(current.snapshot[0].shares, 0); assert.equal(current.snapshot[0].cost, null);
    }
  }
  assert.equal(current.clockReads, reference.clockReads);
  assert.equal(current.trace.filter(row => row[0] === 'claim.allowed').length, 1);
  assert.equal(current.fn.length, 4, 'The optional seam preserves the public JavaScript arity.');
}

test('LEGACY_SEAM_NEGATIVE: independently frozen old App ignores a fifth callback', async () => {
  const reference = await gateRun(LEGACY_APP, { observer() {} });
  assert.equal(reference.observed.length, 0, 'A negative control, not a claimed pre-implementation live RED.');
  assert.equal(reference.returned, reference.rows);
  assert.equal(originalGate.params.length, 4);
});

test('LEGACY_CALL_NEGATIVE: frozen old executor call keeps four arguments and cannot observe a gate', async () => {
  const active = [{ code: '000001', shares: 0, cost: null }], seen = [], callbacks = [];
  const oldCall = runInNewContext(`(async function(clients, snapshot, estimateResource, options, context, scope) {
    return await ${LEGACY_ESTIMATE_CALL};
  })`, {});
  const result = await oldCall({ estimates(...args) {
    seen.push(args); args[4]?.(false); return args[3](async () => new Map());
  } }, active, { codes: ['000001'] }, {}, {}, { dispatch: (_source, operation) => operation() });
  assert.equal(result.size, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 4);
  assert.equal(seen[0][4], undefined);
  assert.deepEqual(callbacks, [], 'This is only the independently frozen call expression, not a complete old executor artifact.');
});

for (const kind of ['ok', 'partial', 'empty', 'fetch_error', 'abort', 'dispatch_error', 'claim_getter', 'force_getter', 'row_getter', 'clock_getter']) {
  test(`real App VM ${kind} remains equivalent to the frozen complete old function`, async () => {
    const reference = await gateRun(LEGACY_APP, { kind });
    const current = await gateRun(gateText, { kind, observer() {} });
    equivalentGate(reference, current);
    assert.equal(current.observed.length, kind === 'claim_getter' ? 0 : 1);
    if (current.observed.length) assert.deepEqual(current.observed[0], [true], 'Only the raw allowed scalar is observed.');
  });
}

for (const allowed of [false, 0, null, '', 'truthy', Object.freeze({ synthetic: true })]) {
  test(`real App VM preserves non-coercing gate behavior for ${String(allowed)}`, async () => {
    const reference = await gateRun(LEGACY_APP, { allowed });
    const current = await gateRun(gateText, { allowed, observer() {} });
    equivalentGate(reference, current);
    assert.equal(current.observed.length, 1);
    assert.equal(current.observed[0].length, 1);
    assert.strictEqual(current.observed[0][0], allowed);
    if (!allowed) {
      assert.equal(current.returned.size, 0);
      assert.equal(current.clockReads, 0);
      assert.equal(current.trace.some(row => row[0] === 'dispatch'), false);
      assert.deepEqual(current.trace.at(-1), ['diagnostic', 'source_cooldown',
        { sourceId: 'sinan-estimate-proxy', reason: 'circuit_breaker_open' }]);
    }
  });
}

for (const observer of [undefined, null, false, {}, Object.freeze({ then() { assert.fail('Non-functions must not be assimilated.'); } })]) {
  test(`real App VM skips non-function observer ${String(observer)}`, async () => {
    equivalentGate(await gateRun(LEGACY_APP), await gateRun(gateText, { observer }));
  });
}

for (const allowed of [true, false]) for (const failure of ['throw', 'reject', 'then_getter']) {
  test(`real App observer ${failure} with gate ${allowed} never changes business outcome or leaks rejection`, async () => {
    const unhandled = [], listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      const reference = await gateRun(LEGACY_APP, { allowed });
      const current = await gateRun(gateText, { allowed, observer() {
        const error = new Error('synthetic observer failure');
        if (failure === 'throw') throw error;
        if (failure === 'reject') return Promise.reject(error);
        return Object.defineProperty({}, 'then', { get() { throw error; } });
      } });
      equivalentGate(reference, current);
      await tick(); await tick();
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', listener); }
  });
}

function estimateRow(code) {
  return { code, name: 'Synthetic QDII', status: 'ok', est_change: 0, coverage: null,
    source_quote: { fundCode: code, fundName: 'Synthetic QDII', market: 'cn', assetKind: 'fund',
      valueKind: 'intraday_estimate', value: 1, changePct: 0, baseNav: 1, baseNavDate: '2026-09-29',
      targetDate: '2026-09-30', sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime',
      observedAt: new Date(NOW - 1000).toISOString(), fetchedAt: new Date(NOW).toISOString(), reasonCodes: [] } };
}

function executorHarness({ count = 1, behavior = observe => observe?.(true), observe = true, previous } = {}) {
  const reports = [], args = [], writes = [], late = [], published = [];
  const snapshot = Array.from({ length: count }, (_, index) => ({ code: String(1000 + index).padStart(6, '0'),
    name: 'Synthetic QDII', shares: 0, cost: null }));
  const coordinator = new RefreshCoordinator({ now: () => NOW, execute(context) {
    return executeRefreshPlan({ context, snapshot, previous, options: { force: false }, now: () => NOW,
      onDiagnostics: observe ? report => reports.push(report) : undefined,
      clients: {
        estimates(...actual) {
          args.push(actual);
          const [active, , , dispatch, observeGate] = actual;
          const rows = new Map(active.map(holding => [holding.code, estimateRow(holding.code)]));
          const alternate = behavior(observeGate, args.length - 1, late, rows);
          return alternate === undefined ? dispatch(async () => rows) : alternate;
        },
        nav: async () => null, models: async () => [], indices: async () => [], gold: async () => null,
      },
      ui: { primary: (_holding, raw) => raw, publish: (holding, raw) => published.push([holding.code, raw]),
        failure() {}, market() {}, cacheData: () => [], holdingsHash: () => 'synthetic', complete() {} },
      storage: { setItem(key, bytes) { writes.push({ key, bytes }); return true; } },
    });
  } });
  return { reports, args, writes, late, published, run: () => coordinator.request({ trigger: 'manual' }) };
}

function assertReports(h, expected) {
  assert.deepEqual(h.reports.map(row => row.phase), ['started', 'resources_settled', 'final']);
  for (const [index, row] of h.reports.entries()) {
    assert.deepEqual(Object.keys(row.executionSkips), KEYS);
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.executionSkips));
    assert.deepEqual(row.executionSkips, counts(index ? expected : null));
  }
  assert.notStrictEqual(h.reports[0].executionSkips, h.reports[1].executionSkips);
  assert.doesNotMatch(JSON.stringify(h.reports.map(row => row.executionSkips)), /payload|code|source_quote|Synthetic|signal|token|https:/);
}

test('observing disabled retains true arity four and identical business/cache results', async () => {
  const observed = executorHarness(), silent = executorHarness({ observe: false });
  assert.deepEqual(await observed.run(), await silent.run());
  assert.deepEqual(observed.args.map(args => args.length), [5]);
  assert.deepEqual(silent.args.map(args => args.length), [4]);
  assert.equal(observed.args[0][4].length, 1);
  assert.deepEqual(observed.published, silent.published);
  assert.deepEqual(observed.writes, silent.writes);
  assert.equal(silent.reports.length, 0);
  assertReports(observed, 0);
});

for (const [name, behavior, expected] of [
  ['all batches allowed', observe => observe(true), 0],
  ['all batches denied', observe => observe(false), 2],
  ['mixed batch decisions', (observe, index) => observe(Boolean(index)), 1],
  ['duplicate opposite decisions', observe => { observe(false); observe(true); observe(false); }, 2],
  ['invalid does not seal the seam', observe => { observe(null); observe(0); observe('false'); observe({}); observe(false); }, 2],
  ['invalid-only decisions', observe => { observe(null); observe(0); observe('false'); observe(new Boolean(false)); }, null],
  ['legacy no callback', () => {}, null],
  ['partial batch callback', (observe, index) => { if (!index) observe(false); }, null],
  ['late-only microtask callback', observe => { queueMicrotask(() => observe(false)); }, null],
  ['first allowed, late denied', observe => { observe(true); queueMicrotask(() => observe(false)); }, 0],
  ['client thenable getter is already late', (observe, _index, _late, rows) => Object.defineProperty({}, 'then', {
    get() { observe(false); return resolve => resolve(rows); },
  }), null],
]) {
  test(`estimate collector ${name} reports only complete synchronous boolean evidence`, async () => {
    const h = executorHarness({ count: 51, behavior });
    assert.equal((await h.run()).status, 'completed');
    assert.deepEqual(h.args.map(args => args[0].length), [50, 1]);
    assertReports(h, expected);
    assert.equal(h.published.length, 51);
    assert.ok(h.published.every(([, row]) => row.est_change === 0 && row.coverage === null));
  });
}

test('saved callbacks close on client return and cannot mutate any frozen earlier report', async () => {
  const h = executorHarness({ behavior(observe, _index, late) { late.push(observe); } });
  assert.equal((await h.run()).status, 'completed');
  assertReports(h, null);
  const before = JSON.stringify(h.reports);
  h.late[0](false); h.late[0](true);
  await tick();
  assert.equal(JSON.stringify(h.reports), before);
});

for (const observeBeforeThrow of [false, true]) {
  test(`synchronous client throw closes retained callbacks after ${observeBeforeThrow ? 'observed' : 'unobserved'} gate`, async () => {
    const h = executorHarness({ behavior(observe, _index, late) {
      late.push(observe);
      if (observeBeforeThrow) observe(false);
      throw new Error('synthetic synchronous client failure');
    } });
    assert.equal((await h.run()).status, 'failed');
    assertReports(h, observeBeforeThrow ? 1 : null);
    const before = JSON.stringify(h.reports);
    h.late[0](false);
    await tick();
    assert.equal(JSON.stringify(h.reports), before);
  });
}

test('no actual estimate client entry, including warm cache and empty portfolio, remains null not zero', async () => {
  const cold = executorHarness(); await cold.run();
  const previous = JSON.parse(cold.writes[0].bytes), bytes = JSON.stringify(previous);
  const warm = executorHarness({ previous });
  assert.equal((await warm.run()).status, 'completed');
  assert.equal(warm.args.length, 0);
  assertReports(warm, null);
  assert.equal(JSON.stringify(previous), bytes);
  const empty = executorHarness({ count: 0 });
  assert.equal((await empty.run()).status, 'completed');
  assert.equal(empty.args.length, 0);
  assertReports(empty, null);
});
