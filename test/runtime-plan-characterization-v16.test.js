// Closed production projections are paired with independent public contract
// assertions below. Keep the complete public plan and executor test suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import {
  createRefreshPlan, createRuntimeRefreshPlan,
  createSecurityQuotePlan, createRuntimeSecurityQuotePlan,
} from '../js/runtime/refresh-plan.js';
import { TTL } from '../js/config.js';
import { executeRefreshPlan } from '../js/runtime/refresh-execution.js';
import { executeDetailSecurityQuotes } from '../js/runtime/security-quote-batch.js';
import { RefreshCoordinator } from '../js/runtime/refresh-runtime.js';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';

const NOW = Date.parse('2026-09-30T06:00:00Z');
const CODE = '005844';
const HOLDING = { code: CODE, name: 'Synthetic 混合基金', shares: 0, cost: null };
const fresh = () => ({ validated: true, fetchedAt: NOW - 100, cachedAt: NOW - 50,
  expiresAt: NOW + 1000, sourceTier: 'cache', status: 'current', cacheState: 'fresh' });

function refreshProjection(value) {
  return {
    generation: value.generation, activeCodes: value.activeCodes,
    resources: value.resources.map(row => row.kind === 'securities' || row.kind === 'model-quotes'
      ? { key: row.key, kind: row.kind, action: row.action, cacheExpiresAt: row.cacheExpiresAt }
      : { key: row.key, kind: row.kind, codes: row.codes, cacheExpiresAt: row.cacheExpiresAt, action: row.action }),
  };
}
function securityProjection(value) {
  return { generation: value.generation, securityCodes: value.securityCodes,
    modelCodes: value.modelCodes, goldRequired: value.goldRequired };
}
function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozen(child);
}

test('closed runtime refresh plan equals full public execution projection without weakening force/TTL/quality rules', () => {
  const metas = [fresh(), {}, { ...fresh(), validated: false }, { ...fresh(), status: 'stale' },
    { ...fresh(), sourceTier: 'invented' }, { ...fresh(), expiresAt: NOW },
    { ...fresh(), cachedAt: NOW - TTL.OFFICIAL_NAV, expiresAt: NOW + TTL.FUND_META },
    Object.create(fresh())];
  const holdings = [[], [HOLDING], [HOLDING, { code: '012920', name: 'Synthetic QDII' }],
    [{ ...HOLDING, deleted: true }], [{ fundCode: CODE, name: HOLDING.name }],
    Array.from({ length: 51 }, (_, index) => ({ code: String(index + 1).padStart(6, '0'), name: HOLDING.name }))];
  for (const activeHoldings of holdings) for (const trigger of ['manual', 'diagnostic'])
    for (const forceLive of [false, true]) for (const meta of metas) {
      const input = { generation: 1, now: NOW, activeHoldings, trigger, forceLive,
        forceStable: [`nav:${CODE}`, 'nav:*'], cacheIndex: {
          [`nav:${CODE}`]: meta, [`holdings:${CODE}`]: meta, [`meta:${CODE}`]: meta,
          'gold:AU9999': meta, [`estimates:${CODE}`]: meta,
        } };
      const result = createRuntimeRefreshPlan(input);
      assert.deepEqual(result, refreshProjection(createRefreshPlan(input)));
      assertFrozen(result);
      assert.deepEqual(Object.keys(result), ['generation', 'activeCodes', 'resources']);
    }
});

test('private security projection retains validation/dedup/fallback/gold behavior while generic public index metadata stays public', () => {
  const scenarios = [
    { snapshots: [], selectedModels: [] },
    { snapshots: [{ validated: true, status: 'ok', items: [
      { quoteCode: 'sh000001' }, { quoteCode: 'sh000001' }, { quoteCode: 'hk00700' }, { quoteCode: 'bad' },
    ] }], selectedModels: [{ legs: [{ code: 'usNDX' }, { code: 'AU9999' }],
      fallback: { legs: [{ code: 'jpN225' }] } }] },
    { snapshots: [{ validated: false, status: 'ok', items: [] },
      { validated: true, status: 'degraded', items: [{ quoteCode: 'sh000001' }] }],
      selectedModels: [{ legs: [{ code: '<script>' }, { code: 'hk00700' }] }] },
  ];
  for (const scenario of scenarios) {
    const input = { generation: 1, ...scenario };
    const result = createRuntimeSecurityQuotePlan(input);
    assert.deepEqual(result, securityProjection(createSecurityQuotePlan(input)));
    assertFrozen(result);
    assert.deepEqual(Object.keys(result), ['generation', 'securityCodes', 'modelCodes', 'goldRequired']);
  }
  const publicPlan = createSecurityQuotePlan({ generation: 1, indexCodes: ['usNDX', 'bad'] });
  assert.deepEqual(publicPlan.indexCodes, ['usNDX']);
  assert.equal(publicPlan.rejected.length, 1);
  assert.deepEqual(publicPlan.qualifiedCodes, ['usNDX']);
});

