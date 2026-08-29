import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('OCR v15 keeps the 16 MP safety gate and adds dynamic viewport fallback ordering', async () => {
  const [paddle, css, page] = await Promise.all([
    readFile(new URL('../js/paddle-local-ocr.js', import.meta.url), 'utf8'),
    readFile(new URL('../css/ocr.css', import.meta.url), 'utf8'),
    readFile(new URL('../js/ocr-import-page.js', import.meta.url), 'utf8'),
  ]);
  assert.match(paddle, /MAX_SOURCE_IMAGE_PIXELS = 16 \* 1024 \* 1024/);
  assert.match(paddle, /imageWidth \* imageHeight > MAX_SOURCE_IMAGE_PIXELS/);
  assert.match(paddle, /截图像素过大，请裁剪为较短的截图后重试/);
  const vh = css.indexOf('calc(100vh - 24px)');
  const dvh = css.indexOf('calc(100dvh - 24px)');
  assert.ok(vh >= 0 && dvh > vh, '100vh must remain the fallback before 100dvh');
  assert.match(page, /placeholder="未填写（--）"/);
  assert.match(page, /catalogLoadMs/);
  assert.match(page, /matchMs/);
  assert.match(page, /commitMs/);
  assert.doesNotMatch(page, /ocrText.*recordOcrPerformance|holdingAmount.*recordOcrPerformance/);
});
