import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshGeneration, isRefreshAbort } from '../js/runtime/refresh-generation.js';

test('creates immutable refresh metadata and exposes one abort signal', () => {
  const refresh = createRefreshGeneration({
    generation: 7,
    trigger: 'visibility',
    startedAt: Date.parse('2026-08-25T01:02:03.000Z'),
  });

  assert.equal(refresh.generation, 7);
  assert.equal(refresh.requestId, `refresh-7-${Date.parse('2026-08-25T01:02:03.000Z')}`);
  assert.equal(refresh.startedAt, '2026-08-25T01:02:03.000Z');
  assert.equal(refresh.trigger, 'visibility');
  assert.equal(refresh.aborted, false);
  assert.equal(Object.isFrozen(refresh), true);

  refresh.abort('superseded');
  refresh.abort('ignored');
  assert.equal(refresh.aborted, true);
  assert.equal(refresh.abortReason, 'superseded');
  assert.equal(isRefreshAbort(new Error('ordinary'), refresh.signal), true);
});

test('rejects invalid generations and recognizes standard abort errors', () => {
  assert.throws(() => createRefreshGeneration({ generation: 0 }), /positive safe integer/);
  assert.throws(() => createRefreshGeneration({ generation: 1.5 }), /positive safe integer/);
  assert.equal(isRefreshAbort({ name: 'AbortError' }), true);
  assert.equal(isRefreshAbort({ code: 'ABORT_ERR' }), true);
  assert.equal(isRefreshAbort({ aborted: true }), true);
  assert.equal(isRefreshAbort(new Error('timeout')), false);
});
