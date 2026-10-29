import { expect, test } from '@playwright/test';

// Actual independent OCR page/layout with synthetic positioned recognition.
// No real image, OCR model, finance provider, Gist or physical-device evidence.
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const catalog = Array.from({ length: 15 }, (_, index) => ({ code: String(index + 1).padStart(6, '0'), name: `合成验证${String(index + 1).padStart(2, '0')}混合A` }));
const token = (text, x0, y0, x1 = x0 + 180, region = 'holdings') => ({ text, x0, y0, x1, y1: y0 + 24, score: 0.99, region });
const recognition = { engine: 'synthetic-test', imageWidth: 1440, imageHeight: 9317,
  tokens: [token('支付宝', 40, 8, 160, 'source'), token('我的持有', 40, 40, 180, 'source'),
    token('名称', 60, 100, 140), token('金额/昨日收益', 640, 100, 840), token('持有收益/率', 1060, 100, 1260),
    ...catalog.flatMap((fund, index) => { const y = 160 + index * 400; return [
      token(fund.name, 55, y, 400), token('100.00', 670, y, 790), token('+0.00', 690, y + 40, 790),
      token('-1.00', 1110, y, 1240), token('-1.00%', 1110, y + 40, 1240),
    ]; })], performance: { backend: 'wasm', blockCount: 80 } };