test('shared cache validator preserves changing getter order and sentinel identity for both plan presentations', () => {
  const sentinel = Object.freeze({ synthetic: 'input-sentinel' });
  const values = { validated: [true], fetchedAt: [NOW - 100, NOW - 90],
    cachedAt: [NOW - 50, NOW - 40, NOW - 30, NOW - 20, NOW - 10],
    expiresAt: [NOW + 1000, NOW + 900, NOW + 800, NOW + 700],
    sourceTier: ['cache'], status: ['current'], cacheState: ['fresh'] };
  function input(trace, fail = null) {
    const reads = {}, meta = {};
    for (const [field, list] of Object.entries(values)) Object.defineProperty(meta, field, {
      enumerable: true, get() {
        const count = reads[field] = (reads[field] || 0) + 1;
        const event = `${field}:${count}`; trace.push(event);
        if (event === fail) throw sentinel;
        return list[Math.min(count - 1, list.length - 1)];
      },
    });
    return { generation: 1, now: NOW, activeHoldings: [HOLDING], forceLive: true,
      cacheIndex: { [`nav:${CODE}`]: meta } };
  }
  const trace = [];
  const expected = refreshProjection(createRefreshPlan(input(trace)));
  const runtimeTrace = [];
  assert.deepEqual(createRuntimeRefreshPlan(input(runtimeTrace)), expected);
  assert.deepEqual(runtimeTrace, trace);
  for (const event of trace) {
    const a = [], b = [];
    assert.throws(() => createRefreshPlan(input(a, event)), error => error === sentinel);
    assert.throws(() => createRuntimeRefreshPlan(input(b, event)), error => error === sentinel);
    assert.deepEqual(a, b);
  }
});

test('runtime plans keep explicit clock/generation guards and never read wall-clock time', () => {
  const readClock = Date.now;
  Date.now = () => { throw new Error('synthetic forbidden wall clock'); };
  try {
    const input = { generation: 1, now: NOW, activeHoldings: [HOLDING] };
    assert.deepEqual(createRuntimeRefreshPlan(input), refreshProjection(createRefreshPlan(input)));
    const security = { generation: 1, snapshots: [], selectedModels: [] };
    assert.deepEqual(createRuntimeSecurityQuotePlan(security), securityProjection(createSecurityQuotePlan(security)));
    for (const generation of [0, -1, 1.5, '1', null, undefined]) {
      assert.throws(() => createRuntimeRefreshPlan({ ...input, generation }), TypeError);
      assert.throws(() => createRuntimeSecurityQuotePlan({ generation }), TypeError);
    }
    for (const now of [undefined, null, NaN, Infinity, -1, NOW + .5, '2026-09-30'])
      assert.throws(() => createRuntimeRefreshPlan({ ...input, now }), TypeError);
  } finally { Date.now = readClock; }
});

