import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeTencentQuoteTime } from '../js/holdings-estimate.js';
import { calculateOverseasEstimate, loadOverseasModels, selectOverseasModel } from '../js/overseas-model.js';

test('ships the latest disclosed Q2 direct models with traceable holding coverage', async () => {
  const config = JSON.parse(await readFile(new URL('../data/overseas-models.json', import.meta.url), 'utf8'));
  const expectedWeights = { '539002': 62.22, '012920': 47.48, '018147': 62.22 };
  for (const [code, expectedWeight] of Object.entries(expectedWeights)) {
    const model = config.models[code];
    assert.equal(model.quarter, '2026Q2');
    assert.equal(model.version, '2026q2-v1');
    assert.equal(model.min_weight, 30);
    assert.equal(model.report_date, '2026-06-30');
    assert.equal(model.source_name, 'eastmoney_fund_archives');
    assert.equal(model.source_url, `https://sinan-estimate-push.ligugu69.workers.dev/holdings?code=${code}`);
    assert.equal(Number(model.legs.reduce((sum, leg) => sum + leg.weight, 0).toFixed(2)), expectedWeight);
  }
  assert.match(config.models['018147'].name, /C$/);
});

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

test('latest overseas source selection preserves every leg order, equal times, and real zero', () => {
  const now = new Date('2026-07-28T06:00:00Z');
  const rows = [
    { code: 'A', weight: 20, change: 0, time: '2026/7/28 13:00', expectedTime: '2026-07-28 13:00:00' },
    { code: 'B', weight: 30, change: -2, time: '2026-07-28 13:55:12', expectedTime: '2026-07-28 13:55:12' },
    { code: 'C', weight: 50, change: 2, time: '2026/7/28 13:55:12', expectedTime: '2026-07-28 13:55:12' },
  ];
  const orders = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const order of orders) for (const asMap of [false, true]) {
    const ordered = order.map(index => rows[index]);
    const pairs = ordered.map(row => [row.code, { change: row.change, time: row.time }]);
    const quotes = asMap ? new Map(pairs) : Object.fromEntries(pairs);
    const result = calculateOverseasEstimate({
      version: 'latest-characterization', label: '合成模型', confidence: 'high', min_weight: 100,
      legs: ordered.map(({ code, weight }) => ({ code, weight })),
    }, quotes, now);
    // Independent expected output; neither production selector nor sort is reused.
    assert.deepEqual(result, {
      change: 0.4, usableWeight: 100, excludedWeight: 0,
      rejected: { missingTime: 0, future: 0, stale: 0 },
      modelVersion: 'latest-characterization', modelLabel: '合成模型', confidence: 'high',
      stale: false, sourceTime: '2026-07-28 13:55:12', reason: '模型可用',
    });
    assert.deepEqual(Object.keys(result), [
      'change', 'usableWeight', 'excludedWeight', 'rejected', 'modelVersion', 'modelLabel',
      'confidence', 'stale', 'sourceTime', 'reason',
    ]);
  }
  const zero = calculateOverseasEstimate({ min_weight: 20, legs: [{ code: 'A', weight: 20 }] }, {
    A: { change: 0, time: rows[0].time },
  }, now);
  assert.equal(zero.change, 0);
  assert.equal(zero.sourceTime, rows[0].expectedTime);
});

test('overseas source selection retains quote getter order and the original thrown error', () => {
  const now = new Date('2026-07-28T06:00:00Z');
  const model = { min_weight: 100, legs: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }] };
  const expected = ['A.change', 'A.time', 'A.change', 'B.change', 'B.time', 'B.change'];
  for (const failAt of [null, ...expected.keys()]) {
    const trace = [];
    const failure = new TypeError('synthetic accessor failure');
    const read = (code, field, value) => {
      trace.push(`${code}.${field}`);
      if (trace.length - 1 === failAt) throw failure;
      return value;
    };
    const quotes = Object.fromEntries(['A', 'B'].map(code => [code, {
      get change() { return read(code, 'change', code === 'A' ? 1 : -1); },
      get time() { return read(code, 'time', '2026-07-28 13:55:12'); },
    }]));
    if (failAt == null) {
      const result = calculateOverseasEstimate(model, quotes, now);
      assert.equal(result.change, 0);
      assert.equal(result.sourceTime, '2026-07-28 13:55:12');
      assert.deepEqual(trace, expected);
    } else {
      assert.throws(() => calculateOverseasEstimate(model, quotes, now), error => error === failure);
      assert.deepEqual(trace, expected.slice(0, failAt + 1));
    }
  }
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

test('uses the converted Korean local time at the 36-hour freshness boundary', () => {
  const quoteTime = normalizeTencentQuoteTime('2026-08-23 14:00:00', 'kr000660');
  assert.equal(quoteTime, '2026-08-23 13:00:00');
  const result = calculateOverseasEstimate({
    min_weight: 100,
    legs: [{ code: 'kr000660', weight: 100 }],
  }, {
    kr000660: { change: 1, time: quoteTime },
  }, new Date('2026-08-24T17:30:00Z'));

  assert.equal(result.change, null);
  assert.equal(result.usableWeight, 0);
  assert.equal(result.rejected.stale, 1);
});

test('keeps the latest disclosed quarter usable during the following calendar quarter', () => {
  const result = calculateOverseasEstimate({
    quarter: '2026Q2', min_weight: 100, confidence: 'medium', legs: [{ code: 'A', weight: 100 }],
  }, {
    A: { change: 1, time: '2026-08-07 14:30:00' },
  }, new Date('2026-08-07T07:00:00Z'));

  assert.equal(result.change, 1);
  assert.equal(result.stale, false);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.reason, '模型可用');
});

test('marks a model two disclosure quarters behind as stale', () => {
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