async function preview(page, { trustedLayout = true, seed = false, holdRecognition = false } = {}) {
  const unexpected = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || url.pathname.includes('/__fundval_dev/') || url.pathname.includes('/assets/ocr/')) {
      unexpected.push(url.origin === ORIGIN ? 'unexpected_ocr_or_provider' : 'external');
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname.endsWith('/js/paddle-local-ocr.js')) {
      const output = trustedLayout ? recognition : { ...recognition, tokens: recognition.tokens.filter(item => item.y0 !== 100) };
      const body = holdRecognition
        ? `export async function recognizeAlipayPaddleImage(file,{signal}){window.__syntheticOcr={aborted:false}; await new Promise(resolve=>{window.__syntheticOcr.finish=resolve;signal.addEventListener('abort',()=>{window.__syntheticOcr.aborted=true;},{once:true})}); return ${JSON.stringify(output)}}`
        : `export async function recognizeAlipayPaddleImage(){return ${JSON.stringify(output)}}`;
      await route.fulfill({ contentType: 'text/javascript', body }); return;
    }
    if (url.pathname.endsWith('/data/fund-catalog.json')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) }); return;
    }
    await route.continue();
  });
  await page.goto('/ocr-import.html');
  await expect(page.locator('#ocr-import-pick')).toBeVisible();
  if (seed) await page.evaluate(async () => {
    const { canonicalHoldingsDocument } = await import('./js/storage/holdings-schema.js');
    const now = '2026-10-25T08:00:00.000Z';
    const holding = (code, shares, costNav, note) => ({ id: `fund:${code}`, fundCode: code,
      fundName: code === '000001' ? '合成验证01混合A' : '截图外合成持仓', shares, costNav,
      createdAt: now, updatedAt: now, deletedAt: null, revision: 1, deviceId: 'synthetic:ocr', note });
    localStorage.setItem('fuyu_device_id_v1', 'synthetic:ocr');
    localStorage.setItem('fuyu_holdings_v3', canonicalHoldingsDocument({ schema: 3, deviceId: 'synthetic:ocr', updatedAt: now,
      holdings: [holding('000001', 100, null, 'existing-note'), holding('900001', 77, 0, 'outside-note')] }));
  });
  await page.locator('#ocr-image-input').setInputFiles({ name: 'synthetic-layout.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  if (holdRecognition) await page.waitForFunction(() => typeof window.__syntheticOcr?.finish === 'function');
  else await expect(page.locator('.ocr-candidate')).toHaveCount(15);
  expect(unexpected).toEqual([]);
}

test('OCR cancel keeps retry locked until the current task really settles and rejects late preview', async ({ page }) => {
  await preview(page, { holdRecognition: true });
  await page.locator('#ocr-import-cancel').click();
  expect(await page.evaluate(() => window.__syntheticOcr.aborted)).toBe(true);
  await expect(page.locator('#ocr-import-cancel')).toBeDisabled();
  await expect(page.locator('#ocr-import-retry')).toBeDisabled();
  await expect(page.locator('#ocr-import-status')).toContainText('正在取消');
  await page.evaluate(() => window.__syntheticOcr.finish());
  await expect(page.locator('#ocr-import-pick')).toBeEnabled();
  await expect(page.locator('#ocr-import-pick')).toBeVisible();
  await expect(page.locator('#ocr-import-status')).toContainText('已取消');
  await expect(page.locator('.ocr-candidate')).toHaveCount(0);
});

test('OCR dirty preview blocks peer update and requires explicit discard before leaving', async ({ page }) => {
  await preview(page);
  const peerBlocked = await page.evaluate(() => new Promise(resolve => {
    const channel = new BroadcastChannel('fuyu_sw_update_v1');
    const timer = setTimeout(() => { channel.close(); resolve(false); }, 1500);
    channel.onmessage = event => {
      if (event.data?.type === 'blocked' && event.data.requestId === 'sw-synthetic-ocr-peer') {
        clearTimeout(timer); channel.close(); resolve(true);
      }
    };
    channel.postMessage({ type: 'prepare', requestId: 'sw-synthetic-ocr-peer' });
  }));
  expect(peerBlocked).toBe(true);
  const cancelled = page.waitForEvent('dialog');
  const cancelClick = page.locator('#ocr-import-close').click({ noWaitAfter: true });
  await (await cancelled).dismiss();
  await cancelClick;
  await expect(page.locator('.ocr-candidate')).toHaveCount(15);
  expect(new URL(page.url()).pathname).toBe('/ocr-import.html');
  const leaving = page.waitForEvent('dialog');
  const leaveClick = page.locator('#ocr-import-close').click({ noWaitAfter: true });
  await (await leaving).accept();
  await leaveClick;
  await page.waitForURL('**/');
});

const storedDocument = page => page.evaluate(() => JSON.parse(localStorage.getItem('fuyu_holdings_v3')));
test('OCR risk row requires a real independent enable event before actual locked commit', async ({ page }) => {
  await preview(page, { trustedLayout: false, seed: true });
  const row = page.locator('.ocr-candidate').first();
  const enable = row.locator('[data-field="enable"]');
  const action = row.locator('[data-field="action"]');
  await expect(action).toHaveValue('skip');
  await expect(enable).not.toBeChecked();
  await expect(row.locator('[data-field="shares"]')).toHaveValue('100');
  const baseline = await storedDocument(page);
  await row.locator('[data-field="shares"]').fill('200');
  await action.selectOption('update');
  await page.locator('#ocr-import-ack').check();
  await page.locator('#ocr-import-confirm').click();
  await expect(row.locator('[data-field="error"]')).toContainText('启用此行');
  expect(await storedDocument(page)).toEqual(baseline);
  // Merely changing a DOM checkbox property does not authorize the memory plan.
  await enable.evaluate(element => { element.checked = true; });
  await page.locator('#ocr-import-confirm').click();
  await expect(row.locator('[data-field="error"]')).toContainText('启用此行');
  expect(await storedDocument(page)).toEqual(baseline);
  await enable.evaluate(element => { element.checked = false; });
  await enable.check();
  await expect(action).toHaveValue('update');
  await page.locator('#ocr-import-confirm').click();
  await page.waitForURL('**/?ocr_import=1');
  const result = await storedDocument(page);
  expect(result.holdings.map(item => item.fundCode)).toEqual(['000001', '900001']);
  expect(result.holdings[0].shares).toBe(200);
  expect(result.holdings[0].costNav).toBeNull();
  expect(result.holdings[0].note).toBe('existing-note');
  expect(result.holdings[1]).toEqual(baseline.holdings[1]);
  expect(JSON.stringify(result)).not.toMatch(/explicitlyEnabled|approvedIdentity|riskReasons/);
});

test('OCR actual identity edits and candidate selection revoke the row grant', async ({ page }) => {
  await preview(page, { trustedLayout: false, seed: true });
  const row = page.locator('.ocr-candidate').first();
  const enable = row.locator('[data-field="enable"]');
  const action = row.locator('[data-field="action"]');
  await enable.check();
  await row.locator('[data-field="candidate"]').selectOption('000001|合成验证01混合A');
  await expect(enable).not.toBeChecked();
  await expect(action).toHaveValue('skip');
  await enable.check();
  await row.locator('[data-field="name"]').fill('人工修改的合成身份');
  await expect(enable).not.toBeChecked();
  await expect(action).toHaveValue('skip');
  const baseline = await storedDocument(page);
  await action.selectOption('update');
  await page.locator('#ocr-import-ack').check();
  await page.locator('#ocr-import-confirm').click();
  await expect(row.locator('[data-field="error"]')).toContainText('启用此行');
  expect(await storedDocument(page)).toEqual(baseline);
});
for (const width of [320, 360, 390]) {
  test(`OCR ${width}px actual preview has usable form sizes and no horizontal overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 }); await preview(page);
    await page.screenshot({ path: testInfo.outputPath(`synthetic-ocr-${width}.png`) });
    const sizes = await page.locator('.ocr-candidate input.f-input, .ocr-candidate select').evaluateAll(elements => elements.map(element => ({
      font: parseFloat(getComputedStyle(element).fontSize), height: element.getBoundingClientRect().height,
    })));
    for (const size of sizes) { expect(size.font).toBeGreaterThanOrEqual(16); expect(size.height).toBeGreaterThanOrEqual(44); }
    const close = await page.locator('#ocr-import-close').boundingBox();
    expect(close.width).toBeGreaterThanOrEqual(44); expect(close.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.locator('.ocr-modal').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
  test(`OCR ${width}px confirmation remains visible at the start and end of a long preview`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); await preview(page);
    const modal = page.locator('.ocr-modal');
    await modal.evaluate(element => { element.scrollTop = 0; });
    await expect(page.locator('#ocr-import-confirm')).toBeInViewport({ ratio: 1 });
    await modal.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('#ocr-import-confirm')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.ocr-candidate').last()).toBeInViewport();
  });
}