test('public reason, expiry, property order and freezing retain independent legacy expectations', () => {
  const inheritedIndex = Object.create({ [`nav:${CODE}`]: fresh() });
  const cases = [
    [{}, 'fetch', 'cache_miss', null],
    [inheritedIndex, 'fetch', 'cache_miss', null],
    [{ [`nav:${CODE}`]: {} }, 'fetch', 'cache_metadata_invalid', null],
    [{ [`nav:${CODE}`]: Object.create(fresh()) }, 'fetch', 'cache_metadata_invalid', null],
    [{ [`nav:${CODE}`]: { ...fresh(), validated: false } }, 'fetch', 'cache_metadata_invalid', null],
    [{ [`nav:${CODE}`]: { ...fresh(), fetchedAt: NOW + 1 } }, 'fetch', 'cache_metadata_invalid', null],
    [{ [`nav:${CODE}`]: { ...fresh(), status: 'stale' } }, 'fetch', 'cache_quality_unusable', null],
    [{ [`nav:${CODE}`]: { ...fresh(), sourceTier: 'unknown' } }, 'fetch', 'cache_quality_unusable', null],
    [{ [`nav:${CODE}`]: { ...fresh(), cacheState: 'expired' } }, 'fetch', 'cache_quality_unusable', null],
    [{ [`nav:${CODE}`]: { ...fresh(), expiresAt: NOW } }, 'fetch', 'cache_expired', null],
    [{ [`nav:${CODE}`]: { ...fresh(), fetchedAt: NOW - TTL.OFFICIAL_NAV, cachedAt: NOW - TTL.OFFICIAL_NAV, expiresAt: NOW + TTL.FUND_META } }, 'fetch', 'cache_expired', null],
    [{ [`nav:${CODE}`]: fresh() }, 'cache', 'fresh_cache', NOW + 1000],
    [{ [`nav:${CODE}`]: { ...fresh(), expiresAt: NOW + TTL.FUND_META } }, 'cache', 'fresh_cache', NOW - 50 + TTL.OFFICIAL_NAV],
  ];
  for (const [cacheIndex, action, reason, expiry] of cases) {
    const plan = createRefreshPlan({ generation: 1, now: NOW, activeHoldings: [HOLDING], cacheIndex });
    const resource = plan.resources.find(row => row.key === `nav:${CODE}`);
    assert.equal(resource.action, action);
    assert.equal(resource.reason, reason);
    assert.equal(resource.cacheExpiresAt, expiry);
    assert.deepEqual(Object.keys(resource), ['key', 'kind', 'provider', 'code', 'ttlMs', 'cacheExpiresAt', 'action', 'reason']);
    assert.deepEqual(Object.keys(plan), ['generation', 'trigger', 'plannedAt', 'activeCodes', 'resources', 'phases']);
    assertFrozen(plan);
  }
  const forced = createRefreshPlan({ generation: 1, now: NOW, trigger: 'diagnostic', activeHoldings: [HOLDING],
    cacheIndex: { [`nav:${CODE}`]: fresh() }, forceStable: [`nav:${CODE}`], forceLive: true });
  assert.equal(forced.resources.find(row => row.key === `nav:${CODE}`).reason, 'force_stable');
  assert.equal(forced.resources.find(row => row.kind === 'estimates').reason, 'force_live');
  const ineligible = createRefreshPlan({ generation: 1, now: NOW, activeHoldings: [{ code: CODE, name: 'Synthetic QDII' }] });
  assert.equal(ineligible.resources.find(row => row.key === `holdings:${CODE}`).reason, 'market_ineligible');
  const invalid = createSecurityQuotePlan({ generation: 1,
    snapshots: [{ validated: false, status: 'ok', items: [] },
      { validated: true, status: 'ok', items: [{ quoteCode: 'bad' }] }],
    indexCodes: ['usNDX', 'bad'] });
  assert.deepEqual(Object.keys(invalid), ['generation', 'qualifiedCodes', 'securityCodes', 'modelCodes', 'indexCodes', 'goldRequired', 'rejected']);
  assert.deepEqual(invalid.rejected, [
    { kind: 'snapshot', index: 0, reason: 'snapshot_unusable' },
    { kind: 'security', index: 0, reason: 'unsupported_quote_identity' },
    { kind: 'index', index: 1, reason: 'unsupported_quote_identity' },
  ]);
  assertFrozen(invalid);
});

test('cache getter sequence and Math.min expiry remain independently fixed, not merely public/private self-consistent', () => {
  const expected = ['validated:1', 'fetchedAt:1', 'cachedAt:1', 'expiresAt:1', 'fetchedAt:2', 'cachedAt:2',
    'cachedAt:3', 'expiresAt:2', 'cachedAt:4', 'sourceTier:1', 'status:1', 'cacheState:1',
    'expiresAt:3', 'cachedAt:5', 'expiresAt:4', 'cachedAt:6'];
  const fields = { validated: [true], fetchedAt: [NOW - 100, NOW - 90],
    cachedAt: [NOW - 50, NOW - 40, NOW - 30, NOW - 20, NOW - 10],
    expiresAt: [NOW + 1000, NOW + 900, NOW + 800, NOW + 700],
    sourceTier: ['cache'], status: ['current'], cacheState: ['fresh'] };
  for (const factory of [createRefreshPlan, createRuntimeRefreshPlan]) {
    const trace = [], counts = {}, meta = {};
    for (const [field, values] of Object.entries(fields)) Object.defineProperty(meta, field, { enumerable: true, get() {
      const count = counts[field] = (counts[field] || 0) + 1;
      trace.push(`${field}:${count}`);
      return values[Math.min(count - 1, values.length - 1)];
    } });
    const plan = factory({ generation: 1, now: NOW, activeHoldings: [HOLDING], forceLive: true,
      cacheIndex: { [`nav:${CODE}`]: meta } });
    assert.deepEqual(trace, expected);
    assert.equal(plan.resources.find(row => row.key === `nav:${CODE}`).cacheExpiresAt, NOW + 700);
  }
});

function walk(node, callback, parents = []) {
  if (!node || typeof node !== 'object') return;
  callback(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, callback, [...parents, node]));
    else if (value && typeof value === 'object') walk(value, callback, [...parents, node]);
  }
}

async function javascriptFiles(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) output.push(...await javascriptFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push([`${prefix}${entry.name}`, new URL(entry.name, directory)]);
  }
  return output;
}

