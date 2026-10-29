import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import { commitHoldingEdit } from '../js/runtime/holding-edit.js';
import { executeRefreshPlan } from '../js/runtime/refresh-execution.js';
import { RefreshCoordinator } from '../js/runtime/refresh-runtime.js';
import { HOLDINGS_DEVICE_KEY, HOLDINGS_V3_KEY } from '../js/storage/holdings-repository.js';
import { canonicalHoldingsDocument, normalizeHoldingsDocumentV3, toLegacyHoldings } from '../js/storage/holdings-schema.js';
import { activeHoldingCodes, retainActiveFundData } from '../js/runtime/active-holdings.js';
import { holdingQuoteAmounts } from '../js/runtime/holding-quote-amounts.js';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const program = parseSync('app.js', source).program;
function functionText(name) {
  const node = program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
  assert.ok(node, `Missing real App function ${name}`);
  return source.slice(node.start, node.end);
}
const NOW = Date.parse('2026-09-30T06:00:00Z');
const CODE = '005844';
const CACHE_KEY = 'fuyu_funds_cache_v1';
const INDEX_CODES = ['sh000001', 'sh000300', 'usINX', 'usNDX'];
const immediateLocks = { request: async (_name, _options, callback) => callback({}) };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// All App bodies below are read from production. Only their dynamic module
// loader, provider IO, rendering/accuracy sinks and storage/lock adapters are
// injected. No browser, Gist, user storage or test-only production API is used.
async function fixture({ holdResult = false, failure = false, conflict = false } = {}) {
  let clock = NOW, phase = 'seed', failBackup = false;
  const values = new Map([[HOLDINGS_DEVICE_KEY, 'synthetic:name-settlement']]);
  const mutations = [], calls = {}, pendingNameEdits = [];
  const locked = deferred(), resultReady = deferred(), releaseResult = deferred();
  let releaseLock, renameTask;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (failBackup && key.includes('backup')) throw new Error('synthetic backup quota');
      values.set(key, String(value));
      mutations.push({ phase, kind: 'set', key });
    },
    removeItem(key) { values.delete(key); mutations.push({ phase, kind: 'remove', key }); },
  };
  const seed = await commitHoldingEdit(storage, {
    code: CODE, baseline: null, operation: 'add', values: { name: CODE, shares: 10, cost: 1.2 },
  }, { locks: immediateLocks, now: NOW - 60000 });
  assert.equal(seed.ok, true);
  const locks = { request: (_name, _options, callback) => new Promise(resolve => {
    releaseLock = () => resolve(callback({}));
    locked.resolve();
  }) };
  let saveBody = functionText('saveHoldingEdit');
  const moduleImport = "await import('./runtime/business-features.js')";
  assert.equal(saveBody.split(moduleImport).length, 2, 'Replace only the private module loader, never edit behavior');
  saveBody = saveBody.replace(moduleImport, 'await loadBusiness()');
  const bindings = {
    canonicalHoldingsDocument, normalizeHoldingsDocumentV3, toLegacyHoldings,
    activeHoldingCodes, retainActiveFundData, holdingQuoteAmounts, CACHE_KEY,
    SKIP_CACHE_KEYS: ['_cached', 'message', 'quoteCandidates'],
    safeGetItem: storage.getItem, safeSetItem: (key, value) => { storage.setItem(key, value); return true; },
    safeRemoveItem: storage.removeItem, initial: seed.document,
    renderFundList() {}, renderHoldingsList() {}, scheduleAutoPush() {}, updateCurrentFundAccuracy() {},
    loadBusiness: async () => ({ commitHoldingEdit: async (_unused, edit, options) => {
      renameTask = commitHoldingEdit(storage, edit, { ...options, locks, now: clock });
      const result = await renameTask;
      resultReady.resolve(result);
      if (holdResult) await releaseResult.promise;
      return result;
    } }),
  };
  const app = new Function(...Object.keys(bindings), [
    'let holdingsDocument=initial,holdings=toLegacyHoldings(initial),holdingsStorageError="",fundsData=[],expandedFund=null;',
    'const holdingsCache={},holdingsMetaCache={},fundTypeCache={},fundFeeCache={},fundHoldingsRequests=new Map();',
    'function upsertFundData(code,data){const i=fundsData.findIndex(x=>x.code===code);if(i<0)fundsData.push(data);else fundsData[i]=data;}',
    ...['isRealFundName', 'holdingsHash', 'slimFundCache', 'saveCache', 'reconcileActiveFundState',
      'installHoldingsDocument', 'commitRefreshedFund'].map(functionText), saveBody,
    'return {commit:commitRefreshedFund,install:installHoldingsDocument,holdings:()=>holdings,document:()=>holdingsDocument,',
    'hash:()=>holdingsHash(holdings),data:()=>slimFundCache(fundsData),error:()=>holdingsStorageError,setError:value=>{holdingsStorageError=value;}};',
  ].join('\n'))(...Object.values(bindings));
  const bump = kind => { calls[phase] ||= {}; calls[phase][kind] = (calls[phase][kind] || 0) + 1; };
  const row = () => ({ code: CODE, name: 'Synthetic 混合基金A', status: 'ok', est_change: 0,
    source_quote: { fundCode: CODE, fundName: 'Synthetic 混合基金A', market: 'cn', assetKind: 'fund',
      valueKind: 'intraday_estimate', value: 1, changePct: 0, baseNav: 1, baseNavDate: '2026-09-29', targetDate: '2026-09-30',
      sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime',
      observedAt: new Date(clock - 1000).toISOString(), fetchedAt: new Date(clock).toISOString(), reasonCodes: [] } });
  const clients = {
    estimates: async (active, _options, _context, dispatch) => dispatch(async () => {
      bump('estimates'); return new Map(active.map(holding => [holding.code, row()]));
    }),
    nav: async () => { bump('nav'); return { nav: 1.1, prevNav: 1, date: '2026-09-29', prevDate: '2026-09-28',
      change: 10, changeAmt: 0.1, fundName: 'Synthetic 混合基金A', meta: { manager: 'Synthetic manager' } }; },
    holdings: async () => { bump('holdings'); return { status: 'ok', sourceStatus: 'ok', wireVersion: 2,
      reportDate: '2026-06-30', fetchedAt: new Date(clock).toISOString(), source: 'sinan-holdings-proxy',
      items: [{ code: '600001', market: 'sh', name: 'Synthetic stock', ratio: 20 }] }; },
    indices: async () => INDEX_CODES.map(code => ({ code, price: 100, changePct: 0,
      observedAt: new Date(clock - 1000).toISOString(), status: 'current' })),
    gold: async (_signal, dispatch) => dispatch(async () => ({ price: 100, changePct: 0,
      observedAt: new Date(clock - 1000).toISOString(), status: 'current', cached: false })),
    models: async () => [], qualifyHoldings: (_holding, items) => items.map(item => ({ ...item, quoteCode: item.market + item.code })),
    calculateHoldings: async () => null, normalizeTime: value => value,
    eastmoney: async codes => ({ data: { diff: codes.map(code => ({ f12: code.slice(2), f13: 1,
      f2: 100, f3: 0, f124: Math.floor(clock / 1000) })) } }), bridge: async () => ({ quotes: [] }),
  };
  const coordinator = new RefreshCoordinator({ withBuiltinSources: true, now: () => clock,
    execute(context) {
      return executeRefreshPlan({ context, snapshot: structuredClone(app.holdings()), options: { force: true },
        previous: storage.getItem(CACHE_KEY), clients, storage, now: () => clock,
        ui: {
          primary: (_holding, raw) => raw,
          publish: (holding, raw) => app.commit(context, holding,
            { data: { ...raw, code: holding.code, quote: raw.source_quote }, fetchedName: raw.name },
            promise => { pendingNameEdits.push(promise); }),
          settlePendingEdits: () => Promise.allSettled(pendingNameEdits),
          enriched() {}, holdings() {}, metadata() {}, market() {}, failure(_holding, error) { throw error; },
          cacheData: app.data, holdingsHash: app.hash,
        },
      });
    },
  });
  async function externalEdit(shares) {
    const latest = JSON.parse(storage.getItem(HOLDINGS_V3_KEY));
    const changed = await commitHoldingEdit(storage, { code: CODE,
      baseline: latest.holdings.find(item => item.fundCode === CODE), operation: 'edit',
      values: { name: 'Synthetic external name', shares, cost: 1.2 } }, { locks: immediateLocks, now: clock + shares });
    assert.equal(changed.ok, true);
    return changed.document;
  }
  return { app, storage, coordinator, mutations, calls, pendingNameEdits, locked: locked.promise, resultReady: resultReady.promise,
    run(name) { phase = name; clock++; return coordinator.request({ trigger: name === 'cold' ? 'startup' : 'manual' }); },
    async release() {
      if (conflict) await externalEdit(20);
      failBackup = failure;
      releaseLock?.();
    },
    releaseResult: releaseResult.resolve, externalEdit, clearFailure() { failBackup = false; },
    async cleanup() { failBackup = false; releaseLock?.(); releaseResult.resolve(); if (renameTask) await renameTask; await tick(); },
  };
}

