import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsCenter } from '../js/runtime/diagnostics-ui.js';
import { marketClock } from '../js/runtime/market-clock.js';

const ROW_LABELS = ['应用版本', 'Service Worker', '网络', '最近启动自检', '持仓 Schema', '最近本地备份',
  '最后完整刷新', '数据源健康', '当前市场', '本地缓存条目', 'OCR 能力', 'OCR 账本条目', '运行错误条目'];
const LABELS = { open: '交易中', break: '休市中', preopen: '盘前', closed: '已收盘', holiday: '节假日', unknown: '未知' };
const SNAPSHOT = { lastCompleted: { completedAt: '2026-09-29T06:00:00Z', trigger: 'timer' },
  sourceRegistry: { sources: [{ descriptor: { id: 'eastmoney-official-nav' },
    health: { status: 'cooldown', consecutiveFailures: 2, lastResponseMs: 300 } }] } };

function harness(t, { holdings = [], now, online = true, storageFails = false } = {}) {
  const values = new Map([['fuyu_funds_cache_v1', JSON.stringify({ fetchedAt: 1, expiresAt: 2, source: 'fund-estimate', data: [] })]]);
  let writes = 0;
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem(key) { if (storageFails) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem() { writes++; }, removeItem() { writes++; } };
  const content = { textContent: '', innerHTML: '' };
  const globals = {
    localStorage: storage,
    navigator: { onLine: online, serviceWorker: null },
    window: { __FUNDVAL_BOOTSTRAP_STATUS__: { migration: 'ok', integrity: 'ok', cacheRepaired: false } },
    document: { getElementById: id => id === 'diagnostics-content' ? content : null },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const center = createDiagnosticsCenter({ getHoldings: () => holdings, getHoldingsDocument: () => ({ schema: 3 }),
    refreshCoordinator: { snapshot: () => structuredClone(SNAPSHOT) }, showToast() {}, esc: String,
    ...(now ? { now } : {}) });
  return { center, content, values, writes: () => writes };
}

function assertMarket(summary, market, timestamp) {
  const clock = marketClock(market, timestamp);
  assert.ok(summary.includes(`${market} ${LABELS[clock.marketState]}`), summary);
  return clock;
}

test('characterization: diagnostic row names, source health and old acquisition times remain read-only', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T02:00:00Z') });
  const view = harness(t);
  const before = structuredClone([...view.values]);
  const summary = await view.center.refreshDiagnosticsCenter();
  assert.deepEqual(summary.split('\n').slice(1, -1).map(line => line.split('：')[0]), ROW_LABELS);
  assert.match(summary, /持仓 Schema：Schema 3/);
  assert.match(summary, /数据源健康：eastmoney-official-nav cooldown \/ 连续失败 2 \/ 300ms/);
  assert.match(summary, /最后完整刷新：[^\n]*2026[^\n]*09[^\n]*29[^\n]* \/ timer/);
  assert.match(summary, /当前市场：cn 交易中/);
  assert.match(summary, /最近脱敏错误：无$/);
  assert.match(view.content.innerHTML, /class="diagnostics-grid"/);
  assert.equal(view.writes(), 0);
  assert.deepEqual([...view.values], before);
});

test('diagnostics uses the same verified mainland holiday as the home market clock', async t => {
  const at = Date.parse('2026-10-01T02:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const view = harness(t);
  const summary = await view.center.refreshDiagnosticsCenter();
  const clock = assertMarket(summary, 'cn', at);
  assert.equal(clock.calendarStatus, 'valid');
  assert.equal(clock.marketState, 'holiday');
  assert.equal(clock.isTradingDay, false);
  assert.doesNotMatch(summary, /当前市场：cn 交易中/);
  assert.equal(view.writes(), 0);
});

test('expired 2027 and missing exchange calendars cannot claim verified open sessions', async t => {
  const at = Date.parse('2027-01-04T02:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const view = harness(t, { holdings: [
    { name: 'Synthetic mainland mixed fund' }, { name: '恒生指数' }, { name: '日经指数' }, { name: '韩国指数' },
  ] });
  const summary = await view.center.refreshDiagnosticsCenter();
  assert.match(summary, /当前市场：cn 未知；hk 未知；jp 未知；kr 未知/);
  for (const market of ['cn', 'hk', 'jp', 'kr']) {
    const clock = assertMarket(summary, market, at);
    assert.equal(clock.calendarStatus, 'unverified');
    assert.equal(clock.isTradingDay, null);
    assert.ok(clock.reasonCodes.includes('MARKET_CALENDAR_UNVERIFIED'));
  }
  assert.equal(view.writes(), 0);
});

test('injected clock is read once per diagnosis and reused across all classified markets', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-27T23:30:00Z') });
  let at = Date.parse('2026-08-25T13:30:00Z'), calls = 0;
  const view = harness(t, { holdings: [{ name: '标普500指数' }, { name: '日经指数' },
    { name: 'Synthetic mainland mixed fund' }, { name: '黄金ETF' }, { name: '恒生指数', deleted: true }],
  now: () => { calls++; return at; } });
  const first = await view.center.refreshDiagnosticsCenter();
  assert.equal(calls, 1);
  assert.match(first, /当前市场：cn 已收盘；gold 未知；jp 已收盘；us 交易中/);
  for (const market of ['cn', 'gold', 'jp', 'us']) assertMarket(first, market, at);
  at = Date.parse('2026-11-27T18:00:00Z');
  const second = await view.center.refreshDiagnosticsCenter();
  assert.equal(calls, 2);
  assertMarket(second, 'us', at);
  assert.match(second, /us 已收盘/);
  assert.equal(view.writes(), 0);
});

test('injected invalid clock remains unknown instead of using host wall time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T02:00:00Z') });
  const view = harness(t, { now: () => NaN });
  const summary = await view.center.refreshDiagnosticsCenter();
  assert.match(summary, /当前市场：cn 未知/);
  assert.equal(view.writes(), 0);
});

test('unverified diagnostics does not renew offline caches or revive stale source health', async t => {
  const at = Date.parse('2027-01-04T02:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const view = harness(t, { now: () => at, online: false, storageFails: true });
  const summary = await view.center.refreshDiagnosticsCenter();
  assert.match(summary, /网络：离线（缓存一律按旧数据处理）/);
  assert.match(summary, /当前市场：cn 未知/);
  assert.match(summary, /eastmoney-official-nav cooldown/);
  assert.equal(view.writes(), 0);
});
