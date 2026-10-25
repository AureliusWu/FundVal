import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsCenter } from '../js/runtime/diagnostics-ui.js';

const zero = { generation: 1, planned: 4, staged: 0, cacheHits: 0, deduped: 0, requests: 0,
  abortedRequests: 0, failedRequests: 0, cancelledResources: 0, writeAttempts: 0, cacheWrites: 0, providers: {} };
function harness(t, snapshot) {
  let writes = 0, copied;
  const content = { textContent: '', innerHTML: '' };
  const globals = { localStorage: { length: 0, getItem: () => null, setItem() { writes++; } },
    navigator: { onLine: true, clipboard: { writeText: async text => { copied = text; } } },
    window: {}, document: { getElementById: () => content } };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const center = createDiagnosticsCenter({ getHoldings: () => [], getHoldingsDocument: () => null,
    refreshCoordinator: { snapshot: () => ({}) }, getRefreshDiagnostics: () => snapshot, showToast() {},
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), now: () => 0 });
  return { center, content, writes: () => writes, copied: () => copied };
}

test('diagnostics distinguishes unobserved cancellation from observed true zero, including clipboard text', async t => {
  const record = { generation: 1, phase: 'final', status: 'cancelled', observed: false, counters: null, plan: null, skipReasons: null };
  const snapshot = { current: record, lastCancelled: record, lastSettled: null };
  const h = harness(t, snapshot);
  let summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /刷新诊断：第1代[^\n]*已取消[^\n]*observed=false/);
  assert.match(summary, /刷新请求：未观测/);
  assert.doesNotMatch(summary, /实际请求 0/);
  snapshot.current = { ...record, status: 'completed', observed: true, counters: zero,
    plan: [{ kind: 'indices', cache: 1, fetch: 0, skip: 0 }], skipReasons: { market_ineligible: 0, no_active_holdings: 2 } };
  summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /刷新诊断：第1代[^\n]*已完成[^\n]*observed=true/);
  assert.match(summary, /实际请求 0；缓存命中 0/);
  assert.match(summary, /刷新计划：indices cache=1 fetch=0 skip=0/);
  assert.match(summary, /最终报价：[^\n]*基金详情[^\n]*数据说明/);
  await h.center.copyDiagnosticsSummary();
  assert.equal(h.copied(), summary);
  assert.equal(h.writes(), 0);
});

test('running new generation keeps a clearly labelled older cancellation summary, without private payloads', async t => {
  const h = harness(t, { current: { generation: 2, status: 'running', observed: false, counters: null },
    lastCancelled: { generation: 1, status: 'cancelled', observed: true,
      counters: { ...zero, requests: 2, abortedRequests: 2, cancelledResources: 3 } } });
  const summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /刷新诊断：第2代[^\n]*执行中/);
  assert.match(summary, /最近取消代：第1代[^\n]*已取消[^\n]*已进入请求中止 2[^\n]*资源取消拒绝 3/);
  assert.doesNotMatch(summary, /取消资源数|请求全部取消/);
  assert.equal(h.writes(), 0);
});

test('plan reason view keeps missing distinct from ten measured zero counts and separates execution gates', async t => {
  const snapshot = { current: { generation: 1, status: 'completed', observed: true, counters: zero } };
  const h = harness(t, snapshot);
  let summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /计划原因：未观测/);
  snapshot.current.planReasons = { fresh_cache: 0, cache_miss: 2, cache_metadata_invalid: null,
    cache_quality_unusable: 0, cache_expired: 0, force_live: 0, force_stable: 0,
    market_ineligible: 0, phase_pending: 0, no_active_holdings: 2, code: '<PRIVATE>' };
  summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /计划原因：缓存新鲜 0；缓存缺失 2；元数据无效 未观测；缓存质量不可用 0；缓存过期 0；强制实时 0；强制稳定 0；市场不适用 0；阶段待定 0；无活动持仓 2；仅表示计划时决策；实际执行 gate 细因未记录/);
  assert.doesNotMatch(summary, /PRIVATE|TTL\/冷却等具体 fetch 原因未记录/);
  await h.center.copyDiagnosticsSummary();
  assert.equal(h.copied(), summary);
  assert.equal(h.writes(), 0);
});

test('execution skip view preserves missing, zero and null counts with fixed labels and read-only clipboard', async t => {
  const record = { generation: 1, status: 'completed', observed: true, counters: zero };
  const snapshot = { current: record };
  const h = harness(t, snapshot);
  let summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /执行跳过：未观测/);
  record.executionSkips = null;
  summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /执行跳过：未观测/);
  record.executionSkips = { estimate_claim_denied: 0, holdings_claim_denied: 2,
    holdings_probe_used: null, model_claim_denied: 0, model_probe_used: 3,
    code: '<PRIVATE>', payload: { token: '<PRIVATE>' } };
  summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /执行跳过：估值源拒绝 0；重仓源拒绝 2；重仓半开额度已用 未观测；模型源拒绝 0；模型半开额度已用 3；按门控检查次数统计，非请求或唯一资源数；拒绝细因未记录/);
  assert.ok(h.content.innerHTML.includes('估值源拒绝 0；重仓源拒绝 2；重仓半开额度已用 未观测'));
  assert.doesNotMatch(summary, /PRIVATE|唯一资源数 [0-9]|请求数 [0-9]/);
  await h.center.copyDiagnosticsSummary();
  assert.equal(h.copied(), summary);
  assert.equal(h.writes(), 0);
});

test('unobserved current execution skips are not filled from an older cancelled generation', async t => {
  const h = harness(t, { current: { generation: 2, status: 'running', observed: false,
    counters: null, executionSkips: null }, lastCancelled: { generation: 1, status: 'cancelled',
    observed: true, counters: zero, executionSkips: { estimate_claim_denied: 9, holdings_claim_denied: 9,
      holdings_probe_used: 9, model_claim_denied: 9, model_probe_used: 9 } } });
  const summary = await h.center.refreshDiagnosticsCenter();
  assert.match(summary, /刷新诊断：第2代[^\n]*执行中/);
  assert.match(summary, /执行跳过：未观测/);
  assert.doesNotMatch(summary, /估值源拒绝 9|重仓半开额度已用 9/);
  assert.equal(h.writes(), 0);
});

test('execution skip clipboard fallback is readonly and has no persistent writes', async t => {
  const h = harness(t, { current: { generation: 1, status: 'completed', observed: true,
    counters: zero, executionSkips: { estimate_claim_denied: 0, holdings_claim_denied: 0,
      holdings_probe_used: 0, model_claim_denied: 0, model_probe_used: 0 } } });
  const attributes = {}, actions = [];
  const area = { style: {}, setAttribute: (key, value) => { attributes[key] = value; },
    select: () => actions.push('select'), remove: () => actions.push('remove') };
  navigator.clipboard = undefined;
  document.createElement = tag => { assert.equal(tag, 'textarea'); return area; };
  document.body = { appendChild: element => { assert.strictEqual(element, area); actions.push('append'); } };
  document.execCommand = command => { assert.equal(command, 'copy'); actions.push('copy'); return true; };
  await h.center.copyDiagnosticsSummary();
  assert.equal(attributes.readonly, '');
  assert.deepEqual(actions, ['append', 'select', 'copy', 'remove']);
  assert.match(area.value, /执行跳过：估值源拒绝 0；重仓源拒绝 0；重仓半开额度已用 0；模型源拒绝 0；模型半开额度已用 0；按门控检查次数统计，非请求或唯一资源数；拒绝细因未记录/);
  assert.equal(h.writes(), 0);
});
