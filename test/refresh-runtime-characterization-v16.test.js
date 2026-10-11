import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { RefreshCoordinator as RuntimeCoordinator } from '../js/runtime/refresh-runtime.js';
import { DATA_SOURCE_REGISTRY, createBuiltinSourceRegistry, createSourceRegistry,
  getDataSourceDescriptor, getSourceHealth, listDataSources } from '../js/runtime/source-registry.js';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';
import { executeDetailSecurityQuotes } from '../js/runtime/security-quote-batch.js';
import { normalizeTencentQuoteTime } from '../js/holdings-estimate.js';

const NOW = Date.parse('2026-09-30T06:00:00.000Z');
const NOW_TEXT = '2026-09-30T06:00:00.000Z';
const SOURCE = 'sinan-estimate-proxy';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function ticks(count = 2) {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

function coordinatorFor(Coordinator, options) {
  // The public class accepts validated descriptors; a production-only runtime
  // will use its built-in factory. Both paths own the same actual source set.
  return new Coordinator({ sources: DATA_SOURCE_REGISTRY, withBuiltinSources: true,
    now: () => NOW, ...options });
}

function walk(node, inspect) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') inspect(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, inspect));
    else if (value && typeof value === 'object') walk(value, inspect);
  }
}

function membersOf(program, object) {
  const names = new Set();
  walk(program, node => {
    if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier' || node.object.name !== object) return;
    assert.equal(node.computed, false, `${object} must have a closed, static property surface`);
    names.add(node.property.name);
  });
  return [...names].sort();
}

function withoutLocations(value) {
  if (Array.isArray(value)) return value.map(withoutLocations);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['start', 'end', 'range', 'loc', 'raw', 'comments', 'leadingComments', 'trailingComments'].includes(key))
    .map(([key, item]) => [key, withoutLocations(item)]));
}

function expectedRuntimeAst(originalSource) {
  const program = parseSync('reference-refresh-coordinator.js', originalSource).program;
  const declaration = program.body.find(node => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration' && node.declaration.id.name === 'RefreshCoordinator').declaration;
  const methods = declaration.body.body;
  assert.deepEqual(methods.filter(method => ['hasRegisteredSource', 'runFund'].includes(method.key.name))
    .map(method => method.key.name), ['hasRegisteredSource', 'runFund']);
  declaration.body.body = methods.filter(method => !['hasRegisteredSource', 'runFund'].includes(method.key.name));
  const constructor = methods.find(method => method.kind === 'constructor').value;
  const parameters = constructor.params[0].left;
  assert.equal(parameters.type, 'ObjectPattern');
  assert.deepEqual(parameters.properties.filter(property => ['sources', 'sourceHealthPolicy'].includes(property.key.name))
    .map(property => property.key.name), ['sources', 'sourceHealthPolicy']);
  const selectedProperty = parseSync('selection.js', 'function selection({ withBuiltinSources = false } = {}) {}')
    .program.body[0].params[0].left.properties[0];
  parameters.properties = parameters.properties.filter(property => property.key.name !== 'sourceHealthPolicy')
    .map(property => property.key.name === 'sources' ? selectedProperty : property);
  let factoryChanges = 0;
  walk(constructor.body, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'createSourceRegistry') return;
    assert.deepEqual(node.arguments.map(argument => [argument.type, argument.name]),
      [['Identifier', 'sources'], ['Identifier', 'sourceHealthPolicy']]);
    node.callee.name = 'createBuiltinSourceRegistry';
    node.arguments = [{ type: 'Identifier', name: 'withBuiltinSources' }];
    factoryChanges++;
  });
  assert.equal(factoryChanges, 1);
  const registryImport = program.body.find(node => node.type === 'ImportDeclaration' && node.source.value === './source-registry.js');
  const factorySpecifier = registryImport.specifiers.find(node => node.imported?.name === 'createSourceRegistry');
  assert.ok(factorySpecifier);
  factorySpecifier.imported.name = 'createBuiltinSourceRegistry';
  factorySpecifier.local.name = 'createBuiltinSourceRegistry';
  const contextMethod = methods.find(method => method.key.name === 'contextFor').value;
  let contextChanges = 0;
  walk(contextMethod.body, node => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier' || node.left.name !== 'context') return;
    assert.equal(node.right.type, 'CallExpression');
    assert.equal(node.right.callee.object.name, 'Object');
    assert.equal(node.right.callee.property.name, 'freeze');
    const object = node.right.arguments[0];
    assert.equal(object.type, 'ObjectExpression');
    assert.deepEqual(object.properties.filter(property => ['commitPartial', 'runFund'].includes(property.key.name))
      .map(property => property.key.name), ['commitPartial', 'runFund']);
    object.properties = object.properties.filter(property => !['commitPartial', 'runFund'].includes(property.key.name));
    contextChanges++;
  });
  assert.equal(contextChanges, 1);
  return withoutLocations(program);
}

