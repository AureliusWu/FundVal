import { expect, test } from '@playwright/test';

const LOCAL_ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const WORKER_HOST = 'sinan-estimate-push.ligugu69.workers.dev';
const TEST_FUND = Object.freeze({
  code: '005844',
  name: 'E2E 测试基金',
  shares: '100',
  cost: '1.2',
});

function estimateRow(code) {
  return {
    code,
    name: code === TEST_FUND.code ? TEST_FUND.name : `基金 ${code}`,
    type: '混合型',
    last_nav: 1.2,
    est_nav: 1.21,
    est_change: 0.83,
    nav_date: '2026-08-27',
    est_time: '2026-08-28 14:45:00',
    source_time: '2026-08-28 14:45:00',
    est_label: '延迟估值',
    est_kind: 'estimate',
    est_realtime: false,
    status: 'ok',
    source: 'sinan-estimate-proxy',
  };
}

async function installHermeticNetwork(context, options = {}) {
  const log = {
    blocked: [],
    mocked: [],
    gistWrites: [],
  };

  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // The development runtime guard rewrites approved Worker reads to a
    // same-origin /__fundval_dev proxy. Match both that form and production's
    // direct Worker form before allowing ordinary local static assets.
    const workerPath = url.pathname.replace(/^\/__fundval_dev/, '');

    if (url.hostname === 'api.github.com' && url.pathname.startsWith('/gists')) {
      if (!['GET', 'HEAD'].includes(request.method())) {
        log.gistWrites.push({ method: request.method(), url: url.href });
      }
      log.blocked.push(url.href);
      await route.abort('blockedbyclient');
      return;
    }

    if ((url.hostname === WORKER_HOST || url.origin === LOCAL_ORIGIN) && workerPath === '/estimates') {
      const codes = (url.searchParams.get('codes') || '')
        .split(',')
        .filter(code => /^\d{6}$/.test(code));
      log.mocked.push(url.href);
      if (options.failEstimates === true) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          fetched_at: '2026-08-28T06:45:10.000Z',
          items: codes.map(estimateRow),
        }),
      });
      return;
    }

    if ((url.hostname === WORKER_HOST || url.origin === LOCAL_ORIGIN) && workerPath === '/holdings') {
      const malicious = options.maliciousHoldings === true;
      log.mocked.push(url.href);
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          report_date: '2026-06-30',
          fetched_at: '2026-08-28T06:45:10.000Z',
          source: 'e2e-worker-fixture',
          items: malicious
            ? [
                { code: '688361', name: '中科飞测', ratio: 9.55 },
                {
                  code: '<img src=x onerror=window.__fundvalPwned=1>',
                  name: '<svg onload=window.__fundvalPwned=1>',
                  ratio: 8.88,
                },
              ]
            : [],
        }),
      });
      return;
    }

    if (url.origin === LOCAL_ORIGIN) {
      await route.continue();
      return;
    }

    // Every other third-party request (including Eastmoney/Tencent JSONP and
    // stock quotes) is intentionally denied. No E2E request may reach a real
    // market provider or a user's Gist.
    log.blocked.push(url.href);
    await route.abort('blockedbyclient');
  });

  return log;
}

async function openApp(page) {
  await page.goto('/');
  await expect(page.getByText('蜉蝣基金', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration)).toBe('ok');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(page.locator('#fund-list .skeleton')).toHaveCount(0);
}

async function addHoldingThroughUi(page, fund = TEST_FUND) {
  await page.locator('#nav-edit').click();
  await expect(page.locator('#page-edit')).toHaveClass(/\bactive\b/);
  await page.locator('#i-code').fill(fund.code);
  await page.locator('#i-name').fill(fund.name);
  await page.locator('#i-shares').fill(fund.shares);
  await page.locator('#i-cost').fill(fund.cost);
  await page.locator('#add-btn').click();
  await expect(page.locator('#holdings-list .holding-item').filter({ hasText: fund.code })).toBeVisible();
}

function fundCard(page, code = TEST_FUND.code) {
  return page.locator('#fund-list .fund-card').filter({ hasText: code });
}