function assertClosedPlanUses(call, parents, kind, localName) {
  const declaration = parents.at(-1);
  assert.equal(declaration.type, 'VariableDeclarator', 'Private plan results must stay in a named local binding.');
  assert.equal(declaration.init, call);
  assert.equal(declaration.id?.type, 'Identifier', 'Private plan results cannot be destructured before use scanning.');
  const binding = declaration.id.name;
  const enclosing = [...parents].reverse().find(node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type));
  assert.ok(enclosing, localName);
  const allowedFields = new Set(kind === 'security' ? ['generation', 'securityCodes', 'modelCodes', 'goldRequired'] : ['generation', 'activeCodes', 'resources']);
  walk(enclosing, (node, ancestors) => {
    if (node.type !== 'Identifier' || node.name !== binding) return;
    const parent = ancestors.at(-1);
    if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
    if (parent?.type === 'Property' && parent.key === node && !parent.computed) return;
    if (parent?.type === 'MemberExpression' && parent.object === node && !parent.computed) {
      assert.ok(allowedFields.has(parent.property.name), `Unexpected private ${kind} result field ${parent.property.name}`);
      return;
    }
    if (parent?.type === 'Property' && parent.value === node && parent.key.name === 'plan') {
      const object = ancestors.at(-2), invocation = ancestors.at(-3);
      const expected = kind === 'security' ? 'executeSecurityQuotePlan' : 'createGenerationResourceScope';
      assert.equal(object?.type, 'ObjectExpression');
      assert.equal(invocation?.type, 'CallExpression');
      assert.equal(invocation.callee.name, expected, 'Private plan may only enter its audited execution consumer.');
      return;
    }
    assert.fail(`Private ${kind} plan escaped via ${parent?.type || 'unknown'} in ${localName}`);
  });
}

function privateImportContracts() {
  return new Map([
    ['createRuntimeRefreshPlan', { expected: new Set(['runtime/refresh-execution.js']), calls: 0 }],
    ['createRuntimeSecurityQuotePlan', { expected: new Set(['runtime/refresh-execution.js', 'runtime/security-quote-batch.js']), calls: 0 }],
  ]);
}

function assertResourceBindingUses(scope, binding, declaration) {
  const allowed = new Set(['key', 'kind', 'codes', 'action', 'cacheExpiresAt']);
  walk(scope, (node, parents) => {
    if (node.type !== 'Identifier' || node.name !== binding) return;
    const parent = parents.at(-1);
    if (parent === declaration && (parent.id === node || parent.params?.includes(node))) return;
    if (parent?.type === 'Property' && parent.key === node && !parent.computed) return;
    assert.equal(parent?.type, 'MemberExpression', 'Planned resource objects cannot escape through aliases, spreads or callbacks.');
    assert.equal(parent.object, node);
    assert.equal(parent.computed, false);
    assert.ok(allowed.has(parent.property.name), `Private planned resource reader widened to ${parent.property.name}`);
  });
}

function assertClosedResourceReads(call, parents) {
  const declaration = parents.at(-1);
  assert.equal(declaration?.type, 'VariableDeclarator');
  assert.equal(declaration.id?.type, 'Identifier', 'Private resource roots cannot be destructured before use scanning.');
  const binding = declaration.id.name;
  const scope = [...parents].reverse().find(node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type));
  const fromResources = node => node?.type === 'MemberExpression' && !node.computed
    && node.object?.type === 'Identifier' && node.object.name === binding && node.property.name === 'resources'
    || node?.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed
      && node.callee.property.name === 'filter' && fromResources(node.callee.object);
  walk(scope, (node, ancestors) => {
    if (fromResources(node)) {
      const parent = ancestors.at(-1), invocation = ancestors.at(-2);
      assert.equal(parent?.type, 'MemberExpression', 'Private resource arrays must not escape.');
      assert.equal(parent.object, node);
      assert.equal(parent.computed, false);
      assert.ok(['filter', 'map', 'find', 'forEach'].includes(parent.property.name));
      assert.equal(invocation?.type, 'CallExpression');
      assert.equal(invocation.callee, parent);
      const callback = invocation.arguments[0];
      assert.ok(['FunctionExpression', 'ArrowFunctionExpression'].includes(callback?.type));
      assert.equal(callback.params[0]?.type, 'Identifier');
      assertResourceBindingUses(callback, callback.params[0].name, callback);
    }
    if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression'
      || node.callee.computed || node.callee.property.name !== 'find' || !fromResources(node.callee.object)) return;
    const parent = ancestors.at(-1);
    if (parent?.type === 'VariableDeclarator' && parent.init === node) {
      assert.equal(parent.id?.type, 'Identifier', 'A found resource must stay in a checked named local, not a destructured alias.');
      const localScope = [...ancestors].reverse().find(item => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(item.type));
      assertResourceBindingUses(localScope, parent.id.name, parent);
    } else {
      assert.equal(parent?.type, 'MemberExpression', 'A found resource may only enter a checked local or direct field read.');
      assert.equal(parent.object, node);
      assert.equal(parent.computed, false);
      assert.ok(['key', 'kind', 'codes', 'action', 'cacheExpiresAt'].includes(parent.property.name));
    }
  });
}

