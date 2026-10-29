import test from 'node:test';
import assert from 'node:assert/strict';
import { syncOutcome, syncRetry } from '../js/runtime/sync-policy.js';

test('verified requires a successful readback and no newer pending content', () => {
  assert.equal(syncOutcome({ ok: true }).state, 'pending');
  assert.equal(syncOutcome({ ok: true, patched: true }).state, 'pending');
  assert.equal(syncOutcome({ ok: true, remoteVerified: true }).state, 'verified');
  assert.equal(syncOutcome({ ok: true, remoteVerified: true, pending: true }).state, 'pending');
  assert.equal(syncOutcome({ ok: true, remoteVerified: true }, true).state, 'pending');
});

test('fixed safe states distinguish readonly/conflict/configuration failures', () => {
  assert.deepEqual(syncOutcome({ ok: false, reason: 'remote_schema_future' }),
    { state: 'readonly', code: 'newer_schema', retryable: false, retryAfterMs: 0, readFirst: false });
  for (const [status, state, code] of [[401, 'failed', 'auth'], [403, 'failed', 'permission'],
    [404, 'failed', 'missing'], [409, 'conflict', 'conflict'], [429, 'failed', 'rate_limit'], [503, 'failed', 'unavailable']]) {
    const result = syncOutcome({ ok: false, reason: `remote_http_${status}` });
    assert.equal(result.state, state); assert.equal(result.code, code);
  }
});

test('unknown or acknowledged-but-unverified writes retry by reading, never blindly writing', () => {
  for (const value of [{ writeUnknown: true }, { patched: true }, { patchAcknowledged: true }]) {
    const model = syncOutcome({ ok: false, reason: 'remote_read_failed', ...value });
    assert.equal(model.readFirst, true); assert.equal(model.state, 'failed');
  }
});

test('arbitrary exception bodies, tokens and content never enter the status DTO', () => {
  const model = syncOutcome({ ok: false, reason: 'synthetic-private-content', error: new Error('Authorization: synthetic-private-content'),
    failure: { code: 'synthetic-private-content', retryAfterMs: Infinity } });
  assert.equal(JSON.stringify(model).includes('synthetic-private-content'), false);
  assert.equal(model.code, 'validation');
  assert.equal(model.retryable, false);
});

test('jittered exponential retry is bounded, deterministic with injected random and respects provider minimum', () => {
  const a = syncRetry({ attempt: 0, now: 1000, random: () => 0 });
  const b = syncRetry({ attempt: 1, now: 1000, random: () => 0 });
  assert.equal(a.delayMs, 1000); assert.equal(b.delayMs, 2000);
  assert.equal(syncRetry({ attempt: 7, now: 0, random: () => 1 }).delayMs, 256000);
  assert.equal(syncRetry({ attempt: 8, now: 0 }).exhausted, true);
  assert.equal(syncRetry({ attempt: 0, now: 1000, retryAfterMs: 65000, random: () => 0 }).retryAt, 66000);
  assert.equal(syncRetry({ attempt: 0, now: 0, random: () => NaN }).delayMs, 1500);
});
