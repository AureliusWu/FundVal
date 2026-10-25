import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Real app/bootstrap/Bridge, synthetic inputs only. This suite is discovered by
// the existing Playwright configuration; it is not an opt-in Node test or a
// source-text assertion. The normal test:e2e build/server is owned by the caller.
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const FIXED_TIME = '2026-09-29T06:30:00.000Z'; // A supported CN trading day, 14:30.
const FUND_CACHE = 'fuyu_funds_cache_v1';
const HOLDINGS = [
  { code: '005844', name: '合成境内混合基金A', shares: 100, cost: 1.2, deleted: false, ts: 1790640000000 },
  { code: '008528', name: '合成境内混合基金B', shares: 100, cost: 1.2, deleted: false, ts: 1790640000000 },
];

function classifyRequest(url) {
  const path = url.pathname.replace(/^\/__fundval_dev/, '');
  if (url.hostname === 'api.github.com') return 'gist';
  if (path === '/estimates') return 'estimates';
  if (path === '/holdings') return 'holdings';
  if (url.hostname === 'fund.eastmoney.com' && /^\/pingzhongdata\/\d{6}\.js$/.test(path)) return 'nav';
  if (url.hostname === 'push2.eastmoney.com' && path.endsWith('/ulist.np/get')) return 'eastmoneySecurities';
  if (url.hostname === 'push2.eastmoney.com' && path.endsWith('/stock/get')) return 'gold';
  if (url.hostname === 'qt.gtimg.cn') return 'tencent';
  return url.origin === ORIGIN ? 'static' : 'blocked';
}

function estimateRow(code, value = 1.21) {
  return {
    code, name: HOLDINGS.find(row => row.code === code)?.name || '合成测试基金', type: '混合型',
    last_nav: 1.2, est_nav: value, est_change: (value / 1.2 - 1) * 100,
    nav_date: '2026-09-28', est_time: '2026-09-29 14:30:00', source_time: '2026-09-29 14:30:00',
    est_kind: 'estimate', est_realtime: true, status: 'ok', source: 'sinan-estimate-proxy',
  };
}

function tencentScript(url, omitCodes = [], modelChange = 1) {
  const codes = decodeURIComponent(url.pathname.match(/\/q=([^&]+)/)?.[1] || '').split(',')
    .filter(code => code && !omitCodes.includes(code));
  return codes.map(code => {
    const fields = Array(34).fill('');
    fields[1] = 'Synthetic security';
    fields[3] = '10.1'; fields[4] = '10';
    if (code === 'sh000300' && Number.isFinite(modelChange)) fields[3] = String(10 * (1 + modelChange / 100));
    // Tencent timestamps are exchange-local, not the request's China clock.
    // At CN 2026-09-29 14:30, the latest US close was Sep 28 16:00 EDT
    // (Sep 29 04:00 in China). Keep that actual source date/time visible.
    fields[30] = code.startsWith('us') ? '20260928160000' : '20260929143000';
    fields[32] = code === 'sh000300' ? Number.isFinite(modelChange) ? String(modelChange) : '' : '1';
    const variable = /^(?:kr|jp)/.test(code) ? `v_${code.slice(0, 2)}_${code.slice(2)}` : `v_${code}`;
    return `var ${variable}=${JSON.stringify(fields.join('~'))};`;
  }).join('\n');
}