function assertClosedReasonCollector(call, parents, kind, file) {
  if (call.arguments.length === 1) return;
  assert.equal(kind, 'refresh', 'Only the private refresh planner has an optional reason observer.');
  assert.equal(file, 'runtime/refresh-execution.js');
  assert.equal(call.arguments.length, 2);
  const enclosing = [...parents].reverse().find(node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type));
  assert.equal(enclosing?.type, 'FunctionDeclaration');
  assert.equal(enclosing.id?.name, 'executeRefreshPlan');
  assert.equal(parents.at(-3), enclosing.body, 'Observed plan creation must remain a direct executor local.');
  const locals = enclosing.body.body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(declaration => declaration.declarations.map(binding => ({ declaration, binding })))
    .filter(({ binding }) => binding.id?.name === 'diagnosticPlanReasons');
  assert.equal(locals.length, 1);
  const [{ declaration, binding }] = locals;
  assert.equal(declaration.kind, 'let');
  assert.equal(binding.init?.type, 'Literal');
  assert.equal(binding.init.value, null);
  assert.ok(binding.start < call.start, 'The collector local must be initialized before planning.');
  const observer = call.arguments[1];
  assert.equal(observer.type, 'ConditionalExpression');
  assert.equal(observer.test.type, 'BinaryExpression');
  assert.equal(observer.test.operator, '===');
  assert.equal(observer.test.left.type, 'UnaryExpression');
  assert.equal(observer.test.left.operator, 'typeof');
  assert.equal(observer.test.left.argument?.type, 'Identifier');
  assert.equal(observer.test.left.argument.name, 'onDiagnostics');
  assert.equal(observer.test.right.type, 'Literal');
  assert.equal(observer.test.right.value, 'function');
  assert.equal(observer.alternate.type, 'Identifier');
  assert.equal(observer.alternate.name, 'undefined');
  const collector = observer.consequent;
  assert.equal(collector.type, 'ArrowFunctionExpression');
  assert.equal(collector.async, false);
  assert.equal(collector.params.length, 1);
  assert.equal(collector.params[0].type, 'Identifier');
  assert.equal(collector.params[0].name, 'reasons');
  assert.equal(collector.body.type, 'BlockStatement');
  assert.equal(collector.body.body.length, 1);
  assert.equal(collector.body.body[0].type, 'ExpressionStatement');
  const assignment = collector.body.body[0].expression;
  assert.equal(assignment.type, 'AssignmentExpression');
  assert.equal(assignment.operator, '=');
  assert.equal(assignment.left.type, 'Identifier');
  assert.equal(assignment.left.name, 'diagnosticPlanReasons');
  assert.equal(assignment.right.type, 'Identifier');
  assert.equal(assignment.right.name, 'reasons');
}

function auditPrivatePlanModule(program, file, imported) {
  const privateBindings = new Map(), auditedCalls = new Set();
  for (const node of program.body) {
    if (!String(node.source?.value || '').endsWith('refresh-plan.js')) continue;
    assert.notEqual(node.type, 'ExportAllDeclaration', 'A wildcard barrel would publish private planning APIs.');
    if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) {
      assert.notEqual(specifier.type, 'ImportNamespaceSpecifier', 'Private planning module must not escape as a namespace.');
      const name = specifier.imported?.name;
      if (!imported.has(name)) continue;
      const contract = imported.get(name);
      assert.ok(contract.expected.delete(file), `Unexpected private plan importer ${file}`);
      privateBindings.set(specifier.local.name, name);
    }
    if (node.type === 'ExportNamedDeclaration') for (const specifier of node.specifiers)
      assert.equal(imported.has(specifier.local?.name), false, 'Private factories cannot be re-exported.');
  }
  walk(program, (node, parents) => {
    if (node.type === 'ImportExpression' && String(node.source?.value || '').endsWith('refresh-plan.js'))
      assert.fail('Dynamic planning namespace would escape private factories.');
    if (node.type !== 'CallExpression' || !privateBindings.has(node.callee?.name)) return;
    const name = privateBindings.get(node.callee.name), kind = name === 'createRuntimeSecurityQuotePlan' ? 'security' : 'refresh';
    imported.get(name).calls++;
    assertClosedReasonCollector(node, parents, kind, file);
    const options = node.arguments[0];
    assert.equal(options.type, 'ObjectExpression', 'Private factory options must be a local literal.');
    const allowed = new Set(kind === 'security' ? ['generation', 'snapshots', 'selectedModels']
      : ['generation', 'trigger', 'now', 'activeHoldings', 'cacheIndex', 'forceLive', 'forceStable']);
    const keys = [];
    for (const property of options.properties) {
      assert.equal(property.type, 'Property', 'Private factory must not spread arbitrary caller options.');
      assert.equal(property.computed, false);
      assert.ok(allowed.has(property.key.name), `Unexpected private option ${property.key.name}`);
      keys.push(property.key.name);
    }
    assert.ok(keys.includes('generation'));
    assert.equal(keys.includes('indexCodes'), false);
    assertClosedPlanUses(node, parents, kind, file);
    if (kind === 'refresh') assertClosedResourceReads(node, parents);
    auditedCalls.add(node);
  });
  // Counting direct calls alone does not protect a second alias, callback,
  // re-export or namespace escape. Every imported binding occurrence is gated.
  walk(program, (node, parents) => {
    if (node.type !== 'Identifier' || !privateBindings.has(node.name)) return;
    const parent = parents.at(-1);
    if (parent?.type === 'ImportSpecifier') return;
    assert.ok(parent?.type === 'CallExpression' && parent.callee === node && auditedCalls.has(parent),
      `Private factory binding ${node.name} escaped its audited direct call.`);
  });
}