async function readPwaCacheState(page) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        if (!registration.active) throw new Error('service_worker_not_active');
        const manifest = await (await fetch('./js/app-chunks.json')).json();
        const lazyPath = manifest.lazy[0];
        const cacheNames = await caches.keys();
        const cache = await caches.open(cacheNames.find(name => name.startsWith('fuyu-v')));
        return {
          cacheNames,
          lazyPath,
          lazyCached: Boolean(await cache.match(`./${lazyPath}`)),
          bridgeCached: Boolean(await cache.match('./quote-bridge.html')),
          updateCompatCached: Boolean(await cache.match('./js/update-compat.js')),
        };
      });
    } catch (error) {
      lastError = error;
      if (!/execution context was destroyed|navigation/i.test(String(error?.message || error))) throw error;
      // Chromium can commit one controller/navigation transition while the
      // first-install worker claims the page. Retry only after the replacement
      // document reaches a usable state; no fixed delay is required.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await expect(page.getByText('蜉蝣基金', { exact: true })).toBeVisible();
    }
  }
  throw lastError || new Error('pwa_cache_state_unavailable');
}

test('a quota failure preserves both saved holding and editable draft', async ({ context, page }) => {
  await installHermeticNetwork(context);
  await openApp(page);
  await addHoldingThroughUi(page);
  await page.locator(`.holding-item[data-code="${TEST_FUND.code}"]`).click();
  await page.locator('#i-shares').fill('999');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.includes('holdings_repository_backup')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.locator('#add-btn').click();
  await expect(page.locator('#toast')).toContainText('保存失败');
  await expect(page.locator('#i-shares')).toHaveValue('999');
  await expect(page.locator('#holdings-list .h-detail')).toContainText('100份');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fuyu_holdings_v3')).holdings[0].shares)).toBe(100);
  await page.locator('#cancel-edit-btn').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('#nav-edit').click();
  await expect(page.locator('#holdings-list .h-detail')).toContainText('100份');
});

test('stale editor cannot overwrite another tab and navigation preserves its draft', async ({ context, page }, testInfo) => {
  const evidence = [];
  let second = null;
  const navigations = { first: 0, second: 0 };
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.first += 1; });
  const observeSyntheticSaveClicks = target => target.evaluate(() => {
    window.__E2E_SYNTHETIC_SAVE_CLICKS__ = 0;
    document.addEventListener('click', event => {
      if (event.target?.closest('#add-btn')) window.__E2E_SYNTHETIC_SAVE_CLICKS__ += 1;
    }, true);
  });
  const readSyntheticEditorEvidence = target => target.evaluate(fund => {
    const parse = raw => {
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch (_) { return { malformed: true }; }
    };
    const v3Raw = localStorage.getItem('fuyu_holdings_v3');
    const v1Raw = localStorage.getItem('fuyu_holdings_v1');
    const canonical = parse(v3Raw);
    const legacy = parse(v1Raw);
    const projection = parse(localStorage.getItem('fuyu_holdings_projection_meta_v1'));
    // This diagnostic is limited to this new browser context's synthetic
    // fixture. Refuse to emit any unexpected holdings or raw storage contents.
    const canonicalSynthetic = Array.isArray(canonical?.holdings)
      && canonical.holdings.every(row => row.fundCode === fund.code && row.fundName === fund.name);
    const legacySynthetic = Array.isArray(legacy)
      && legacy.every(row => row.code === fund.code && row.name === fund.name);
    if ((canonical && !canonicalSynthetic) || (legacy && !legacySynthetic)) {
      return { unexpectedFixture: true };
    }
    const input = id => document.getElementById(id)?.value ?? null;
    const save = document.getElementById('add-btn');
    return {
      canonical,
      canonicalHolding: canonical?.holdings.find(row => row.fundCode === fund.code) || null,
      legacy,
      projection: projection ? {
        version: projection.version,
        matchesCanonical: projection.v3Canonical === v3Raw,
        matchesLegacy: projection.v1Raw === v1Raw,
      } : null,
      journalPresent: localStorage.getItem('fuyu_holdings_repository_journal_v1') !== null,
      input: { code: input('i-code'), name: input('i-name'), shares: input('i-shares'), cost: input('i-cost') },
      saveButton: { enabled: Boolean(save && !save.disabled), text: save?.textContent || null },
      toast: document.getElementById('toast')?.textContent || null,
      toastVisible: document.getElementById('toast')?.classList.contains('show') || false,
      saveClickCount: window.__E2E_SYNTHETIC_SAVE_CLICKS__ ?? null,
      visible: document.visibilityState,
    };
  }, TEST_FUND);
  const capture = async phase => {
    evidence.push({
      phase,
      mainFrameNavigations: { ...navigations },
      first: await readSyntheticEditorEvidence(page),
      second: second && !second.isClosed() ? await readSyntheticEditorEvidence(second) : null,
    });
  };
  try {
    await installHermeticNetwork(context);
    await openApp(page);
    await observeSyntheticSaveClicks(page);
    await addHoldingThroughUi(page);
    await capture('initial-save-returned');
    await page.locator(`.holding-item[data-code="${TEST_FUND.code}"]`).click();
    await page.locator('#i-shares').fill('999');
    await page.locator('#nav-market').click();
    await page.locator('#nav-edit').click();
    await expect(page.locator('#i-shares')).toHaveValue('999');

    await capture('first-draft-opened-and-navigation-returned');
    second = await context.newPage();
    second.on('framenavigated', frame => { if (frame === second.mainFrame()) navigations.second += 1; });
    await openApp(second);
    await observeSyntheticSaveClicks(second);
    await second.locator('#nav-edit').click();
    await second.locator(`.holding-item[data-code="${TEST_FUND.code}"]`).click();
    await second.locator('#i-shares').fill('200');
    await capture('before-second-save');
    await second.locator('#add-btn').click();
    await expect.poll(async () => (await readSyntheticEditorEvidence(second)).canonicalHolding?.shares,
      { message: 'second tab must have durably committed the synthetic 200-share record' }).toBe(200);
    await expect(second.locator('#holdings-list .h-detail')).toContainText('200份');
    await capture('after-second-canonical-save');
    // Capture first-tab storage without waiting for cross-renderer propagation
    // or mutating it; preserve the original concurrent stale-save window.
    await capture('before-first-stale-save');
    await page.locator('#add-btn').click();
    await capture('first-stale-save-click-returned');
    await expect(page.locator('#toast')).toContainText('未覆盖新数据');
    await expect(page.locator('#i-shares')).toHaveValue('999');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fuyu_holdings_v3')).holdings[0].shares)).toBe(200);
    await capture('first-stale-save-rejected');
  } finally {
    await capture('final').catch(() => evidence.push({ phase: 'final', unreadable: true }));
    console.log(`LOCAL_STALE_EDITOR_EVIDENCE ${JSON.stringify(evidence)}`);
    await testInfo.attach('synthetic-stale-editor-evidence', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json',
    });
    await second?.close();
  }
});

