import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertLightweightPaddleEntry, assertRelativePaddleWorkerUrl } from '../scripts/build-paddle-ocr.mjs';

test('PaddleOCR build accepts an engine-relative module Worker and rejects a root Worker', () => {
  const relativeEntry = 'return new Worker(new URL("assets/fundval-paddle-worker.js", import.meta.url));';
  assert.equal(
    assertRelativePaddleWorkerUrl(relativeEntry),
    'assets/fundval-paddle-worker.js'
  );
  assert.equal(
    assertRelativePaddleWorkerUrl('new URL("./assets/fundval-paddle-worker.js", import.meta.url)'),
    './assets/fundval-paddle-worker.js'
  );
  assert.throws(
    () => assertRelativePaddleWorkerUrl('new URL("/assets/fundval-paddle-worker.js", import.meta.url)'),
    /root-absolute Worker URL/
  );
  assert.throws(
    () => assertRelativePaddleWorkerUrl('new URL("assets/not-the-worker.js", import.meta.url)'),
    /expected same-origin module Worker URL/
  );
});

test('PaddleOCR page entry stays light and delegates heavy SDK work to the pinned official Worker', async () => {
  const [entry, build, officialWorker] = await Promise.all([
    readFile(new URL('../scripts/paddle-ocr-entry.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-paddle-ocr.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../node_modules/@paddleocr/paddleocr-js/dist/assets/worker-entry-C9UNuyOJ.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(entry, /import\s+\{\s*PaddleOCR\s*\}/);
  assert.match(entry, /new URL\(\/\* @vite-ignore \*\/ '\.\/assets\/fundval-paddle-worker\.js',\s*import\.meta\.url\)/);
  assert.match(entry, /new Worker\(workerUrl,\s*\{[\s\S]*type:\s*'module'/);
  assert.match(entry, /sources:\s*\[\{\s*kind:\s*'imageBitmap',\s*imageBitmap\s*\}\]/);
  assert.match(entry, /\},\s*\[imageBitmap\]\)/);
  assert.match(entry, /textDetectionBatchSize:\s*1/);
  assert.match(entry, /textRecognitionBatchSize:\s*1/);
  assertLightweightPaddleEntry('new Worker(new URL("./assets/fundval-paddle-worker.js", import.meta.url));');

  assert.match(build, /worker-entry-C9UNuyOJ\.js/);
  assert.match(build, /officialWorker\.byteLength < 10_000_000/);
  assert.match(officialWorker, /worker-transport-request/);
  assert.match(officialWorker, /worker-transport-response/);
  assert.match(officialWorker, /sourcePayloadToMat/);
});
