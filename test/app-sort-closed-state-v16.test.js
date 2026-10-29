import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import { quoteStatusRank } from '../js/runtime/quote-contract.js';

const app = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const program = parseSync('app.js', app).program;
const MODES = ['est_change_desc', 'est_change_asc'];

function visit(node, callback, parent = null, key = null, owner = '<module>') {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') owner = node.id.name;
  callback(node, parent, key, owner);
  for (const [childKey, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback, node, childKey, owner);
    } else if (value && typeof value === 'object') {
      visit(value, callback, node, childKey, owner);
    }
  }
}

function declaration(name) {
  const result = program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(result, `Missing private function ${name}`);
  return result;
}

function functionText(name) {
  const node = declaration(name);
  return app.slice(node.start, node.end);
}

function currentSorter(mode) {
  // Execute only the three local pure functions, never app initialization.
  return new Function('sortBy', 'quoteStatusRank', [
    functionText('safeN'), functionText('displayChangeOf'), functionText('sortFunds'),
    'return sortFunds;',
  ].join('\n'))(mode, quoteStatusRank);
}

// Independent pre-compaction reference, including the eight historical cases.
// They remain here to document the old implementation, not as a public API.
function legacySorter(mode) {
  const ranks = { realtime: 5, delayed: 4, model: 3, official: 2, stale: 1, unavailable: 0 };
  function rank(value) {
    const status = typeof value === 'string' ? value : value && value.status;
    return ranks[status] ?? 0;
  }
  function finite(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }
  function change(fund) {
    if (!fund || !fund.quote || fund.quote.status === 'unavailable' || fund.quote.changePct == null) return NaN;
    return Number.isFinite(Number(fund.quote.changePct)) ? Number(fund.quote.changePct) : NaN;
  }
  return function sortFunds(data) {
    const sorted = [...data];
    sorted.sort((a, b) => {
      const qualityDifference = rank(b && b.quote) - rank(a && a.quote);
      if (qualityDifference) return qualityDifference;
      if (mode.startsWith('today_profit_') || mode.startsWith('est_change_')) {
        const intervalDifference = String(a.period?.comparisonKey || '~').localeCompare(String(b.period?.comparisonKey || '~'));
        if (intervalDifference) return intervalDifference;
      }
      switch (mode) {
        case 'est_change_desc': return finite(change(b), -Infinity) - finite(change(a), -Infinity);
        case 'est_change_asc': return finite(change(a), Infinity) - finite(change(b), Infinity);
        case 'today_profit_desc': return finite(b.today_profit, -Infinity) - finite(a.today_profit, -Infinity);
        case 'today_profit_asc': return finite(a.today_profit, Infinity) - finite(b.today_profit, Infinity);
        case 'curr_value_desc': return finite(b.curr_value, 0) - finite(a.curr_value, 0);
        case 'curr_value_asc': return finite(a.curr_value, 0) - finite(b.curr_value, 0);
        case 'total_profit_desc': return finite(b.total_profit, -Infinity) - finite(a.total_profit, -Infinity);
        case 'total_profit_asc': return finite(a.total_profit, Infinity) - finite(b.total_profit, Infinity);
        case 'profit_rate_desc': return finite(b.total_profit_rate, -Infinity) - finite(a.total_profit_rate, -Infinity);
        case 'profit_rate_asc': return finite(a.total_profit_rate, Infinity) - finite(b.total_profit_rate, Infinity);
        default: return 0;
      }
    });
    return sorted;
  };
}

