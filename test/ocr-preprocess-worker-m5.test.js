import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalImagePreprocessor, IMAGE_PREPROCESS_TIMEOUTS } from '../js/ocr/preprocess-client.js';
import { createImagePreprocessWorker } from '../js/ocr/preprocess-worker.js';

// These tests run the actual client/handler with controlled Worker/Bitmap
// resources. They prove lifecycle/protocol behavior, not physical stop latency.
const REQUEST = 'fundval-image-preprocess-request', RESPONSE = 'fundval-image-preprocess-response';
const localFile = () => new Blob(['synthetic local image bytes'], { type: 'image/png' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
class Bitmap {
  constructor(width = 100, height = 200) { this.width = width; this.height = height; this.closed = 0; }
  close() { this.closed++; }
}
function globals(t, options = {}) {
  const descriptors = ['Worker', 'ImageBitmap', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const workers = [];
  Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: Bitmap });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: class {
    constructor(url, opts) { this.url = url; this.options = opts; this.messages = []; this.terminated = 0; workers.push(this); }
    postMessage(message) { this.messages.push(message); if (options.throwPost) throw new Error('private synthetic transport body'); }
    terminate() { this.terminated++; }
    reply(message, payload, status = 'success') {
      this.onmessage?.({ data: { kind: RESPONSE, requestId: message.requestId, type: message.type, status, payload } });
    }
  } });
  t.after(() => descriptors.forEach(([key, descriptor]) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }));
  return workers;
}
async function readyClient(t) {
  const workers = globals(t), client = createLocalImagePreprocessor(), pending = client.initialize(localFile());
  workers[0].reply(workers[0].messages[0], { width: 100, height: 200 });
  assert.deepEqual(await pending, { width: 100, height: 200 }); return { client, worker: workers[0] };
}
function handler(t, { decode, post } = {}) {
  globals(t); const output = [], calls = [], source = new Bitmap(), crop = new Bitmap(25, 30); let closed = 0;
  const processor = createImagePreprocessWorker({
    createBitmap: async (...args) => { calls.push(args); return decode ? decode(...args) : args.length > 2 ? crop : source; },
    postMessage: (message, transfer) => { if (post) post(message, transfer); output.push({ message, transfer }); },
    closeWorker: () => { closed++; },
  });
  const send = (requestId, type, payload = {}) => processor.handleMessage({ data: { kind: REQUEST, requestId, type, payload } });
  return { processor, send, output, calls, source, crop, closed: () => closed };
}

