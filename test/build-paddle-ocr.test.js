import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRelativePaddleWorkerUrl } from '../scripts/build-paddle-ocr.mjs';

test('PaddleOCR build accepts an engine-relative module Worker and rejects a root Worker', () => {
  const relativeEntry = 'return new URL("assets/worker-entry-C9UNuyOJ-EhIzhVdm.js", import.meta.url);';
  assert.equal(
    assertRelativePaddleWorkerUrl(relativeEntry),
    'assets/worker-entry-C9UNuyOJ-EhIzhVdm.js'
  );
  assert.equal(
    assertRelativePaddleWorkerUrl('new URL("./assets/worker-entry-C9UNuyOJ.js", import.meta.url)'),
    './assets/worker-entry-C9UNuyOJ.js'
  );
  assert.throws(
    () => assertRelativePaddleWorkerUrl('new URL("/assets/worker-entry-C9UNuyOJ.js", import.meta.url)'),
    /root-absolute Worker URL/
  );
  assert.throws(
    () => assertRelativePaddleWorkerUrl('new URL("assets/not-the-worker.js", import.meta.url)'),
    /expected same-origin module Worker URL/
  );
});
