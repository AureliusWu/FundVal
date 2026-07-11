import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyStats, recordPrediction, settlePredictions } from '../js/accuracy.js';

test('records once, settles and computes traceable accuracy', () => {
  let rows = recordPrediction([], { code: '012920', prediction_date: '2026-07-10', target_nav_date: '2026-07-10', model_version: '1', predicted_change: -1 });
  rows = recordPrediction(rows, { code: '012920', prediction_date: '2026-07-10', target_nav_date: '2026-07-10', model_version: '1', predicted_change: -1 });
  assert.equal(rows.length, 1);
  rows = settlePredictions(rows, '012920', '2026-07-10', -0.8);
  assert.equal(accuracyStats(rows).mae, 0.19999999999999996);
  assert.equal(accuracyStats(rows).directionRate, 100);
});