async function installHarness(context, options = {}) {
  const state = {
    phase: 'cold', requests: [], gistWrites: [], failEstimates: Boolean(options.failEstimates),
    failAll: false, estimateValue: 1.21, estimateRequests: 0, heldEstimate: null, heldRequest: null,
    navPoints: options.navPoints,
  };
  const pending = new Set();
  const requestFacts = new WeakMap();
  let lastRequestAt = performance.now();

  context.on('request', request => {
    const url = new URL(request.url());
    const category = classifyRequest(url);
    pending.add(request);
    lastRequestAt = performance.now();
    requestFacts.set(request, { phase: state.phase, category, method: request.method(), startedAt: lastRequestAt });
    state.requests.push({ phase: state.phase, category, url: url.href, method: request.method() });
    if (category === 'gist' && !['GET', 'HEAD'].includes(request.method())) state.gistWrites.push(request.method());
  });
  const finished = request => { pending.delete(request); };
  context.on('requestfinished', finished);
  context.on('requestfailed', finished);

  await context.addInitScript(({ origin, time, rows, ignoreEstimateAbort }) => {
    const NativeDate = Date;
    const epoch = NativeDate.parse(time);
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [Math.floor(epoch + performance.now() + (globalThis.__refreshTestClockAdvance || 0))])); }
      static now() { return Math.floor(epoch + performance.now() + (globalThis.__refreshTestClockAdvance || 0)); }
    };
    // The real Bridge deliberately has an opaque origin and no storage access.
    if (window !== window.top || location.origin !== origin) return;
    const nativeSet = Storage.prototype.setItem;
    nativeSet.call(localStorage, 'fuyu_holdings_v1', JSON.stringify(rows));
    globalThis.__refreshTestPhase = 'cold';
    globalThis.__refreshTestWrites = [];
    Storage.prototype.setItem = function(key, value) {
      const result = nativeSet.call(this, key, value);
      if (this === localStorage && (key === 'fuyu_funds_cache_v1' || /^fuyu_nav_move_/.test(key) || key === 'fuyu_gold_cache_v2')) {
        globalThis.__refreshTestWrites.push({ key, value: String(value), phase: globalThis.__refreshTestPhase });
      }
      return result;
    };
    if (ignoreEstimateAbort) {
      // Deliberately non-cooperative provider: a late response must be rejected
      // by the real generation boundary even if transport ignores AbortSignal.
      const nativeFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname.replace(/^\/__fundval_dev/, '') !== '/estimates') return nativeFetch(input, init);
        const uncooperative = { ...init };
        delete uncooperative.signal;
        return nativeFetch(input, uncooperative);
      };
    }
  }, { origin: ORIGIN, time: FIXED_TIME, rows: options.rows || HOLDINGS.slice(0, 1), ignoreEstimateAbort: Boolean(options.holdFirstEstimate) });

  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const category = classifyRequest(url);
    const json = payload => route.fulfill({ contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload) });
    if (category === 'estimates') {
      state.estimateRequests += 1;
      const codes = (url.searchParams.get('codes') || '').split(',').filter(code => /^\d{6}$/.test(code));
      if (options.holdFirstEstimate && state.estimateRequests === 1 || state.holdNextEstimate) {
        state.holdNextEstimate = false;
        state.heldRequest = route.request();
        await new Promise(resolve => {
          state.heldEstimate = async () => {
            try { await json({ fetched_at: FIXED_TIME, items: codes.map(code => estimateRow(code, 9.99)) }); }
            catch (_) { /* A cooperative transport may already have cancelled. */ }
            finally { resolve(); }
          };
        });
        return;
      }
      if (state.failEstimates || state.failAll) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_unavailable"}' });
      return json({ fetched_at: FIXED_TIME, items: codes.map(code => estimateRow(code, state.estimateValue)) });
    }
    if (category === 'holdings') {
      if (state.failAll || options.failHoldings) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_unavailable"}' });
      return json({ report_date: '2026-06-30', fetched_at: FIXED_TIME, source: 'synthetic-refresh-fixture',
        items: Array.from({ length: 10 }, (_, i) => ({ code: String(i + 1).padStart(6, '0'), name: `合成股票${i + 1}`, ratio: 8, market: 'cn' })) });
    }
    if (category === 'nav') {
      if (state.failAll) return route.abort('failed');
      const code = url.pathname.match(/(\d{6})\.js$/)[1];
      const points = state.navPoints || [
        { x: Date.parse('2026-09-25T00:00:00+08:00'), y: 1.19 },
        { x: Date.parse('2026-09-28T00:00:00+08:00'), y: 1.2 },
      ];
      return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body:
        `var fS_code=${JSON.stringify(code)};var fS_name='合成测试基金';var Data_netWorthTrend=${JSON.stringify(points)};` });
    }
    if (category === 'eastmoneySecurities') {
      if (state.failAll) return route.abort('failed');
      const identities = (url.searchParams.get('secids') || '').split(',').map(secid => secid.split('.'));
      return json({ data: { diff: identities.map(([market, code]) => {
        // Explicit null/undefined are missing quotes, not the default +1%.
        const change = market === '1' && code === '000300' && Object.hasOwn(options, 'modelChange')
          ? options.modelChange : Object.hasOwn(options, 'securityChange') ? options.securityChange : 1;
        return { f12: code, f13: Number(market), f2: Number.isFinite(change) ? 10 * (1 + change / 100) : 10.1,
          f3: change, f124: Date.parse(FIXED_TIME) / 1000 };
      }) } });
    }
    if (category === 'gold') {
      if (state.failAll) return route.abort('failed');
      return json({ data: { f43: 900, f60: 890, f170: 1.12, f124: Date.parse(FIXED_TIME) / 1000 } });
    }
    if (category === 'tencent') {
      if (state.failAll) return route.abort('failed');
      return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: tencentScript(url, options.omitTencentCodes,
        Object.hasOwn(options, 'modelChange') ? options.modelChange : 1) });
    }
    if (category === 'static') return route.continue();
    // Never send any request to a live provider or a user's Gist.
    return route.abort('blockedbyclient');
  });

  async function ready(page) {
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await expect.poll(() => page.evaluate(() => window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration)).toBe('ok');
  }
  function belongsToAttachedFrame(request) {
    // Superseding a generation can remove its sandbox while Chromium is still
    // loading the document/runtime. Such requests need not emit a terminal
    // Playwright event. They cannot update the attached app and must not keep
    // its idle barrier open forever. Ambiguous ownership stays blocking.
    try { return !request.frame().isDetached(); } catch (_) { return true; }
  }
  async function settle(page, { allowHeld = false } = {}) {
    await ready(page);
    try {
      await expect.poll(() => [...pending].filter(belongsToAttachedFrame).every(request => allowHeld && request === state.heldRequest)
        && performance.now() - lastRequestAt >= 500, {
        timeout: 15_000, message: 'real refresh requests must settle without networkidle or fixed sleeps',
      }).toBe(true);
    } catch (error) {
      // Safe evidence only: no URLs, query strings, response bodies or storage.
      const facts = [...pending].map(request => {
        const { startedAt, ...safe } = requestFacts.get(request);
        let detachedFrame = null;
        try { detachedFrame = request.frame().isDetached(); } catch (_) {}
        return { ...safe, resourceType: request.resourceType(), held: request === state.heldRequest,
          detachedFrame, ageMs: Math.floor(performance.now() - startedAt) };
      });
      throw new Error(`${error.message}\nPending request categories: ${JSON.stringify(facts)}`);
    }
    await expect(page.locator('#fund-list .skeleton')).toHaveCount(0);
  }
  async function phase(page, name) {
    state.phase = name;
    await page.evaluate(value => { globalThis.__refreshTestPhase = value; }, name);
  }
  async function refresh(page, name = 'warm') {
    await phase(page, name);
    const before = state.estimateRequests;
    await page.evaluate(() => {
      const start = new Event('touchstart');
      Object.defineProperty(start, 'touches', { value: [{ clientY: 0 }] });
      window.dispatchEvent(start);
      const end = new Event('touchend');
      Object.defineProperty(end, 'changedTouches', { value: [{ clientY: 100 }] });
      window.dispatchEvent(end);
    });
    await expect.poll(() => state.estimateRequests).toBeGreaterThan(before);
    await settle(page);
  }
  const requests = (name, category) => state.requests.filter(row => row.phase === name && row.category === category);
  const writes = (page, name, key = FUND_CACHE) => page.evaluate(({ phaseName, storageKey }) =>
    globalThis.__refreshTestWrites.filter(row => row.phase === phaseName && row.key === storageKey), { phaseName: name, storageKey: key });
  return { state, ready, settle, phase, refresh, requests, writes };
}