test('pre-aborted client creates no Worker and never exposes arbitrary abort reason', t => {
  const workers = globals(t), controller = new AbortController(); controller.abort(new Error('private screenshot abort'));
  assert.throws(() => createLocalImagePreprocessor({ signal: controller.signal }), error => {
    assert.equal(error.code, 'preprocess_aborted'); assert.doesNotMatch(error.message + error.stack, /private screenshot/); return true;
  });
  assert.equal(workers.length, 0);
});
test('client pins a same-origin module Worker and rejects nonlocal inputs before posting', async t => {
  const workers = globals(t), client = createLocalImagePreprocessor();
  assert.equal(workers[0].url.href, new URL('../js/ocr/preprocess-worker.js', import.meta.url).href);
  assert.equal(workers[0].options.type, 'module');
  for (const input of ['https://example.test/private.jpg', 'data:image/png;base64,private', new Uint8Array([1]), {}, new Blob([])]) {
    await assert.rejects(client.initialize(input), error => error.code === 'preprocess_invalid_input');
  }
  assert.equal(workers[0].messages.length, 0); client.dispose();
});
test('client has one in-flight request and validates source/crop bounds', async t => {
  const workers = globals(t), client = createLocalImagePreprocessor();
  const init = client.initialize(localFile());
  await assert.rejects(client.initialize(localFile()), error => error.code === 'preprocess_busy');
  await assert.rejects(client.crop({ x: 0, y: 0, width: 1, height: 1 }));
  workers[0].reply(workers[0].messages[0], { width: 100, height: 200 }); await init;
  for (const rect of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 99, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: '1', height: 1 },
    { x: 0, y: 0, width: 1, height: 1, url: 'private' }]) await assert.rejects(client.crop(rect), error => error.code === 'preprocess_invalid_input');
  const pending = client.crop({ x: 1, y: 2, width: 25, height: 30 });
  await assert.rejects(client.crop({ x: 0, y: 0, width: 1, height: 1 }), error => error.code === 'preprocess_busy');
  const bitmap = new Bitmap(25, 30); workers[0].reply(workers[0].messages[1], { imageBitmap: bitmap });
  assert.equal(await pending, bitmap); assert.equal(bitmap.closed, 0); bitmap.close(); client.dispose();
});
test('abort synchronously terminates and rejects an initialization that never replies', async t => {
  const workers = globals(t), controller = new AbortController(), client = createLocalImagePreprocessor({ signal: controller.signal });
  const pending = client.initialize(localFile()), checked = assert.rejects(pending, error => error.code === 'preprocess_aborted');
  controller.abort(); assert.equal(workers[0].terminated, 1); await checked;
  await assert.rejects(client.crop({ x: 0, y: 0, width: 1, height: 1 })); client.dispose();
  assert.equal(workers[0].terminated, 1);
});
test('dispose synchronously terminates an in-flight crop without waiting for its response', async t => {
  const { client, worker } = await readyClient(t), pending = client.crop({ x: 0, y: 0, width: 25, height: 30 });
  const checked = assert.rejects(pending, error => error.code === 'preprocess_disposed'); client.dispose();
  assert.equal(worker.terminated, 1); await checked; assert.equal(typeof worker.onmessage, 'function');
});
for (const type of ['initialize', 'crop']) test(`client ${type} deadline terminates the Worker and clears ownership`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, worker } = type === 'crop' ? await readyClient(t) : (() => {
    const workers = globals(t); return { client: createLocalImagePreprocessor(), worker: workers[0] };
  })();
  const pending = type === 'crop' ? client.crop({ x: 0, y: 0, width: 25, height: 30 }) : client.initialize(localFile());
  const checked = assert.rejects(pending, error => error.code === 'preprocess_timeout');
  t.mock.timers.tick(IMAGE_PREPROCESS_TIMEOUTS[type]); await checked; assert.equal(worker.terminated, 1); client.dispose();
});
test('foreign or late transferred bitmaps close without resolving an active request', async t => {
  const { client, worker } = await readyClient(t), pending = client.crop({ x: 0, y: 0, width: 25, height: 30 });
  const callback = worker.onmessage, foreign = new Bitmap(25, 30); let resolved = false;
  pending.then(() => { resolved = true; }, () => {});
  callback({ data: { kind: RESPONSE, requestId: 999, type: 'crop', status: 'success', payload: { imageBitmap: foreign } } });
  await flush(); assert.equal(foreign.closed, 1); assert.equal(resolved, false);
  const checked = assert.rejects(pending); client.dispose(); await checked;
  const late = new Bitmap(25, 30); callback({ data: { kind: RESPONSE, requestId: 2, type: 'crop', status: 'success', payload: { imageBitmap: late } } });
  assert.equal(late.closed, 1); assert.equal(resolved, false);
});
test('the installed post-dispose receiver closes a queued transferred bitmap without retaining business state', async t => {
  const { client, worker } = await readyClient(t), pending = client.crop({ x: 0, y: 0, width: 25, height: 30 });
  const checked = assert.rejects(pending); client.dispose(); await checked;
  const late = new Bitmap(25, 30);
  worker.onmessage?.({ data: { kind: RESPONSE, requestId: 2, type: 'crop', status: 'success', payload: { imageBitmap: late } } });
  assert.equal(late.closed, 1);
});
for (const errorCode of [null, { toString: null }]) test('malformed response error code cannot execute coercion or escape the fixed error boundary ' + JSON.stringify(errorCode), async t => {
  const workers = globals(t), client = createLocalImagePreprocessor(); let failure;
  client.initialize(localFile()).catch(error => { failure = error; });
  let thrown;
  try { workers[0].onmessage({ data: { kind: RESPONSE, requestId: 1, type: 'initialize', status: 'error', errorCode } }); }
  catch (error) { thrown = error; }
  await flush(); assert.equal(thrown, undefined); assert.equal(failure?.code, 'preprocess_invalid_response');
  assert.equal(workers[0].terminated, 1);
});
test('malformed active responses fail closed, sanitize errors and close an invalid bitmap', async t => {
  const { client, worker } = await readyClient(t), bitmap = new Bitmap(26, 30);
  const checked = assert.rejects(client.crop({ x: 0, y: 0, width: 25, height: 30 }), error => {
    assert.equal(error.code, 'preprocess_invalid_response'); assert.doesNotMatch(error.message + error.stack, /private/); return true;
  });
  worker.reply(worker.messages[1], { imageBitmap: bitmap, raw: 'private' }); await checked;
  assert.equal(bitmap.closed, 1); assert.equal(worker.terminated, 1);
});
test('postMessage throw and Worker failures are sanitized and terminate exactly once', async t => {
  const workers = globals(t, { throwPost: true }), client = createLocalImagePreprocessor();
  await assert.rejects(client.initialize(localFile()), error => {
    assert.equal(error.code, 'preprocess_worker_failed'); assert.doesNotMatch(error.message + error.stack, /private synthetic/); return true;
  });
  assert.equal(workers[0].terminated, 1); client.dispose();
});

