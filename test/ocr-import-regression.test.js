import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('OCR import runs in an isolated local-only document and remains confirmation-gated', async () => {
  const [app, page, localOcr, paddleOcr, layout, plan, catalog, index, importPage, build, workflow, sw] = await Promise.all([
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ocr-import-page.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/local-ocr.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/paddle-local-ocr.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ocr-table-layout.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/holding-import-plan.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/fund-catalog.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ocr-import.html', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /window\.location\.assign\('ocr-import\.html'\)/);
  assert.doesNotMatch(app, /^import .*local-ocr/m);
  assert.doesNotMatch(app, /ocr-import-page\.js/);
  assert.doesNotMatch(index, /ocr-image-input|ocr-import-modal|image\/png,image\/jpeg,image\/webp/);
  assert.doesNotMatch(index, /assets\/ocr|tesseract/i);
  assert.match(importPage, /src="js\/ocr-import-page\.js"/);
  assert.match(importPage, /href="css\/ocr\.css"/);
  assert.match(importPage, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(importPage, /Content-Security-Policy/);
  assert.match(importPage, /default-src 'none'; script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(importPage, /worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(importPage, /unsafe-inline/);
  assert.doesNotMatch(importPage, /bootstrap\.js|app\.js|https?:\/\/|preconnect/i);
  assert.match(page, /import\('\.\/paddle-local-ocr\.js'\)/);
  assert.match(page, /reconstructOcrTableLayout/);
  assert.match(page, /let activeRecognitionTask = null/);
  assert.match(page, /if \(!file \|\| activeRecognitionTask\) return/);
  assert.match(page, /setRecognitionControlsDisabled\(true\)/);
  assert.match(page, /finally \{\s*finishRecognitionTask\(task\)/);
  assert.match(page, /\['ocr-image-input', 'ocr-import-pick', 'ocr-import-retry', 'ocr-import-confirm'\]/);
  assert.match(paddleOcr, /assertPaddleOcrBrowserCapabilities\(\)/);
  assert.match(paddleOcr, /Worker[\s\S]*createImageBitmap[\s\S]*OffscreenCanvas[\s\S]*WebAssembly[\s\S]*structuredClone/);
  assert.match(paddleOcr, /Android 请升级到最新版 Chrome/);
  assert.doesNotMatch(page, /sourceHint\s*:/);
  assert.doesNotMatch(page, /document\.createElement\(['"]script|https?:\/\/qt\.gtimg|https?:\/\/fund\.eastmoney/i);
  assert.match(page, /backupHoldings\(previousHoldings\)/);
  assert.match(page, /runStartupIntegrityChecks\(globalThis\.localStorage\)/);
  assert.match(page, /safeSetItem\(OCR_IMPORT_PENDING_KEY, '1'\)/);
  assert.ok(
    page.indexOf("safeSetItem(OCR_IMPORT_PENDING_KEY, '1')") < page.indexOf('safeSetItem(STORAGE_KEY, JSON.stringify(result.holdings))'),
    'the recoverable sync flag must be persisted before canonical holdings are changed'
  );
  assert.match(page, /catch \(_\) \{\s*safeRemoveItem\(OCR_IMPORT_PENDING_KEY\)/);
  assert.match(page, /window\.location\.replace\('\.\/\?ocr_import=1'\)/);
  assert.match(app, /consumeOcrImportReturn/);
  assert.match(app, /safeGetItem\(OCR_IMPORT_PENDING_KEY\) === '1'/);
  assert.match(localOcr, /new URL\('\.\.\/assets\/ocr\/tesseract\/worker\.min\.js', import\.meta\.url\)/);
  assert.match(localOcr, /workerBlobURL:\s*false/);
  assert.match(localOcr, /cacheMethod:\s*'none'/);
  assert.doesNotMatch(localOcr, /https?:\/\/|data:image|fetch\(/i);
  assert.match(paddleOcr, /paddle-ocr-engine\.mjs/);
  assert.match(paddleOcr, /PP-OCRv6_tiny_det_onnx_infer\.tar/);
  assert.match(paddleOcr, /numThreads:\s*1/);
  assert.doesNotMatch(paddleOcr, /https?:\/\/|data:image|fetch\(|localStorage|indexedDB/i);
  assert.doesNotMatch(layout, /fetch\(|localStorage|indexedDB|document\./i);
  assert.match(catalog, /FUND_CATALOG_PATH/);
  assert.match(catalog, /credentials:\s*'same-origin'/);
  assert.doesNotMatch(catalog, /https?:\/\/|document\.createElement\(['"]script|base64|localStorage|indexedDB/i);
  assert.doesNotMatch(catalog, /\b(?:File|Blob)\b/);
  assert.match(plan, /number != null && number > 0/);
  assert.match(plan, /row\.action === 'skip'/);
  assert.match(importPage, /确认并同步/);
  assert.match(importPage, /GitHub Gist/);
  assert.match(build, /tesseract\.esm\.min\.js/);
  assert.match(build, /chi_sim\.traineddata\.gz/);
  assert.match(build, /onnxruntime-web-MIT\.txt/);
  assert.match(build, /clipper-lib-BSL-1\.0\.txt/);
  assert.match(build, /chi_sim-MIT\.txt/);
  assert.match(build, /ocr-import\.html/);
  assert.match(build, /buildPaddleOcrAssets/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /site\/assets\/ocr\/tessdata\/chi_sim\.traineddata\.gz/);
  assert.match(workflow, /site\/assets\/ocr\/paddle\/engine\/paddle-ocr-engine\.mjs/);
  assert.match(workflow, /PP-OCRv6_tiny_det_onnx_infer\.tar/);
  assert.match(workflow, /Verify Pages publishing mode/);
  assert.match(workflow, /\.build_type['"]?\)" = workflow/);
  assert.match(workflow, /Smoke-test deployed OCR assets/);
  assert.match(workflow, /engine\/assets\/fundval-paddle-worker\.js/);
  assert.match(workflow, /ort-wasm-simd-threaded\.jsep\.wasm/);
  assert.match(workflow, /--retry 12 --retry-all-errors --retry-delay 5/);
  const core = sw.slice(sw.indexOf('const CORE'), sw.indexOf('self.addEventListener'));
  assert.doesNotMatch(core, /assets\/ocr/);
  assert.match(sw, /url\.pathname\.includes\('\/assets\/ocr\/'\)[\s\S]*networkOnly\(event\.request\)/);
});
