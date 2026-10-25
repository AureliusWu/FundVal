import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The actual App scheduler body is evaluated, replacing only its ESM import
// with a deferred loader. Real ESM/Bridge/storage behavior is covered by E2E.
const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const begin = source.indexOf('function updateCurrentFundAccuracy(');
const end = source.indexOf('\nfunction commitRefreshedFund(', begin);
assert.ok(begin >= 0 && end > begin);
const original = source.slice(begin, end);
const importText = "import('./runtime/business-features.js')";
assert.equal(original.split(importText).length, 2);
const body = original.replace(importText, 'loadAccuracyModule()');
const drain = () => new Promise(resolve => setImmediate(resolve));

function harness({ overseas = true, rejectUpdate = false, rejectRender = false } = {}) {
  const calls = { loads: 0, commits: 0, updates: [], renders: 0 };
  const pending = [];
  let current = true;
  const globals = { fundsData: [], isOverseasLikeFund: () => overseas,
    loadAccuracyModule: () => { calls.loads++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    scheduleFundRender: () => { calls.renders++; if (rejectRender) throw new Error('synthetic_render_failure'); } };
  const schedule = vm.runInNewContext(body + '\nupdateCurrentFundAccuracy;', globals);
  const context = { commit(operation) { if (!current) return; calls.commits++; return operation(); } };
  const module = { updateFundAccuracy(fund) { calls.updates.push(fund); if (rejectUpdate) throw new Error('synthetic_accuracy_failure'); } };
  return { calls, globals, schedule, context, module, pending, cancel() { current = false; } };
}

test('accuracy lifecycle: current overseas projection records and schedules render', async () => {
  const h = harness(), fund = { code: '110022' }; h.globals.fundsData = [fund];
  assert.equal(h.schedule(h.context, fund), undefined);
  h.pending[0].resolve(h.module); await drain();
  assert.deepEqual(h.calls, { loads: 1, commits: 1, updates: [fund], renders: 1 });
});

test('accuracy lifecycle: domestic fund does not load or mutate accuracy', async () => {
  const h = harness({ overseas: false }), fund = { code: '005844' };
  h.globals.fundsData = [fund]; h.schedule(h.context, fund); await drain();
  assert.deepEqual(h.calls, { loads: 0, commits: 0, updates: [], renders: 0 });
});

test('accuracy lifecycle: cancelled generation cannot write after deferred import', async () => {
  const h = harness(), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.cancel(); h.pending[0].resolve(h.module); await drain();
  assert.equal(h.calls.commits, 0); assert.deepEqual(h.calls.updates, []); assert.equal(h.calls.renders, 0);
});

test('accuracy lifecycle: same-generation replaced projection cannot write', async () => {
  const h = harness(), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.globals.fundsData = [{ code: fund.code }]; h.pending[0].resolve(h.module); await drain();
  assert.deepEqual(h.calls.updates, []); assert.equal(h.calls.renders, 0);
});

test('accuracy lifecycle: removed fund cannot write', async () => {
  const h = harness(), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.globals.fundsData = []; h.pending[0].resolve(h.module); await drain();
  assert.deepEqual(h.calls.updates, []); assert.equal(h.calls.renders, 0);
});

test('accuracy lifecycle: other portfolio changes do not reject the unchanged current fund', async () => {
  const h = harness(), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.globals.fundsData = [{ code: '000001' }, fund]; h.pending[0].resolve(h.module); await drain();
  assert.deepEqual(h.calls.updates, [fund]); assert.equal(h.calls.renders, 1);
});

for (const order of [[0, 1], [1, 0]]) test(`accuracy lifecycle: only latest same-code projection writes in completion order ${order}`, async () => {
  const h = harness(), old = { code: '110022' }, latest = { code: '110022' };
  h.globals.fundsData = [old]; h.schedule(h.context, old);
  h.globals.fundsData = [latest]; h.schedule(h.context, latest);
  for (const index of order) { h.pending[index].resolve(h.module); await drain(); }
  assert.deepEqual(h.calls.updates, [latest]); assert.equal(h.calls.renders, 1);
});

test('accuracy lifecycle: load rejection degrades without updates or unhandled rejection', async () => {
  const h = harness(), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.pending[0].reject(new Error('synthetic_import_failure')); await drain();
  assert.deepEqual(h.calls.updates, []); assert.equal(h.calls.renders, 0);
});

test('accuracy lifecycle: accuracy exception does not schedule misleading render', async () => {
  const h = harness({ rejectUpdate: true }), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.pending[0].resolve(h.module); await drain();
  assert.deepEqual(h.calls.updates, [fund]); assert.equal(h.calls.renders, 0);
});

test('accuracy lifecycle: render exception remains isolated after the single update', async () => {
  const h = harness({ rejectRender: true }), fund = { code: '110022' }; h.globals.fundsData = [fund];
  h.schedule(h.context, fund); h.pending[0].resolve(h.module); await drain();
  assert.deepEqual(h.calls.updates, [fund]); assert.equal(h.calls.renders, 1);
});

test('accuracy lifecycle: primary and enriched use the scheduler, enrichment does not repeat name-edit publication', () => {
  const primary = source.slice(source.indexOf('function commitRefreshedFund('), source.indexOf('function commitRefreshFailure('));
  const enriched = source.slice(source.indexOf('        enriched: ('), source.indexOf('        failure: ('));
  assert.match(primary, /updateCurrentFundAccuracy\(context, built\.data\)/);
  assert.match(enriched, /updateCurrentFundAccuracy\(context, built\.data\)/);
  assert.doesNotMatch(enriched, /commitRefreshedFund|saveHoldingEdit|scheduleAutoPush/);
});