test('actual worker keeps the source, transfers only requested crop, and closes source on destroy', async t => {
  const h = handler(t); await h.send(1, 'initialize', { file: localFile() });
  assert.deepEqual(h.output[0].message.payload, { width: 100, height: 200 }); assert.equal(h.source.closed, 0);
  await h.send(2, 'crop', { rect: { x: 1, y: 2, width: 25, height: 30 } });
  assert.deepEqual(h.calls[1], [h.source, 1, 2, 25, 30]);
  assert.deepEqual(h.output[1].transfer, [h.crop]); assert.equal(h.crop.closed, 0);
  await h.send(3, 'destroy'); assert.equal(h.source.closed, 1); assert.equal(h.closed(), 1);
  h.processor.dispose(); assert.equal(h.source.closed, 1); h.crop.close();
});
for (const [width, height] of [[0, 1], [4097, 4096], [Infinity, 1], [1.5, 100]]) test(`actual worker rejects unsafe decoded geometry ${width}x${height}`, async t => {
  const bitmap = new Bitmap(width, height), h = handler(t, { decode: async () => bitmap });
  await h.send(1, 'initialize', { file: localFile() });
  assert.equal(h.output[0].message.status, 'error'); assert.equal(bitmap.closed, 1); assert.equal(h.closed(), 1);
});
test('actual worker accepts exactly 16 Mi pixels without downscaling the source', async t => {
  const bitmap = new Bitmap(4096, 4096), h = handler(t, { decode: async () => bitmap });
  await h.send(1, 'initialize', { file: localFile() });
  assert.deepEqual(h.output[0].message.payload, { width: 4096, height: 4096 }); h.processor.dispose(); assert.equal(bitmap.closed, 1);
});
test('actual worker closes a late decoded bitmap and suppresses results after destroy', async t => {
  const held = deferred(), bitmap = new Bitmap(), h = handler(t, { decode: () => held.promise });
  const pending = h.send(1, 'initialize', { file: localFile() }); await flush();
  await h.send(2, 'destroy'); held.resolve(bitmap); await pending;
  assert.equal(bitmap.closed, 1); assert.equal(h.output.length, 0); assert.equal(h.closed(), 1);
});
test('actual worker cannot start compatibility decode after the lifecycle was destroyed', async t => {
  const held = deferred(), h = handler(t, { decode: () => held.promise });
  const pending = h.send(1, 'initialize', { file: localFile() }); await flush();
  await h.send(2, 'destroy'); held.reject(new Error('private image metadata')); await pending;
  assert.equal(h.calls.length, 1); assert.equal(h.output.length, 0);
});
test('actual worker retains genuine options-compatibility decode fallback', async t => {
  const bitmap = new Bitmap(), h = handler(t, { decode: async (...args) => {
    if (args.length > 1) throw new Error('synthetic option unsupported'); return bitmap;
  } });
  await h.send(1, 'initialize', { file: localFile() });
  assert.equal(h.calls.length, 2); assert.deepEqual(h.output[0].message.payload, { width: 100, height: 200 }); h.processor.dispose();
});
test('actual worker closes a crop whose transfer throws, and releases its source', async t => {
  let sends = 0; const h = handler(t, { post: () => { if (++sends === 2) throw new Error('private transfer error'); } });
  await h.send(1, 'initialize', { file: localFile() }); await h.send(2, 'crop', { rect: { x: 0, y: 0, width: 25, height: 30 } });
  assert.equal(h.crop.closed, 1); assert.equal(h.source.closed, 1); assert.equal(h.closed(), 1);
  assert.doesNotMatch(JSON.stringify(h.output), /private transfer/);
});
test('actual worker validates local Blob before any decode', async t => {
  const h = handler(t); await h.send(1, 'initialize', { file: 'https://example.test/private.png' });
  assert.equal(h.calls.length, 0); assert.equal(h.output[0].message.status, 'error');
  assert.doesNotMatch(JSON.stringify(h.output), /https:|private.png/);
});