test('automatic name edits settle before the one aggregate flush, and the next warm refresh reuses stable resources', async t => {
  const h = await fixture();
  t.after(() => h.cleanup());
  let completed = false;
  const cold = h.run('cold').then(result => { completed = true; return result; });
  await h.locked; await tick();
  assert.equal(completed, false, 'A refresh-owned name edit still holds the generation completion boundary');
  assert.equal(h.storage.getItem(CACHE_KEY), null, 'No final aggregate may precede the pending name edit');
  assert.equal(h.pendingNameEdits.length, 1, 'The real App must register the automatic edit, not merely the test executor');
  await h.release();
  assert.equal((await cold).status, 'completed');
  const cache = JSON.parse(h.storage.getItem(CACHE_KEY));
  assert.equal(cache.holdingsHash, h.app.hash());
  assert.equal(h.app.holdings()[0].name, 'Synthetic 混合基金A');
  assert.equal(h.mutations.filter(row => row.key === CACHE_KEY && row.kind === 'set').length, 1);
  assert.ok(cache.refreshResources[`nav:${CODE}`]);
  assert.ok(cache.refreshResources[`holdings:${CODE}`]);
  assert.ok(cache.refreshResources[`meta:${CODE}`]);
  const stable = structuredClone(Object.fromEntries(Object.entries(cache.refreshResources).filter(([key]) => /^(nav|holdings|meta):/.test(key))));
  const warm = await h.run('warm');
  assert.equal(warm.status, 'completed');
  assert.equal(h.calls.warm.nav || 0, 0);
  assert.equal(h.calls.warm.holdings || 0, 0);
  assert.equal(warm.result.diagnostics.cacheHits, 3);
  for (const [key, value] of Object.entries(stable)) assert.deepEqual(JSON.parse(h.storage.getItem(CACHE_KEY)).refreshResources[key], value);
});

