import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import * as quoteNormalizer from '../js/runtime/quote-normalizer.js';
import * as quoteContract from '../js/runtime/quote-contract.js';
import { classifyMarketKind, classifyAssetKind } from '../js/runtime/market-session.js';
import { holdingQuoteAmounts } from '../js/runtime/holding-quote-amounts.js';

const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const program = parseSync('app.js', source).program;
const NOW = Date.parse('2026-09-30T02:07:00Z');
const CODE = '000001';
const NAME = '当前持仓基金';

function declaration(name) {
  const node = program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
  assert.ok(node, `The real app ${name} function must exist.`);
  return node;
}

function functionText(name) {
  const node = declaration(name);
  return source.slice(node.start, node.end);
}

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}

function quote(code = CODE) {
  return quoteContract.createQuoteEnvelope({
    fundCode: code, fundName: NAME, market: 'cn', assetKind: 'fund',
    valueKind: 'intraday_estimate', value: 2.2, changePct: 10,
    baseNav: 2, baseNavDate: '2026-09-29', targetDate: '2026-09-30',
    sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime',
    observedAt: '2026-09-30T02:05:00Z', fetchedAt: '2026-09-30T02:06:00Z',
    reasonCodes: [],
  }, { now: NOW });
}

function legacyRow(code = CODE) {
  return {
    code, name: '缓存基金名称', market: 'cn', assetKind: 'fund', shares: 999, cost: 888,
    last_nav: 2, nav_date: '2026-09-29', est_nav: 2.2, est_change: 10,
    est_time: '2026-09-30T02:05:00Z', source_time: '2026-09-30T02:05:00Z',
    est_kind: 'estimate', est_realtime: true, est_note: '合法旧格式估值说明',
    base_nav: 2, base_nav_date: '2026-09-29', value_date: '2026-09-30',
    source: 'sinan-estimate-proxy',
  };
}

function poisonedRow(extra = {}) {
  return {
    ...legacyRow(), quote: quote(),
    today_profit: 998, curr_value: 997, total_profit: 996, total_profit_rate: 995,
    primary_change: 994, primary_nav: 993, primary_base_nav: 992, primary_note: '旧金融说明',
    today_is_latest_nav: true,
    est_model: true, est_model_base_nav: 2, est_model_base_date: '2026-09-29',
    est_model_target_date: '2026-09-30', est_model_weight: 99, est_model_version: 'legacy-model',
    est_holdings_model: true, est_holdings_base_nav: 2, est_holdings_coverage: 99,
    est_holdings_base_date: '2026-09-29', est_holdings_target_date: '2026-09-30',
    latest_nav_move: { nav: 99, prevNav: 88, change: 12.5, date: '2026-09-30', prevDate: '2026-09-29' },
    secondary: { nav: 77, change: 66 }, secondary_quote: quote('000002'),
    secondary_nav: 55, secondary_change: 44, quoteCandidates: [quote('000002')],
    display: { nav: 33, change: 22, kind: 'official_nav', stale: false },
    ...extra,
  };
}

function holding(extra = {}) {
  return { code: CODE, name: NAME, shares: 10, cost: 1.5, ...extra };
}

