import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPaddleOcr, createWorkerClient } from '../scripts/paddle-ocr-entry.mjs';
import { LocalOcrEngine } from '../js/ocr/engine.js';

function mockWorker(t) {
  const original = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.messages = []; this.terminated = 0; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated += 1; }
    reply(index, payload = {}) {
      this.onmessage?.({ data: { kind: 'worker-transport-response',
        requestId: this.messages[index].requestId, status: 'success', payload } });
    }
  };
  t.after(() => {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  });
  return workers;
}

for (const operation of ['init', 'predict', 'dispose']) {
  test(`a silent worker ${operation} reaches its deadline, terminates, and rejects further requests`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const workers = mockWorker(t);
    const client = createWorkerClient({ timeouts: { [operation]: 20 } });
    const checked = assert.rejects(client.request(operation), /timed out/);
    t.mock.timers.tick(20);
    await checked;
    assert.equal(workers[0].terminated, 1);
    assert.equal(workers[0].onmessage, null);
    await assert.rejects(client.request('predict'), /disposed/);
    client.terminate();
    assert.equal(workers[0].terminated, 1);
  });
}

test('successful worker reply clears the deadline and cancellation terminates remaining work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = mockWorker(t);
  const controller = new AbortController();
  const client = createWorkerClient({ signal: controller.signal, timeouts: { init: 20, predict: 20 } });
  const initialized = client.request('init');
  workers[0].reply(0, { ready: true });
  assert.deepEqual(await initialized, { ready: true });
  t.mock.timers.tick(20);
  assert.equal(workers[0].terminated, 0);
  const checked = assert.rejects(client.request('predict'), /cancelled/);
  controller.abort();
  await checked;
  assert.equal(workers[0].terminated, 1);
  t.mock.timers.tick(20);
  assert.equal(workers[0].terminated, 1);
});

test('disposing the facade aborts active recognition before waiting for engine cleanup', async t => {
  const workers = mockWorker(t);
  // Use the real engine lifecycle and worker backend, but synthetic WASM
  // capability and image data. No OCR models or personal screenshots are used.
  const capabilities = {
    baseline: { supported: true },
    wasm: { supported: true },
    webgpu: { supported: false },
  };
  const initializing = createLocalPaddleOcr({ createEngine: options => new LocalOcrEngine({
    ...options, detectCapabilities: () => capabilities,
  }) });
  for (let index = 0; index < 12 && !workers[0]?.messages.length; index += 1) await Promise.resolve();
  assert.equal(workers.length, 1);
  workers[0].reply(0, { summary: { detProvider: 'wasm', recProvider: 'wasm' } });
  const facade = await initializing;
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ synthetic: true });
  t.after(() => {
    if (previousBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previousBitmap;
  });
  const prediction = assert.rejects(facade.predict(new Blob(['synthetic'])), /worker operation failed/);
  for (let index = 0; index < 12 && workers[0].messages.length < 2; index += 1) await Promise.resolve();
  assert.equal(workers[0].messages[1].type, 'predict');
  await facade.dispose();
  await prediction;
  assert.equal(workers[0].terminated, 1);
});
