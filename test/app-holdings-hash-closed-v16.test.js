import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import { canonicalHoldingsDocument, normalizeHoldingsDocumentV3, toLegacyHoldings } from '../js/storage/holdings-schema.js';
import { loadHoldingsRepository, withHoldingsLock, HOLDINGS_V3_KEY, HOLDINGS_DEVICE_KEY } from '../js/storage/holdings-repository.js';

const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const program = parseSync('app.js', source).program;
const T0 = '2026-09-28T00:00:00.000Z';
const T1 = '2026-09-29T00:00:00.000Z';
const T2 = '2026-09-30T00:00:00.000Z';
const stateNames = new Set(['holdings', 'holdingsDocument']);

function visit(node, callback, parent = null, key = null, owner = '<module>') {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') owner = node.id.name;
  callback(node, parent, key, owner);
  for (const [childKey, value] of Object.entries(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback, node, childKey, owner));
    else if (value && typeof value === 'object') visit(value, callback, node, childKey, owner);
  }
}

function declaration(name) {
  const node = program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
  assert.ok(node, `Missing real app function ${name}`);
  return node;
}

function text(node) { return source.slice(node.start, node.end); }
function compact(node) { return text(node).replace(/\s+/g, ''); }
function functionText(name) { return text(declaration(name)); }

function row(code = '000001', extra = {}) {
  return { id: `fund:${code}`, fundCode: code, fundName: `当前基金 ${code}`, shares: 10, costNav: 1.25,
    createdAt: T0, updatedAt: T1, deletedAt: null, revision: 1, deviceId: 'device:a', note: null, ...extra };
}

function document(holdings = [], extra = {}) {
  return { schema: 3, updatedAt: T2, deviceId: 'document:device', holdings, ...extra };
}

function memoryStorage(value) {
  const data = new Map([[HOLDINGS_DEVICE_KEY, 'synthetic:device']]);
  if (value !== undefined) data.set(HOLDINGS_V3_KEY, JSON.stringify(value));
  return { getItem: key => data.get(key) ?? null, setItem: (key, raw) => data.set(key, String(raw)),
    removeItem: key => data.delete(key) };
}

function app(storage = memoryStorage(), locks = { request: async (_name, _options, callback) => callback({}) }) {
  let reconciliations = 0;
  const initializers = ['holdings', 'holdingsDocument', 'holdingsStorageError'].map(name => {
    const node = program.body.flatMap(item => item.type === 'VariableDeclaration' ? item.declarations : [])
      .find(item => item.id.name === name);
    assert.ok(node);
    return `let ${text(node)};`;
  });
  // Only the real private functions run. Persistence and locking also use the
  // real implementation, but exclusively against synthetic in-memory adapters.
  const bindings = {
    canonicalHoldingsDocument,
    loadHoldingsRepository: (argument, options) => {
      assert.equal(argument, undefined);
      return loadHoldingsRepository(storage, { ...options, now: Date.parse(T2) });
    },
    withHoldingsLock: callback => withHoldingsLock(callback, { locks }),
    normalizeHoldingsDocumentV3,
    toLegacyHoldings,
    CACHE_KEY: 'synthetic:fund-cache',
    reconcileActiveFundState: () => { reconciliations++; },
  };
  const instance = new Function(...Object.keys(bindings), [
    ...initializers, functionText('holdingsHash'), functionText('loadHoldings'), functionText('installHoldingsDocument'),
    'return { hash: () => holdingsHash(holdings), hashArity: holdingsHash.length, load: loadHoldings,',
    'install: installHoldingsDocument, state: () => ({ holdings, holdingsDocument, holdingsStorageError }) };',
  ].join('\n'))(...Object.values(bindings));
  return { ...instance, storage, reconciliationCount: () => reconciliations };
}

function exactHash(instance, value) {
  const before = structuredClone(value);
  const expected = canonicalHoldingsDocument(value);
  assert.equal(instance.hash(), expected);
  assert.deepEqual(Buffer.from(instance.hash(), 'utf8'), Buffer.from(expected, 'utf8'));
  assert.deepEqual(value, before, 'Fingerprinting must not change native private state.');
  assert.equal(instance.hashArity, 1);
}