function navValue(page, code = HOLDINGS[0].code) {
  return page.locator(`#fund-toggle-${code} .nav-cur`);
}

test('overseas accuracy automatically records enrichment, deduplicates warm refresh and settles published NAV', async ({ context, page, browser }, testInfo) => {
  const code = '110022';
  const harness = await installHarness(context, { failEstimates: true,
    rows: [{ ...HOLDINGS[0], code, name: '合成纳斯达克QDII基金A' }],
    navPoints: [{ x: Date.parse('2026-09-24T00:00:00+08:00'), y: 1.19 },
      { x: Date.parse('2026-09-25T00:00:00+08:00'), y: 1.2 }] });
  const read = () => page.evaluate(({ code, key }) => {
    const aggregate = JSON.parse(localStorage.getItem(key) || 'null');
    return { fund: aggregate?.data?.find(row => row.code === code),
      ledger: JSON.parse(localStorage.getItem('fuyu_overseas_accuracy_v1') || '[]').filter(row => row.code === code) };
  }, { code, key: FUND_CACHE });
  await page.goto('/'); await harness.settle(page);
  await expect.poll(async () => (await read()).fund?.quote?.sourceId).toBe('market-model');
  await expect(navValue(page, code)).toHaveText('1.2120');
  const cold = await read();
  expect(cold.fund.quote).toMatchObject({ valueKind: 'model_estimate', status: 'model', changePct: 1,
    baseNavDate: '2026-09-25', targetDate: '2026-09-28', modelVersion: 'rule-v1', confidence: 0.35 });
  await expect.poll(async () => (await read()).ledger.length).toBe(1);
  const predicted = (await read()).ledger;
  expect(predicted[0]).toMatchObject({ code, prediction_date: '2026-09-29', base_nav_date: '2026-09-25',
    target_nav_date: '2026-09-28', predicted_change: 1, model_version: 'rule-v1', confidence: 0.35,
    model_label: '纳指100代理', actual_change: null, error: null, direction_correct: null });

  await harness.refresh(page, 'accuracyWarm');
  expect((await read()).ledger, 'same date/version prediction cannot be duplicated or timestamp-renewed').toEqual(predicted);
  expect(harness.requests('accuracyWarm', 'nav'), 'warm prediction does not force the stable NAV resource').toHaveLength(0);

  // The next China day publishes the underlying Sep28 NAV. The unchanged US
  // fixture is then insufficient for a new Sep29 target and must not fabricate one.
  harness.state.navPoints = [{ x: Date.parse('2026-09-25T00:00:00+08:00'), y: 1.2 },
    { x: Date.parse('2026-09-28T00:00:00+08:00'), y: 1.224 }];
  await page.evaluate(() => { globalThis.__refreshTestClockAdvance = 24 * 60 * 60_000; });
  await harness.refresh(page, 'accuracySettlement');
  await expect.poll(async () => (await read()).ledger[0]?.actual_change).not.toBeNull();
  const settled = await read();
  expect(settled.ledger).toHaveLength(1);
  expect(settled.ledger[0].actual_change).toBeCloseTo(2, 10);
  expect(settled.ledger[0].error).toBeCloseTo(-1, 10);
  expect(settled.ledger[0].direction_correct).toBe(true);
  expect(settled.ledger[0].settled_at).toMatch(/^2026-09-30T/);
  expect(settled.fund.quote).toMatchObject({ valueKind: 'official_nav', value: 1.224, targetDate: '2026-09-28' });
  expect(harness.state.gistWrites).toEqual([]);
  expect(harness.state.requests.filter(row => row.category === 'gist')).toEqual([]);
  writeFileSync(testInfo.outputPath('actual-accuracy-lifecycle.json'), JSON.stringify({
    scope: 'synthetic real App/Bridge automatic prediction, warm dedup and next publication settlement; not real providers/devices',
    browser: browser.version(), cold, predicted, settled, noCloudWrites: true,
  }, null, 2) + '\n', { flag: 'wx' });
});

test('independent holdings and market models survive the real refresh, renderer and cache reload', async ({ context, page, browser }, testInfo) => {
  const row = { ...HOLDINGS[0], name: '合成沪深300指数基金' };
  const harness = await installHarness(context, { rows: [row], failEstimates: true, securityChange: 2, modelChange: 3 });
  await page.goto('/');
  await harness.settle(page);
  const cached = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).data[0], FUND_CACHE);
  await expect.poll(async () => (await cached())?.market_model_evidence?.changePct).toBe(3);
  const fund = await cached();
  expect(fund.holdings_model_evidence.fundCode).toBe(row.code);
  expect(fund.holdings_model_evidence.changePct).toBeCloseTo(1.6, 10);
  expect(fund.holdings_model_evidence.value).toBeCloseTo(1.2192, 10);
  expect(fund.holdings_model_evidence.coverage).toBe(80);
  expect(fund.market_model_evidence.value).toBeCloseTo(1.236, 10);
  expect(fund.market_model_evidence.coverage).toBe(100);
  expect(fund.quote.sourceId).toBe('market-model');
  expect(fund.quote.valueKind).toBe('model_estimate');
  expect(fund.quote.changePct).toBe(3);
  expect(fund.curr_value).toBeCloseTo(123.6, 8);
  expect(fund.today_profit).toBeCloseTo(3.6, 8);
  await expect(navValue(page)).toHaveText('1.2360');
  await page.locator(`#fund-toggle-${row.code}`).click();
  await expect(page.locator(`#fund-detail-${row.code}`)).toContainText('可用权重100.00%');
  await expect(page.locator(`#fund-detail-${row.code}`)).not.toContainText('覆盖净值80.0%');
  const identities = { quote: fund.quote, holdings: fund.holdings_model_evidence, market: fund.market_model_evidence };
  harness.state.failAll = true;
  harness.state.holdNextEstimate = true;
  await page.reload();
  await harness.ready(page);
  await expect.poll(() => Boolean(harness.state.heldEstimate)).toBe(true);
  try {
    // Hold the new primary acquisition so this observes the real cache restore,
    // not a later, legitimately different official/failed-refresh projection.
    await expect(navValue(page)).toHaveText('1.2360');
    const restored = await cached();
    expect(restored.holdings_model_evidence).toEqual(identities.holdings);
    expect(restored.market_model_evidence).toEqual(identities.market);
    expect(restored.quote.value).toBe(identities.quote.value);
    expect(restored.quote.fetchedAt).toBe(identities.quote.fetchedAt);
  } finally {
    await harness.state.heldEstimate();
    await harness.settle(page);
  }
  expect(harness.state.gistWrites).toEqual([]);
  await testInfo.attach('model-provenance-synthetic-refresh', { contentType: 'application/json', body: JSON.stringify({
    scope: 'local Chrome real app/Bridge/refresh/render/reload; synthetic providers only; not production/device proof',
    browser: browser.version(), holdings: identities.holdings, market: identities.market,
    selected: identities.quote, noCloudWrites: true,
  }) });
});