test('lazy diagnostics and export keep working without loading OCR assets', async ({ context, page }) => {
  const network = await installHermeticNetwork(context);
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await openApp(page);
  await addHoldingThroughUi(page);
  await page.locator('#diagnostics-center').evaluate(element => { element.open = true; });
  await expect(page.locator('#diagnostics-content')).toContainText('持仓 Schema');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="export-data"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fuyu-holdings.json');
  expect(requests.some(url => /assets\/ocr|paddle-local-ocr/.test(url))).toBe(false);
  expect(network.gistWrites).toHaveLength(0);
});

test('local mobile cold/warm readiness and holding save stay within the interaction budget', async ({ browser }, testInfo) => {
  const samples = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await installHermeticNetwork(context);
    await context.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if (document.documentElement?.dataset.appReady !== 'true') return;
        window.__E2E_READY_MS__ = performance.now();
        observer.disconnect();
      });
      observer.observe(document, { attributes: true, subtree: true, attributeFilter: ['data-app-ready'] });
    });
    const page = await context.newPage();
    await page.goto(LOCAL_ORIGIN);
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    const cold = await page.evaluate(() => window.__E2E_READY_MS__);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    const warm = await page.evaluate(() => window.__E2E_READY_MS__);
    await page.locator('#nav-edit').click();
    await page.locator('#i-code').fill(TEST_FUND.code);
    await page.locator('#i-name').fill(TEST_FUND.name);
    await page.locator('#i-shares').fill(TEST_FUND.shares);
    await page.locator('#i-cost').fill(TEST_FUND.cost);
    const start = performance.now();
    await page.locator('#add-btn').click();
    await expect(page.locator('#holdings-list .h-detail')).toContainText('100份');
    const save = performance.now() - start;
    samples.push({ coldReadyMs: cold, warmReadyMs: warm, saveUiMs: save });
    expect(Math.max(cold, warm, save)).toBeLessThan(3000);
    await context.close();
  }
  console.log('LOCAL_PERFORMANCE ' + JSON.stringify(samples));
  await testInfo.attach('local-performance.json', { body: JSON.stringify({ viewport: '390x844', network: 'hermetic local no-store, no real providers', samples }, null, 2), contentType: 'application/json' });
});

