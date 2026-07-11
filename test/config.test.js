import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshInterval } from '../js/config.js';

test('uses market-aware recursive refresh intervals', () => {
  assert.equal(refreshInterval(new Date(2026, 6, 6, 10, 0)), 60000);
  assert.equal(refreshInterval(new Date(2026, 6, 5, 10, 0)), 900000);
});