test('private sort state has exactly one initializer and one closed two-state setter', () => {
  const references = [], writes = [], updates = [], exports = [], dynamicScope = [];
  visit(program, (node, parent, key, owner) => {
    if (node.type === 'Identifier' && node.name === 'sortBy') references.push(`${owner}:${parent.type}:${key}`);
    if (node.type === 'VariableDeclarator' && node.id?.name === 'sortBy') writes.push({ node, owner });
    if (node.type === 'AssignmentExpression' && node.left?.name === 'sortBy') writes.push({ node, owner });
    if (node.type === 'UpdateExpression' && node.argument?.name === 'sortBy') updates.push(node);
    if (node.type?.startsWith('Export')) exports.push(node);
    if (node.type === 'CallExpression' && node.callee?.name === 'eval') dynamicScope.push(node);
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee?.name === 'Function') dynamicScope.push(node);
  });
  assert.equal(writes.length, 2);
  const [initial, setter] = writes;
  assert.equal(initial.owner, '<module>');
  assert.equal(initial.node.init.type, 'Literal');
  assert.equal(initial.node.init.value, 'est_change_desc');
  assert.equal(setter.owner, 'toggleEstSort');
  assert.equal(setter.node.operator, '=');
  const expression = setter.node.right;
  assert.equal(expression.type, 'ConditionalExpression');
  const condition = expression.test.type === 'ParenthesizedExpression' ? expression.test.expression : expression.test;
  assert.equal(condition.type, 'BinaryExpression');
  assert.equal(condition.operator, '===');
  assert.equal(condition.left.name, 'sortBy');
  assert.equal(condition.right.value, 'est_change_desc');
  assert.equal(expression.consequent.value, 'est_change_asc');
  assert.equal(expression.alternate.value, 'est_change_desc');
  assert.deepEqual(references.sort(), [
    '<module>:VariableDeclarator:id',
    'sortFunds:MemberExpression:object', 'sortFunds:MemberExpression:object',
    'sortFunds:SwitchStatement:discriminant',
    'toggleEstSort:AssignmentExpression:left', 'toggleEstSort:BinaryExpression:left',
    'updateSortBar:BinaryExpression:left',
  ].sort());
  assert.equal(updates.length, 0);
  assert.equal(exports.length, 0);
  assert.equal(dynamicScope.length, 0);
  // New UI modes or new writers must deliberately revise this closed-state
  // proof and reference before adding a different private sorting contract.
});