test('private hash has exactly four one-argument holdings calls and never escapes or exports', () => {
  const calls = [], escapes = [], exports = [], dynamicScope = [];
  visit(program, (node, parent, key, owner) => {
    if (node.type === 'Identifier' && node.name === 'holdingsHash') {
      if (parent.type === 'FunctionDeclaration' && key === 'id') return;
      if ((key === 'key' && !parent.computed)
        || (parent.type === 'MemberExpression' && key === 'property' && !parent.computed)) return;
      if (parent.type === 'CallExpression' && key === 'callee') {
        assert.equal(parent.arguments.length, 1);
        assert.equal(parent.arguments[0].type, 'Identifier');
        assert.equal(parent.arguments[0].name, 'holdings');
        calls.push(owner);
      } else escapes.push(`${owner}:${parent.type}:${key}`);
    }
    if (node.type?.startsWith('Export')) exports.push(node.type);
    if (node.type === 'CallExpression' && node.callee?.name === 'eval') dynamicScope.push(node.type);
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee?.name === 'Function') dynamicScope.push(node.type);
  });
  assert.deepEqual(calls.sort(), ['loadCache', 'markSyncPending', 'runRefresh', 'saveCache'].sort());
  assert.deepEqual(escapes, []);
  assert.deepEqual(exports, []);
  assert.deepEqual(dynamicScope, []);
  assert.equal(declaration('holdingsHash').params.length, 1);
  assert.equal(declaration('holdingsHash').params[0].type, 'Identifier');
});

test('holdings and document have only the native initial, load and install writers and no mutators', () => {
  const writes = [], mutations = [];
  const rootName = node => node?.type === 'Identifier' ? node.name
    : node?.type === 'MemberExpression' ? rootName(node.object) : null;
  const mutators = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
  visit(program, (node, _parent, _key, owner) => {
    if (node.type === 'VariableDeclarator' && stateNames.has(node.id?.name)) {
      writes.push(`${owner}:${node.id.name}=${compact(node.init)}`);
    }
    if (node.type === 'AssignmentExpression' && stateNames.has(rootName(node.left))) {
      if (node.left.type !== 'Identifier' || node.operator !== '=') mutations.push(text(node));
      else writes.push(`${owner}:${node.left.name}=${compact(node.right)}`);
    }
    if ((node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete'))
      && stateNames.has(rootName(node.argument))) mutations.push(text(node));
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const receiver = rootName(node.callee.object);
      const property = node.callee.computed ? node.callee.property.value : node.callee.property.name;
      if (stateNames.has(receiver) && (node.callee.computed || mutators.has(property))) mutations.push(text(node));
      if (node.callee.object?.name === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(property)
        && stateNames.has(rootName(node.arguments[0]))) mutations.push(text(node));
    }
  });
  assert.deepEqual(writes.sort(), [
    '<module>:holdings=[]', '<module>:holdingsDocument=null',
    'loadHoldings:holdings=[]', 'loadHoldings:holdingsDocument=null',
    'loadHoldings:holdings=loaded.legacy', 'loadHoldings:holdingsDocument=loaded.document',
    'installHoldingsDocument:holdings=toLegacyHoldings(holdingsDocument)',
    'installHoldingsDocument:holdingsDocument=normalizeHoldingsDocumentV3(value)',
  ].sort());
  assert.deepEqual(mutations, []);
});

test('load closes failure to null/empty and success to a repository document plus its projection', () => {
  const statements = declaration('loadHoldings').body.body;
  assert.equal(statements.length, 6);
  assert.equal(compact(statements[0].declarations[0].init),
    'awaitwithHoldingsLock(()=>loadHoldingsRepository(undefined,{cacheKey:CACHE_KEY}))');
  assert.equal(compact(statements[1].test), '!loaded.ok');
  assert.deepEqual(statements[1].consequent.body.slice(1).map(compact), ['holdingsDocument=null;', 'holdings=[];', 'returnfalse;']);
  assert.deepEqual(statements.slice(2).map(compact), ["holdingsStorageError='';", 'holdingsDocument=loaded.document;', 'holdings=loaded.legacy;', 'returntrue;']);
  const install = declaration('installHoldingsDocument').body.body;
  assert.deepEqual(declaration('installHoldingsDocument').params.map(compact), ['value', 'options={}']);
  assert.deepEqual(install.map(compact), ['holdingsDocument=normalizeHoldingsDocumentV3(value);',
    'holdings=toLegacyHoldings(holdingsDocument);', "holdingsStorageError='';", 'reconcileActiveFundState(options);']);
});

test('initial and blocked native state fingerprints are exactly [] with no invented document', async () => {
  const initial = app();
  assert.equal(initial.hash(), '[]');
  assert.deepEqual(initial.state(), { holdings: [], holdingsDocument: null, holdingsStorageError: '' });
  assert.equal(initial.hashArity, 1);
  const blocked = app(memoryStorage(document([row()])), null);
  assert.equal(await blocked.load(), false);
  assert.equal(blocked.hash(), '[]');
  assert.equal(blocked.state().holdingsDocument, null);
  assert.deepEqual(blocked.state().holdings, []);
  assert.equal(blocked.state().holdingsStorageError, 'storage_lock_unavailable');
});

