import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracyStats,
  loadAccuracy,
  normalizeAccuracyRows,
  recordPrediction,
  saveAccuracy,
  settlePredictions,
} from '../js/accuracy.js';

test('records once, settles and computes traceable accuracy', () => {
  let rows = recordPrediction([], { code: '012920', prediction_date: '2026-07-10', target_nav_date: '2026-07-10', model_version: '1', predicted_change: -1 });
  rows = recordPrediction(rows, { code: '012920', prediction_date: '2026-07-10', target_nav_date: '2026-07-10', model_version: '1', predicted_change: -1 });
  assert.equal(rows.length, 1);
  rows = settlePredictions(rows, '012920', '2026-07-10', -0.8);
  assert.equal(accuracyStats(rows).mae, 0.19999999999999996);
  assert.equal(accuracyStats(rows).directionRate, 100);
});

test('settles next-NAV predictions only against their recorded base NAV date', () => {
  const rows = [
    { code: '012920', prediction_date: '2026-07-28', target_nav_date: 'next', base_nav_date: '2026-07-24', predicted_change: 1, actual_change: null },
    { code: '012920', prediction_date: '2026-07-29', target_nav_date: 'next', base_nav_date: '2026-07-28', predicted_change: -1, actual_change: null },
  ];
  const settled = settlePredictions(rows, '012920', '2026-07-29', -0.8, '2026-07-30T00:00:00.000Z', '2026-07-28');
  assert.equal(settled[0].actual_change, null);
  assert.equal(settled[1].actual_change, -0.8);
});

test('degrades malformed accuracy storage and non-array inputs without throwing', () => {
  const invalidStorage = {
    getItem() { return JSON.stringify({ unexpected: true }); },
    setItem() { throw new Error('quota'); },
  };

  assert.deepEqual(loadAccuracy(invalidStorage), []);
  assert.equal(saveAccuracy({ unexpected: true }, invalidStorage), false);
  assert.deepEqual(loadAccuracy({ getItem() { throw new Error('storage blocked'); } }), []);
  assert.deepEqual(normalizeAccuracyRows({ unexpected: true }), []);
  assert.deepEqual(recordPrediction({ unexpected: true }, { code: '012920' }), [{
    code: '012920', actual_change: null, error: null, direction_correct: null, settled_at: null,
  }]);
  assert.deepEqual(recordPrediction([], null), []);
  assert.deepEqual(settlePredictions({ unexpected: true }, '012920', '2026-07-10', 1), []);
  assert.equal(accuracyStats({ unexpected: true }).samples, 0);
});
