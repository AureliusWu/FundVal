import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { contractOwn, contractNumber } from '../js/runtime/holding-set-contract.js';
import { WorkerContractError, normalizeWorkerEstimateRow, parseWorkerEnvelope } from '../js/runtime/worker-contract.js';
import { RemoteSchemaError, validateBridgeOperationData } from '../js/runtime/remote-schema.js';
import {
  WORKER_FIXTURE_NOW as now, officialRow, intradayRow, holdingsModelRow, unavailableRow, qdiiRow,
  estimatesV1, estimatesV2,
} from './fixtures/worker-contract-v16.js';

const workerSource = readFileSync(new URL('../js/runtime/worker-contract.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const bridgeSource = readFileSync(new URL('../js/runtime/remote-schema.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function privateFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `${name} must remain available for characterization`);
  return source.slice(start, end);
}

// Independent pre-compaction reference: preserve every own/get and alias guard.
const referenceChooseSource = `
function chooseNumber(row, canonical, aliases, { percent = false, ignoreNullAliases = false } = {}) {
  const hasCanonical = own(row, canonical);
  let value = hasCanonical ? numeric(row[canonical], percent) : null;
  if (hasCanonical && row[canonical] != null && value == null) reject('WORKER_ROW_INVALID');
  for (const alias of aliases) {
    if (!own(row, alias)) continue;
    const candidate = numeric(row[alias], percent);
    if (row[alias] != null && candidate == null && !['', '--'].includes(row[alias])) reject('WORKER_ROW_INVALID');
    if (hasCanonical) {
      if (ignoreNullAliases && candidate == null) continue;
      if (candidate !== value) reject('WORKER_ALIAS_CONFLICT');
    } else if (value == null) value = candidate;
    else if (candidate != null && candidate !== value) reject('WORKER_ALIAS_CONFLICT');
  }
  return value;
}
`;

const referenceFiniteSource = `
function finiteNumber(value, label, { minimum = -Infinity, maximum = Infinity, nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('invalid_response', label + ' must be a finite number');
  }
  return value;
}
`;

// Keep literal field names, limits and evaluation order independent of the table.
const referenceMetaBlock = `
  const meta = Object.freeze({
    scale: finiteNumber(rawMeta.scale, 'meta.scale', { minimum: 0, maximum: 1e9, nullable: true }),
    managerName: nullableBoundedString(rawMeta.managerName, 'meta.managerName', 80),
    managerWorkTime: nullableBoundedString(rawMeta.managerWorkTime, 'meta.managerWorkTime', 80),
    managerId: nullableBoundedString(rawMeta.managerId, 'meta.managerId', 40, /^[A-Za-z0-9_-]+$/),
    sourceRate: nullableBoundedString(rawMeta.sourceRate, 'meta.sourceRate', 32),
    currentRate: nullableBoundedString(rawMeta.currentRate, 'meta.currentRate', 32),
  });
`;

const fail = (code, message) => { throw new RemoteSchemaError(code, message); };
const reject = code => { throw new WorkerContractError(code); };
const context = { own: contractOwn, numeric: contractNumber, reject, fail, Number, Object };
const productionChooseSource = privateFunction(workerSource, 'chooseNumber');
const positionalChoose = productionChooseSource.startsWith('function chooseNumber(row, canonical, aliases, percent = false, ignoreNullAliases = false)');
assert.ok(positionalChoose || productionChooseSource.startsWith('function chooseNumber(row, canonical, aliases, { percent = false, ignoreNullAliases = false } = {})'));
const referenceChoose = runInNewContext(`${referenceChooseSource}\nchooseNumber;`, { ...context });
const productionChoose = runInNewContext(`${productionChooseSource}\nchooseNumber;`, { ...context });
const productionFiniteSource = privateFunction(bridgeSource, 'finiteNumber');
const positionalFinite = productionFiniteSource.startsWith('function finiteNumber(value, label, minimum = -Infinity, maximum = Infinity, nullable = false)');
assert.ok(positionalFinite || productionFiniteSource.startsWith('function finiteNumber(value, label, { minimum = -Infinity, maximum = Infinity, nullable = false } = {})'));
const referenceFinite = runInNewContext(`${referenceFiniteSource}\nfiniteNumber;`, { ...context });
const productionFinite = runInNewContext(`${productionFiniteSource}\nfiniteNumber;`, { ...context });
const metaStart = bridgeSource.indexOf('  const meta = ');
const metaEnd = bridgeSource.indexOf('\n  return Object.freeze({ fundCode', metaStart);
assert.ok(metaStart >= 0 && metaEnd > metaStart);
const productionMetaBlock = bridgeSource.slice(metaStart, metaEnd);
const unchangedStringHelpers = [privateFunction(bridgeSource, 'boundedString'), privateFunction(bridgeSource, 'nullableBoundedString')].join('\n');
const referenceMeta = runInNewContext(`${referenceFiniteSource}\n${unchangedStringHelpers}\n(function(rawMeta) {\n${referenceMetaBlock}\nreturn meta; });`, { ...context });
const productionMeta = runInNewContext(`${productionFiniteSource}\n${unchangedStringHelpers}\n(function(rawMeta) {\n${productionMetaBlock}\nreturn meta; });`, { ...context });