test('one generation shares official NAV between fallback and enrichment', async ({ context, page }) => {
  // Keep this case on official NAV: a successful holdings enrichment would
  // legitimately select today's model and make its visible quote time 14:30.
  const harness = await installHarness(context, { failEstimates: true, failHoldings: true, omitTencentCodes: ['sh000300'] });
  await page.goto('/');
  await harness.settle(page);
  await expect(navValue(page)).not.toHaveText('--');
  await expect(page.locator(`#fund-toggle-${HOLDINGS[0].code} .quote-time`)).toHaveText('2026-09-28');
  expect(harness.requests('cold', 'nav'), 'fallback and enrichment must acquire the same nav:code resource').toHaveLength(1);
  const index = name => page.locator('#index-bar-inner .index-item').filter({ hasText: name });
  await expect(index('上证').locator('.index-price')).toHaveText('10');
  await expect(index('上证').locator('.index-stale')).toHaveCount(0);
  await expect(index('沪深300').locator('.index-price')).toHaveText('--');
  for (const name of ['纳指100', '标普500']) {
    await expect(index(name).locator('.index-price')).toHaveText('10');
    await expect(index(name).locator('.index-stale')).toHaveText('旧');
  }
  const sourceTimes = await page.evaluate(key => {
    const cache = JSON.parse(localStorage.getItem(key));
    const entry = cache.refreshResources['indices:sh000001,sh000300,usINX,usNDX'];
    return entry?.payload.quotes.filter(row => row.code.startsWith('us')).map(row => row.observedAt);
  }, FUND_CACHE);
  expect(sourceTimes, 'US close timestamps must retain exchange-local conversion rather than use the refresh clock')
    .toEqual(['2026-09-29 04:00:00', '2026-09-29 04:00:00']);
  expect(harness.state.gistWrites).toEqual([]);
});

test('large official-only portfolio drains without overflowing the real Bridge queue', async ({ context, page }) => {
  const rows = Array.from({ length: 105 }, (_, index) => ({
    code: String(200000 + index), name: `合成日本基金${index}`, shares: 0, cost: null,
    deleted: false, ts: 1790640000000,
  }));
  const harness = await installHarness(context, { rows, failEstimates: true });
  await page.goto('/');
  await harness.settle(page);
  const navs = page.locator('#fund-list .nav-cur');
  await expect(navs).toHaveCount(rows.length);
  // A quiet network window can precede Bridge dispatch; await all exact NAVs.
  await expect(navs, 'All official fallbacks must survive parent-queue admission').toHaveText(rows.map(() => '1.2000'));
  const dates = page.locator('#fund-list .quote-time');
  expect(await dates.allTextContents(), 'Request completion must not turn the official NAV date into today').toEqual(rows.map(() => '2026-09-28'));
  expect(harness.requests('cold', 'nav')).toHaveLength(rows.length);
  expect(new Set(harness.requests('cold', 'nav').map(row => new URL(row.url).pathname)).size).toBe(rows.length);
  // Publishing every NAV precedes the generation's final metadata/cache flush.
  await expect.poll(async () => (await harness.writes(page, 'cold')).length, {
    message: 'All official fallbacks must reach the single final aggregate cache flush',
  }).toBe(1);
  const writes = await harness.writes(page, 'cold');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0].value).data).toHaveLength(rows.length);
  expect(harness.state.gistWrites).toEqual([]);
});

test('warm manual refresh respects stable holdings and official NAV TTL', async ({ context, page }) => {
  const harness = await installHarness(context);
  await page.goto('/');
  await harness.settle(page);
  expect(harness.requests('cold', 'holdings')).toHaveLength(1);
  expect(harness.requests('cold', 'nav')).toHaveLength(1);
  await harness.refresh(page);
  expect(harness.requests('warm', 'estimates')).toHaveLength(1);
  expect(harness.requests('warm', 'holdings'), 'ordinary force refresh must not bypass the 12-hour holdings TTL').toHaveLength(0);
  expect(harness.requests('warm', 'nav'), 'ordinary force refresh must not bypass the stable official-NAV TTL').toHaveLength(0);
  expect(harness.state.gistWrites).toEqual([]);
});

test('successful generation persists one aggregate fund cache and no legacy NAV/gold keys', async ({ context, page }) => {
  const harness = await installHarness(context, { rows: HOLDINGS });
  await page.goto('/');
  await harness.settle(page);
  for (const holding of HOLDINGS) await expect(navValue(page, holding.code)).not.toHaveText('--');
  const writes = await harness.writes(page, 'cold');
  expect(writes, 'primary and all enrichment commits share one aggregate cache flush').toHaveLength(1);
  const data = JSON.parse(writes[0].value).data;
  expect(data.map(row => row.code).sort()).toEqual(HOLDINGS.map(row => row.code).sort());
  const legacyWrites = await page.evaluate(() => globalThis.__refreshTestWrites.filter(row =>
    /^fuyu_nav_move_/.test(row.key) || row.key === 'fuyu_gold_cache_v2'));
  expect(legacyWrites, 'legacy NAV/gold cache entries are migration reads, not new write channels').toEqual([]);
  await harness.refresh(page);
  expect(await harness.writes(page, 'warm')).toHaveLength(1);
  expect(harness.state.gistWrites).toEqual([]);
});

