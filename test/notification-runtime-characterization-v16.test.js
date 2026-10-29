import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// Keep the original public policy as the executable reference; this internal
// entry is only a boolean projection for the closed notification consumer.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_POLICY_IMPORT = '../runtime/notification-policy-runtime.js';
const publicPolicy = await import(pathToFileURL(`${ROOT}/js/runtime/notification-policy.js`));
const internalPolicy = await import(pathToFileURL(`${ROOT}/js/runtime/notification-policy-runtime.js`));
const before = publicPolicy.isQuoteEligibleForNotification;
const after = internalPolicy.isQuoteEligibleForNotification;
const require = createRequire(`${ROOT}/package.json`);
const { parseSync } = await import(pathToFileURL(require.resolve('rolldown/utils')));
const NOW = Date.parse('2026-08-25T14:30:00+08:00');
const lf = value => value.replaceAll('\r\n', '\n');
const counts = { native: 0, proxy: 0, sentinel: 0, changing: 0, options: 0, controller: 0 };
function quote(overrides = {}) {
  return { status: 'realtime', valueKind: 'intraday_estimate', changePct: 0,
    value: 1, baseNav: 1, baseNavDate: '2026-08-24', targetDate: '2026-08-25', market: 'cn', sourceTier: 'primary',
    observedAt: '2026-08-25 14:29:00', fetchedAt: '2026-08-25T06:29:30.000Z', ...overrides };
}
function outcome(run) {
  try { return { kind: 'returned', value: run() }; }
  catch (error) { return { kind: 'thrown', error, name: error?.name, message: error?.message, code: error?.code }; }
}
function compare(left, right, label) {
  assert.equal(left.kind, right.kind, label);
  if (left.kind === 'returned') assert.equal(left.value, right.value, label);
  else {
    assert.equal(left.name, right.name, label);
    assert.equal(left.message, right.message, label);
    assert.equal(left.code, right.code, label);
    if (left.error?.syntheticSentinel) assert.equal(right.error, left.error, label);
  }
}
function same(candidate, options, label) {
  const left = outcome(() => before(candidate, options));
  const right = outcome(() => after(candidate, options));
  compare(left, right, label);
  return left;
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

test('notification internal bool keeps the original public detailed API and exports', () => {
  assert.deepEqual(Object.keys(internalPolicy), ['isQuoteEligibleForNotification']);
  assert.deepEqual(Object.keys(publicPolicy), ['DEFAULT_NOTIFICATION_FUTURE_SKEW_MS', 'DEFAULT_NOTIFICATION_MAX_AGE_MS',
    'NOTIFICATION_REJECTION_REASONS', 'evaluateNotificationEligibility', 'isQuoteEligibleForNotification']);
  const eligible = publicPolicy.evaluateNotificationEligibility(quote(), { now: NOW });
  assert.deepEqual(eligible, { eligible: true, reason: null, observedAgeMs: 60000, fetchedAgeMs: 30000, chinaDate: '2026-08-25' });
  assert.equal(Object.isFrozen(eligible), true);
  const rejection = publicPolicy.evaluateNotificationEligibility(quote({ sourceTier: 'cache' }), { now: NOW });
  assert.deepEqual(rejection, { eligible: false, reason: 'cached_quote' });
  assert.equal(Object.isFrozen(rejection), true);
  assert.equal(Object.isFrozen(publicPolicy.NOTIFICATION_REJECTION_REASONS), true);
  assert.equal(Object.keys(publicPolicy.NOTIFICATION_REJECTION_REASONS).length, 16);
});

test('notification internal bool matches full native status/kind/source/zero matrix without mutation', () => {
  for (const status of ['realtime', 'delayed', 'official', 'model', 'stale', 'unavailable', 'invented', '', null, undefined])
    for (const valueKind of ['intraday_estimate', 'official_nav', 'model_estimate', 'holding_lookthrough_estimate', 'other', null])
      for (const sourceTier of ['primary', 'secondary', 'model', 'cache', 'other', null])
        for (const changePct of [0, -0, 1, -1, NaN, Infinity, -Infinity, null, undefined, '0']) {
          const input = quote({ status, valueKind, sourceTier, changePct });
          const descriptors = Object.getOwnPropertyDescriptors(input);
          same(input, { now: NOW }, `${status}/${valueKind}/${sourceTier}/${String(changePct)}`);
          assert.deepEqual(Object.getOwnPropertyDescriptors(input), descriptors);
          counts.native++;
        }
  for (const input of [null, undefined, 0, '', false, true, [], [quote()], Symbol('invalid'), () => quote()]) {
    same(input, { now: NOW }, 'non-record'); counts.native++;
  }
});

test('notification internal bool preserves all observed/fetched boundary and custom policy cases', () => {
  const iso = delta => new Date(NOW + delta).toISOString();
  const times = [null, undefined, '', '--', 'not-time', '2026-08-25', '2026-02-30T06:00:00Z',
    '2026-08-24T06:00:00Z', iso(-600001), iso(-600000), iso(-1), iso(0), iso(300000), iso(300001),
    '2026-08-25 14:29:00', '2026-08-25T06:29:30.000Z'];
  for (const observedAt of times) for (const fetchedAt of times) {
    for (const options of [{ now: NOW }, { now: NOW, maxAgeMs: 0 }, { now: NOW, maxFutureSkewMs: 0 },
      { now: NOW, maxAgeMs: 1200000, maxFutureSkewMs: 600000 }]) {
      same(quote({ observedAt, fetchedAt }), options, 'timestamp boundary'); counts.native++;
    }
  }
  for (const now of [NOW, 0, -1, NaN, Infinity, '', 'bad', null, NOW + 86400000, NOW - 86400000])
    for (const maxAgeMs of [undefined, 0, -1, 1, 600000, Infinity, NaN, null, '600000'])
      for (const maxFutureSkewMs of [undefined, 0, -1, 300000, Infinity, NaN, null]) {
        same(quote(), { now, maxAgeMs, maxFutureSkewMs }, 'policy matrix'); counts.native++;
      }
  for (const options of [null, true, 0, '', undefined]) { same(quote(), options, 'option shape'); counts.options++; }
});

test('notification internal bool preserves full valuation-period and cache checks', () => {
  for (const baseNavDate of [null, '', '2026-02-30', '2026-08-21', '2026-08-24', '2026-08-25', '2026-08-26'])
    for (const targetDate of [null, '', '2026-02-30', '2026-08-24', '2026-08-25', '2026-08-26'])
      for (const market of ['cn', 'cn-index', 'hk', 'us', 'jp', 'kr', 'qdii', 'unknown', null])
        for (const cacheState of [undefined, null, 'fresh', 'stale', 'expired', false]) {
          same(quote({ baseNavDate, targetDate, market, cacheState }), { now: NOW }, 'period/cache matrix'); counts.native++;
        }
  for (const fields of [{ value: null, changePct: 0 }, { value: 0 }, { value: -1 }, { value: Infinity }, { value: NaN },
    { value: null, changePct: null }, { expiresAt: NOW - 1 }, { reasonCodes: ['SYNTHETIC_REASON'] },
    { reasonCodes: [null, 'unsafe <reason>', 'duplicate', 'duplicate'] }, { reasonCodes: null }]) {
    same(quote(fields), { now: NOW }, 'period extra'); counts.native++;
  }
});

function tracedRun(fn, specification, { throwAt = Infinity, sentinel, changing = false } = {}) {
  const trace = [];
  const target = quote(specification);
  let reads = 0;
  const proxy = new Proxy(target, {
    get(value, key, receiver) {
      trace.push(['get', typeof key === 'symbol' ? key.toString() : key]);
      if (++reads === throwAt) throw sentinel;
      if (changing && key === 'changePct') return reads % 2 ? 0 : -1;
      return Reflect.get(value, key, receiver);
    },
    getOwnPropertyDescriptor(value, key) { trace.push(['descriptor', String(key)]); return Reflect.getOwnPropertyDescriptor(value, key); },
    ownKeys(value) { trace.push(['ownKeys']); return Reflect.ownKeys(value); },
  });
  return { result: outcome(() => fn(proxy, { now: NOW })), trace, reads, target };
}
const traceCases = [ {}, { status: 'stale' }, { valueKind: 'official_nav' }, { changePct: NaN },
  { observedAt: null }, { fetchedAt: null }, { observedAt: '2026-08-24T06:29:00Z' },
  { observedAt: '2026-08-25T06:35:00.001Z' }, { fetchedAt: '2026-08-25T06:19:59.999Z' },
  { sourceTier: 'cache' }, { cacheState: 'fresh' }, { baseNavDate: null }, { targetDate: '2026-08-24' },
  { reasonCodes: ['SYNTHETIC_REASON'] }, { market: 'unknown' }, { baseNavDate: '2026-08-21' } ];
test('notification internal bool keeps Proxy/getter access order and changing reads', () => {
  for (const fields of traceCases) for (const changing of [false, true]) {
    const left = tracedRun(before, fields, { changing });
    const right = tracedRun(after, fields, { changing });
    compare(left.result, right.result, 'proxy result');
    assert.deepEqual(right.trace, left.trace, 'same exact property/descriptor/ownKeys order');
    assert.deepEqual(right.target, left.target);
    counts.proxy++;
  }
});

test('notification internal bool propagates the same sentinel at every reachable property read', () => {
  const sentinel = Object.assign(new TypeError('synthetic notification property sentinel'), { syntheticSentinel: true });
  for (const fields of traceCases) {
    const baseline = tracedRun(before, fields);
    for (let throwAt = 1; throwAt <= baseline.reads; throwAt++) {
      const left = tracedRun(before, fields, { throwAt, sentinel });
      const right = tracedRun(after, fields, { throwAt, sentinel });
      compare(left.result, right.result, 'throw identity');
      assert.equal(left.result.error, sentinel);
      assert.deepEqual(right.trace, left.trace, 'read prefix before exact throw');
      counts.sentinel++;
    }
  }
});

test('notification internal bool preserves coercion, Date subclass, default clock and option getter exceptions', () => {
  const sentinel = Object.assign(new Error('synthetic notification clock sentinel'), { syntheticSentinel: true });
  for (const values of [[NOW], [NOW, NOW - 86400000], [NOW - 86400000, NOW], [NaN], [Infinity], [sentinel]]) {
    function run(fn) {
      const trace = [];
      let reads = 0;
      class ChangingDate extends Date { getTime() { trace.push('getTime'); const value = values[Math.min(reads++, values.length - 1)]; if (value === sentinel) throw sentinel; return value; } }
      return { result: outcome(() => fn(quote(), { now: new ChangingDate() })), trace, reads };
    }
    const left = run(before), right = run(after);
    compare(left.result, right.result, 'Date subclass'); assert.deepEqual(right.trace, left.trace); assert.equal(right.reads, left.reads); counts.changing++;
  }
  for (const key of ['now', 'maxAgeMs', 'maxFutureSkewMs']) {
    function run(fn, throwing) {
      const trace = [];
      const options = new Proxy({ now: NOW }, { get(target, name) { trace.push(name); if (name === key && throwing) throw sentinel; return Reflect.get(target, name); } });
      return { result: outcome(() => fn(quote(), options)), trace };
    }
    for (const throwing of [false, true]) {
      const left = run(before, throwing), right = run(after, throwing);
      compare(left.result, right.result, 'option getter'); assert.deepEqual(right.trace, left.trace); counts.options++;
    }
  }
  const originalNow = Date.now;
  try {
    function run(fn) {
      const trace = [];
      Date.now = () => { trace.push('Date.now'); return NOW; };
      return { result: outcome(() => fn(quote())), trace };
    }
    const left = run(before), right = run(after);
    compare(left.result, right.result, 'default clock'); assert.deepEqual(right.trace, left.trace); counts.changing++;
  } finally { Date.now = originalNow; }
  for (const value of [Symbol('clock'), { valueOf() { throw sentinel; } }, { valueOf() { return NOW; } }]) {
    same(quote(), { now: value }, 'clock coercion'); counts.changing++;
  }
  const sourceText = { toString() { throw sentinel; } };
  for (const key of ['observedAt', 'fetchedAt', 'baseNavDate', 'targetDate']) {
    same(quote({ [key]: sourceText }), { now: NOW }, 'source coercion sentinel'); counts.sentinel++;
  }
});

test('notification controller still produces exact active/truncated lines under the internal predicate', async () => {
  const { buildEligibleNotificationLines } = await import(pathToFileURL(`${ROOT}/js/notifications/notification-controller.js`));
  const holdings = Array.from({ length: 12 }, (_, index) => ({ code: String(index).padStart(6, '0'), deleted: index === 3 }));
  const funds = holdings.map((holding, index) => ({ code: holding.code, name: ` 合成基金 ${index}`, quote: quote({ changePct: index === 0 ? 0 : index / -10 }) }));
  funds[1].quote = quote({ status: 'official', valueKind: 'official_nav' });
  funds[2].quote = quote({ cacheState: 'fresh' });
  for (const limit of [0, 1, 8, 12]) {
    const expectedLines = funds.filter(fund => !holdings.find(holding => holding.code === fund.code).deleted && before(fund.quote, { now: NOW }))
      .map(fund => `${fund.name.replace(/\s+/g, '').slice(0, 8)} ${fund.quote.changePct >= 0 ? '+' : ''}${fund.quote.changePct.toFixed(2)}%`);
    assert.deepEqual(buildEligibleNotificationLines(holdings, funds, { now: NOW, limit }),
      { lines: expectedLines.slice(0, limit), truncated: expectedLines.length > limit, eligibleCount: expectedLines.length }); counts.controller++;
  }
});

test('notification production controller is a single boolean-only consumer with fail-closed AST negative controls', async () => {
  const source = lf(await readFile(`${ROOT}/js/notifications/notification-controller.js`, 'utf8'));
  function guard(text) {
    const ast = parseSync('notification-controller.js', text).program;
    let imports = 0, calls = 0, references = 0;
    walk(ast, node => {
      if (node.type === 'ImportDeclaration' && /notification-policy(?:-runtime)?\.js$/.test(node.source.value)) {
        imports++; assert.equal(node.source.value, EXPECTED_POLICY_IMPORT); assert.equal(node.specifiers.length, 1); assert.equal(node.specifiers[0].imported.name, 'isQuoteEligibleForNotification');
      }
      if (node.type === 'Identifier' && node.name === 'isQuoteEligibleForNotification') references++;
      if (node.type === 'CallExpression' && node.callee?.name === 'isQuoteEligibleForNotification') {
        calls++; assert.equal(text.slice(node.start, node.end), 'isQuoteEligibleForNotification(fund.quote, { now })');
      }
    });
    assert.equal(imports, 1); assert.equal(calls, 1); assert.equal(references, 3);
    assert.ok(text.includes('if (!isQuoteEligibleForNotification(fund.quote, { now })) continue;'));
  }
  guard(source);
  assert.throws(() => guard(source + '\nconst leak = isQuoteEligibleForNotification;'));
  assert.throws(() => guard(source.replace('isQuoteEligibleForNotification(fund.quote, { now })', 'isQuoteEligibleForNotification(fund.quote, { now, maxAgeMs: 1 })')));
  assert.throws(() => guard(source.replace('if (!isQuoteEligibleForNotification(fund.quote, { now })) continue;', 'const detail = isQuoteEligibleForNotification(fund.quote, { now }); if (!detail.eligible) continue;')));
});

test('notification production import surface stays closed across all JS sources', async () => {
  const publicFile = resolve(ROOT, 'js/runtime/notification-policy.js');
  const privateFile = resolve(ROOT, 'js/runtime/notification-policy-runtime.js');
  const controllerFile = resolve(ROOT, 'js/notifications/notification-controller.js');
  const sources = new Map();
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.name.endsWith('.js')) sources.set(path, lf(await readFile(path, 'utf8')));
    }
  }
  await visit(resolve(ROOT, 'js'));
  function guard(values) {
    const runtime = parseSync('notification-policy-runtime.js', values.get(privateFile)).program;
    const isAlias = runtime.body.length === 1 && runtime.body[0].type === 'ExportNamedDeclaration'
      && runtime.body[0].source?.value === './notification-policy.js';
    const alias = EXPECTED_POLICY_IMPORT === '../runtime/notification-policy.js';
    assert.equal(isAlias, alias, 'the characterized stage must match the explicit production policy target');
    const actual = [];
    for (const [file, text] of values) {
      walk(parseSync(file, text).program, node => {
        let specifier = null;
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) specifier = node.source?.value;
        if (node.type === 'ImportExpression') specifier = node.source?.value;
        if (typeof specifier !== 'string' || !specifier.startsWith('.')) return;
        const target = resolve(dirname(file), specifier);
        if (target !== publicFile && target !== privateFile) return;
        assert.notEqual(node.type, 'ImportExpression', 'the policy seam is a static import, not an escaping dynamic namespace');
        actual.push({ file, target, kind: node.type, names: node.specifiers?.map(value => value.imported?.name || value.exported?.name).sort() });
      });
    }
    const expected = alias ? [
      { file: controllerFile, target: publicFile, kind: 'ImportDeclaration', names: ['isQuoteEligibleForNotification'] },
      { file: privateFile, target: publicFile, kind: 'ExportNamedDeclaration', names: ['isQuoteEligibleForNotification'] },
    ] : [
      { file: controllerFile, target: privateFile, kind: 'ImportDeclaration', names: ['isQuoteEligibleForNotification'] },
    ];
    const order = rows => [...rows].sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual(order(actual), order(expected));
  }
  guard(sources);
  const escaped = new Map(sources);
  escaped.set(resolve(ROOT, 'js/unexpected-notification-consumer.js'),
    "import { isQuoteEligibleForNotification } from './runtime/notification-policy-runtime.js';");
  assert.throws(() => guard(escaped), 'a new private consumer needs explicit contract review');
  const namespace = new Map(sources);
  namespace.set(controllerFile, sources.get(controllerFile).replace(
    'import { isQuoteEligibleForNotification }', 'import * as policy'));
  assert.throws(() => guard(namespace), 'namespace access is outside the boolean-only contract');
});

