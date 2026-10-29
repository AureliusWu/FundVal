import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_RELATIVE_DIRECTORY } from '../test/fixtures/ocr-synthetic-corpus.mjs';
import { bindOcrSource, sha256 } from './helpers/ocr-corpus-binding.mjs';
import { boundObservedCancellation, observeNativeCloseLatency } from './helpers/cancel-clock.mjs';

// Desktop native-Worker cancellation preflight, not physical memory evidence.
// Only passive protocol/DOM observation; real SDK, models and inference remain.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const imagePath = resolve(ROOT, CORPUS_RELATIVE_DIRECTORY, 'synthetic-alipay-1440x9317.png');
const expectedBytes = readFileSync(resolve(ROOT, CORPUS_RELATIVE_DIRECTORY, 'synthetic-alipay-1440x9317.expected.json'));
const expected = JSON.parse(expectedBytes), imageSha256 = sha256(readFileSync(imagePath));
if (imageSha256 !== expected.imageSha256 || expected.rows.length !== 15) throw new Error('Locked synthetic corpus changed');

for (const stage of ['init', 'predict']) test(`actual Paddle ${stage} cancellation closes Workers and permits real same-image retry`, async ({ page, context, browser }, testInfo) => {
  const started = performance.now();
  const record = { scope: 'ACTUAL_PADDLE_CANCEL_DESKTOP_UPPER_BOUND_NOT_PHYSICAL_NOT_RELEASE', stage,
    testTimeoutMs: testInfo.timeout, retry: testInfo.retry,
    startedAt: new Date().toISOString(), browser: browser.version(), context: 'fresh_nonpersistent',
    resourceCacheState: 'fresh_context_no_store_not_os_cold', viewport: { width: 390, height: 844 },
    corpusSha256: imageSha256, expectedSha256: sha256(expectedBytes), workerEvents: [], requests: [],
    blockedRequests: 0, requestFailures: 0, consoleErrors: 0, pageErrors: 0, noConfirmClick: true };
  const workers = [], pendingMetrics = new Set();
  let sourceBefore, completed = false, retryStarted = false, cancelNodeStart = null;
  try {
    expect(testInfo.timeout).toBe(30_000); expect(testInfo.retry).toBe(0);
    sourceBefore = await bindOcrSource(ROOT); record.ocrSourceFingerprintBefore = sourceBefore.fingerprint;
    await page.setViewportSize(record.viewport);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== ORIGIN || !['GET', 'HEAD'].includes(request.method()) || url.pathname.startsWith('/__fundval_dev/')) {
        record.blockedRequests++; await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    context.on('requestfailed', () => { record.requestFailures++; });
    context.on('requestfinished', request => {
      const metric = (async () => {
        const response = await request.response(), url = new URL(request.url());
        record.requests.push({ path: url.origin === ORIGIN ? url.pathname : 'blocked_external', method: request.method(), status: response?.status() || null });
      })().catch(() => {});
      pendingMetrics.add(metric); metric.finally(() => pendingMetrics.delete(metric));
    });
    page.on('console', message => { if (message.type() === 'error') record.consoleErrors++; });
    page.on('pageerror', () => { record.pageErrors++; });
    page.on('worker', worker => {
      const path = new URL(worker.url()).pathname;
      const kind = path.endsWith('/js/ocr/preprocess-worker.js') ? 'light_preprocess'
        : path.endsWith('/fundval-paddle-worker.js') ? 'heavy_paddle' : 'other';
      const entry = { id: workers.length + 1, kind, round: retryStarted ? 'retry' : 'cancel', startedNodeMs: performance.now(), closedNodeMs: null };
      workers.push(entry);
      record.workerEvents.push({ id: entry.id, kind, round: entry.round, event: 'started', elapsedMs: entry.startedNodeMs - started });
      worker.on('close', () => {
        entry.closedNodeMs = performance.now();
        record.workerEvents.push({ id: entry.id, kind, round: entry.round, event: 'closed', elapsedMs: entry.closedNodeMs - started });
      });
    });
    await page.addInitScript(() => {
      const observation = { protocol: [], timeOriginMs: performance.timeOrigin, cancelPageMs: null, unlockPageMs: null,
        predictAtCancel: false, retryStarted: false, lateCandidateObserved: false };
      globalThis.__fundvalActualCancelObservation = observation;
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        const result = Reflect.apply(original, this, args);
        const request = args[0];
        if (request?.kind === 'worker-transport-request' && Number.isSafeInteger(request.requestId)
          && ['init', 'predict'].includes(request.type)) {
          // Do not inspect/copy payload, bitmap, text or model/inference output.
          observation.protocol.push({ type: request.type, pageMs: performance.now() });
        }
        return result;
      };
    });
    await page.goto('/ocr-import.html');
    await expect(page.locator('#ocr-import-pick')).toBeVisible();
    const initialRaw = await page.evaluate(async () => {
      const { canonicalHoldingsDocument } = await import('./js/storage/holdings-schema.js');
      const value = { schema: 3, deviceId: 'synthetic:actual-cancel', updatedAt: '2026-10-26T00:00:00.000Z', holdings: [] };
      localStorage.setItem('fuyu_device_id_v1', value.deviceId);
      const raw = canonicalHoldingsDocument(value); localStorage.setItem('fuyu_holdings_v3', raw); return raw;
    });
    record.holdingsBeforeSha256 = sha256(initialRaw);
    await page.evaluate(() => {
      const observation = globalThis.__fundvalActualCancelObservation;
      const cancel = document.getElementById('ocr-import-cancel');
      cancel.addEventListener('click', event => {
        if (!event.isTrusted || observation.cancelPageMs !== null) return;
        observation.cancelPageMs = performance.now();
        observation.predictAtCancel = observation.protocol.some(entry => entry.type === 'predict');
      }, { capture: true });
      const inspect = () => {
        if (observation.cancelPageMs === null || observation.retryStarted) return;
        if (document.querySelectorAll('.ocr-candidate').length) observation.lateCandidateObserved = true;
        const status = document.getElementById('ocr-import-status');
        if (observation.unlockPageMs === null && cancel.hidden && !status.classList.contains('working')
          && status.textContent.includes('已取消')
          && ['ocr-image-input', 'ocr-import-pick', 'ocr-import-retry'].every(id => !document.getElementById(id).disabled)) {
          observation.unlockPageMs = performance.now();
        }
      };
      new MutationObserver(inspect).observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
    });

    // Browser protocol delivery and Playwright's native Worker-created event
    // are separate channels. Observe both; never mistake a delayed event for
    // a missing Worker or cancel before the native active-set is measurable.
    const firstNativeHeavy = page.waitForEvent('worker', { predicate: worker => new URL(worker.url()).pathname.endsWith('/fundval-paddle-worker.js') });
    await page.locator('#ocr-image-input').setInputFiles(imagePath);
    await Promise.all([
      firstNativeHeavy,
      page.waitForFunction(target => globalThis.__fundvalActualCancelObservation.protocol.some(entry => entry.type === target), stage),
    ]);
    const active = workers.filter(entry => entry.round === 'cancel' && entry.closedNodeMs === null);
    record.activeAtCancel = active.map(({ id, kind }) => ({ id, kind }));
    expect(active.some(entry => entry.kind === 'light_preprocess')).toBe(true);
    expect(active.some(entry => entry.kind === 'heavy_paddle')).toBe(true);
    const nodeBeforeMs = performance.now();
    const pageClock = await page.evaluate(() => ({ pageSampleMs: performance.now(), sampleTimeOriginMs: performance.timeOrigin }));
    const nodeAfterMs = performance.now();
    record.cancelClockSample = { nodeBeforeMs, nodeAfterMs, ...pageClock };
    cancelNodeStart = performance.now();
    record.cancelClickInvocationStartElapsedMs = cancelNodeStart - started;
    await page.locator('#ocr-import-cancel').click();
    record.cancelClickInvocationEndElapsedMs = performance.now() - started;
    await Promise.all([
      // The user waived the native resource-latency release gate. Still require
      // actual close before retry within the unchanged 8 s expect deadline;
      // measure the original 2 s goal below, never relabel a miss as PASS.
      expect.poll(() => active.every(entry => entry.closedNodeMs !== null), { timeout: 8_000, intervals: [10, 20, 50] }).toBe(true),
      page.waitForFunction(() => globalThis.__fundvalActualCancelObservation.unlockPageMs !== null, null, { timeout: 2_000 }),
    ]);
    record.allActiveWorkersClosedUpperBoundMs = Math.max(...active.map(entry => entry.closedNodeMs)) - cancelNodeStart;
    record.cancelObservation = await page.evaluate(() => globalThis.__fundvalActualCancelObservation);
    record.trustedClickClockBounds = boundObservedCancellation({ ...record.cancelClockSample,
      pageCancelMs: record.cancelObservation.cancelPageMs, cancelTimeOriginMs: record.cancelObservation.timeOriginMs,
      invocationStartMs: cancelNodeStart, invocationEndMs: record.cancelClickInvocationEndElapsedMs + started,
      closedNodeMs: Math.max(...active.map(entry => entry.closedNodeMs)) });
    record.trustedClickToWorkersClosedUpperBoundMs = record.trustedClickClockBounds.observedCloseUpperBoundMs;
    record.nativeWorkerCloseLatency = observeNativeCloseLatency(record.trustedClickToWorkersClosedUpperBoundMs);
    record.nativeWorkersClosedBeforeRetry = active.every(entry => entry.closedNodeMs !== null);
    record.taskFinallyUnlockMs = record.cancelObservation.unlockPageMs - record.cancelObservation.cancelPageMs;
    expect(record.cancelObservation.cancelPageMs).not.toBeNull();
    expect(record.cancelObservation.protocol.some(entry => entry.type === stage && entry.pageMs <= record.cancelObservation.cancelPageMs)).toBe(true);
    if (stage === 'init') expect(record.cancelObservation.predictAtCancel).toBe(false);
    else expect(record.cancelObservation.predictAtCancel).toBe(true);
    expect(record.allActiveWorkersClosedUpperBoundMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(record.trustedClickToWorkersClosedUpperBoundMs)).toBe(true);
    expect(record.trustedClickToWorkersClosedUpperBoundMs).toBeGreaterThanOrEqual(0);
    expect(record.nativeWorkersClosedBeforeRetry).toBe(true);
    expect(record.taskFinallyUnlockMs).toBeGreaterThanOrEqual(0);
    expect(record.taskFinallyUnlockMs).toBeLessThanOrEqual(2_000);
    await expect(page.locator('#ocr-import-pick')).toBeVisible();
    await expect(page.locator('#ocr-import-pick')).toBeEnabled();
    await expect(page.locator('#ocr-import-status')).toContainText('已取消');
    // Finite post-settle observation, not a fabricated network/Worker hold.
    await page.waitForTimeout(200);
    await expect(page.locator('.ocr-candidate')).toHaveCount(0);
    record.newWorkersAfterCancelBeforeRetry = workers.filter(entry => entry.startedNodeMs >= cancelNodeStart).map(entry => ({ id: entry.id, kind: entry.kind }));
    expect(record.newWorkersAfterCancelBeforeRetry).toEqual([]);
    const cancelledState = await page.evaluate(() => ({ raw: localStorage.getItem('fuyu_holdings_v3'), observation: globalThis.__fundvalActualCancelObservation }));
    record.holdingsAfterCancelSha256 = sha256(cancelledState.raw || '');
    expect(record.holdingsAfterCancelSha256).toBe(record.holdingsBeforeSha256);
    expect(cancelledState.observation.lateCandidateObserved).toBe(false);

    await page.evaluate(() => { globalThis.__fundvalActualCancelObservation.retryStarted = true; });
    retryStarted = true;
    const retryStart = performance.now();
    await page.locator('#ocr-image-input').setInputFiles(imagePath);
    await page.waitForFunction(() => {
      const status = document.getElementById('ocr-import-status');
      return status && !status.classList.contains('working') && document.getElementById('ocr-import-pick').hidden;
    });
    record.retryElapsedMs = performance.now() - retryStart;
    record.retryCandidateCount = await page.locator('.ocr-candidate').count();
    const retryState = await page.evaluate(async () => {
      const { readOcrPerformanceLedger } = await import('./js/ocr/performance-ledger.js');
      return { raw: localStorage.getItem('fuyu_holdings_v3'), metrics: readOcrPerformanceLedger().at(-1) || null,
        acknowledged: document.getElementById('ocr-import-ack')?.checked === true,
        observation: globalThis.__fundvalActualCancelObservation };
    });
    record.holdingsAfterRetrySha256 = sha256(retryState.raw || '');
    record.retryMetrics = retryState.metrics; record.cancelObservation = retryState.observation;
    expect(record.retryCandidateCount).toBe(15);
    expect(record.holdingsAfterRetrySha256).toBe(record.holdingsBeforeSha256);
    expect(retryState.acknowledged).toBe(false);
    expect(record.retryMetrics?.errorCategory).toBe('none');
    expect(record.retryMetrics?.backend).toMatch(/^(?:webgpu|wasm)$/);
    expect(record.retryMetrics?.imageWidth).toBe(1440); expect(record.retryMetrics?.imageHeight).toBe(9317);
    expect(record.retryMetrics?.tileCount).toBe(8); expect(record.retryMetrics?.blockCount).toBeGreaterThan(0);
    expect(workers.some(entry => entry.round === 'retry' && entry.kind === 'light_preprocess')).toBe(true);
    expect(workers.some(entry => entry.round === 'retry' && entry.kind === 'heavy_paddle')).toBe(true);
    expect(record.blockedRequests).toBe(0); expect(record.pageErrors).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`actual-${stage}-cancel-retry.png`) });
    completed = true;
  } catch (error) {
    record.failureKind = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '') ? 'timeout' : 'assertion_or_execution';
    throw error;
  } finally {
    await Promise.allSettled([...pendingMetrics]);
    try {
      record.finalObservation = await page.evaluate(() => globalThis.__fundvalActualCancelObservation);
      record.finalCandidateCount = await page.locator('.ocr-candidate').count();
    } catch (_) { record.finalObservationUnavailable = true; }
    try {
      const sourceAfter = await bindOcrSource(ROOT); record.ocrSourceFingerprintAfter = sourceAfter.fingerprint;
      record.ocrSourceUnchanged = sourceBefore?.fingerprint === sourceAfter.fingerprint;
    } catch (_) { record.ocrSourceUnchanged = false; }
    record.finishedAt = new Date().toISOString(); record.wallMs = performance.now() - started;
    record.result = completed && !testInfo.errors.length && record.ocrSourceUnchanged ? 'PASS' : 'FAIL';
    const path = testInfo.outputPath('actual-paddle-cancel-receipt.json'); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await testInfo.attach('actual-paddle-cancel-receipt', { contentType: 'application/json', body: JSON.stringify(record) });
    expect(record.ocrSourceUnchanged).toBe(true);
  }
});