test('production private factories stay in exact closed literal consumers and never leak through barrels or namespace imports', async () => {
  const imported = privateImportContracts();
  for (const [file, url] of await javascriptFiles(new URL('../js/', import.meta.url))) {
    const parsed = parseSync(file, await readFile(url, 'utf8'));
    assert.equal(parsed.errors.length, 0);
    auditPrivatePlanModule(parsed.program, file, imported);
  }
  assert.equal(imported.get('createRuntimeRefreshPlan').calls, 1);
  assert.equal(imported.get('createRuntimeSecurityQuotePlan').calls, 2);
  for (const contract of imported.values()) assert.equal(contract.expected.size, 0);
});

test('closed-consumer guards reject factory aliases, namespace/reexport/dynamic escape, spread/index options and result leaks', () => {
  const base = `import { createRuntimeSecurityQuotePlan as makePlan } from './refresh-plan.js';
    function execute(context, items) {
      const plan = makePlan({ generation: context.generation, snapshots: [{ validated: true, status: 'ok', items }] });
      return executeSecurityQuotePlan({ plan, scope: {}, now: Date.now });
    }`;
  const check = source => {
    const parsed = parseSync('runtime/security-quote-batch.js', source);
    assert.equal(parsed.errors.length, 0);
    auditPrivatePlanModule(parsed.program, 'runtime/security-quote-batch.js', privateImportContracts());
  };
  check(base);
  const invalid = [
    base + '\nconst alias = makePlan;',
    base + '\nexport { makePlan as leaked };',
    base.replace('const plan =', 'const alias = makePlan; const plan ='),
    base.replace('import { createRuntimeSecurityQuotePlan as makePlan }', 'import * as makePlan'),
    base + "\nexport { createRuntimeSecurityQuotePlan } from './refresh-plan.js';",
    base + "\nconst namespace = import('./refresh-plan.js');",
    base.replace('generation: context.generation,', 'generation: context.generation, ...context,'),
    base.replace('generation: context.generation,', "generation: context.generation, indexCodes: ['usNDX'],"),
    base.replace('return executeSecurityQuotePlan', 'report(plan); return executeSecurityQuotePlan'),
    base.replace('return executeSecurityQuotePlan', 'report(plan.rejected); return executeSecurityQuotePlan'),
    base.replace('return executeSecurityQuotePlan', 'const snapshot = { ...plan }; return executeSecurityQuotePlan'),
  ];
  for (const source of invalid) assert.throws(() => check(source), { name: 'AssertionError' });
  const refresh = `import { createRuntimeRefreshPlan as makePlan } from './refresh-plan.js';
    function execute(context) {
      const plan = makePlan({ generation: context.generation, now: 1 });
      const resource = plan.resources.find(row => row.key === 'nav:005844');
      return createGenerationResourceScope({ context, plan, now: Date.now });
    }`;
  const checkRefresh = source => auditPrivatePlanModule(parseSync('runtime/refresh-execution.js', source).program,
    'runtime/refresh-execution.js', privateImportContracts());
  checkRefresh(refresh);
  assert.throws(() => checkRefresh(refresh.replace('return createGenerationResourceScope',
    'report(resource.reason); return createGenerationResourceScope')), { name: 'AssertionError' });
  assert.throws(() => checkRefresh(refresh.replace('row.key ===', 'row.reason ===')), { name: 'AssertionError' });
  assert.throws(() => checkRefresh(refresh.replace('const resource =', 'const resources = plan.resources; const resource =')),
    { name: 'AssertionError' });
  checkRefresh(refresh.replace('const resource =',
    'plan.resources.forEach(row => report({ kind: row.kind, action: row.action })); const resource ='));
  for (const body of ['report(row)', 'report(row.reason)', 'report({ ...row })']) {
    assert.throws(() => checkRefresh(refresh.replace('const resource =',
      `plan.resources.forEach(row => { ${body}; }); const resource =`)), { name: 'AssertionError' });
  }
});