test('M3 runtime common AST is identical to the public implementation outside the explicit narrowing whitelist', async () => {
  const original = (await readFile(new URL('../js/runtime/refresh-coordinator.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const runtime = (await readFile(new URL('../js/runtime/refresh-runtime.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const expected = expectedRuntimeAst(original);
  assert.deepEqual(withoutLocations(parseSync('refresh-runtime.js', runtime).program), expected);
  assert.deepEqual(Object.getOwnPropertyNames(RuntimeCoordinator.prototype),
    Object.getOwnPropertyNames(RefreshCoordinator.prototype).filter(name => !['hasRegisteredSource', 'runFund'].includes(name)));
  for (const [from, to] of [
    ['typeof execute !== \'function\'', 'typeof execute === \'function\''],
    ['if (this.current) this.current.abort(\'superseded\');', 'if (this.current) this.current.abort(\'changed\');'],
    ['return Object.freeze({ committed: true, value });', 'return Object.freeze({ committed: false, value });'],
  ]) {
    assert.equal(runtime.split(from).length, 2, 'negative-control mutation must target exactly one expression');
    assert.notDeepEqual(withoutLocations(parseSync('changed-runtime.js', runtime.replace(from, to)).program), expected);
  }
});

// Independent pre-narrowing product declaration, including insertion order.
// These are public synthetic descriptor values, never user holdings or secrets.
const EXPECTED_DESCRIPTORS = [
  { id: 'sinan-estimate-proxy', markets: ['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii'],
    capabilities: ['intraday_estimate', 'official_nav', 'holding_lookthrough_estimate'], priority: 100,
    timeoutMs: 10000, freshnessPolicy: 'source-observed-time', requiresProxy: true, sourceTier: 'primary' },
  { id: 'sinan-holdings-proxy', markets: ['cn', 'hk'], capabilities: ['holdings_snapshot'], priority: 90,
    timeoutMs: 10000, freshnessPolicy: 'source-observed-time', requiresProxy: true, sourceTier: 'primary' },
  { id: 'eastmoney-official-nav', markets: ['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii'],
    capabilities: ['official_nav'], priority: 80, timeoutMs: 7000,
    freshnessPolicy: 'official-nav-date', requiresProxy: false, sourceTier: 'secondary' },
  { id: 'eastmoney-security-quote', markets: ['cn', 'gold'], capabilities: ['security_quote'], priority: 60,
    timeoutMs: 7000, freshnessPolicy: 'exact-source-time-required', requiresProxy: false, sourceTier: 'secondary' },
  { id: 'tencent-market-quote', markets: ['cn', 'hk', 'us', 'jp', 'kr'], capabilities: ['security_quote', 'index_quote'], priority: 60,
    timeoutMs: 8000, freshnessPolicy: 'exact-source-time-required', requiresProxy: false, sourceTier: 'secondary' },
  { id: 'market-model', markets: ['us', 'jp', 'kr', 'qdii'], capabilities: ['model_estimate'], priority: 40,
    timeoutMs: 8000, freshnessPolicy: 'model-underlying-time', requiresProxy: false, sourceTier: 'model' },
  { id: 'quarterly-holdings-model', markets: ['cn'], capabilities: ['holding_lookthrough_estimate'], priority: 40,
    timeoutMs: 10000, freshnessPolicy: 'same-day-lookthrough', requiresProxy: true, sourceTier: 'model' },
  { id: 'local-cache', markets: ['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii', 'unknown'], capabilities: ['cached_quote'], priority: 10,
    timeoutMs: 0, freshnessPolicy: 'never-realtime', requiresProxy: false, sourceTier: 'cache' },
];

const EXPECTED_INITIAL_HEALTH = { status: 'healthy', consecutiveFailures: 0, lastSuccessAt: null,
  lastFailureAt: null, lastResponseMs: null, lastAvailableAt: null, degradationReason: null,
  cooldownUntil: null, halfOpenProbeActive: false, halfOpenProbeAt: null };

function assertFrozenTree(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertFrozenTree);
}

function assertSameKeyOrder(actual, expected) {
  if (!actual || typeof actual !== 'object') return;
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const key of Object.keys(actual)) assertSameKeyOrder(actual[key], expected[key]);
}

test('M3 built-in factory preserves literal descriptors, initial health, policy and precise JSON/key ordering', () => {
  assert.equal(JSON.stringify(DATA_SOURCE_REGISTRY), JSON.stringify(EXPECTED_DESCRIPTORS));
  assertSameKeyOrder(DATA_SOURCE_REGISTRY, EXPECTED_DESCRIPTORS);
  const expected = { policy: { failureThreshold: 3, cooldownMs: 60000 },
    sources: EXPECTED_DESCRIPTORS.map(descriptor => ({ descriptor, health: EXPECTED_INITIAL_HEALTH })) };
  const builtin = createBuiltinSourceRegistry(true);
  const publicRegistry = createSourceRegistry(DATA_SOURCE_REGISTRY);
  assert.deepEqual(builtin, expected);
  assert.equal(JSON.stringify(builtin), JSON.stringify(expected));
  assert.equal(JSON.stringify(builtin), JSON.stringify(publicRegistry));
  assertSameKeyOrder(builtin, publicRegistry);
  assertFrozenTree(builtin);
  const empty = { policy: { failureThreshold: 3, cooldownMs: 60000 }, sources: [] };
  for (const registry of [createBuiltinSourceRegistry(), createBuiltinSourceRegistry(false)]) {
    assert.deepEqual(registry, empty);
    assert.equal(JSON.stringify(registry), JSON.stringify(createSourceRegistry()));
    assertFrozenTree(registry);
  }
});

test('M3 each built-in coordinator owns descriptor arrays, initial health and policy without shared mutable records', () => {
  const first = createBuiltinSourceRegistry(true);
  const second = createBuiltinSourceRegistry(true);
  const firstEmpty = createBuiltinSourceRegistry(false);
  const secondEmpty = createBuiltinSourceRegistry(false);
  for (const [left, right] of [[first, second], [firstEmpty, secondEmpty]]) {
    assert.notStrictEqual(left, right);
    assert.notStrictEqual(left.policy, right.policy);
    assert.notStrictEqual(left.sources, right.sources);
  }
  first.sources.forEach((entry, index) => {
    const other = second.sources[index];
    const declaration = getDataSourceDescriptor(entry.descriptor.id);
    assert.strictEqual(declaration, DATA_SOURCE_REGISTRY[index]);
    assert.notStrictEqual(entry, other);
    assert.notStrictEqual(entry.health, other.health);
    for (const reference of [other.descriptor, declaration]) {
      assert.notStrictEqual(entry.descriptor, reference);
      assert.notStrictEqual(entry.descriptor.markets, reference.markets);
      assert.notStrictEqual(entry.descriptor.capabilities, reference.capabilities);
    }
    for (const action of [() => { entry.descriptor.priority = -1; },
      () => entry.descriptor.markets.push('poison'), () => { entry.health.consecutiveFailures = 999; }]) {
      assert.throws(action, TypeError);
    }
  });
  assert.equal(new Set(first.sources.map(entry => entry.health)).size, 8);
  assertFrozenTree(DATA_SOURCE_REGISTRY);
  assertFrozenTree(first);
  assertFrozenTree(second);
  const listed = listDataSources();
  listed.length = 0;
  assert.equal(DATA_SOURCE_REGISTRY.length, 8);
  assert.equal(listDataSources().length, 8);
});

test('M3 built-in selection is a strict boolean and never reads descriptor-like extra arguments', () => {
  let coercions = 0;
  const object = { valueOf() { coercions++; return 1; }, toString() { coercions++; return 'true'; } };
  for (const value of [null, 0, 1, 'true', [], {}, new Boolean(true), object]) {
    assert.throws(() => createBuiltinSourceRegistry(value),
      { name: 'TypeError', message: 'Builtin registry selection must be boolean.' });
  }
  assert.equal(coercions, 0);
  const descriptorLike = Object.defineProperty({}, 'id', { get() { assert.fail('extra argument must not be treated as a descriptor'); } });
  assert.equal(createBuiltinSourceRegistry(true, descriptorLike).sources.length, 8);
  assert.equal(createBuiltinSourceRegistry(false, descriptorLike).sources.length, 0);
});

test('M3 built-in declarations route through the complete public descriptor validator', async () => {
  const source = await readFile(new URL('../js/runtime/source-registry.js', import.meta.url), 'utf8');
  const program = parseSync('source-registry.js', source).program;
  const descriptors = program.body.find(node => node.type === 'VariableDeclaration'
    && node.declarations.some(declaration => declaration.id.name === 'DESCRIPTORS')).declarations
    .find(declaration => declaration.id.name === 'DESCRIPTORS').init;
  assert.equal(descriptors.type, 'CallExpression');
  assert.equal(descriptors.callee.type, 'MemberExpression');
  assert.equal(descriptors.callee.object.type, 'ArrayExpression');
  assert.equal(descriptors.callee.object.elements.length, 8);
  assert.equal(descriptors.callee.property.name, 'map');
  assert.deepEqual(descriptors.arguments.map(argument => [argument.type, argument.name]), [['Identifier', 'freezeDescriptor']]);
  const freezeDescriptor = program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'freezeDescriptor');
  assert.ok(freezeDescriptor);
  const calls = new Set();
  walk(freezeDescriptor, node => { if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.add(node.callee.name); });
  assert.deepEqual([...calls].sort(), ['finiteNumber', 'immutableTextList', 'isRecord', 'nonEmptyText']);
  // This contract concerns closed, validated declarations and standard
  // intrinsics, not an already-hostile realm that rewrites Array methods.
});