test('cancelling while the automatic name edit waits for the origin lock cannot write or install it', async t => {
  const h = await fixture();
  t.after(() => h.cleanup());
  const before = h.app.hash();
  const cold = h.run('cold');
  await h.locked; h.coordinator.stop('synthetic cancelled generation');
  await h.release(); await cold; await tick();
  assert.equal(h.app.hash(), before);
  assert.equal(h.app.error(), '', 'A cancelled refresh tail cannot overwrite App error state');
  assert.equal(h.storage.getItem(CACHE_KEY), null);
  assert.equal(h.mutations.filter(row => row.key === CACHE_KEY && row.kind === 'set').length, 0);
});

for (const outcome of ['saved', 'conflict', 'failed']) {
  test(`late automatic-name ${outcome} result cannot replace newer App state after cancellation`, async t => {
    const h = await fixture({ holdResult: true, conflict: outcome === 'conflict', failure: outcome === 'failed' });
    t.after(() => h.cleanup());
    const cold = h.run('cold');
    await h.locked; await h.release();
    const result = await h.resultReady;
    assert.equal(outcome === 'saved' ? result.ok : result.reason,
      outcome === 'saved' ? true : outcome === 'conflict' ? 'edit_conflict' : 'backup_failed');
    h.coordinator.stop('newer App state wins');
    // Clear the injected storage failure before a separate user's valid edit.
    h.clearFailure();
    const newer = await h.externalEdit(30);
    h.app.install(newer);
    h.app.setError('synthetic newer error state');
    const expected = h.app.hash();
    h.releaseResult(); await cold; await tick();
    assert.equal(h.app.hash(), expected);
    assert.equal(h.app.holdings()[0].shares, 30);
    assert.equal(h.app.error(), 'synthetic newer error state');
  });
}

