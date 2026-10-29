import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDiagnostic, redactDiagnosticText, selectSafeDiagnosticEvents } from '../js/integrity.js';

const token = 'github_pat_SYNTHETIC12345678901234567890';
const privateContent = 'synthetic-user-holdings-content';
test('M4 diagnostics persist only timestamp and enum, including when old raw logs are present', () => {
  const old = JSON.stringify([{ time: '2026-10-25T00:00:00.000Z', type: 'window_error', message: privateContent, stack: token }]);
  const result = appendDiagnostic(old, { time: token, type: 'unhandled_rejection', message: privateContent,
    stack: `https://gist.github.com/synthetic/abcdef?access_token=${token}` });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(privateContent), false);
  for (const row of result) assert.deepEqual(Object.keys(row).sort(), ['time', 'type']);
  assert.equal(result[1].type, 'unhandled_rejection');
});
test('M4 diagnostic summary rejects hostile timestamp content as well as error text', () => {
  assert.deepEqual(selectSafeDiagnosticEvents([{ time: token, type: 'window_error', message: privateContent }]),
    [{ time: '', type: 'window_error' }]);
});
test('M4 generic redactor covers fine-grained tokens and removes entire private Gist URLs', () => {
  const value = redactDiagnosticText(`${token} Authorization: Bearer ${token} https://gist.github.com/synthetic/abcdef?file=${privateContent}`);
  assert.equal(value.includes(token), false); assert.equal(value.includes(privateContent), false);
  assert.equal(value.includes('gist.github.com/synthetic'), false);
});

test('M4 old JSON diagnostic types cannot run coercions or prevent startup', () => {
  const hostile = JSON.parse('[{"time":"2026-10-25T00:00:00.000Z","type":{"toString":null},"message":"synthetic-private"}]');
  assert.deepEqual(selectSafeDiagnosticEvents(hostile), [{ time: '2026-10-25T00:00:00.000Z', type: 'unknown' }]);
});
