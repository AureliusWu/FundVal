import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_RELATIVE_DIRECTORY } from '../test/fixtures/ocr-synthetic-corpus.mjs';
import { bindOcrSource, sha256 } from './helpers/ocr-corpus-binding.mjs';

// Real production page, real Paddle SDK/models and real bitmap Workers. The
// input/expected values are deliberately synthetic, never user screenshot data.
// No request fulfillment, injected engine, fake prediction or synthetic catalog.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const expectedBytes = readFileSync(resolve(ROOT, CORPUS_RELATIVE_DIRECTORY, 'synthetic-alipay-1440x9317.expected.json'));
const expected = JSON.parse(expectedBytes);
const imagePath = resolve(ROOT, CORPUS_RELATIVE_DIRECTORY, 'synthetic-alipay-1440x9317.png');
const imageSha256 = sha256(readFileSync(imagePath));
if (imageSha256 !== expected.imageSha256 || expected.rows.length !== 15) throw new Error('Locked synthetic corpus changed');
const numberFromSnapshot = value => {
  if (value === '未识别') return { kind: 'unknown', value: null };
  if (typeof value !== 'string' || !value.trim()) return { kind: 'missing', value: null };
  const plain = value.replaceAll(',', '').replace(/%$/, '');
  return /^[+-]?\d+(?:\.\d+)?$/.test(plain) ? { kind: 'number', value: Number(plain) } : { kind: 'invalid', value: null };
};