function errorData(error) { return { name: error.name, code: error.code, message: error.message }; }
function tracedRecord(value, throwAt = Infinity, changingReads = false) {
  const trace = [];
  const reads = new Map();
  let steps = 0;
  function step(event) {
    trace.push(event);
    if (++steps === throwAt) throw new TypeError(`synthetic exception at ${event}`);
  }
  const row = new Proxy(value, {
    get(target, key, receiver) {
      step(`get:${String(key)}`);
      reads.set(key, (reads.get(key) || 0) + 1);
      if (changingReads && reads.get(key) % 2 === 0) return null;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      step(`own:${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { row, trace };
}

const ABSENT = Symbol('absent synthetic field');
const SCALARS = [undefined, null, '', '--', ' ', 0, -0, 1, -1, NaN, Infinity, true, false, '1', '1%', '1e2', '0x10', '1,2', {}, []];
const CHOOSE_CASES = [];
for (const canonical of [ABSENT, ...SCALARS]) for (const alias of [ABSENT, ...SCALARS]) {
  for (const mode of [{}, { percent: true }, { ignoreNullAliases: true }, { percent: true, ignoreNullAliases: true }]) {
    CHOOSE_CASES.push({ canonical, alias, mode });
  }
}
for (const canonical of [ABSENT, null, 1, '1', '--']) for (const alias of [null, 1, '1%', 'bad']) {
  CHOOSE_CASES.push({ canonical, alias, extra: 1, mode: { percent: true, ignoreNullAliases: true }, inherited: true });
}

function chooseRun(production, spec, throwAt = Infinity, changingReads = false) {
  const raw = spec.inherited ? Object.create({ canonical: 100, missing: 100 }) : {};
  if (spec.canonical !== ABSENT) raw.canonical = spec.canonical;
  if (spec.alias !== ABSENT) raw.alias = spec.alias;
  if (Object.hasOwn(spec, 'extra')) raw.extra = spec.extra;
  const fixture = tracedRecord(raw, throwAt, changingReads);
  const aliases = Object.hasOwn(spec, 'extra') ? ['missing', 'alias', 'extra'] : ['missing', 'alias'];
  try {
    const value = production && positionalChoose
      ? productionChoose(fixture.row, 'canonical', aliases, spec.mode.percent, spec.mode.ignoreNullAliases)
      : (production ? productionChoose : referenceChoose)(fixture.row, 'canonical', aliases, spec.mode);
    return { value, trace: fixture.trace };
  } catch (error) { return { error: errorData(error), trace: fixture.trace }; }
}

test('wire compaction: numeric alias projection preserves 1784 cases and own/get order', () => {
  assert.equal(CHOOSE_CASES.length, 1784);
  for (const spec of CHOOSE_CASES) assert.deepEqual(chooseRun(true, spec), chooseRun(false, spec));
});

test('wire compaction: numeric alias projection preserves each exception boundary and repeated reads', t => {
  let boundaries = 0;
  for (const spec of CHOOSE_CASES) {
    const reference = chooseRun(false, spec);
    for (let step = 1; step <= reference.trace.length; step++) {
      assert.deepEqual(chooseRun(true, spec, step), chooseRun(false, spec, step));
      boundaries++;
    }
    assert.deepEqual(chooseRun(true, spec, Infinity, true), chooseRun(false, spec, Infinity, true));
  }
  assert.equal(boundaries, 8826);
  t.diagnostic(`checked ${boundaries} exception boundaries and ${CHOOSE_CASES.length} changing-read cases`);
});

const META_KEYS = ['scale', 'managerName', 'managerWorkTime', 'managerId', 'sourceRate', 'currentRate'];
function validMeta() {
  return { scale: 0, managerName: ' synthetic manager ', managerWorkTime: '6 years', managerId: 'A_123-4', sourceRate: '1.50', currentRate: '0.15' };
}
const META_CASES = [() => validMeta()];
const META_VALUES = [...SCALARS, 'x'.repeat(33), 'x'.repeat(41), 'x'.repeat(81), '<bad>', '\u0000', 1e9, 1e9 + 1];
for (const key of META_KEYS) {
  for (const value of META_VALUES) META_CASES.push(() => ({ ...validMeta(), [key]: value }));
  META_CASES.push(() => { const meta = validMeta(); delete meta[key]; return meta; });
}
META_CASES.push(() => Object.assign(Object.create(null), validMeta()));

function metaRun(production, factory, throwAt = Infinity, changingReads = false) {
  const fixture = tracedRecord(factory(), throwAt, changingReads);
  try {
    const value = (production ? productionMeta : referenceMeta)(fixture.row);
    return { value: Object.fromEntries(Object.entries(value)), keys: Object.keys(value), frozen: Object.isFrozen(value),
      descriptors: Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) =>
        [key, { writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable }])), trace: fixture.trace };
  } catch (error) { return { error: errorData(error), trace: fixture.trace }; }
}

test('wire compaction: Bridge meta retains literal scalar bounds, errors, keys and freeze', () => {
  assert.equal(META_CASES.length, 170);
  for (const factory of META_CASES) assert.deepEqual(metaRun(true, factory), metaRun(false, factory));
  const output = metaRun(true, validMeta);
  assert.deepEqual(output.keys, META_KEYS);
  assert.equal(output.frozen, true);
  assert.equal(output.value.scale, 0);
  assert.equal(output.value.managerName, 'synthetic manager');
  assert.deepEqual(output.trace, META_KEYS.map(key => `get:${key}`));
});

test('wire compaction: Bridge meta retains every getter exception and repeated nullable string read', t => {
  let boundaries = 0;
  for (const factory of META_CASES) {
    const reference = metaRun(false, factory);
    for (let step = 1; step <= reference.trace.length; step++) {
      assert.deepEqual(metaRun(true, factory, step), metaRun(false, factory, step));
      boundaries++;
    }
    assert.deepEqual(metaRun(true, factory, Infinity, true), metaRun(false, factory, Infinity, true));
  }
  assert.equal(boundaries, 763);
  t.diagnostic(`checked ${boundaries} exception boundaries and ${META_CASES.length} changing-read cases`);
});

function finiteRun(production, value, options) {
  try {
    return { value: production && positionalFinite
      ? productionFinite(value, 'synthetic.field', options.minimum, options.maximum, options.nullable)
      : (production ? productionFinite : referenceFinite)(value, 'synthetic.field', options) };
  } catch (error) { return { error: errorData(error) }; }
}

test('wire compaction: Bridge finite-number guards preserve exact nullable and inclusive bounds', () => {
  const limits = [{}, { minimum: 0, maximum: 1e9, nullable: true },
    { minimum: Number.MIN_VALUE, maximum: 1e9 }, { minimum: Number.MIN_VALUE, maximum: 1e15 },
    { minimum: -1e6, maximum: 1e6, nullable: true },
    { minimum: Date.UTC(1990, 0, 1), maximum: Date.UTC(2200, 0, 1) }];
  const values = [...SCALARS, Number.MIN_VALUE, 1e9, 1e9 + 1, 1e15, 1e15 + 1, -1e6, 1e6, -1e6 - 1, 1e6 + 1,
    Date.UTC(1990, 0, 1), Date.UTC(2200, 0, 1)];
  for (const options of limits) for (const value of values) assert.deepEqual(finiteRun(true, value, options), finiteRun(false, value, options));
  assert.deepEqual(finiteRun(true, null, { nullable: true }), { value: null });
  assert.deepEqual(finiteRun(true, '0', {}), { error: { name: 'RemoteSchemaError', code: 'invalid_response', message: 'synthetic.field must be a finite number' } });
  assert.ok(Object.is(finiteRun(true, -0, {}).value, -0));
});

test('wire compaction: public Worker projections retain official, estimate, unavailable and model fields', () => {
  for (const wireVersion of [1, 2]) {
    const official = normalizeWorkerEstimateRow(officialRow(), { wireVersion, now });
    assert.equal(official.kind, 'official_nav');
    assert.equal(official.value_nav, 1.02);
    assert.equal(official.value_change, 2);
    assert.equal(official.estimate_nav, null);
    assert.equal(official.estimate_change, null);
    assert.equal(official.est_nav, 1.02);
    assert.equal(official.est_kind, 'official_nav');
    for (const factory of [intradayRow, holdingsModelRow, qdiiRow]) {
      const input = factory();
      const output = normalizeWorkerEstimateRow(input, { wireVersion, now });
      assert.equal(output.kind, input.kind);
      assert.equal(output.value_nav, 1.01);
      assert.equal(output.estimate_nav, 1.01);
      assert.equal(output.estimate_change, 1);
      assert.equal(output.value_change, null);
    }
    const absent = normalizeWorkerEstimateRow(unavailableRow(), { wireVersion, now });
    assert.equal(absent.value_nav, null);
    assert.equal(absent.est_change, null);
    assert.equal(absent.kind, 'unavailable');
  }
  const legacy = parseWorkerEnvelope(estimatesV1([intradayRow(), officialRow()]), {
    endpoint: 'estimates', requestedCodes: ['000002', '000001'], now,
  });
  assert.deepEqual(legacy.items[0].adapterReasonCodes, ['LEGACY_SUCCESS_ROW']);
  const versioned = parseWorkerEnvelope(estimatesV2(), { endpoint: 'estimates', requestedCodes: ['000002'], now });
  assert.equal(versioned.wireVersion, 2);
  assert.equal(versioned.items[0].kind, 'intraday_estimate');
});

test('wire compaction: public Bridge point and quote schemas preserve finite limits and missing values', () => {
  const data = {
    fundCode: '005844', fundName: 'synthetic fund',
    points: [{ date: '2026-08-27', timestampMs: Date.UTC(2026, 7, 27), nav: Number.MIN_VALUE },
      { date: '2026-08-28', timestampMs: Date.UTC(2026, 7, 28), nav: 1e9 }], meta: validMeta(),
  };
  const official = validateBridgeOperationData('officialFundData', data, { fundCode: '005844' });
  assert.equal(official.points[0].nav, Number.MIN_VALUE);
  assert.equal(official.points[1].nav, 1e9);
  assert.ok(Object.isFrozen(official.meta));
  for (const nav of [0, null, '1', 1e9 + 1, Infinity, NaN]) {
    assert.throws(() => validateBridgeOperationData('officialFundData', {
      ...data, points: [{ ...data.points[0], nav }, data.points[1]],
    }, { fundCode: '005844' }), { name: 'RemoteSchemaError', code: 'invalid_response', message: 'points[0].nav must be a finite number' });
  }
  const quote = { code: 'sh688361', price: 1e15, changePct: null, sourceTimeRaw: null };
  const quotes = validateBridgeOperationData('securityQuotes', { quotes: [quote] }, { codes: ['sh688361'] });
  assert.equal(quotes.quotes[0].price, 1e15);
  assert.equal(quotes.quotes[0].changePct, null);
  for (const changePct of [-1e6, 0, 1e6]) {
    assert.equal(validateBridgeOperationData('securityQuotes', { quotes: [{ ...quote, changePct }] }, { codes: ['sh688361'] }).quotes[0].changePct, changePct);
  }
  for (const changePct of [-1e6 - 1, 1e6 + 1, '0', Infinity]) {
    assert.throws(() => validateBridgeOperationData('securityQuotes', { quotes: [{ ...quote, changePct }] }, { codes: ['sh688361'] }), {
      name: 'RemoteSchemaError', code: 'invalid_response', message: 'quotes[0].changePct must be a finite number',
    });
  }
});

test('wire compaction: public Bridge meta creates own fields without invoking prototype setters', t => {
  const stringKeys = META_KEYS.slice(1);
  const previous = new Map(stringKeys.map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  const outcomes = [];
  function restore() {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
  for (const branch of ['preinstalled', 'installed by scale getter']) {
    const setterCalls = [];
    const install = () => {
      for (const key of stringKeys) Object.defineProperty(Object.prototype, key, {
        configurable: true,
        set() { setterCalls.push(key); },
      });
    };
    try {
      const meta = validMeta();
      if (branch === 'preinstalled') install();
      else Object.defineProperty(meta, 'scale', {
        configurable: true, enumerable: true,
        get() { install(); return 0; },
      });
      const data = {
        fundCode: '005844', fundName: 'synthetic fund',
        points: [{ date: '2026-08-27', timestampMs: Date.UTC(2026, 7, 27), nav: 1 },
          { date: '2026-08-28', timestampMs: Date.UTC(2026, 7, 28), nav: 1.01 }], meta,
      };
      const output = validateBridgeOperationData('officialFundData', data, { fundCode: '005844' }).meta;
      outcomes.push({ branch, setterCalls: [...setterCalls], keys: Object.keys(output),
        ownFields: stringKeys.map(key => Object.hasOwn(output, key)), frozen: Object.isFrozen(output) });
    } finally { restore(); }
  }
  // Complete both public API branches and restore global state before asserting.
  for (const output of outcomes) {
    t.diagnostic(`${output.branch}: ${output.keys.length} own keys, ${output.setterCalls.length} setter calls`);
  }
  assert.equal(outcomes.length, 2);
  for (const output of outcomes) {
    assert.deepEqual(output.setterCalls, [], output.branch);
    assert.deepEqual(output.ownFields, [true, true, true, true, true], output.branch);
    assert.deepEqual(output.keys, META_KEYS, output.branch);
    assert.equal(output.frozen, true, output.branch);
  }
});