test('app starts and a holding survives add/reload/delete/reload through the UI', async ({ context, page }) => {
  const network = await installHermeticNetwork(context);
  await openApp(page);

  await addHoldingThroughUi(page);
  await page.locator('#nav-market').click();
  await expect(fundCard(page)).toBeVisible();
  await expect(fundCard(page).locator('.fund-name')).toHaveText(TEST_FUND.name);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration)).toBe('ok');
  await expect(fundCard(page)).toBeVisible();
  await page.locator('#nav-edit').click();
  await expect(page.locator('#holdings-list .holding-item').filter({ hasText: TEST_FUND.code })).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.locator(`.del-btn[data-code="${TEST_FUND.code}"]`).click();
  await expect(page.locator('#holdings-list .holding-item').filter({ hasText: TEST_FUND.code })).toHaveCount(0);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration)).toBe('ok');
  await page.locator('#nav-edit').click();
  await expect(page.locator('#holdings-list .holding-item').filter({ hasText: TEST_FUND.code })).toHaveCount(0);
  await page.locator('#nav-market').click();
  await expect(fundCard(page)).toHaveCount(0);

  expect(network.gistWrites).toEqual([]);
});

test('quote bridge uses an opaque-origin scripts-only sandbox', async ({ context, page }) => {
  const network = await installHermeticNetwork(context);
  await openApp(page);

  await page.evaluate(async () => {
    const { createQuoteBridgeClient } = await import('./js/runtime/quote-bridge-client.js');
    const client = createQuoteBridgeClient();
    const frame = await client.ensureFrame();
    frame.id = 'e2e-quote-bridge';
    window.__E2E_QUOTE_BRIDGE_CLIENT__ = client;
  });

  const frame = page.locator('#e2e-quote-bridge');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const sandboxTokens = await frame.evaluate(element => Array.from(element.sandbox));
  expect(sandboxTokens).toEqual(['allow-scripts']);
  expect(sandboxTokens).not.toContain('allow-same-origin');

  await page.evaluate(() => window.__E2E_QUOTE_BRIDGE_CLIENT__?.destroy());
  expect(network.gistWrites).toEqual([]);
});

test('malicious remote holding fields are rejected before detail DOM rendering', async ({ context, page }) => {
  const network = await installHermeticNetwork(context, { maliciousHoldings: true });
  await openApp(page);
  await addHoldingThroughUi(page);
  await page.locator('#nav-market').click();

  const card = fundCard(page);
  await expect(card).toBeVisible();
  await card.locator('.fund-card-toggle').click();
  await expect(card.locator('.holdings-row')).toHaveCount(1);
  await expect(card.locator('.holdings-row')).toContainText('中科飞测');
  await expect(card.locator('.holdings-row')).not.toContainText('fundvalPwned');
  await expect(card.locator('img, svg')).toHaveCount(0);
  expect(await page.evaluate(() => window.__fundvalPwned)).toBeUndefined();

  expect(network.mocked.some(url => new URL(url).pathname.endsWith('/holdings'))).toBe(true);
  expect(network.gistWrites).toEqual([]);
});

test('an estimate outage never falls back to an identically numbered stock quote', async ({ context, page }) => {
  const network = await installHermeticNetwork(context, { failEstimates: true });
  await openApp(page);
  await addHoldingThroughUi(page, { code: '000001', name: '代码碰撞基金', shares: '10', cost: '1' });
  await page.locator('#nav-market').click();
  const card = fundCard(page, '000001');
  await expect(card).toBeVisible();
  await expect(card.locator('.fund-pct')).toHaveText('--');
  expect(network.blocked.some(url => {
    const parsed = new URL(url);
    return parsed.hostname === 'push2.eastmoney.com'
      && parsed.pathname.includes('/stock/get')
      && parsed.searchParams.get('secid') === '0.000001';
  })).toBe(false);
  expect(network.gistWrites).toEqual([]);
});

