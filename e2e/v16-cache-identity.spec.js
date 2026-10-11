import { expect, test } from '@playwright/test';
import { canonicalHoldingsDocument, normalizeHoldingsDocumentV3, stableHoldingId, toLegacyHoldings } from '../js/storage/holdings-schema.js';
import { createQuoteEnvelope } from '../js/runtime/quote-contract.js';

// Browser storage here belongs only to disposable Playwright contexts. No
// screenshots, personal holdings, Gist credentials or live providers are used.
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const NOW = Date.parse('2026-09-30T06:00:00Z');
const CACHE_KEY = 'fuyu_funds_cache_v1';
const DEVICE = 'synthetic-cache-identity-device';
const TIME = '2026-09-30T05:00:00.000Z';
const CODES = ['005844', '000003', '000004'];
const document = normalizeHoldingsDocumentV3({
  schema: 3, deviceId: DEVICE, updatedAt: TIME,
  holdings: CODES.map(code => ({
    id: stableHoldingId(code), fundCode: code, fundName: `合成境内基金 ${code}`,
    shares: 10, costNav: 1.5, createdAt: TIME, updatedAt: TIME,
    deletedAt: null, revision: 1, deviceId: DEVICE, note: null,
  })),
});

function quote(code, value = 2.2, base = 2) {
  return createQuoteEnvelope({
    fundCode: code, fundName: `合成境内基金 ${code}`, market: 'cn', assetKind: 'fund',
    valueKind: 'intraday_estimate', value, changePct: 10, baseNav: base,
    baseNavDate: '2026-09-29', targetDate: '2026-09-30',
    sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime',
    observedAt: '2026-09-30T05:59:00Z', fetchedAt: '2026-09-30T05:59:30Z',
    reasonCodes: [],
  }, { now: NOW });
}

function legacy(code) {
  return {
    code, name: `合成境内基金 ${code}`, shares: 999, cost: 888,
    status: 'ok', last_nav: 2, est_nav: 2.2, est_change: 10, primary_base_nav: 2,
    nav_date: '2026-09-29', value_date: '2026-09-30', base_nav_date: '2026-09-29',
    est_time: '2026-09-30T05:59:00Z', source_time: '2026-09-30T05:59:00Z',
    est_kind: 'estimate', est_realtime: true, source: 'sinan-estimate-proxy',
  };
}

async function openCachedPage(context, page, mode) {
  const bad = {
    ...legacy(CODES[0]), quote: quote(CODES[0], 999.1234, 888.1234),
    primary_base_nav: 888.1234, est_nav: 999.1234, est_change: 77.7,
    est_note: '外来金融说明', latest_nav_move: {
      nav: 999.1234, prevNav: 888.1234, change: 77.7, date: '2026-09-30', prevDate: '2026-09-29',
    },
  };
  if (mode === 'different') bad.quote = { ...bad.quote, fundCode: '000002' };
  else if (mode === 'missing') {
    bad.quote = { ...bad.quote };
    delete bad.quote.fundCode;
  } else if (mode === 'nested') bad.source_quote = quote('000002');
  const rows = mode === 'matching'
    ? [{ ...legacy(CODES[0]), quote: quote(CODES[0]) }]
    : [bad];
  rows.push({ ...legacy(CODES[1]), quote: quote(CODES[1]) }, legacy(CODES[2]));
  const cache = JSON.stringify({
    data: rows, fetchedAt: NOW - 30000, expiresAt: NOW + 300000,
    holdingsHash: canonicalHoldingsDocument(document),
  });
  const entries = {
    fuyu_device_id_v1: DEVICE,
    fuyu_holdings_v3: canonicalHoldingsDocument(document),
    fuyu_holdings_v1: JSON.stringify(toLegacyHoldings(document)),
    [CACHE_KEY]: cache,
  };
  await page.clock.setFixedTime(new Date(NOW));
  await context.addInitScript(({ origin, items }) => {
    if (window !== window.top || location.origin !== origin) return;
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
  }, { origin: ORIGIN, items: entries });
  let writeAttempts = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/__fundval_dev/, '');
    if (!['GET', 'HEAD'].includes(route.request().method())) writeAttempts++;
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    if (['/estimates', '/holdings'].includes(path)) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic outage"}' });
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(page.locator('#fund-list .fund-card')).toHaveCount(3);
  const card = code => page.locator('#fund-list .fund-card').filter({ hasText: code });
  return { card, cache, entries, writeAttempts: () => writeAttempts };
}

for (const mode of ['different', 'missing', 'nested']) {
  test(`aggregate cache ${mode} identity is isolated before any successful network response`, async ({ context, page }) => {
    const state = await openCachedPage(context, page, mode);
    const bad = state.card(CODES[0]);
    await expect(bad.locator('.nav-cur')).toHaveText('--');
    await expect(bad.locator('.nav-prev')).toHaveText('--');
    await expect(bad.locator('.fund-pct')).toHaveText('--');
    await bad.locator('.fund-card-toggle').click();
    await expect(bad.locator('.detail-money .money')).toHaveText(['--', '--']);
    await expect(bad).not.toContainText(/999\.1234|888\.1234|77\.70|外来金融说明/);
    for (const code of CODES.slice(1)) await expect(state.card(code).locator('.nav-cur')).toHaveText('2.2000');
    const persisted = await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), [CACHE_KEY, 'fuyu_holdings_v3']);
    expect(persisted).toEqual([state.cache, state.entries.fuyu_holdings_v3]);
    expect(state.writeAttempts()).toBe(0);
  });
}

test('matching and raw legacy aggregate caches still display current holding profit during provider outage', async ({ context, page }) => {
  const state = await openCachedPage(context, page, 'matching');
  for (const code of CODES) {
    const card = state.card(code);
    await expect(card.locator('.nav-cur')).toHaveText('2.2000');
    await expect(card.locator('.nav-prev')).toHaveText('2.0000');
    await card.locator('.fund-card-toggle').click();
    await expect(card.locator('.detail-money .money').last()).toContainText('+7.00');
  }
  expect(state.writeAttempts()).toBe(0);
});