test('actual worker rejects nonempty destroy payload instead of accepting an unknown protocol shape', async t => {
  const h = handler(t); await h.send(1, 'initialize', { file: localFile() });
  await h.send(2, 'destroy', { unknown: 'private synthetic body' });
  assert.equal(h.output[1]?.message.status, 'error');
  assert.equal(h.output[1]?.message.errorCode, 'preprocess_invalid_input');
  assert.equal(h.source.closed, 1); assert.doesNotMatch(JSON.stringify(h.output), /private synthetic/);
});
test('actual worker rejects out-of-order IDs and closes its owned source', async t => {
  const h = handler(t); await h.send(1, 'initialize', { file: localFile() });
  await h.send(3, 'crop', { rect: { x: 0, y: 0, width: 25, height: 30 } });
  assert.equal(h.calls.length, 1); assert.equal(h.output[1].message.errorCode, 'preprocess_invalid_input');
  assert.equal(h.source.closed, 1); assert.equal(h.closed(), 1);
});
for (const rect of [{ x: 99, y: 0, width: 25, height: 30 }, { x: 0, y: 0, width: 0, height: 1 },
  { x: 0, y: 1.5, width: 1, height: 1 }, { x: 0, y: 0, width: 25, height: 30, url: 'private' }]) {
  test('actual worker independently rejects invalid crop rectangle ' + JSON.stringify(rect), async t => {
    const h = handler(t); await h.send(1, 'initialize', { file: localFile() }); await h.send(2, 'crop', { rect });
    assert.equal(h.calls.length, 1); assert.equal(h.output[1].message.errorCode, 'preprocess_invalid_input');
    assert.equal(h.source.closed, 1); assert.doesNotMatch(JSON.stringify(h.output), /private/);
  });
}
test('actual worker closes a late crop after destroy without publishing it', async t => {
  const held = deferred(), source = new Bitmap(), crop = new Bitmap(25, 30);
  const h = handler(t, { decode: (...args) => args.length > 2 ? held.promise : Promise.resolve(source) });
  await h.send(1, 'initialize', { file: localFile() });
  const pending = h.send(2, 'crop', { rect: { x: 0, y: 0, width: 25, height: 30 } });
  await flush(); await h.send(3, 'destroy'); held.resolve(crop); await pending;
  assert.equal(source.closed, 1); assert.equal(crop.closed, 1); assert.equal(h.output.length, 1);
});
for (const kind of ['error', 'messageerror']) test(`client ${kind} is fixed-error-only and terminates its pending Worker`, async t => {
  const workers = globals(t), client = createLocalImagePreprocessor(), pending = client.initialize(localFile());
  const checked = assert.rejects(pending, error => {
    assert.equal(error.code, 'preprocess_worker_failed'); assert.doesNotMatch(error.message + error.stack, /private/); return true;
  });
  let prevented = false;
  workers[0][`on${kind}`]({ message: 'private screenshot filename', preventDefault() { prevented = true; } });
  await checked; assert.equal(workers[0].terminated, 1); assert.equal(prevented, kind === 'error');
});
test('client refuses an off-origin worker location before constructing a Worker', t => {
  const workers = globals(t);
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://foreign.example' } });
  assert.throws(() => createLocalImagePreprocessor(), error => error.code === 'preprocess_unsupported'); assert.equal(workers.length, 0);
});
test('actual client and actual handler exchange only dimensions then one transferred crop', async t => {
  const workers = globals(t), source = new Bitmap(), crop = new Bitmap(25, 30), client = createLocalImagePreprocessor();
  const worker = workers[0], requests = [], responses = [];
  const processor = createImagePreprocessWorker({ createBitmap: async (...args) => args.length > 2 ? crop : source,
    postMessage: (message, transfer) => { responses.push({ type: message.type, transferCount: transfer?.length || 0 });
      queueMicrotask(() => worker.onmessage?.({ data: message })); }, closeWorker() {},
  });
  worker.postMessage = message => { requests.push(message.type); queueMicrotask(() => { void processor.handleMessage({ data: message }); }); };
  assert.deepEqual(await client.initialize(localFile()), { width: 100, height: 200 });
  assert.equal(await client.crop({ x: 0, y: 0, width: 25, height: 30 }), crop);
  assert.deepEqual(requests, ['initialize', 'crop']);
  assert.deepEqual(responses, [{ type: 'initialize', transferCount: 0 }, { type: 'crop', transferCount: 1 }]);
  assert.equal(source.closed, 0); assert.equal(crop.closed, 0);
  client.dispose(); assert.equal(worker.terminated, 1);
  // Fake terminate cannot actually destroy a browser realm. Exercise the real
  // handler's cleanup separately, and leave the transferred crop to its caller.
  processor.dispose(); assert.equal(source.closed, 1); crop.close(); assert.equal(crop.closed, 1);
});
test('actual worker rejects a second request while decode is pending', async t => {
  const held = deferred(), h = handler(t, { decode: () => held.promise });
  const pending = h.send(1, 'initialize', { file: localFile() });
  await h.send(2, 'crop', { rect: { x: 0, y: 0, width: 1, height: 1 } });
  assert.ok(h.output.some(({ message }) => message.status === 'error' && message.errorCode === 'preprocess_busy'));
  h.processor.dispose(); const bitmap = new Bitmap(); held.resolve(bitmap); await pending; assert.equal(bitmap.closed, 1);
});