test('the only sort control calls the closed toggle without exposing a mode parameter', () => {
  assert.equal((html.match(/data-action=["']toggle-sort["']/g) || []).length, 1);
  const sortBranches = [];
  visit(declaration('handleAppAction'), node => {
    if (node.type === 'IfStatement' && node.test.type === 'BinaryExpression'
      && node.test.left.name === 'action' && node.test.right.value === 'toggle-sort') sortBranches.push(node);
  });
  assert.equal(sortBranches.length, 1);
  const action = sortBranches[0].consequent.expression;
  assert.equal(action.type, 'CallExpression');
  assert.equal(action.callee.name, 'toggleEstSort');
  assert.deepEqual(action.arguments, []);
  assert.deepEqual(declaration('toggleEstSort').params, []);
});

test('reachable modes preserve quality, comparison period, stable ties and missing versus true zero', () => {
  const quote = (status, changePct) => ({ status, changePct });
  const period = comparisonKey => ({ comparisonKey });
  const funds = [
    { quote: quote('stale', 99), period: period('A') },
    { quote: quote('realtime', 3), period: period('B') },
    { quote: quote('realtime', -2), period: period('A') },
    { quote: quote('realtime', 0), period: period('A') },
    { quote: quote('realtime', null), period: period('A') },
    { quote: quote('official', 999), period: period('A') },
    { quote: quote('realtime', -0), period: period('A') },
  ];
  const expected = {
    est_change_desc: [3, 6, 2, 4, 1, 5, 0],
    est_change_asc: [2, 3, 6, 4, 1, 5, 0],
  };
  const initial = [...funds];
  for (const mode of MODES) {
    const sorted = currentSorter(mode)(funds);
    assert.notEqual(sorted, funds);
    assert.deepEqual(sorted, expected[mode].map(index => funds[index]));
    assert.deepEqual(sorted, legacySorter(mode)(funds));
    assert.deepEqual(funds, initial);
  }
  assert.ok(Object.is(funds[6].quote.changePct, -0));
  assert.equal(funds[4].quote.changePct, null);
});

function instrument(specs, throwAt) {
  const trace = [], identities = new WeakMap(), injectedErrors = new WeakSet();
  let reads = 0;
  function track(value, id) {
    if (!value || typeof value !== 'object') return value;
    const target = { ...value };
    for (const key of ['quote', 'period']) {
      if (target[key] && typeof target[key] === 'object') target[key] = track(target[key], `${id}.${key}`);
    }
    if (target.changePct && typeof target.changePct === 'object' && target.changePct.coercion != null) {
      const raw = target.changePct;
      const conversionError = new RangeError('change conversion failed');
      injectedErrors.add(conversionError);
      target.changePct = { valueOf() {
        trace.push(`${id}.changePct.valueOf`);
        if (raw.throws) throw conversionError;
        return raw.coercion;
      } };
    }
    const proxy = new Proxy(target, { get(object, key, receiver) {
      const label = `${id}.${String(key)}`;
      trace.push(label);
      if (++reads === throwAt) {
        const error = new TypeError(`getter ${label}`);
        injectedErrors.add(error);
        throw error;
      }
      return Reflect.get(object, key, receiver);
    } });
    identities.set(proxy, id);
    return proxy;
  }
  const array = specs.map((spec, index) => track(spec, `f${index}`));
  const original = [...array];
  const input = new Proxy(array, { get(object, key, receiver) {
    trace.push(`array.${String(key)}`);
    return Reflect.get(object, key, receiver);
  } });
  return { input, array, original, trace, identities, injectedErrors };
}

function outcome(sorter, specs, throwAt) {
  const fixture = instrument(specs, throwAt);
  let result, error;
  try { result = sorter(fixture.input); } catch (caught) { error = caught; }
  return {
    error: error ? {
      name: error.name, message: error.message,
      injectedIdentityRetained: fixture.injectedErrors.has(error),
    } : null,
    result: result ? result.map(value => value && typeof value === 'object'
      ? fixture.identities.get(value) : String(value)) : null,
    newArray: result ? result !== fixture.input : null,
    unchangedInput: fixture.original.every((value, index) => fixture.array[index] === value),
    trace: fixture.trace,
  };
}

test('both reachable modes match the independent old reference including getter order and exceptions', () => {
  const statuses = ['realtime', 'delayed', 'model', 'official', 'stale', 'unavailable', null, 'unknown'];
  const values = [null, undefined, NaN, 0, -0, 1, -1, Infinity, -Infinity,
    '0', '-3.5', '', true, { coercion: 4.2 }, { coercion: 1, throws: true }];
  const scenarios = [[], [null], [undefined], [{}], [null, {}], [{}, undefined]];
  for (let index = 0; index < 240; index++) {
    const funds = [];
    for (let offset = 0; offset < 2 + index % 5; offset++) {
      const value = values[(index * 7 + offset * 2) % values.length];
      funds.push({
        quote: { status: statuses[(index + offset * 3) % statuses.length], changePct: value },
        period: (index + offset) % 3 === 0 ? null : {
          comparisonKey: ['2026-09-29|2026-09-30', '2026-09-30|2026-10-01', '', null, 0][(index + offset) % 5],
        },
        today_profit: value, curr_value: value, total_profit: value, total_profit_rate: value,
      });
    }
    scenarios.push(funds);
  }
  let comparisons = 0, exceptions = 0, getterExceptions = 0, conversions = 0;
  for (const mode of MODES) {
    const current = currentSorter(mode), reference = legacySorter(mode);
    for (const specs of scenarios) {
      for (const throwAt of [Infinity, 1, 2, 3, 5, 7, 10, 14, 20, 30]) {
        const expected = outcome(reference, specs, throwAt);
        const actual = outcome(current, specs, throwAt);
        assert.deepEqual(actual, expected, `${mode}, scenario ${comparisons}, throwAt ${throwAt}`);
        comparisons++;
        if (actual.error) exceptions++;
        if (actual.error?.message.startsWith('getter ')) getterExceptions++;
        if (actual.trace.some(event => event.endsWith('.valueOf'))) conversions++;
      }
    }
  }
  assert.equal(comparisons, 4920);
  assert.ok(exceptions > 0);
  assert.ok(getterExceptions > 0);
  assert.ok(conversions > 0);
});