for (const sample of [1, 2, 3]) test(`actual Paddle synthetic 1440x9317 corpus sample ${sample}`, async ({ page, context, browser }, testInfo) => {
  const startedAt = new Date().toISOString(), clock = performance.now();
  const record = { scope: 'ACTUAL_PADDLE_SYNTHETIC_DESKTOP_NOT_PHYSICAL_DEVICE_NOT_RELEASE', sample, startedAt,
    browser: browser.version(), viewport: { width: 390, height: 844 }, context: 'fresh_nonpersistent',
    resourceCacheState: 'fresh_context_serve_no_store_not_os_cold', corpusSha256: imageSha256, expectedSha256: sha256(expectedBytes),
    phases: [], requests: [], requestFailures: 0, blockedRequests: 0, workerEvents: [], consoleErrors: 0, pageErrors: 0,
    observed: null, metrics: null, reachedPreview: false, actualOcrElapsedMs: null, noConfirmClick: true };
  const pendingRequestMetrics = new Set();
  let before, completed = false;
  try {
    before = await bindOcrSource(ROOT); record.ocrSourceFingerprintBefore = before.fingerprint;
    await page.setViewportSize(record.viewport);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== ORIGIN || !['GET', 'HEAD'].includes(request.method()) || url.pathname.startsWith('/__fundval_dev/')) {
        record.blockedRequests++; await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page.on('console', message => { if (message.type() === 'error') record.consoleErrors++; });
    page.on('pageerror', () => { record.pageErrors++; });
    context.on('requestfailed', () => { record.requestFailures++; });
    context.on('requestfinished', request => {
      const collected = (async () => {
        const url = new URL(request.url()), response = await request.response(), sizes = await request.sizes().catch(() => null);
        record.requests.push({ path: url.origin === ORIGIN ? url.pathname : 'blocked_external', method: request.method(),
          status: response?.status() || null, bodyBytes: sizes?.responseBodySize ?? null });
      })().catch(() => {});
      pendingRequestMetrics.add(collected); collected.finally(() => pendingRequestMetrics.delete(collected));
    });
    page.on('worker', worker => {
      const path = new URL(worker.url()).pathname;
      const kind = path.endsWith('/js/ocr/preprocess-worker.js') ? 'light_preprocess'
        : path.endsWith('/fundval-paddle-worker.js') ? 'heavy_paddle' : 'other';
      record.workerEvents.push({ kind, event: 'started', elapsedMs: Math.round(performance.now() - clock) });
      worker.on('close', () => record.workerEvents.push({ kind, event: 'closed', elapsedMs: Math.round(performance.now() - clock) }));
    });
    await page.exposeFunction('__recordSyntheticCorpusPhase', phase => {
      const allowed = ['preparing', 'loading_engine', 'loading_models', 'initializing', 'recognizing', 'matching', 'complete', 'error', 'other'];
      record.phases.push({ phase: allowed.includes(phase) ? phase : 'other', elapsedMs: Math.round(performance.now() - clock) });
    });
    await page.goto('/ocr-import.html');
    await expect(page.locator('#ocr-import-pick')).toBeVisible();
    const baselineRaw = await page.evaluate(async () => {
      const { canonicalHoldingsDocument } = await import('./js/storage/holdings-schema.js');
      const document = { schema: 3, deviceId: 'synthetic:actual-ocr-corpus', updatedAt: '2026-10-26T00:00:00.000Z', holdings: [] };
      localStorage.setItem('fuyu_device_id_v1', document.deviceId);
      const raw = canonicalHoldingsDocument(document); localStorage.setItem('fuyu_holdings_v3', raw); return raw;
    });
    record.holdingsBeforeSha256 = sha256(baselineRaw);
    await page.evaluate(() => {
      const status = document.getElementById('ocr-import-status');
      new MutationObserver(() => {
        const text = status.textContent || '';
        const phase = text.includes('识别完成') ? 'complete' : /失败|无法|未识别到|不可用/.test(text) ? 'error'
          : text.includes('核对基金') ? 'matching' : text.includes('识别文字') ? 'recognizing'
            : text.includes('初始化') ? 'initializing' : text.includes('识别模型') ? 'loading_models'
              : text.includes('识别组件') ? 'loading_engine' : text.includes('读取并优化') ? 'preparing' : 'other';
        void globalThis.__recordSyntheticCorpusPhase(phase).catch(() => {});
      }).observe(status, { childList: true, characterData: true, subtree: true });
    });
    const ocrStartedAt = performance.now();
    await page.locator('#ocr-image-input').setInputFiles(imagePath);
    // Completion condition uses the existing test's overall30s bound, not a
    // widened timeout or a fabricated SDK result. Counts are asserted afterward.
    await page.waitForFunction(() => {
      const status = document.getElementById('ocr-import-status');
      return status && !status.classList.contains('working') && document.getElementById('ocr-import-pick').hidden;
    });
    record.actualOcrElapsedMs = Math.round(performance.now() - ocrStartedAt);
    record.reachedPreview = await page.locator('.ocr-candidate').count() > 0;
    record.observed = await page.locator('.ocr-candidate').evaluateAll(rows => rows.map(row => {
      const snapshots = Object.fromEntries([...row.querySelectorAll('.ocr-snapshot-item')].map(item => [item.querySelector('span')?.textContent, item.querySelector('strong')?.textContent]));
      const value = field => row.querySelector(`[data-field="${field}"]`)?.value ?? null;
      return { code: value('code'), name: value('name'), action: value('action'), shares: value('shares'), cost: value('cost'),
        badge: row.querySelector('.ocr-match-badge')?.textContent || '', snapshots,
        explicitRowGrantChecked: row.querySelector('[data-field="enable"]')?.checked === true,
        candidateCodes: [...row.querySelectorAll('[data-field="candidate"] option')].map(option => option.value.split('|')[0]).filter(code => /^\d{6}$/.test(code)) };
    }));
    const storage = await page.evaluate(async () => {
      const { readOcrPerformanceLedger } = await import('./js/ocr/performance-ledger.js');
      return { raw: localStorage.getItem('fuyu_holdings_v3'), keys: Object.keys(localStorage),
        ledger: readOcrPerformanceLedger(), ack: document.getElementById('ocr-import-ack')?.checked === true };
    });
    record.holdingsAfterSha256 = sha256(storage.raw || ''); record.metrics = storage.ledger.at(-1) || null;
    record.credentialKeys = storage.keys.filter(key => /gist.*token|authorization/i.test(key));
    const fields = { holdingAmount: '截图持有金额', holdingProfit: '截图累计收益', holdingProfitRate: '截图收益率', dailyProfit: '截图日收益' };
    const differences = [];
    let automaticMatches = 0, wrongAutomaticMatches = 0, acClassMismatch = 0;
    record.observed.forEach((row, index) => {
      const expectedRow = expected.rows[index];
      if (!expectedRow) { differences.push({ row: index + 1, field: 'extra_row' }); return; }
      const automatic = row.badge === '已匹配';
      if (automatic) { automaticMatches++; if (expectedRow.expectedAmbiguous || row.code !== expectedRow.code) wrongAutomaticMatches++; }
      if (['006228', '006229'].includes(expectedRow.code) && row.code && row.code !== expectedRow.code) acClassMismatch++;
      for (const [field, label] of Object.entries(fields)) {
        const actual = numberFromSnapshot(row.snapshots[label]), target = expectedRow[field];
        if ((target === null && actual.kind !== 'unknown') || (target !== null && (actual.kind !== 'number' || actual.value !== target))) {
          differences.push({ row: index + 1, field, expected: target, actual });
        }
      }
      if (expectedRow.expectedAmbiguous && (row.action !== 'skip' || row.code || automatic)) differences.push({ row: index + 1, field: 'ambiguous_identity_default' });
    });
    record.automaticMatches = automaticMatches; record.wrongAutomaticMatches = wrongAutomaticMatches;
    record.acClassMismatch = acClassMismatch; record.differences = differences;
    expect.soft(record.observed.length).toBe(15);
    expect.soft(automaticMatches).toBeGreaterThanOrEqual(12);
    expect.soft(wrongAutomaticMatches).toBe(0); expect.soft(acClassMismatch).toBe(0); expect.soft(differences).toEqual([]);
    const ambiguous = record.observed[14];
    expect.soft([...(ambiguous?.candidateCodes || [])].sort()).toEqual([...expected.rows[14].allowedCandidateCodes].sort());
    // Trusted exact rows MAY default to action=add. This assertion concerns
    // untouched real shares/cost and explicit per-row grants, not auto action.
    expect.soft(record.observed.every(row => row.shares === '' && row.cost === '' && !row.explicitRowGrantChecked)).toBe(true);
    expect.soft(storage.ack).toBe(false); expect.soft(record.holdingsAfterSha256).toBe(record.holdingsBeforeSha256);
    expect.soft(record.credentialKeys).toEqual([]); expect.soft(record.blockedRequests).toBe(0); expect.soft(record.pageErrors).toBe(0);
    expect.soft(record.metrics).not.toBeNull();
    expect.soft(record.metrics?.backend).toMatch(/^(?:webgpu|wasm)$/);
    expect.soft(record.metrics?.errorCategory).toBe('none');
    expect.soft(record.metrics?.imageWidth).toBe(1440); expect.soft(record.metrics?.imageHeight).toBe(9317);
    expect.soft(record.metrics?.tileCount).toBe(8); expect.soft(record.metrics?.blockCount).toBeGreaterThan(0);
    await Promise.allSettled([...pendingRequestMetrics]);
    expect.soft(record.workerEvents.filter(event => event.event === 'started' && event.kind === 'heavy_paddle').length).toBeGreaterThanOrEqual(1);
    expect.soft(record.requests.some(request => /PP-OCRv6_tiny_det/.test(request.path))).toBe(true);
    expect.soft(record.requests.some(request => /PP-OCRv6_tiny_rec/.test(request.path))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('synthetic-actual-paddle-preview.png') });
    completed = true;
  } catch (error) {
    record.failureKind = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '') ? 'timeout' : 'execution_error';
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString(); record.wallMs = Math.round(performance.now() - clock);
    await Promise.allSettled([...pendingRequestMetrics]);
    try { const after = await bindOcrSource(ROOT); record.ocrSourceFingerprintAfter = after.fingerprint;
      record.ocrSourceUnchanged = before?.fingerprint === after.fingerprint; }
    catch (_) { record.ocrSourceUnchanged = false; }
    record.result = completed && !testInfo.errors.length && record.ocrSourceUnchanged ? 'PASS' : 'FAIL';
    const receiptPath = testInfo.outputPath('actual-paddle-synthetic-receipt.json');
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await testInfo.attach('actual-paddle-synthetic-receipt', { contentType: 'application/json', body: JSON.stringify(record) });
    expect(record.ocrSourceUnchanged).toBe(true);
  }
});