test('the real App runRefresh wires publication edits into the executor settlement hook', async () => {
  let body = functionText('runRefresh');
  const moduleImport = "import('./runtime/business-features.js')";
  assert.equal(body.split(moduleImport).length, 2);
  body = body.replace(moduleImport, 'loadBusiness()');
  const nameEdit = deferred();
  const holding = { code: CODE, name: CODE, shares: 10, cost: 1.2 };
  const context = { generation: 1, signal: new AbortController().signal, isCurrent: () => true,
    commit: operation => ({ committed: true, value: operation() }), recordDiagnostic() {} };
  let registered = false;
  const execution = { async executeRefreshPlan({ ui }) {
    assert.equal(typeof ui.settlePendingEdits, 'function');
    ui.publish(holding, { name: 'Synthetic 混合基金A' });
    assert.equal(registered, true);
    let done = false;
    const settlement = ui.settlePendingEdits().then(() => { done = true; });
    await tick();
    assert.equal(done, false, 'App closure must await the same promise supplied by its publisher');
    nameEdit.resolve();
    await settlement;
    return 'settled';
  } };
  const noop = () => {};
  const bindings = {
    requireCurrentRefresh: noop, detailRefreshGeneration: null, detailController: null,
    reconcileActiveFundState: noop, holdings: [holding], fundsData: [], updateFundStatus: noop,
    upsertFundData: noop, renderFundList: noop,
    loadBusiness: async () => execution, loadFundHoldingsFeature: async () => ({}),
    loadHoldingsEstimateFeature: async () => ({}), safeGetItem: () => null, CACHE_KEY,
    refreshDiagnostics: { observe: noop }, safeSetItem: noop,
    fetchRefreshEstimateRows: noop, fetchLatestNavMoveRaw: noop, normalizeTencentQuoteTime: noop,
    fetchSecurityEastmoney: noop, fetchSecurityBridge: noop, fetchGoldFromEastmoney: noop,
    updateLatestSourceSummary: noop, isRefreshAbort: () => false, tryShowCache: () => false,
    buildFundData: raw => ({ data: raw, fetchedName: raw.name }),
    commitRefreshedFund(actualContext, actualHolding, built, trackPendingEdit) {
      assert.equal(actualContext, context);
      assert.equal(actualHolding, holding);
      assert.equal(built.fetchedName, 'Synthetic 混合基金A');
      assert.equal(typeof trackPendingEdit, 'function');
      registered = true;
      trackPendingEdit(nameEdit.promise);
    },
  };
  const run = new Function(...Object.keys(bindings), body + '\nreturn runRefresh;')(...Object.values(bindings));
  try { assert.equal(await run(context, {}), 'settled'); }
  finally { nameEdit.resolve(); }
});