test('M3 production app and detail use only the closed runtime surface and explicit built-in selection', async () => {
  const paths = ['js/app.js', 'js/runtime/security-quote-batch.js',
    'js/runtime/refresh-execution.js', 'js/runtime/generation-resource-scope.js'];
  const programs = new Map(await Promise.all(paths.map(async path => [path,
    parseSync(path, (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n')).program])));
  const constructions = [];
  for (const path of paths.slice(0, 2)) {
    const imports = programs.get(path).body.filter(node => node.type === 'ImportDeclaration');
    const coordinatorImport = imports.find(node => node.specifiers.some(specifier => specifier.local.name === 'RefreshCoordinator'));
    assert.equal(coordinatorImport?.source.value,
      path === 'js/app.js' ? './runtime/refresh-runtime.js' : './refresh-runtime.js');
    assert.equal(imports.some(node => node.specifiers.some(specifier => specifier.local.name === 'DATA_SOURCE_REGISTRY')), false);
  }
  for (const [path, program] of programs) walk(program, node => {
    if (node.type !== 'NewExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'RefreshCoordinator') return;
    assert.equal(node.arguments.length, 1);
    assert.equal(node.arguments[0].type, 'ObjectExpression');
    const options = node.arguments[0].properties.map(property => {
      assert.equal(property.type, 'Property');
      assert.equal(property.computed, false);
      return property.key.name;
    }).sort();
    const builtin = node.arguments[0].properties.find(property => property.key.name === 'withBuiltinSources');
    if (builtin) assert.deepEqual([builtin.value.type, builtin.value.value], ['Literal', true]);
    constructions.push({ path, options });
  });
  assert.deepEqual(constructions, [
    { path: 'js/app.js', options: ['execute', 'onStateChange', 'withBuiltinSources'] },
    { path: 'js/runtime/security-quote-batch.js', options: ['execute', 'now'] },
  ]);
  assert.deepEqual(membersOf(programs.get('js/app.js'), 'refreshCoordinator'),
    ['activePromise', 'request', 'snapshot', 'stopAndDrain']);
  assert.deepEqual(membersOf(programs.get('js/runtime/security-quote-batch.js'), 'coordinator'), ['request', 'stop']);
  const allowedContext = new Set(['generation', 'requestId', 'startedAt', 'trigger', 'signal',
    'isCurrent', 'commit', 'recordDiagnostic', 'sourceHealth', 'canAttemptSource', 'claimSourceAttempt',
    'recordSourceSuccess', 'recordSourcePartial', 'recordSourceFailure', 'releaseSourceAttempt']);
  const allContext = new Set();
  for (const program of programs.values()) for (const name of membersOf(program, 'context')) {
    assert.ok(allowedContext.has(name), `uncharacterized production context member: ${name}`);
    allContext.add(name);
  }
  assert.ok(allContext.has('commit'));
  assert.ok(allContext.has('recordSourcePartial'));
  assert.equal(allContext.has('runFund'), false);
  assert.equal(allContext.has('commitPartial'), false);
});

// The permanent cases first execute against the unchanged public class. The
// implementation under test is never recreated as a mock scheduling algorithm.
for (const [label, Coordinator] of [['public reference', RefreshCoordinator], ['production runtime', RuntimeCoordinator]]) {
  test(`M3 ${label}: request/coalesce use one promise and preserve payload identity`, async () => {
    const gate = deferred();
    const calls = [];
    const payload = { force: false, nested: { exact: true } };
    const coordinator = coordinatorFor(Coordinator, { execute(context, value) {
      calls.push([context, value]);
      return gate.promise;
    } });
    const first = coordinator.request({ trigger: ' timer\n', payload, coalesce: true, coalesceKey: ' group\n' });
    const duplicate = coordinator.request({ trigger: 'another', payload: { ignored: true }, coalesce: true, coalesceKey: 'group' });
    assert.strictEqual(duplicate, first);
    assert.equal(calls.length, 0, 'execute must not move into the synchronous request turn');
    await ticks();
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0][1], payload);
    assert.equal(calls[0][0].trigger, ' timer\n');
    assert.equal(Object.isFrozen(calls[0][0]), true);
    const value = { changePct: 0 };
    gate.resolve(value);
    const result = await first;
    assert.deepEqual(result, { status: 'completed', generation: 1, result: value });
    assert.strictEqual(result.result, value);
    assert.equal(Object.isFrozen(result), true);
  });

  test(`M3 ${label}: then/catch/finally boundaries remain asynchronous and ordered`, async () => {
    const trace = [];
    const coordinator = coordinatorFor(Coordinator, { execute(context) {
      trace.push(`execute:${context.generation}`);
      return 'value';
    }, onStateChange(state) { trace.push(state.active ? `state:${state.active.generation}` : 'state:idle'); } });
    const task = coordinator.request({ trigger: 'timer' });
    trace.push('requested');
    queueMicrotask(() => trace.push('queued'));
    const observed = task.then(value => { trace.push('then'); return value; })
      .catch(() => { trace.push('catch'); })
      .finally(() => { trace.push('finally'); });
    assert.deepEqual(trace, ['state:1', 'requested']);
    await Promise.resolve();
    trace.push('after-first-turn');
    assert.deepEqual(trace, ['state:1', 'requested', 'execute:1', 'queued', 'after-first-turn']);
    assert.deepEqual(await observed, { status: 'completed', generation: 1, result: 'value' });
    assert.deepEqual(trace, ['state:1', 'requested', 'execute:1', 'queued', 'after-first-turn', 'state:idle', 'then', 'finally']);
    assert.equal(coordinator.activePromise, null);
  });

  test(`M3 ${label}: snapshots freeze metadata but preserve registry and result references`, async () => {
    const gate = deferred();
    let context;
    const coordinator = coordinatorFor(Coordinator, { execute(value) { context = value; return gate.promise; } });
    const initial = coordinator.snapshot();
    const registry = initial.sourceRegistry;
    assert.equal(Object.isFrozen(initial), true);
    assert.deepEqual(initial, { active: null, currentGeneration: null, lastCompleted: null,
      lastFailure: null, lastDiagnostic: null, diagnosticCount: 0, sourceRegistry: registry });
    const task = coordinator.request({ trigger: 'manual' });
    const during = coordinator.snapshot();
    assert.deepEqual(during.active, { generation: 1, requestId: `refresh-1-${NOW}`, startedAt: NOW_TEXT, trigger: 'manual' });
    assert.equal(Object.isFrozen(during.active), true);
    assert.strictEqual(during.sourceRegistry, registry);
    await ticks();
    const signal = context.signal;
    assert.strictEqual(signal, coordinator.current.signal);
    gate.resolve(null);
    assert.deepEqual(await task, { status: 'completed', generation: 1, result: null });
    const done = coordinator.snapshot();
    assert.deepEqual(done.lastCompleted, { generation: 1, requestId: `refresh-1-${NOW}`, trigger: 'manual', completedAt: NOW_TEXT });
    assert.equal(Object.isFrozen(done.lastCompleted), true);
    assert.strictEqual(done.lastCompleted, coordinator.snapshot().lastCompleted);
    assert.strictEqual(done.sourceRegistry, registry);
    assert.equal(done.active, null);
    assert.equal(done.currentGeneration, 1);
    assert.equal(signal.aborted, false);
  });

  test(`M3 ${label}: synchronous commits are guarded and detached completion expires only on replacement`, async () => {
    const contexts = [];
    const coordinator = coordinatorFor(Coordinator, { execute(context) { contexts.push(context); return 'ready'; } });
    await coordinator.request({ trigger: 'startup' });
    const first = contexts[0];
    assert.deepEqual(first.commit(null), { committed: false, value: undefined });
    let asyncCalls = 0;
    const asyncRejected = first.commit(async () => { asyncCalls++; return 'not-run'; });
    assert.deepEqual(asyncRejected, { committed: false, value: undefined, reason: 'async_commit_not_allowed' });
    assert.equal(asyncCalls, 0);
    const thenable = { then() {} };
    let syncCalls = 0;
    assert.deepEqual(first.commit(() => { syncCalls++; return thenable; }),
      { committed: false, value: undefined, reason: 'async_commit_not_allowed' });
    const value = { zero: 0, missing: null };
    const accepted = first.commit(() => { syncCalls++; return value; });
    assert.deepEqual(accepted, { committed: true, value });
    assert.strictEqual(accepted.value, value);
    assert.equal(Object.isFrozen(accepted), true);
    const error = new Error('commit marker');
    assert.throws(() => first.commit(() => { throw error; }), thrown => thrown === error);
    await coordinator.request({ trigger: 'manual' });
    assert.equal(first.signal.aborted, true);
    assert.equal(first.signal.reason, 'superseded');
    assert.deepEqual(first.commit(() => { syncCalls++; }), { committed: false, value: undefined });
    assert.equal(syncCalls, 2);
    assert.equal(contexts[1].isCurrent(), true);
  });

  test(`M3 ${label}: replacement before execute, late rejection, and old finally do not clear a newer task`, async () => {
    const secondGate = deferred();
    const contexts = [];
    const coordinator = coordinatorFor(Coordinator, { execute(context) { contexts.push(context); return secondGate.promise; } });
    const first = coordinator.request({ trigger: 'timer' });
    const second = coordinator.request({ trigger: 'manual' });
    assert.notStrictEqual(first, second);
    assert.deepEqual(await first, { status: 'superseded', generation: 1, result: null });
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].generation, 2);
    assert.strictEqual(coordinator.activePromise, second);
    assert.equal(coordinator.snapshot().active.generation, 2);
    secondGate.resolve('new');
    assert.deepEqual(await second, { status: 'completed', generation: 2, result: 'new' });

    const oldGate = deferred();
    const newGate = deferred();
    const late = coordinatorFor(Coordinator, { execute(context) { return context.generation === 1 ? oldGate.promise : newGate.promise; } });
    const old = late.request();
    await ticks();
    const current = late.request();
    oldGate.reject(new Error('late source failure'));
    assert.deepEqual(await old, { status: 'aborted', generation: 1, result: null });
    assert.strictEqual(late.activePromise, current);
    assert.equal(late.lastFailure, null);
    newGate.resolve(0);
    assert.deepEqual(await current, { status: 'completed', generation: 2, result: 0 });
  });

  test(`M3 ${label}: stop and drain wait for the actual task and retain sequence gaps`, async () => {
    const gate = deferred();
    let context;
    const trace = [];
    const coordinator = coordinatorFor(Coordinator, { execute(value) { context = value; return gate.promise; } });
    const task = coordinator.request({ trigger: 'manual' });
    await ticks();
    const drain = coordinator.stopAndDrain('service-worker-update').then(value => { trace.push('drained'); return value; });
    assert.equal(context.signal.aborted, true);
    assert.equal(context.signal.reason, 'service-worker-update');
    assert.equal(coordinator.current, null);
    assert.equal(coordinator.activePromise, null);
    await ticks(6);
    assert.deepEqual(trace, []);
    gate.resolve('late');
    assert.deepEqual(await task, { status: 'superseded', generation: 1, result: null });
    assert.equal(await drain, true);
    assert.deepEqual(trace, ['drained']);
    assert.equal(coordinator.stop('nothing-active'), false);
    const next = coordinator.request({ trigger: 'manual' });
    assert.equal(coordinator.snapshot().currentGeneration, 4);
    assert.equal((await next).generation, 4);
  });

  test(`M3 ${label}: observer exceptions cannot break real failure, diagnostic, or recovery state`, async () => {
    const error = Object.assign(new Error('synthetic request'), { code: 'HTTP_503' });
    const callbacks = [];
    const observedErrors = [];
    let invocation = 0;
    const coordinator = coordinatorFor(Coordinator, {
      execute(context) {
        context.recordDiagnostic(' type\nwith\ttabs ', { key: ' 005844\n', sourceId: SOURCE, reason: ' bounded\nreason ' });
        if (invocation++ === 0) throw error;
        return 'recovered';
      },
      onStateChange(value) { callbacks.push(['state', value.active?.generation || null]); throw new Error('state observer'); },
      onDiagnostic(value) { callbacks.push(['diagnostic', value.type]); throw new Error('diagnostic observer'); },
      onError(value) { callbacks.push(['error', value.errorKind]); observedErrors.push(value); throw new Error('error observer'); },
    });
    const task = coordinator.request({ trigger: 'manual' });
    let caught = false;
    const failed = await task.catch(() => { caught = true; });
    assert.deepEqual(failed, { status: 'failed', generation: 1, error });
    assert.equal(caught, false, 'coordinator reports failure as a fulfilled outcome, not a task rejection');
    assert.equal(Object.isFrozen(failed), true);
    assert.deepEqual(coordinator.snapshot().lastFailure, { generation: 1, requestId: `refresh-1-${NOW}`,
      trigger: 'manual', failedAt: NOW_TEXT, errorKind: 'HTTP_503' });
    assert.deepEqual(coordinator.snapshot().lastDiagnostic, { generation: 1, requestId: `refresh-1-${NOW}`,
      trigger: 'manual', recordedAt: NOW_TEXT, type: 'type with tabs', key: '005844', sourceId: SOURCE, reason: 'bounded reason' });
    assert.equal(coordinator.snapshot().currentGeneration, null);
    assert.equal(observedErrors.length, 1);
    assert.strictEqual(observedErrors[0].error, error);
    assert.equal(Object.isFrozen(observedErrors[0]), true);
    assert.deepEqual(callbacks, [['state', 1], ['diagnostic', 'type with tabs'], ['state', 1], ['error', 'HTTP_503'], ['state', null]]);
    assert.equal((await coordinator.request({ trigger: 'manual' })).status, 'completed');
    assert.equal(coordinator.lastFailure, null);
    assert.equal(coordinator.diagnosticCount, 2);
  });

  test(`M3 ${label}: late real success/failure remain health evidence but stale partial never updates it`, async () => {
    let now = NOW;
    const contexts = [];
    const coordinator = coordinatorFor(Coordinator, { now: () => now,
      execute(context) { contexts.push(context); return context.generation; } });
    await coordinator.request({ trigger: 'timer' });
    const old = contexts[0];
    await coordinator.request({ trigger: 'manual' });
    const current = contexts[1];
    now += 25;
    const failure = old.recordSourceFailure(SOURCE, { code: 'HTTP_503', responseMs: 25 });
    assert.deepEqual(failure, { status: 'degraded', consecutiveFailures: 1, lastSuccessAt: null,
      lastFailureAt: NOW + 25, lastResponseMs: 25, lastAvailableAt: null, degradationReason: 'HTTP_503',
      cooldownUntil: null, halfOpenProbeActive: false, halfOpenProbeAt: null });
    const registry = coordinator.registry;
    assert.equal(old.recordSourcePartial(SOURCE, { responseMs: 999, reason: 'late partial' }), false);
    assert.strictEqual(coordinator.registry, registry);
    now += 25;
    const success = old.recordSourceSuccess(SOURCE, { responseMs: 50, availableAt: NOW_TEXT });
    assert.deepEqual(success, { status: 'healthy', consecutiveFailures: 0, lastSuccessAt: NOW + 50,
      lastFailureAt: NOW + 25, lastResponseMs: 50, lastAvailableAt: NOW_TEXT, degradationReason: null,
      cooldownUntil: null, halfOpenProbeActive: false, halfOpenProbeAt: null });
    assert.strictEqual(current.sourceHealth(SOURCE), success);
    assert.equal(current.recordSourcePartial(SOURCE, { reason: 'partial_1_of_2', responseMs: 0, availableAt: NOW - 100 }), true);
    const partial = current.sourceHealth(SOURCE);
    assert.equal(partial.status, 'degraded');
    assert.equal(partial.consecutiveFailures, 0);
    assert.equal(partial.lastResponseMs, 0);
    assert.equal(partial.lastAvailableAt, NOW_TEXT, 'older availableAt must not replace a later source observation');
    assert.equal(partial.degradationReason, 'partial_1_of_2');
    assert.equal(Object.isFrozen(partial), true);
  });

  test(`M3 ${label}: actual source breaker reserves one half-open attempt and abort releases without failure`, async () => {
    let now = NOW;
    let context;
    const coordinator = coordinatorFor(Coordinator, { now: () => now, execute(value) { context = value; } });
    await coordinator.request();
    for (let index = 1; index <= 3; index++) context.recordSourceFailure(SOURCE, { reason: 'timeout', responseMs: index });
    const failed = context.sourceHealth(SOURCE);
    assert.equal(failed.status, 'cooldown');
    assert.equal(failed.consecutiveFailures, 3);
    assert.equal(failed.cooldownUntil, NOW + 60_000);
    assert.deepEqual(context.claimSourceAttempt(SOURCE), { allowed: false, halfOpen: false });
    now = NOW + 59_999;
    assert.equal(context.canAttemptSource(SOURCE), false);
    now++;
    assert.equal(context.canAttemptSource(SOURCE), true);
    const claim = context.claimSourceAttempt(SOURCE);
    assert.deepEqual(claim, { allowed: true, halfOpen: true });
    assert.equal(Object.isFrozen(claim), true);
    const probing = context.sourceHealth(SOURCE);
    assert.equal(probing.halfOpenProbeAt, now);
    assert.equal(probing.halfOpenProbeActive, true);
    assert.deepEqual(context.claimSourceAttempt(SOURCE), { allowed: false, halfOpen: false });
    const released = context.recordSourceFailure(SOURCE, Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    assert.deepEqual(released, { ...failed, halfOpenProbeActive: false, halfOpenProbeAt: null });
    assert.equal(context.canAttemptSource(SOURCE), true);
    assert.deepEqual(context.claimSourceAttempt(SOURCE), { allowed: true, halfOpen: true });
    context.releaseSourceAttempt(SOURCE);
    assert.equal(context.sourceHealth(SOURCE).consecutiveFailures, 3);
    assert.equal(context.recordSourcePartial(SOURCE, { reason: 'partial', responseMs: 0 }), true);
    assert.equal(context.sourceHealth(SOURCE).status, 'degraded');
    assert.equal(context.sourceHealth(SOURCE).cooldownUntil, null);
    assert.equal(context.sourceHealth(SOURCE).halfOpenProbeActive, false);
    assert.equal(context.sourceHealth('unknown'), null);
    assert.equal(context.canAttemptSource('unknown'), false);
    assert.deepEqual(context.claimSourceAttempt('unknown'), { allowed: false, halfOpen: false });
    assert.throws(() => context.recordSourceSuccess('unknown'), { name: 'RangeError', message: 'Unknown source: unknown.' });
  });

  test(`M3 ${label}: real generation scope blocks obsolete dispatch/UI/cache and shares rejected acquisition`, async () => {
    const oldGate = deferred();
    const entered = deferred();
    const scopes = [];
    const events = [];
    const coordinator = coordinatorFor(Coordinator, { execute: async context => {
      const scope = createGenerationResourceScope({ context, now: () => NOW,
        plan: { generation: context.generation, resources: [{ key: 'nav:005844', action: 'fetch', cacheExpiresAt: null }] } });
      scopes.push(scope);
      const load = () => scope.dispatch('eastmoney-official-nav', signal => {
        assert.strictEqual(signal, context.signal);
        if (context.generation === 1) { entered.resolve(); return oldGate.promise; }
        return { nav: 2, missing: null, zero: 0 };
      });
      const first = scope.acquire('nav:005844', load);
      assert.strictEqual(scope.acquire('nav:005844', load), first);
      const result = await first;
      assert.equal(scope.stageCache('nav:005844', result, value => value.nav === 2), true);
      assert.equal(scope.commitUi(() => { events.push(`ui:${context.generation}`); }).committed, true);
      assert.equal(scope.flushCache({ storage: { setItem(key, raw) {
        events.push(`cache:${context.generation}`);
        assert.equal(key, 'fuyu_funds_cache_v1');
        assert.deepEqual(JSON.parse(raw), { 'nav:005844': { nav: 2, missing: null, zero: 0 } });
      } }, serialize: JSON.stringify }), true);
      return result;
    } });
    const old = coordinator.request({ trigger: 'timer' });
    await entered.promise;
    const current = coordinator.request({ trigger: 'manual' });
    assert.equal((await current).status, 'completed');
    oldGate.reject(new Error('late transport failure'));
    assert.deepEqual(await old, { status: 'aborted', generation: 1, result: null });
    assert.deepEqual(events, ['ui:2', 'cache:2']);
    assert.equal(scopes[0].snapshot().requests, 1);
    assert.equal(scopes[0].snapshot().deduped, 1);
    assert.equal(scopes[0].snapshot().abortedRequests, 1);
    assert.equal(scopes[0].snapshot().cacheWrites, 0);
    assert.equal(scopes[1].snapshot().cacheWrites, 1);
    assert.deepEqual(scopes[0].commitUi(() => { events.push('forbidden'); }), { committed: false });
  });

  test(`M3 ${label}: numeric clock conversion and the actual injected AbortController retain request boundaries`, async () => {
    let creates = 0;
    const aborts = [];
    class RecordingAbortController extends AbortController {
      constructor() { super(); creates++; }
      abort(reason) { aborts.push(reason); return super.abort(reason); }
    }
    const coordinator = coordinatorFor(Coordinator, { now: () => String(NOW),
      AbortControllerClass: RecordingAbortController, execute(context) {
        assert.equal(context.startedAt, NOW_TEXT);
        assert.ok(context.signal instanceof AbortSignal);
        return context.generation;
      } });
    assert.deepEqual(await coordinator.request(), { status: 'completed', generation: 1, result: 1 });
    assert.deepEqual(await coordinator.request(), { status: 'completed', generation: 2, result: 2 });
    assert.equal(creates, 2);
    assert.deepEqual(aborts, ['superseded']);
    assert.equal(coordinator.stop('explicit stop'), true);
    assert.deepEqual(aborts, ['superseded', 'explicit stop']);
    assert.throws(() => coordinatorFor(Coordinator, { now: null, execute() {} }),
      { name: 'TypeError', message: 'RefreshCoordinator now must be a function.' });
    assert.throws(() => coordinatorFor(Coordinator, { execute: null }),
      { name: 'TypeError', message: 'RefreshCoordinator execute must be a function.' });
  });
}

test('M3 actual detail wrapper preserves zero, refuses late aborted quotes, and removes its cancel listener', async () => {
  const result = await executeDetailSecurityQuotes({ items: [{ quoteCode: 'sh600000' }], now: () => NOW,
    normalizeTime: normalizeTencentQuoteTime,
    fetchEastmoney: async codes => {
      assert.deepEqual(codes, ['sh600000']);
      return { data: { diff: [{ f12: '600000', f13: 1, f2: 10, f3: 0, f124: NOW / 1000 }] } };
    }, fetchBridge: async () => { assert.fail('a legitimate zero must not fall through to another source'); } });
  assert.deepEqual(result, { sh600000: { quoteCode: 'sh600000', change: 0, quoteTime: '2026-09-30 14:00:00' } });

  const controller = new AbortController();
  const gate = deferred();
  const entered = deferred();
  const trace = [];
  const nativeAdd = controller.signal.addEventListener.bind(controller.signal);
  const nativeRemove = controller.signal.removeEventListener.bind(controller.signal);
  let listener;
  controller.signal.addEventListener = (type, callback, options) => {
    trace.push(['add', type, options.once]); listener = callback;
    return nativeAdd(type, callback, options);
  };
  controller.signal.removeEventListener = (type, callback) => {
    trace.push(['remove', type, callback === listener]);
    return nativeRemove(type, callback);
  };
  const task = executeDetailSecurityQuotes({ items: [{ quoteCode: 'sh600000' }], signal: controller.signal,
    now: () => NOW, normalizeTime: normalizeTencentQuoteTime,
    fetchEastmoney: (codes, signal) => { assert.equal(signal.aborted, false); entered.resolve(); return gate.promise; },
    fetchBridge: async () => { assert.fail('cancelled detail must not start fallback'); } });
  const rejected = assert.rejects(task, { name: 'AbortError' });
  await entered.promise;
  controller.abort('detail closed');
  gate.resolve({ data: { diff: [{ f12: '600000', f13: 1, f2: 10, f3: 99, f124: NOW / 1000 }] } });
  await rejected;
  assert.deepEqual(trace, [['add', 'abort', true], ['remove', 'abort', true]]);
});

test('M3 public generic coordinator API remains available independently of production narrowing', async () => {
  const partials = [];
  const coordinator = new RefreshCoordinator({ now: () => NOW,
    sources: [{ id: 'synthetic', markets: ['cn'], capabilities: ['estimate'], priority: 1,
      timeoutMs: 100, freshnessPolicy: 'test-only', requiresProxy: false }],
    sourceHealthPolicy: { failureThreshold: 1, cooldownMs: 7 },
    onPartial(entry) { partials.push(entry); },
    execute(context) { return context.runFund('005844', async () => 0, { sourceId: 'synthetic' }); },
  });
  assert.equal(coordinator.hasRegisteredSource('synthetic'), true);
  const result = await coordinator.request();
  assert.deepEqual(result.result, { key: '005844', status: 'fulfilled', committed: true, value: 0 });
  assert.equal(partials.length, 1);
  assert.equal(partials[0].value, 0);
  assert.equal(getSourceHealth(coordinator.registry, 'synthetic').status, 'healthy');
  assert.deepEqual(coordinator.registry.policy, { failureThreshold: 1, cooldownMs: 7 });
});