test('two funds share one union securities batch instead of one batch per fund', async ({ context, page }) => {
  const harness = await installHarness(context, { rows: HOLDINGS });
  await page.goto('/');
  await harness.settle(page);
  expect(harness.requests('cold', 'holdings')).toHaveLength(2);
  const batches = harness.requests('cold', 'eastmoneySecurities');
  expect(batches, 'all active funds use one canonical securities union before provider batching').toHaveLength(1);
  expect(new URL(batches[0].url).searchParams.get('secids').split(',')).toHaveLength(10);
  expect(harness.state.gistWrites).toEqual([]);
});

test('a detail opened during refresh consumes the existing generation disclosure and quote union', async ({ context, page }) => {
  const harness = await installHarness(context, { holdFirstEstimate: true });
  await page.goto('/');
  await harness.ready(page);
  await expect.poll(() => typeof harness.state.heldEstimate).toBe('function');
  try {
    const toggle = page.locator(`#fund-toggle-${HOLDINGS[0].code}`);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await harness.settle(page, { allowHeld: true });
    expect(harness.requests('cold', 'holdings')).toHaveLength(1);
    expect(harness.requests('cold', 'eastmoneySecurities')).toHaveLength(1);
    await harness.phase(page, 'detailWaiting');
    await harness.state.heldEstimate();
    harness.state.heldEstimate = null;
    await harness.settle(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.holdings-table')).toContainText('合成股票1');
    expect(harness.requests('detailWaiting', 'holdings')).toHaveLength(0);
    expect(harness.requests('detailWaiting', 'eastmoneySecurities')).toHaveLength(0);
    expect(harness.requests('detailWaiting', 'tencent')).toHaveLength(0);
    expect(harness.state.gistWrites).toEqual([]);
  } finally {
    if (harness.state.heldEstimate) await harness.state.heldEstimate();
  }
});

test('all providers failing cannot renew the aggregate cache timestamp or bytes', async ({ context, page }) => {
  const harness = await installHarness(context);
  await page.goto('/');
  await harness.settle(page);
  const before = await page.evaluate(key => localStorage.getItem(key), FUND_CACHE);
  expect(before).not.toBeNull();
  harness.state.failAll = true;
  // Cache expiry is a clock rule, not an instruction to wait fifteen real minutes.
  await page.evaluate(() => { globalThis.__refreshTestClockAdvance = 15 * 60_000; });
  await harness.refresh(page, 'allFailed');
  expect(harness.requests('allFailed', 'estimates')).toHaveLength(1);
  expect(await harness.writes(page, 'allFailed'), 'failed/cached-only results must not receive a new fetchedAt/expiresAt').toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), FUND_CACHE)).toBe(before);
  expect(harness.state.gistWrites).toEqual([]);
});

test('warm details keep failed prior quotes visibly historical with their real clock, not today or zero', async ({ context, page }) => {
  const harness = await installHarness(context);
  await page.goto('/');
  await harness.settle(page);
  const toggle = page.locator(`#fund-toggle-${HOLDINGS[0].code}`);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await harness.settle(page);
  const clocks = page.locator('.stock-quote-time');
  await expect(clocks).toHaveCount(10);
  await expect(clocks.first()).toHaveText('最近行情 · 2026-09-29 14:30:00');
  await expect(page.locator('.holdings-row').first()).toContainText('+1.00%');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const cache = await page.evaluate(key => localStorage.getItem(key), FUND_CACHE);
  harness.state.failAll = true;
  await page.evaluate(() => { globalThis.__refreshTestClockAdvance = 24 * 60 * 60_000; });
  await harness.phase(page, 'oldDetail');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await harness.settle(page);
  await expect(clocks).toHaveCount(10);
  await expect(clocks.first()).toHaveText('旧行情 · 2026-09-29 14:30:00');
  await expect(page.locator('.holdings-row').first()).toContainText('+1.00%');
  expect(harness.requests('oldDetail', 'eastmoneySecurities')).toHaveLength(1);
  expect(harness.requests('oldDetail', 'tencent')).toHaveLength(1);
  expect(harness.requests('oldDetail', 'holdings')).toHaveLength(0);
  expect(harness.requests('oldDetail', 'nav')).toHaveLength(0);
  expect(await harness.writes(page, 'oldDetail')).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), FUND_CACHE)).toBe(cache);
  expect(harness.state.gistWrites).toEqual([]);
});

for (const [name, change, value, caption] of [
  ['zero', 0, '+0.00%', '最近行情 · 2026-09-29 14:30:00'],
  ['missing', null, '--', '行情暂不可用'],
]) test(`detail renderer distinguishes a genuine ${name} change without borrowing adjacent quotes`, async ({ context, page }) => {
  const harness = await installHarness(context, { securityChange: change,
    omitTencentCodes: Array.from({ length: 10 }, (_, i) => `sz${String(i + 1).padStart(6, '0')}`) });
  await page.goto('/');
  await harness.settle(page);
  await page.locator(`#fund-toggle-${HOLDINGS[0].code}`).click();
  await harness.settle(page);
  await expect(page.locator('.holdings-row')).toHaveCount(10);
  await expect(page.locator('.holdings-row').first().locator(':scope > span').nth(2)).toHaveText(value);
  await expect(page.locator('.stock-quote-time').first()).toHaveText(caption);
  expect(harness.state.gistWrites).toEqual([]);
});

