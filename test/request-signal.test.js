import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestSignal, throwIfAborted } from '../js/runtime/request-signal.js';

test('caller cancellation remains an AbortError', () => {
  const caller = new AbortController();
  const request = createRequestSignal(caller.signal, 10_000);
  caller.abort('superseded');
  const normalized = request.normalizeError(Object.assign(new Error('native abort'), { name: 'AbortError' }));
  request.cleanup();

  assert.equal(request.signal.aborted, true);
  assert.equal(normalized.name, 'AbortError');
  assert.equal(normalized.code, 'ABORT_ERR');
  assert.throws(() => throwIfAborted(caller.signal), { name: 'AbortError' });
});

test('internal timeout is a source failure instead of a caller abort', async () => {
  const request = createRequestSignal(null, 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  const normalized = request.normalizeError(Object.assign(new Error('native abort'), { name: 'AbortError' }));
  request.cleanup();

  assert.equal(request.signal.aborted, true);
  assert.equal(normalized.name, 'TimeoutError');
  assert.equal(normalized.code, 'REQUEST_TIMEOUT');
  assert.equal(normalized.timeoutMs, 1);
});
