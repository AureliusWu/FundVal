import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPaddleOcr, createWorkerClient } from '../scripts/paddle-ocr-entry.mjs';
import { LocalOcrEngine, OCR_ENGINE_ERROR } from '../js/ocr/engine.js';

// Actual facade/engine/transport with controlled resources. No real OCR,
// bitmap decoder, model, browser, network or timing/device proof is involved.
const capabilities = webgpu => ({ baseline: { supported: true }, wasm: { supported: true }, webgpu: { supported: webgpu } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  for (let count = 0; count < 80 && !predicate(); count++) await Promise.resolve();
  assert.ok(predicate(), 'synthetic operation reached its controlled await');
}
function resources(t, { init = 'success', predict = 'success', bitmap } = {}) {
  const keys = ['Worker', 'ImageBitmap', 'createImageBitmap'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const workers = [], decoded = [];
  class SyntheticBitmap {
    closeCalls = 0;
    close() { this.closeCalls++; }
  }
  globalThis.ImageBitmap = SyntheticBitmap;
  globalThis.createImageBitmap = async image => {
    decoded.push(image);
    return bitmap ? bitmap(image) : new SyntheticBitmap();
  };
  globalThis.Worker = class {
    constructor() { this.messages = []; this.terminated = 0; workers.push(this); }
    postMessage(message, transferables) {
      this.messages.push({ ...message, transferables });
      if (message.type === 'init' && init === 'hold') return;
      if (message.type === 'predict' && predict === 'throw') throw new Error('private synthetic transfer body');
      queueMicrotask(() => {
        if (message.type === 'init') {
          const selected = message.payload.options.ortOptions.backend;
          this.reply(message, init === 'fail-webgpu' && selected === 'webgpu' ? null
            : { summary: { detProvider: selected, recProvider: selected } });
        } else if (message.type === 'predict') this.reply(message, predict === 'failure' ? null : []);
        else this.reply(message, {});
      });
    }
    reply(message, payload) {
      this.onmessage?.({ data: { kind: 'worker-transport-response', requestId: message.requestId,
        status: payload === null ? 'error' : 'success', payload, errorCode: 'engine-failure' } });
    }
    terminate() { this.terminated++; }
  };
  t.after(() => keys.forEach((key, index) => {
    if (originals[index]) Object.defineProperty(globalThis, key, originals[index]);
    else delete globalThis[key];
  }));
  return { workers, decoded, SyntheticBitmap };
}
const facade = (signal, webgpu = false) => createLocalPaddleOcr({ signal,
  createEngine: options => new LocalOcrEngine({ ...options, detectCapabilities: () => capabilities(webgpu) }) });

test('already-aborted worker client constructs no Worker and exposes no raw abort reason', t => {
  const { workers } = resources(t), controller = new AbortController();
  controller.abort(new Error('private synthetic cancellation reason'));
  assert.throws(() => createWorkerClient({ signal: controller.signal }), error => {
    assert.match(error.message, /cancelled/);
    assert.doesNotMatch(error.message + error.stack, /private synthetic/); return true;
  });
  assert.equal(workers.length, 0);
});

test('already-aborted facade never constructs its engine or a Worker', async t => {
  const { workers } = resources(t), controller = new AbortController(); let created = 0;
  controller.abort();
  await assert.rejects(createLocalPaddleOcr({ signal: controller.signal, createEngine: () => {
    created++; return new LocalOcrEngine({ detectCapabilities: () => capabilities(true) });
  } }));
  assert.equal(created, 0); assert.equal(workers.length, 0);
});

test('cancelling the actual WebGPU init terminates its only Worker without WASM fallback', async t => {
  const { workers } = resources(t, { init: 'hold' }), controller = new AbortController();
  const initializing = facade(controller.signal, true);
  const checked = assert.rejects(initializing);
  await until(() => workers[0]?.messages.some(message => message.type === 'init'));
  controller.abort(); await checked;
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, 1);
  assert.equal(workers[0].messages.filter(message => message.type === 'init').length, 1);
});

test('a real WebGPU initialization failure still releases once then initializes one WASM fallback', async t => {
  const { workers } = resources(t, { init: 'fail-webgpu' });
  const selected = await facade(undefined, true);
  assert.equal(workers.length, 2); assert.equal(workers[0].terminated, 1);
  assert.equal(selected.performance.backend, 'wasm'); assert.equal(selected.performance.fallback, true);
  await selected.dispose(); assert.equal(workers[1].terminated, 1);
});

for (const outcome of ['success', 'failure', 'throw']) test(`backend-owned decoded bitmap closes once after predict ${outcome}`, async t => {
  const { workers, decoded, SyntheticBitmap } = resources(t, { predict: outcome });
  const owned = new SyntheticBitmap(); globalThis.createImageBitmap = async image => { decoded.push(image); return owned; };
  const selected = await facade(); const local = new Blob(['synthetic local bytes']);
  if (outcome === 'success') assert.deepEqual(await selected.predict(local), []);
  else await assert.rejects(selected.predict(local), error => {
    assert.doesNotMatch(error.message + error.stack, /private synthetic/); return true;
  });
  assert.equal(decoded.length, 1); assert.equal(owned.closeCalls, 1);
  assert.deepEqual(workers[0].messages.find(message => message.type === 'predict').transferables, [owned]);
  await selected.dispose(); assert.equal(workers[0].terminated, 1);
});

test('a borrowed transferable crop is never closed by the backend owner', async t => {
  const { workers, decoded, SyntheticBitmap } = resources(t), crop = new SyntheticBitmap();
  const selected = await facade();
  assert.deepEqual(await selected.predict(crop), []);
  assert.equal(decoded.length, 0); assert.equal(crop.closeCalls, 0);
  assert.deepEqual(workers[0].messages.find(message => message.type === 'predict').transferables, [crop]);
  await selected.dispose(); assert.equal(crop.closeCalls, 0);
  crop.close(); assert.equal(crop.closeCalls, 1);
});

test('an owned bitmap resolving after cancellation closes without any predict dispatch', async t => {
  const decoding = deferred(), { workers, decoded, SyntheticBitmap } = resources(t, { bitmap: () => decoding.promise });
  const controller = new AbortController(), selected = await facade(controller.signal), owned = new SyntheticBitmap();
  const prediction = selected.predict(new Blob(['synthetic bytes']));
  const checked = assert.rejects(prediction);
  await until(() => decoded.length === 1); controller.abort(); decoding.resolve(owned);
  await checked;
  assert.equal(workers[0].terminated, 1);
  assert.equal(workers[0].messages.filter(message => message.type === 'predict').length, 0);
  assert.equal(owned.closeCalls, 1); await selected.dispose();
});

test('a queued recognition after abort cannot start a fresh bitmap decode', async t => {
  const { decoded } = resources(t), controller = new AbortController(), selected = await facade(controller.signal);
  controller.abort(); await assert.rejects(selected.predict(new Blob(['synthetic bytes'])));
  assert.equal(decoded.length, 0); await selected.dispose();
});

test('engine cancellation between awaited factory and initialize releases candidate without starting it', async () => {
  const held = deferred(), controller = new AbortController(); let starts = 0, disposals = 0, wasm = 0;
  const engine = new LocalOcrEngine({ signal: controller.signal, detectCapabilities: () => capabilities(true), backends: {
    webgpu: async () => { await held.promise; return { async initialize() { starts++; }, async recognize() {}, async dispose() { disposals++; } }; },
    wasm: () => { wasm++; return { async recognize() {} }; },
  } });
  const checked = assert.rejects(engine.initialize(), error => error.code === OCR_ENGINE_ERROR.CANCELLED);
  controller.abort(); held.resolve(); await checked;
  assert.equal(starts, 0); assert.equal(disposals, 1); assert.equal(wasm, 0);
});

test('engine cancellation during awaited compatibility cannot publish ready or use fallback', async () => {
  const held = deferred(), controller = new AbortController(); let compatibility = false, disposals = 0, wasm = 0;
  const engine = new LocalOcrEngine({ signal: controller.signal, detectCapabilities: () => capabilities(true), backends: {
    webgpu: () => ({ async recognize() {}, async isModelCompatible() { compatibility = true; await held.promise; return true; },
      async dispose() { disposals++; } }),
    wasm: () => { wasm++; return { async recognize() {} }; },
  } });
  const checked = assert.rejects(engine.initialize(), error => error.code === OCR_ENGINE_ERROR.CANCELLED);
  await until(() => compatibility); controller.abort(); held.resolve(); await checked;
  assert.notEqual(engine.state, 'ready'); assert.equal(disposals, 1); assert.equal(wasm, 0);
});