test('real repository success uses complete V3 canonical bytes, including a valid empty document', async () => {
  for (const value of [document([]), document([row('000002'), row('000001', { shares: 0, costNav: null })])]) {
    const instance = app(memoryStorage(value));
    assert.equal(await instance.load(), true);
    exactHash(instance, instance.state().holdingsDocument);
    assert.equal(instance.state().holdingsStorageError, '');
    assert.notEqual(instance.hash(), '[]');
  }
});

test('a failed reload clears an earlier successful document rather than hashing stale holdings', async () => {
  const instance = app(memoryStorage(document([row()])));
  assert.equal(await instance.load(), true);
  instance.storage.setItem(HOLDINGS_V3_KEY, '{corrupt synthetic JSON');
  assert.equal(await instance.load(), false);
  assert.equal(instance.hash(), '[]');
  assert.deepEqual(instance.state().holdings, []);
  assert.equal(instance.state().holdingsDocument, null);
  assert.equal(instance.state().holdingsStorageError, 'v3_corrupt');
});

test('real install preserves exact UTF-8 field order, current names, sorted rows and tombstones', () => {
  const instance = app();
  const value = document([row('000002', { fundName: ' 当前合成📈 ', shares: 12.5, costNav: null, revision: 7,
    deviceId: 'device:phone', note: '  备注 "A"\n第二行  ' }), row('000001', { fundName: '零份额', shares: 0, costNav: 0 }),
    row('000003', { fundName: '已删除', deletedAt: T1, revision: 8 })]);
  const before = structuredClone(value);
  instance.install(value);
  const expected = `{"schema":3,"updatedAt":"${T2}","deviceId":"document:device","holdings":[`
    + `{"id":"fund:000001","fundCode":"000001","fundName":"零份额","shares":0,"costNav":0,"createdAt":"${T0}","updatedAt":"${T1}","deletedAt":null,"revision":1,"deviceId":"device:a","note":null},`
    + `{"id":"fund:000002","fundCode":"000002","fundName":"当前合成📈","shares":12.5,"costNav":null,"createdAt":"${T0}","updatedAt":"${T1}","deletedAt":null,"revision":7,"deviceId":"device:phone","note":"备注 \\"A\\"\\n第二行"},`
    + `{"id":"fund:000003","fundCode":"000003","fundName":"已删除","shares":10,"costNav":1.25,"createdAt":"${T0}","updatedAt":"${T1}","deletedAt":"${T1}","revision":8,"deviceId":"device:a","note":null}]}`;
  assert.equal(instance.hash(), expected);
  assert.deepEqual(Buffer.from(instance.hash(), 'utf8'), Buffer.from(expected, 'utf8'));
  exactHash(instance, instance.state().holdingsDocument);
  assert.deepEqual(value, before);
  assert.equal(Object.isFrozen(value), false);
  assert.equal(value.holdings.some(Object.isFrozen), false);
  assert.equal(instance.reconciliationCount(), 1);
});

test('every persisted semantic field contributes to the complete hash without lossy legacy projection', () => {
  const baseline = document([row()]);
  const variants = [
    document([row('000002')]), document([row('000001', { fundName: '名称更新' })]),
    document([row('000001', { shares: 0 })]), document([row('000001', { costNav: null })]),
    document([row('000001', { createdAt: '2026-09-27T00:00:00Z' })]),
    document([row('000001', { updatedAt: T2 })]), document([row('000001', { deletedAt: T1 })]),
    document([row('000001', { revision: 2 })]), document([row('000001', { deviceId: 'device:b' })]),
    document([row('000001', { note: '' })]), document([row('000001', { note: '保留备注' })]),
    document([row()], { updatedAt: '2026-10-01T00:00:00Z' }), document([row()], { deviceId: 'document:other' }),
  ];
  const instance = app();
  instance.install(baseline);
  const previous = instance.hash();
  for (const value of variants) {
    instance.install(value);
    exactHash(instance, instance.state().holdingsDocument);
    assert.notEqual(instance.hash(), previous);
  }
});

test('native state matrices keep null/zero, normalized time, notes and original input order unchanged', () => {
  const instance = app();
  for (const shares of [-0, 0, 1e-8, 12.5]) for (const costNav of [null, 0, 1.25]) {
    for (const deletedAt of [null, T1]) for (const note of [null, '', 'Unicode 合成📈']) {
      const value = document([row('000002', { shares, costNav, deletedAt, note, revision: 9 }), row('000001')],
        { updatedAt: '2026-09-30T08:00:00+08:00', extra: 'not part of canonical bytes' });
      const before = structuredClone(value);
      instance.install(value);
      exactHash(instance, instance.state().holdingsDocument);
      assert.deepEqual(value, before);
      assert.equal(Object.isFrozen(value), false);
      assert.equal(value.holdings.some(Object.isFrozen), false);
      assert.deepEqual(value.holdings.map(item => item.fundCode), ['000002', '000001']);
      assert.doesNotMatch(instance.hash(), /not part of canonical bytes/);
    }
  }
});