function harness(rows, currentHoldings = [holding()]) {
  const cache = { data: rows, time: NOW - 30_000, fresh: true, expiresAt: NOW + 300_000 };
  const beforeCache = structuredClone(cache);
  const beforeHoldings = structuredClone(currentHoldings);
  const renders = [];
  const label = { textContent: '' };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  // These are the real imported algorithms. Only their clock option is supplied
  // explicitly: replacing the app's Date binding cannot replace an ES module's
  // Date binding, and a VM Date would also fail instanceof Date across realms.
  const dependencies = {
    ...quoteContract, ...quoteNormalizer,
    normalizeCachedQuote: (value, options) => quoteNormalizer.normalizeCachedQuote(value, { ...options, now: NOW }),
    buildFundQuoteCandidates: (value, options) => quoteNormalizer.buildFundQuoteCandidates(value, { ...options, now: NOW }),
    selectPreferredQuote: (values, identity, options) => quoteNormalizer.selectPreferredQuote(values, identity, { ...options, now: NOW }),
    unavailableQuote: (identity, options) => quoteContract.unavailableQuote(identity, { ...options, now: NOW }),
    createQuoteEnvelope: (value, options) => quoteContract.createQuoteEnvelope(value, { ...options, now: NOW }),
    classifyMarketKind, classifyAssetKind, holdingQuoteAmounts,
    Date: Clock, holdings: currentHoldings, fundsData: [], navigator: { onLine: true },
    loadCache: () => cache,
    renderFundList: values => renders.push(structuredClone(values)),
    document: { getElementById(id) { assert.equal(id, 'last-upd'); return label; } },
  };
  const app = new Function(...Object.keys(dependencies), [
    functionText('pad'), functionText('tryShowCache'),
    'return { run: tryShowCache, getFunds: () => fundsData };',
  ].join('\n'))(...Object.values(dependencies));
  assert.equal(app.run(), true);
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0], app.getFunds());
  assert.match(label.textContent, /^缓存数据 /);
  assert.deepEqual(cache, beforeCache, 'Displaying a cached row must not mutate or persist its source snapshot.');
  assert.deepEqual(currentHoldings, beforeHoldings, 'The current repository holdings must remain unchanged.');
  return app.getFunds();
}

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should equal ${expected}`);
}

function assertUsable(row, current = holding()) {
  assert.equal(row.quote.fundCode, row.code);
  assert.equal(row.quote.status, 'delayed');
  assert.equal(row.quote.cacheState, 'fresh');
  assert.equal(row.quote.value, 2.2);
  assert.equal(row.quote.baseNav, 2);
  assert.equal(row.quote.changePct, 10);
  assert.equal(row.primary_nav, 2.2);
  assert.equal(row.primary_change, 10);
  assert.equal(row.display.nav, 2.2);
  assert.equal(row.display.change, 10);
  assert.equal(row.shares, current.shares);
  assert.equal(row.cost, current.cost ?? null);
  approx(row.curr_value, current.shares * 2.2);
  if (current.shares > 0) approx(row.today_profit, current.shares * 0.2);
  else assert.equal(row.today_profit, null);
  if (current.shares > 0 && current.cost != null) approx(row.total_profit, current.shares * (2.2 - current.cost));
  else assert.equal(row.total_profit, null);
  assert.equal(row.quote.reasonCodes.includes('SOURCE_TIME_IN_FUTURE'), false);
  assert.equal(row.quote.reasonCodes.includes('SOURCE_DATE_IN_FUTURE'), false);
}

function assertIsolated(row, current = holding()) {
  assert.equal(row.code, current.code);
  assert.equal(row.quote.status, 'unavailable', 'A fund identity mismatch must never remain a usable NAV.');
  assert.equal(row.quote.fundCode, current.code);
  assert.ok(row.quote.reasonCodes.includes('CACHE_FUND_IDENTITY_MISMATCH'));
  for (const field of ['value', 'changePct', 'baseNav']) assert.equal(row.quote[field], null, `quote.${field}`);
  for (const field of ['primary_nav', 'primary_change', 'primary_base_nav', 'last_nav']) {
    assert.equal(Number.isFinite(row[field]), false, `The bad row must not expose ${field}.`);
  }
  assert.equal(row.display.nav, null);
  assert.equal(row.display.change, null);
  for (const field of ['today_profit', 'curr_value', 'total_profit', 'total_profit_rate']) {
    assert.equal(row[field], null, `The bad row must not expose ${field}.`);
  }
  assert.equal(row.period.periodKind, 'unavailable');
  assert.equal(row.period.profitAmount, null);
  assert.equal(row.period.isTodayEstimate, false);
  assert.equal(row.shares, current.shares);
  assert.equal(row.cost, current.cost ?? null);
  assert.equal(row.name, current.name);
  const residual = Object.keys(row).filter(key => /^est_|^secondary/.test(key)
    || ['latest_nav_move', 'source_quote', 'quoteCandidates', 'primary_note', 'nav_date', 'base_nav', 'base_nav_date', 'value_date'].includes(key));
  assert.deepEqual(residual, [], 'The complete bad snapshot must be isolated, not merely its chosen quote.');
}

test('aggregate cache display performs no Storage or repository write', () => {
  const forbidden = new Set(['saveCache', 'safeSetItem', 'safeRemoveItem', 'localStorage', 'sessionStorage',
    'indexedDB', 'withHoldingsLock', 'saveHoldingEdit', 'commitHoldingEdit']);
  const found = [];
  visit(declaration('tryShowCache'), node => {
    if (node.type === 'Identifier' && forbidden.has(node.name)) found.push(node.name);
  });
  assert.deepEqual(found, [], 'Cache rendering must not write to any persistence entry point.');
  assertUsable(harness([{ ...legacyRow(), quote: quote() }])[0]);
});

test('a matching cached quote retains NAV and period P/L and uses current repository shares/cost', () => {
  const current = holding({ shares: 12, cost: 1.7 });
  const row = harness([{ ...legacyRow(), quote: quote() }], [current])[0];
  assertUsable(row, current);
  assert.equal(row.name, '缓存基金名称');
});

test('matching quote and matching legacy source_quote remain usable', () => {
  assertUsable(harness([{ ...legacyRow(), quote: quote(), source_quote: quote() }])[0]);
});

test('raw legacy cached rows without either quote retain the real legacy adapter', () => {
  for (const extra of [{}, { quote: null, source_quote: null }]) {
    const row = harness([{ ...legacyRow(), ...extra }])[0];
    assertUsable(row);
    assert.equal(row.est_nav, 2.2);
    assert.equal(row.est_change, 10);
    assert.equal(row.est_note, '合法旧格式估值说明');
  }
});

test('a matching legacy nested source_quote still retains its identity and usable values', () => {
  assertUsable(harness([{ ...legacyRow(), source_quote: quote() }])[0]);
});

const invalidIdentities = [
  ['different fund', value => ({ ...value, fundCode: '000002' })],
  ['missing fundCode', value => { const copy = { ...value }; delete copy.fundCode; return copy; }],
  ['null fundCode', value => ({ ...value, fundCode: null })],
  ['numeric fundCode', value => ({ ...value, fundCode: 1 })],
  ['padded fundCode', value => ({ ...value, fundCode: ' 000001 ' })],
];

for (const [label, invalid] of invalidIdentities) {
  test(`a cached selected quote with ${label} isolates all NAV, secondary and profit fields`, () => {
    assertIsolated(harness([poisonedRow({ quote: invalid(quote()) })])[0]);
  });
  test(`a legacy nested source_quote with ${label} isolates the complete snapshot`, () => {
    const input = poisonedRow({ source_quote: invalid(quote()) });
    delete input.quote;
    assertIsolated(harness([input])[0]);
  });
  test(`a matching selected quote does not conceal a source_quote with ${label}`, () => {
    assertIsolated(harness([poisonedRow({ source_quote: invalid(quote()) })])[0]);
  });
}

test('one mismatched cache row does not erase matching or raw legacy rows in the same snapshot', () => {
  const current = [holding(), holding({ code: '000003', name: '另一当前基金', shares: 4, cost: 1.2 }),
    holding({ code: '000004', name: '第三当前基金', shares: 6, cost: 1.3 })];
  const rows = harness([
    { ...legacyRow(), quote: quote() },
    { ...poisonedRow(), code: '000003' },
    legacyRow('000004'),
  ], current);
  assert.equal(rows.length, 3);
  assertUsable(rows[0], current[0]);
  assertIsolated(rows[1], current[1]);
  assertUsable(rows[2], current[2]);
});

test('null/missing cost and zero shares survive identity isolation without inventing any profit', () => {
  const missingCost = holding();
  delete missingCost.cost;
  for (const current of [holding({ cost: null }), missingCost, holding({ shares: 0, cost: 0 })]) {
    assertIsolated(harness([poisonedRow({ quote: quote('000002') })], [current])[0], current);
  }
});

test('legal cache controls preserve null/missing cost and zero shares independently of identity isolation', () => {
  const missingCost = holding();
  delete missingCost.cost;
  for (const current of [holding({ cost: null }), missingCost, holding({ shares: 0, cost: 0 })]) {
    assertUsable(harness([{ ...legacyRow(), quote: quote() }], [current])[0], current);
  }
});
