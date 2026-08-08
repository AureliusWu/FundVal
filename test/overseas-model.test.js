import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOverseasEstimate, loadOverseasModels, selectOverseasModel } from '../js/overseas-model.js';

test('loads model configuration and enforces usable weight', async () => {
  await loadOverseasModels(async () => ({ ok: true, json: async () => ({
    models: { '012920': { version: 'v1', min_weight: 100, legs: [{ code: 'A', weight: 60 }, { code: 'B', weight: 40 }] } }, rules: []
  }) }));
  const model = selectOverseasModel('012920', 'fund');
  const now = new Date('2026-07-22T06:00:00Z');
  assert.equal(calculateOverseasEstimate(model, { A: { change: 1, time: '2026-07-22 13:50:00' } }, now).change, null);
  assert.equal(calculateOverseasEstimate(model, {
    A: { change: 1, time: '2026-07-22 13:50:00' },
    B: { change: -1, time: '2026-07-22 13:50:00' },
  }, now).change, 0.2);
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

test('ignores malformed model configuration and bad rule patterns without interrupting selection', async () => {
  await loadOverseasModels(async () => ({ ok: true, json: async () => ({
    models: {
      '000001': { legs: 'invalid' },
      '000002': { version: 'v1', min_weight: 100, legs: [{ code: 'A', weight: 100 }] },
    },
    rules: [
      { pattern: '[', min_weight: 100, legs: [{ code: 'B', weight: 100 }] },
      { pattern: 'safe rule', min_weight: 100, legs: [{ code: 'C', weight: 100 }] },
    ],
  }) }));

  assert.equal(selectOverseasModel('000001', 'fund'), null);
  assert.equal(selectOverseasModel('000002', 'fund').legs[0].code, 'A');
  assert.doesNotThrow(() => selectOverseasModel('999999', 'safe rule fund'));
  assert.equal(selectOverseasModel('999999', 'safe rule fund').legs[0].code, 'C');
});

test('excludes missing, future and older-than-36-hour quote weights', () => {
  const now = new Date('2026-07-28T06:00:00Z');
  const model = { min_weight: 100, legs: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }] };
  const cases = [
    { quote: { change: 2 }, key: 'missingTime' },
    { quote: { change: 2, time: '2026-07-28 14:01:00' }, key: 'future' },
    { quote: { change: 2, time: '2026-07-26 21:59:59' }, key: 'stale' },
  ];

  cases.forEach(({ quote, key }) => {
    const result = calculateOverseasEstimate(model, {
      A: { change: 1, time: '2026-07-28 13:50:00' },
      B: quote,
    }, now);
    assert.equal(result.change, null);
    assert.equal(result.usableWeight, 50);
    assert.equal(result.excludedWeight, 50);
    assert.equal(result.rejected[key], 1);
  });
});

test('marks a model from an earlier disclosure quarter stale even within the same year', () => {
  const result = calculateOverseasEstimate({
    quarter: '2026Q1', min_weight: 100, confidence: 'medium', legs: [{ code: 'A', weight: 100 }],
  }, {
    A: { change: 1, time: '2026-08-07 14:30:00' },
  }, new Date('2026-08-07T07:00:00Z'));

  assert.equal(result.change, 1);
  assert.equal(result.stale, true);
  assert.equal(result.confidence, 'low');
  assert.equal(result.reason, '模型披露季度已过期');
});

test('abandons a hanging model configuration request without blocking startup', async () => {
  const result = await loadOverseasModels(() => new Promise(() => {}), { timeout: 5 });
  assert.deepEqual(result.models, {});
  assert.deepEqual(result.rules, []);
});