test('cloud synchronization fails closed when a PATCH readback does not match', async ({ context, page }) => {
  const network = await installHermeticNetwork(context);
  await openApp(page);
  const result = await page.evaluate(async () => {
    const { synchronizeHoldingsCloud } = await import('./js/storage/cloud-sync.js');
    const { normalizeHoldingsDocumentV3, stableHoldingId } = await import('./js/storage/holdings-schema.js');
    const time = '2026-08-28T00:00:00.000Z';
    const makeDocument = shares => normalizeHoldingsDocumentV3({
      schema: 3,
      updatedAt: time,
      deviceId: 'e2e-device',
      holdings: [{
        id: stableHoldingId('005844'), fundCode: '005844', fundName: 'E2E 基金',
        shares, costNav: null, createdAt: time, updatedAt: time, deletedAt: null,
        revision: 1, deviceId: 'e2e-device', note: null,
      }],
    });
    let localDocument = makeDocument(10);
    const remoteBefore = makeDocument(8);
    const wrongReadback = makeDocument(7);
    const pending = [];
    const local = {
      async load() { return { ok: true, document: localDocument }; },
      async backup() { return { ok: true, verified: true }; },
      async persist(next) { localDocument = next; return { ok: true, document: next }; },
      async markPending(value) { pending.push(value); return { ok: true }; },
    };
    const remote = {
      async get({ phase }) { return { ok: true, raw: phase === 'readback' ? wrongReadback : remoteBefore }; },
      async patch() { return { ok: true }; },
    };
    const synced = await synchronizeHoldingsCloud({ local, remote });
    return { ok: synced.ok, reason: synced.reason, pending };
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/readback|mismatch/);
  expect(network.gistWrites).toEqual([]);
});

test('OCR confirmation page loads and candidate selection respects explicit skip', async ({ context, page }) => {
  const network = await installHermeticNetwork(context);
  await page.goto('/ocr-import.html');

  await expect(page.locator('#ocr-modal-title')).toHaveText('支付宝 / 蚂蚁财富基金截图导入');
  await expect(page.locator('#ocr-import-status')).toContainText('请选择一张');
  await expect(page.locator('#ocr-import-pick')).toBeVisible();
  await expect(page.locator('.ocr-privacy-note')).toContainText('不上传、不保存');

  const actions = await page.evaluate(async () => {
    const {
      createHoldingImportPlan,
      resolveCandidateSelectionAction,
    } = await import('./js/holding-import-plan.js');
    const candidate = {
      rawFundName: '东方人工智能主题混合A',
      match: {
        status: 'needs_confirmation',
        candidates: [{ code: '005844', name: '东方人工智能主题混合A' }],
      },
    };
    const [unconfirmed] = createHoldingImportPlan([candidate], []);
    return {
      initial: unconfirmed.action,
      selectedNew: resolveCandidateSelectionAction(null, false),
      selectedExisting: resolveCandidateSelectionAction({ code: '005844' }, false),
      explicitSkipNew: resolveCandidateSelectionAction(null, true),
      explicitSkipExisting: resolveCandidateSelectionAction({ code: '005844' }, true),
    };
  });

  expect(actions).toEqual({
    initial: 'skip',
    selectedNew: 'add',
    selectedExisting: 'update',
    explicitSkipNew: 'skip',
    explicitSkipExisting: 'skip',
  });
  expect(network.gistWrites).toEqual([]);
  expect(network.mocked).toEqual([]);
  expect(network.blocked).toEqual([]);
});

test('new HTML can invoke the guarded updater exposed by a cached legacy app shell', async ({ context, page }) => {
  await context.route('**/js/app-shell.js', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    body: `
      globalThis.__legacyUpdateCalls = 0;
      globalThis.applyPendingServiceWorkerUpdate = function () {
        globalThis.__legacyUpdateCalls += 1;
      };
      document.getElementById('update-banner').hidden = false;
    `,
  }));
  await page.goto('/');
  await expect(page.locator('#update-now-btn')).toBeVisible();

  await page.locator('#update-now-btn').click();

  await expect.poll(() => page.evaluate(() => globalThis.__legacyUpdateCalls)).toBe(1);
});

test('PWA installs the versioned shell, caches lazy chunks and reopens offline', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  await installHermeticNetwork(context);
  try {
    await openApp(page);
    const state = await readPwaCacheState(page);
    expect(state.cacheNames.some(name => name.startsWith('fuyu-v'))).toBe(true);
    expect(state.lazyPath).toMatch(/^js\/chunks\/.+\.js$/);
    expect(state.lazyCached).toBe(true);
    expect(state.bridgeCached).toBe(true);
    expect(state.updateCompatCached).toBe(true);
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('蜉蝣基金', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