test('optional plan-reason collector is accepted only as the exact closed executor callback', () => {
  const source = `import { createRuntimeRefreshPlan as makePlan } from './refresh-plan.js';
    function executeRefreshPlan({ context, onDiagnostics }) {
      let diagnosticPlanReasons = null;
      const plan = makePlan({ generation: context.generation, now: 1 },
        typeof onDiagnostics === 'function' ? reasons => { diagnosticPlanReasons = reasons; } : undefined);
      return createGenerationResourceScope({ context, plan, now: Date.now });
    }`;
  const check = (value, file = 'runtime/refresh-execution.js') => {
    const parsed = parseSync(file, value);
    assert.equal(parsed.errors.length, 0);
    auditPrivatePlanModule(parsed.program, file, privateImportContracts());
  };
  check(source);
  const invalid = [
    source.replace('executeRefreshPlan', 'otherExecute'),
    source.replace('let diagnosticPlanReasons = null;', 'const diagnosticPlanReasons = null;'),
    source.replace('let diagnosticPlanReasons = null;', 'let diagnosticPlanReasons = {};'),
    source.replace('let diagnosticPlanReasons = null;', ''),
    source.replace('let diagnosticPlanReasons = null;', '')
      .replace('return createGenerationResourceScope', 'let diagnosticPlanReasons = null; return createGenerationResourceScope'),
    source.replace("typeof onDiagnostics === 'function'", 'onDiagnostics'),
    source.replace("typeof onDiagnostics === 'function'", "typeof arbitrary === 'function'"),
    source.replace('reasons =>', 'async reasons =>'),
    source.replace('reasons =>', '(reasons, raw) =>'),
    source.replace('reasons => { diagnosticPlanReasons = reasons; }', 'onDiagnostics'),
    source.replace('reasons => { diagnosticPlanReasons = reasons; }', 'reasons => diagnosticPlanReasons = reasons'),
    source.replace('diagnosticPlanReasons = reasons;', 'diagnosticPlanReasons = { ...reasons };'),
    source.replace('diagnosticPlanReasons = reasons;', 'diagnosticPlanReasons = reasons; report(reasons);'),
    source.replace('diagnosticPlanReasons = reasons;', 'target.reasons = reasons;'),
    source.replace(': undefined', ': null'),
    source.replace(': undefined)', ': undefined, onDiagnostics)'),
    source.replace('createRuntimeRefreshPlan', 'createRuntimeSecurityQuotePlan'),
  ];
  for (const value of invalid) assert.throws(() => check(value), { name: 'AssertionError' });
  assert.throws(() => check(source, 'runtime/security-quote-batch.js'), { name: 'AssertionError' });
});

for (const pattern of ['{ resources }', '[resources]']) {
  const source = `import { createRuntimeRefreshPlan as makePlan } from './refresh-plan.js';
    function executeRefreshPlan({ context, onDiagnostics }) {
      let diagnosticPlanReasons = null;
      const ${pattern} = makePlan({ generation: context.generation, now: 1 },
        typeof onDiagnostics === 'function' ? reasons => { diagnosticPlanReasons = reasons; } : undefined);
      report(resources);
      return null;
    }`;
  test(`closed plan root rejects destructured ${pattern} binding before use scanning`, () => {
    const parsed = parseSync('runtime/refresh-execution.js', source);
    assert.equal(parsed.errors.length, 0);
    assert.throws(() => auditPrivatePlanModule(parsed.program, 'runtime/refresh-execution.js', privateImportContracts()),
      { name: 'AssertionError' });
  });
  test(`closed resource root independently rejects destructured ${pattern} binding`, () => {
    const parsed = parseSync('runtime/refresh-execution.js', source);
    assert.equal(parsed.errors.length, 0);
    let target = null;
    walk(parsed.program, (node, parents) => {
      if (node.type === 'CallExpression' && node.callee?.name === 'makePlan') target = { node, parents };
    });
    assert.ok(target);
    assert.throws(() => assertClosedResourceReads(target.node, target.parents), { name: 'AssertionError' });
  });
}