test('a non-cooperative late response cannot overwrite the current generation UI or cache', async ({ context, page }) => {
  const harness = await installHarness(context, { holdFirstEstimate: true });
  await page.goto('/');
  await harness.ready(page);
  await expect.poll(() => typeof harness.state.heldEstimate).toBe('function');
  try {
    harness.state.estimateValue = 1.23;
    await harness.phase(page, 'current');
    // Online intentionally supersedes an active generation; pull-to-refresh is
    // correctly disabled while a refresh is active and cannot test this path.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => harness.state.estimateRequests).toBe(2);
    await expect(navValue(page)).toHaveText('1.2300');
    await harness.settle(page, { allowHeld: true });
    await harness.phase(page, 'late');
    await harness.state.heldEstimate();
    harness.state.heldEstimate = null;
    await harness.settle(page);
    await expect(navValue(page)).toHaveText('1.2300');
    expect(await harness.writes(page, 'late'), 'superseded results cannot persist after current generation commits').toEqual([]);
    const cache = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), FUND_CACHE);
    expect(cache.data.find(row => row.code === HOLDINGS[0].code).quote.value).toBe(1.23);
    expect(harness.state.gistWrites).toEqual([]);
  } finally {
    if (harness.state.heldEstimate) await harness.state.heldEstimate();
  }
});

test('refresh diagnostics reconcile real cold and warm requests without renewing data or loading private features', async ({ context, page }, testInfo) => {
  const harness = await installHarness(context);
  const dataCategories = ['estimates', 'holdings', 'nav', 'eastmoneySecurities', 'gold', 'tencent'];
  const requestCounts = phase => Object.fromEntries(dataCategories.map(category =>
    [category, harness.requests(phase, category).length]));
  const requestTotal = phase => Object.values(requestCounts(phase)).reduce((sum, value) => sum + value, 0);
  const diagnosticValue = label => page.locator('#diagnostics-content .diagnostics-row')
    .filter({ has: page.getByText(label, { exact: true }) }).locator('strong');
  const counter = async label => {
    const text = await diagnosticValue('刷新请求').innerText();
    const match = new RegExp(`${label}\\s*[:：=]?\\s*(\\d+)`).exec(text);
    expect(match, `structured refresh request summary must expose ${label}`).not.toBeNull();
    return Number(match[1]);
  };
  const planReasonLabels = ['缓存新鲜', '缓存缺失', '元数据无效', '缓存质量不可用', '缓存过期',
    '强制实时', '强制稳定', '市场不适用', '阶段待定', '无活动持仓'];
  const assertPlanReasons = async counts => {
    const row = diagnosticValue('计划原因');
    await expect(row, 'planning reasons must be visible in the real diagnostics center').toHaveCount(1);
    await expect(row).toBeVisible();
    await expect(row).toHaveText(planReasonLabels.map((label, index) => `${label} ${counts[index]}`)
      .concat('仅表示计划时决策；实际执行 gate 细因未记录').join('；'));
    return row.innerText();
  };
  const executionSkipLabels = ['估值源拒绝', '重仓源拒绝', '重仓半开额度已用', '模型源拒绝', '模型半开额度已用'];
  const assertExecutionSkips = async counts => {
    const row = diagnosticValue('执行跳过');
    await expect(row, 'execution gate observations must be visible in the real diagnostics center').toHaveCount(1);
    await expect(row).toBeVisible();
    await expect(row).toHaveText(executionSkipLabels.map((label, index) => `${label} ${counts[index]}`)
      .concat('按门控检查次数统计，非请求或唯一资源数；拒绝细因未记录').join('；'));
    return row.innerText();
  };
  const readCache = () => page.evaluate(key => {
    const raw = localStorage.getItem(key);
    const cache = raw && JSON.parse(raw);
    return { raw, holdingsHash: cache?.holdingsHash,
      stable: Object.fromEntries(Object.entries(cache?.refreshResources || {})
        .filter(([resource]) => /^(?:nav|holdings|meta):/.test(resource))) };
  }, FUND_CACHE);
  const openDiagnostics = async phase => {
    await harness.phase(page, phase);
    await page.locator('#nav-edit').click();
    await page.locator('#diagnostics-center > summary').click();
    await expect(page.locator('#diagnostics-center')).toHaveAttribute('open', '');
    await expect(diagnosticValue('刷新诊断'), 'completed refresh must be observable through the real diagnostics center').toHaveCount(1);
    await expect(diagnosticValue('刷新诊断')).toContainText(/completed|已完成/);
    await expect(diagnosticValue('刷新诊断')).toContainText(/observed\s*[:：=]?\s*true/i);
    await harness.settle(page);
  };
  const assertPrivateFeaturesAbsent = () => {
    expect(harness.state.requests.filter(row => row.category === 'gist'), 'diagnostics must not initiate even read-only Gist requests').toEqual([]);
    expect(harness.state.requests.filter(row => /(?:\/assets\/ocr\/|ocr-import\.html|paddle|tesseract|\.wasm(?:$|\?))/i.test(row.url)),
      'opening or refreshing diagnostics must not load OCR assets or an OCR document').toEqual([]);
    expect(harness.state.gistWrites).toEqual([]);
  };

  await page.goto('/');
  await harness.settle(page);
  await expect(navValue(page)).not.toHaveText('--');
  const cold = await readCache();
  expect(cold.raw).not.toBeNull();
  expect(typeof cold.holdingsHash).toBe('string');
  expect(Object.keys(cold.stable)).toHaveLength(3);
  expect(harness.requests('cold', 'holdings')).toHaveLength(1);
  expect(harness.requests('cold', 'nav')).toHaveLength(1);
  const coldRequests = requestCounts('cold');
  await testInfo.attach('cold-refresh-network-categories', {
    contentType: 'application/json', body: JSON.stringify({ scope: 'real app and opaque Bridge; synthetic network only', counts: coldRequests }),
  });
  await openDiagnostics('coldDiagnostics');
  expect(await counter('实际请求')).toBe(requestTotal('cold'));
  expect(await counter('已进入请求中止')).toBe(0);
  expect(await counter('资源取消拒绝')).toBe(0);
  expect(await counter('写尝试')).toBe(1);
  expect(await counter('缓存写入')).toBe(1);
  await expect(diagnosticValue('刷新计划')).toContainText(/estimates/);
  await expect(diagnosticValue('刷新计划')).toContainText(/fetch/);
  // Startup forces the three volatile resources. The three stable resources
  // miss their cache; the two phase-B resources remain pending at plan time.
  const coldPlanReasons = await assertPlanReasons([0, 3, 0, 0, 0, 3, 0, 0, 2, 0]);
  const coldExecutionSkips = await assertExecutionSkips([0, 0, 0, 0, 0]);
  await expect(diagnosticValue('请求来源')).toContainText('sinan-estimate-proxy');
  await expect(diagnosticValue('最终报价')).toContainText(/基金详情.*数据说明/);
  expect(await readCache(), 'reading diagnostics must preserve all cache acquisition bytes and holdings identity').toEqual(cold);
  expect(requestTotal('coldDiagnostics')).toBe(0);
  expect(await harness.writes(page, 'coldDiagnostics')).toEqual([]);
  assertPrivateFeaturesAbsent();

  await page.locator('#diagnostics-center > summary').click();
  await page.locator('#nav-market').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await harness.refresh(page);
  expect(harness.requests('warm', 'holdings')).toHaveLength(0);
  expect(harness.requests('warm', 'nav')).toHaveLength(0);
  const warm = await readCache();
  expect(warm.holdingsHash).toBe(cold.holdingsHash);
  expect(warm.stable, 'warm refresh cannot renew NAV, disclosure or metadata acquisition envelopes').toEqual(cold.stable);
  await openDiagnostics('warmDiagnostics');
  expect(await counter('实际请求')).toBe(requestTotal('warm'));
  expect(await counter('缓存命中')).toBeGreaterThan(0);
  expect(await counter('已进入请求中止')).toBe(0);
  expect(await counter('资源取消拒绝')).toBe(0);
  expect(await counter('写尝试')).toBe(1);
  expect(await counter('缓存写入')).toBe(1);
  await expect(diagnosticValue('刷新计划')).toContainText(/cache/);
  await expect(diagnosticValue('跳过原因')).not.toBeEmpty();
  // A warm manual refresh still forces live data; only NAV, disclosure and
  // metadata become fresh-cache decisions, without renewing their envelopes.
  const warmPlanReasons = await assertPlanReasons([3, 0, 0, 0, 0, 3, 0, 0, 2, 0]);
  const warmExecutionSkips = await assertExecutionSkips([0, 0, 0, 0, 0]);
  const summary = (await Promise.all(['刷新诊断', '刷新计划', '计划原因', '执行跳过', '刷新请求', '跳过原因', '请求来源', '最终报价']
    .map(label => diagnosticValue(label).innerText()))).join('\n');
  expect(summary).not.toMatch(/005844|合成境内混合基金A|ghp_|Authorization|https?:|source_quote|baseNav|shares|cost/);
  expect(await readCache(), 'opening warm diagnostics must not change aggregate dates, hash or stored data').toEqual(warm);
  expect(requestTotal('warmDiagnostics')).toBe(0);
  expect(await harness.writes(page, 'warmDiagnostics')).toEqual([]);
  assertPrivateFeaturesAbsent();
  await testInfo.attach('refresh-diagnostics-cold-warm', {
    contentType: 'application/json', body: JSON.stringify({ scope: 'synthetic completed generations only; no cancellation or production acceptance',
      cold: coldRequests, warm: requestCounts('warm'), coldPlanReasons, warmPlanReasons,
      coldExecutionSkips, warmExecutionSkips, summary }),
  });
});

