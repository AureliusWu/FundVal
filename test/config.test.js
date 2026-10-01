import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshInterval } from '../js/config.js';

test('uses market-aware recursive refresh intervals', () => {
  assert.equal(refreshInterval(new Date('2026-07-06T10:00:00+08:00')), 60000);
  assert.equal(refreshInterval(new Date('2026-07-05T10:00:00+08:00')), 900000);
  assert.equal(refreshInterval(new Date('2026-10-01T10:00:00+08:00')), 900000);
  assert.equal(refreshInterval(new Date('2027-01-04T10:00:00+08:00')), 300000);
});