for (const pattern of ['{ reason }', '[reason]']) {
  test(`closed find-resource reader rejects destructured ${pattern} aliases`, () => {
    const source = `import { createRuntimeRefreshPlan as makePlan } from './refresh-plan.js';
      function execute(context) {
        const plan = makePlan({ generation: context.generation, now: 1 });
        const ${pattern} = plan.resources.find(row => row.key === 'nav:005844');
        report(reason);
        return createGenerationResourceScope({ context, plan, now: Date.now });
      }`;
    const parsed = parseSync('runtime/refresh-execution.js', source);
    assert.equal(parsed.errors.length, 0);
    assert.throws(() => auditPrivatePlanModule(parsed.program, 'runtime/refresh-execution.js', privateImportContracts()),
      { name: 'AssertionError' });
  });
}

test('real generation scope exposes only counters, not the private execution plan or public metadata', () => {
  const controller = new AbortController();
  const context = { generation: 1, signal: controller.signal, isCurrent: () => true,
    commit: operation => ({ committed: true, value: operation() }) };
  const plan = createRuntimeRefreshPlan({ generation: 1, now: NOW, activeHoldings: [HOLDING] });
  const scope = createGenerationResourceScope({ context, plan, now: () => NOW });
  assert.deepEqual(Object.keys(scope.snapshot()), ['generation', 'planned', 'staged', 'cacheHits', 'deduped', 'requests',
    'abortedRequests', 'failedRequests', 'cancelledResources', 'writeAttempts', 'cacheWrites', 'providers']);
  assert.equal(scope.snapshot().planned, plan.resources.length);
  assert.doesNotMatch(JSON.stringify(scope.snapshot()), /phases|plannedAt|resourceKeys|force_live|cache_miss/);
});

test('real private planner and production refresh executor keep genuine zero market values and perform one cache write', async () => {
  const indexCodes = ['sh000001', 'sh000300', 'usINX', 'usNDX'];
  const writes = [], events = [];
  const coordinator = new RefreshCoordinator({ withBuiltinSources: true, now: () => NOW,
    execute: context => executeRefreshPlan({ context, snapshot: [], options: {}, now: () => NOW,
      clients: {
        indices: async codes => { assert.deepEqual(codes, indexCodes); return codes.map(code => ({ code, price: 100,
          changePct: 0, observedAt: new Date(NOW - 1000).toISOString(), status: 'current' })); },
        gold: async (_signal, dispatch) => dispatch(async () => ({ price: 100, changePct: 0,
          observedAt: new Date(NOW - 1000).toISOString(), status: 'current', cached: false })),
        models: async () => [],
      },
      ui: { market: (indices, gold) => events.push({ indices, gold }), cacheData: () => [],
        holdingsHash: () => 'synthetic-empty', complete() {} },
      storage: { setItem(key, bytes) { writes.push({ key, value: JSON.parse(bytes) }); return true; } },
    }) });
  const result = await coordinator.request({ trigger: 'manual' });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.diagnostics.requests, 2);
  assert.equal(result.result.diagnostics.cacheWrites, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'fuyu_funds_cache_v1');
  assert.equal(writes[0].value.holdingsHash, 'synthetic-empty');
  assert.equal(Object.hasOwn(writes[0].value, 'fetchedAt'), false, 'Market-only acquisition must not renew a fund acquisition clock.');
  assert.equal(writes[0].value.refreshResources['gold:AU9999'].payload.changePct, 0);
  assert.equal(events.length, 2);
});

test('actual detail entry uses the private planner and preserves zero without mutating disclosure rows', async () => {
  const items = [{ quoteCode: 'sh600000' }], before = structuredClone(items);
  const result = await executeDetailSecurityQuotes({ items, now: () => NOW, normalizeTime: value => value,
    fetchEastmoney: async codes => { assert.deepEqual(codes, ['sh600000']); return { data: { diff: [
      { f12: '600000', f13: 1, f2: 100, f3: 0, f124: Math.floor(NOW / 1000) },
    ] } }; },
    fetchBridge: async () => assert.fail('A genuine primary zero must not trigger fallback'),
  });
  assert.equal(result.sh600000.change, 0);
  assert.equal(result.sh600000.quoteCode, 'sh600000');
  assert.deepEqual(items, before);
});

test('actual detail private generation rejects a late provider result after cancellation with no extra dispatch', async () => {
  let entered, resolve;
  const started = new Promise(done => { entered = done; });
  const pending = new Promise(done => { resolve = done; });
  const controller = new AbortController(), items = [{ quoteCode: 'sh600000' }];
  let calls = 0;
  const task = executeDetailSecurityQuotes({ items, signal: controller.signal, now: () => NOW,
    normalizeTime: value => value,
    fetchEastmoney: async () => { calls++; entered(); return pending; },
    fetchBridge: async () => assert.fail('Cancelled detail must not start fallback'),
  });
  await started;
  controller.abort('synthetic detail closed');
  resolve({ data: { diff: [{ f12: '600000', f13: 1, f2: 100, f3: 0, f124: Math.floor(NOW / 1000) }] } });
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.deepEqual(items, [{ quoteCode: 'sh600000' }]);
});