test('refresh diagnostics observe a real estimate source gate rejection without requesting or renewing official NAV', async ({ context, page }, testInfo) => {
  // Keep disclosure acquisition healthy, but leave its securities unpriced so
  // neither holdings enrichment nor the model's index leg replaces official NAV.
  const harness = await installHarness(context, { failEstimates: true, securityChange: null,
    omitTencentCodes: ['sh000300', ...Array.from({ length: 10 }, (_, i) => `sz${String(i + 1).padStart(6, '0')}`)] });
  await context.addInitScript(origin => {
    if (window !== window.top || location.origin !== origin) return;
    globalThis.__diagnosticsStorageMutations = [];
    for (const method of ['setItem', 'removeItem', 'clear']) {
      const native = Storage.prototype[method];
      Storage.prototype[method] = function(...args) {
        const result = native.apply(this, args);
        if (this === localStorage) globalThis.__diagnosticsStorageMutations.push({ method, phase: globalThis.__refreshTestPhase });
        return result;
      };
    }
  }, ORIGIN);
  const diagnosticValue = label => page.locator('#diagnostics-content .diagnostics-row')
    .filter({ has: page.getByText(label, { exact: true }) }).locator('strong');
  const refreshDiagnostics = () => page.getByRole('button', { name: '刷新诊断', exact: true }).click();
  const dataCategories = ['estimates', 'holdings', 'nav', 'eastmoneySecurities', 'gold', 'tencent'];
  const requestCounts = phase => Object.fromEntries(dataCategories.map(category =>
    [category, harness.requests(phase, category).length]));
  const readCache = () => page.evaluate(({ key, code }) => {
    const raw = localStorage.getItem(key);
    const cache = raw && JSON.parse(raw);
    const quote = cache?.data?.find(row => row.code === code)?.quote;
    return { raw, holdingsHash: cache?.holdingsHash,
      stable: Object.fromEntries(Object.entries(cache?.refreshResources || {})
        .filter(([resource]) => /^(?:nav|holdings|meta):/.test(resource))),
      official: quote && { value: quote.value, valueKind: quote.valueKind, baseNav: quote.baseNav,
        baseNavDate: quote.baseNavDate, targetDate: quote.targetDate, officialNavDate: quote.officialNavDate } };
  }, { key: FUND_CACHE, code: HOLDINGS[0].code });
  const assertOfficialNav = async () => {
    const row = page.locator(`#fund-toggle-${HOLDINGS[0].code}`);
    await expect(row.locator('.nav-cur')).toHaveText('1.2000');
    await expect(row.locator('.nav-prev')).toHaveText('1.1900');
    await expect(row.locator('.fund-pct')).toHaveText('+0.84%');
    await expect(row.locator('.quote-kind')).toHaveText('最新净值涨跌');
    await expect(row.locator('.quote-time')).toHaveText('2026-09-28');
    expect((await readCache()).official).toEqual({ value: 1.2, valueKind: 'official_nav', baseNav: 1.19,
      baseNavDate: '2026-09-25', targetDate: '2026-09-28', officialNavDate: '2026-09-28' });
  };

  await page.goto('/');
  await harness.settle(page);
  await assertOfficialNav();
  const cold = await readCache();
  expect(harness.requests('cold', 'estimates')).toHaveLength(1);
  expect(harness.requests('cold', 'nav')).toHaveLength(1);
  for (const phase of ['secondFailure', 'thirdFailure']) {
    await harness.refresh(page, phase);
    expect(harness.requests(phase, 'estimates')).toHaveLength(1);
    expect(harness.requests(phase, 'nav')).toHaveLength(0);
    expect(harness.requests(phase, 'holdings')).toHaveLength(0);
    await assertOfficialNav();
  }
  expect(harness.state.estimateRequests, 'three real failures must reach the unchanged default circuit threshold').toBe(3);
  const beforeDenied = await readCache();
  expect(beforeDenied.stable, 'failed estimates cannot renew official NAV, metadata or disclosure acquisition dates').toEqual(cold.stable);
  expect(beforeDenied.holdingsHash).toBe(cold.holdingsHash);

  // Public diagnostics expose the real third-generation cooldown; do not read
  // or mutate the private coordinator, registry, observer or source policy.
  await harness.phase(page, 'thresholdDiagnostics');
  await page.locator('#nav-edit').click();
  await page.locator('#diagnostics-center > summary').click();
  await expect(diagnosticValue('刷新诊断')).toHaveText('第3代 / 已完成 / observed=true');
  await expect(diagnosticValue('数据源健康')).toContainText('sinan-estimate-proxy cooldown / 连续失败 3');
  await harness.settle(page);

  // The existing online handler starts generation four. Unlike manual helper
  // refresh(), this path must not wait for an estimate request that is denied.
  await harness.phase(page, 'sourceDenied');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => {
    await refreshDiagnostics();
    return diagnosticValue('刷新诊断').innerText();
  }, { message: 'the real online generation must complete through public diagnostics' })
    .toBe('第4代 / 已完成 / observed=true');
  await harness.settle(page);
  expect(harness.state.estimateRequests).toBe(3);
  expect(harness.requests('sourceDenied', 'estimates'), 'a denied estimate claim is not a dispatched network request').toHaveLength(0);
  expect(harness.requests('sourceDenied', 'nav')).toHaveLength(0);
  expect(harness.requests('sourceDenied', 'holdings')).toHaveLength(0);
  const executionSkips = { estimate_claim_denied: 1, holdings_claim_denied: 0, holdings_probe_used: 0,
    model_claim_denied: 0, model_probe_used: 0 };
  await expect(diagnosticValue('执行跳过')).toHaveText('估值源拒绝 1；重仓源拒绝 0；重仓半开额度已用 0；模型源拒绝 0；模型半开额度已用 0；按门控检查次数统计，非请求或唯一资源数；拒绝细因未记录');
  await expect(diagnosticValue('请求来源')).not.toContainText(/sinan-estimate-proxy=[1-9]\d*/);
  await assertOfficialNav();
  const denied = await readCache();
  expect(denied.stable).toEqual(beforeDenied.stable);
  expect(denied.official).toEqual(beforeDenied.official);
  expect(denied.holdingsHash).toBe(beforeDenied.holdingsHash);

  // Once completed, re-reading diagnostics must be entirely read-only across
  // every request category and every localStorage mutation API, not only Gist.
  await harness.phase(page, 'deniedDiagnostics');
  const requestsBeforeRead = harness.state.requests.length;
  const storageBeforeRead = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  await refreshDiagnostics();
  await expect(diagnosticValue('刷新诊断')).toHaveText('第4代 / 已完成 / observed=true');
  await harness.settle(page);
  expect(harness.state.requests.length).toBe(requestsBeforeRead);
  expect(await harness.writes(page, 'deniedDiagnostics')).toEqual([]);
  expect(await page.evaluate(() => globalThis.__diagnosticsStorageMutations
    .filter(row => row.phase === 'deniedDiagnostics'))).toEqual([]);
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(storageBeforeRead);
  expect(await readCache()).toEqual(denied);
  expect(harness.state.requests.filter(row => row.category === 'gist')).toEqual([]);
  expect(harness.state.requests.filter(row => /(?:\/assets\/ocr\/|ocr-import\.html|paddle|tesseract|\.wasm(?:$|\?))/i.test(row.url))).toEqual([]);
  expect(harness.state.gistWrites).toEqual([]);
  const summary = (await Promise.all(['刷新诊断', '执行跳过', '刷新请求', '请求来源', '最终报价']
    .map(label => diagnosticValue(label).innerText()))).join('\n');
  expect(summary).not.toMatch(/005844|合成境内混合基金A|ghp_|Authorization|https?:|source_quote|baseNav|shares|cost/);
  await testInfo.attach('refresh-diagnostics-real-source-gate-denied', {
    contentType: 'application/json', body: JSON.stringify({ scope: 'real default source-health cooldown and public online handler; synthetic network only; no half-open or production acceptance',
      completedGeneration: 4, executionSkips, cold: requestCounts('cold'), secondFailure: requestCounts('secondFailure'),
      thirdFailure: requestCounts('thirdFailure'), sourceDenied: requestCounts('sourceDenied'), summary }),
  });
});