test('notification internal AST retains every public guard/read/default except explicit result-only projection', async () => {
  const original = lf(await readFile(`${ROOT}/js/runtime/notification-policy.js`, 'utf8'));
  const runtime = lf(await readFile(`${ROOT}/js/runtime/notification-policy-runtime.js`, 'utf8'));
  const parse = value => parseSync('notification.js', value).program;
  const declaration = (program, name) => program.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
    .find(node => node?.type === 'FunctionDeclaration' && node.id.name === name);
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'loc', 'range', 'raw', 'comments'].includes(key)).map(([key, child]) => [key, stable(child)]));
  }
  const old = parse(original);
  const falseLiteral = declaration(parse('function marker(){return false;}'), 'marker').body.body[0].argument;
  const trueLiteral = declaration(parse('function marker(){return true;}'), 'marker').body.body[0].argument;
  const expectedMain = structuredClone(declaration(old, 'evaluateNotificationEligibility'));
  expectedMain.id.name = 'isQuoteEligibleForNotification';
  walk(expectedMain, node => {
    if (node.type === 'ReturnStatement') {
      assert.equal(node.argument.type, 'CallExpression');
      assert.ok(['rejected', 'eligible'].includes(node.argument.callee.name));
      node.argument = structuredClone(node.argument.callee.name === 'rejected' ? falseLiteral : trueLiteral);
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'timestampRejection') {
      assert.ok(['observedAt', 'fetchedAt'].includes(node.arguments[0].value));
      node.callee.name = 'timestampRejected'; node.arguments.shift();
    }
  });
  const expectedTime = structuredClone(declaration(old, 'timestampRejection'));
  expectedTime.id.name = 'timestampRejected';
  assert.equal(expectedTime.params[0].name, 'label'); expectedTime.params.shift();
  const prefix = expectedTime.body.body.shift();
  assert.equal(prefix.type, 'VariableDeclaration'); assert.equal(prefix.declarations[0].id.name, 'prefix');
  walk(expectedTime, node => {
    if (node.type !== 'ReturnStatement') return;
    assert.ok(node.argument.type === 'MemberExpression' || node.argument.type === 'Literal' && node.argument.value === null);
    node.argument = structuredClone(node.argument.type === 'MemberExpression' ? trueLiteral : falseLiteral);
  });
  function guard(source) {
    const actual = parse(source);
    assert.deepEqual(stable(declaration(actual, 'isQuoteEligibleForNotification')), stable(expectedMain));
    assert.deepEqual(stable(declaration(actual, 'timestampRejected')), stable(expectedTime));
    assert.deepEqual(stable(declaration(actual, 'instantMs')), stable(declaration(old, 'instantMs')));
    const constantNames = ['ELIGIBLE_STATUSES', 'DEFAULT_NOTIFICATION_MAX_AGE_MS', 'DEFAULT_NOTIFICATION_FUTURE_SKEW_MS'];
    const selectConstants = ast => ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
      .filter(node => node?.type === 'VariableDeclaration' && constantNames.includes(node.declarations[0].id.name));
    assert.deepEqual(stable(selectConstants(actual)), stable(selectConstants(old)));
    assert.deepEqual(stable(actual.body.filter(node => node.type === 'ImportDeclaration')),
      stable(old.body.filter(node => node.type === 'ImportDeclaration')));
  }
  guard(runtime);
  for (const negative of [
    runtime.replace('if (!Number.isFinite(quote.changePct)) {', 'if (false) {'),
    runtime.replace('const observedMs = parseQuoteTimestamp(quote.observedAt);\n  const fetchedMs = parseQuoteTimestamp(quote.fetchedAt);',
      'const fetchedMs = parseQuoteTimestamp(quote.fetchedAt);\n  const observedMs = parseQuoteTimestamp(quote.observedAt);'),
    runtime.replace("if (quote.sourceTier === 'cache' || quote.cacheState != null) return false;", ''),
  ]) { assert.notEqual(negative, runtime); assert.throws(() => guard(negative)); }
});

test('notification boolean characterization sample counts are retained', t => {
  t.diagnostic(JSON.stringify(counts));
  assert.equal(counts.native, 7542);
  assert.equal(counts.proxy, 32);
  assert.ok(counts.sentinel > 100);
  assert.equal(counts.changing, 10);
  assert.equal(counts.options, 11);
  assert.equal(counts.controller, 4);
});

