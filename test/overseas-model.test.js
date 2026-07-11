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
