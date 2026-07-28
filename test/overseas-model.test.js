import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOverseasEstimate, loadOverseasModels, selectOverseasModel } from '../js/overseas-model.js';

test('loads model configuration and enforces usable weight', async () => {
  await loadOverseasModels(async () => ({ ok: true, json: async () => ({
    models: { '012920': { version: 'v1', min_weight: 100, legs: [{ code: 'A', weight: 60 }, { code: 'B', weight: 40 }] } }, rules: []
  }) }));
  const model = selectOverseasModel('012920', 'fund');
  assert.equal(calculateOverseasEstimate(model, { A: { change: 1 } }).change, null);
  assert.equal(calculateOverseasEstimate(model, { A: { change: 1 }, B: { change: -1 } }).change, 0.2);
});

test('preserves the newest underlying market timestamp and marks old quotes stale', async () => {
  await loadOverseasModels(async () => ({ ok: true, json: async () => ({
    models: { '012920': { version: 'v1', min_weight: 100, legs: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }] } }, rules: []
  }) }));
  const model = selectOverseasModel('012920', 'fund');
  const current = calculateOverseasEstimate(model, {
    A: { change: 1, time: '2026-07-28 04:00:01' },
    B: { change: -1, time: '2026-07-28 13:52:12' },
  }, new Date('2026-07-28T06:00:00Z'));
  assert.equal(current.sourceTime, '2026-07-28 13:52:12');
  assert.equal(current.stale, false);

  const stale = calculateOverseasEstimate(model, {
    A: { change: 1, time: '2026-07-24 04:00:01' },
    B: { change: -1, time: '2026-07-24 13:52:12' },
  }, new Date('2026-07-28T06:00:00Z'));
  assert.equal(stale.stale, true);
});
