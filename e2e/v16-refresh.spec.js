import { expect, test } from '@playwright/test';

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

function tencentScript(url, omitCodes = []) {
  const codes = decodeURIComponent(url.pathname.match(/\/q=([^&]+)/)?.[1] || '').split(',')
    .filter(code => code && !omitCodes.includes(code));
  return codes.map(code => {
    const fields = Array(34).fill('');
    fields[1] = 'Synthetic security';
    fields[3] = '10.1'; fields[4] = '10';
    // Tencent timestamps are exchange-local, not the request's China clock.
    // At CN 2026-09-29 14:30, the latest US close was Sep 28 16:00 EDT
    // (Sep 29 04:00 in China). Keep that actual source date/time visible.
    fields[30] = code.startsWith('us') ? '20260928160000' : '20260929143000';
    fields[32] = '1';
    const variable = /^(?:kr|jp)/.test(code) ? `v_${code.slice(0, 2)}_${code.slice(2)}` : `v_${code}`;
    return `var ${variable}=${JSON.stringify(fields.join('~'))};`;
  }).join('\n');
}

async function installHarness(context, options = {}) {
  const state = {
    phase: 'cold', requests: [], gistWrites: [], failEstimates: Boolean(options.failEstimates),
    failAll: false, estimateValue: 1.21, estimateRequests: 0, heldEstimate: null, heldRequest: null,
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
      if (options.holdFirstEstimate && state.estimateRequests === 1) {
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
      const points = [
        { x: Date.parse('2026-09-25T00:00:00+08:00'), y: 1.19 },
        { x: Date.parse('2026-09-28T00:00:00+08:00'), y: 1.2 },
      ];
      return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body:
        `var fS_code=${JSON.stringify(code)};var fS_name='合成测试基金';var Data_netWorthTrend=${JSON.stringify(points)};` });
    }
    if (category === 'eastmoneySecurities') {
      if (state.failAll) return route.abort('failed');
      const identities = (url.searchParams.get('secids') || '').split(',').map(secid => secid.split('.'));
      return json({ data: { diff: identities.map(([market, code]) => ({ f12: code, f13: Number(market),
        f2: 10.1, f3: 1, f124: Date.parse(FIXED_TIME) / 1000 })) } });
    }
    if (category === 'gold') {
      if (state.failAll) return route.abort('failed');
      return json({ data: { f43: 900, f60: 890, f170: 1.12, f124: Date.parse(FIXED_TIME) / 1000 } });
    }
    if (category === 'tencent') {
      if (state.failAll) return route.abort('failed');
      return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: tencentScript(url, options.omitTencentCodes) });
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
