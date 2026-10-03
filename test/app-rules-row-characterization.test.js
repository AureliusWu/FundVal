import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = appSource.indexOf('      // 基金信息 & 费率');
const end = appSource.indexOf("\n\n      html += '</div>';", start);
assert.ok(start >= 0 && end > start, 'The complete fund information and fee render block must exist.');
const renderBlock = appSource.slice(start, end);
const escStart = appSource.indexOf('function esc(s) {');
const escEnd = appSource.indexOf('// ── 持仓编辑', escStart);
assert.ok(escStart >= 0 && escEnd > escStart);
const sourceEscape = appSource.slice(escStart, escEnd);
const helperStart = appSource.indexOf('function ruleRow(');
const helperEnd = appSource.indexOf('\nfunction ', helperStart + 1);
const sourceHelper = helperStart < 0 ? '' : appSource.slice(helperStart, helperEnd);

// Independent pre-compaction render reference. Keep its literal rows, guards,
// repeated reads, and HTML order rather than deriving it from the production helper.
const referenceBlock = `
      var hasType = fundTypeCache[f.code] !== undefined;
      var hasFee = fundFeeCache[f.code] !== undefined;
      if (!hasType && !hasFee) {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        html += '<div class="rules-loading">加载中...</div>';
        html += '</div>';
      } else if (fundTypeCache[f.code] === null && fundFeeCache[f.code] === null) {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        html += '<div class="rules-empty">暂无数据</div>';
        html += '</div>';
      } else {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        if (fundTypeCache[f.code]) {
          var ti = fundTypeCache[f.code];
          html += '<div class="rules-table">';
          if (ti.type) html += '<div class="rules-row"><span class="rules-label">基金类型</span><span class="rules-val">' + esc(ti.type) + '</span></div>';
          if (ti.setupDate) html += '<div class="rules-row"><span class="rules-label">成立日期</span><span class="rules-val">' + esc(ti.setupDate) + '</span></div>';
          if (ti.scale) html += '<div class="rules-row"><span class="rules-label">基金规模</span><span class="rules-val">' + esc(ti.scale) + '</span></div>';
          if (ti.manager) html += '<div class="rules-row"><span class="rules-label">基金经理</span><span class="rules-val">' + esc(ti.manager + (ti.managerWorkTime ? ' · ' + ti.managerWorkTime : '')) + '</span></div>';
          if (ti.company) html += '<div class="rules-row"><span class="rules-label">管理人</span><span class="rules-val">' + esc(ti.company) + '</span></div>';
          if (ti.benchmark) html += '<div class="rules-row"><span class="rules-label">跟踪标的</span><span class="rules-val">' + esc(ti.benchmark) + '</span></div>';
          html += '</div>';
        }
        if (fundFeeCache[f.code]) {
          var fi = fundFeeCache[f.code];
          html += '<div class="rules-table" style="margin-top:6px">';
          if (fi.buyFee) html += '<div class="rules-row"><span class="rules-label">申购费率</span><span class="rules-val">' + esc(fi.buyFee) + '</span></div>';
          if (fi.sourceBuyFee && fi.sourceBuyFee !== fi.buyFee) html += '<div class="rules-row"><span class="rules-label">原申购费率</span><span class="rules-val">' + esc(fi.sourceBuyFee) + '</span></div>';
          if (fi.sellFee) html += '<div class="rules-row"><span class="rules-label">赎回费率</span><span class="rules-val">' + esc(fi.sellFee) + '</span></div>';
          if (fi.manageFee) html += '<div class="rules-row"><span class="rules-label">管理费率</span><span class="rules-val">' + esc(fi.manageFee) + '</span></div>';
          if (fi.custodyFee) html += '<div class="rules-row"><span class="rules-label">托管费率</span><span class="rules-val">' + esc(fi.custodyFee) + '</span></div>';
          html += '</div>';
        }
        html += '</div>';
      }
`;

function referenceEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scenario(seed, throwAt = -1, changingReads = false) {
  const trace = [];
  let count = 0;
  const reads = new Map();
  function read(key) {
    trace.push(key);
    if (++count === throwAt) throw new TypeError(`read stopped at ${key}`);
    reads.set(key, (reads.get(key) || 0) + 1);
  }
  const pool = [null, 0, false, '', '<>&"\'', '12.34%', {
    [Symbol.toPrimitive](hint) { read(`coerce:${hint}`); return 'object<&>'; },
  }];
  function payload(names, tag) {
    const values = Object.fromEntries(names.map((name, index) => [name, pool[(seed + index) % pool.length]]));
    return new Proxy(values, {
      get(object, key) {
        const traceKey = `${tag}.${String(key)}`;
        read(traceKey);
        return changingReads && reads.get(traceKey) % 2 === 0 ? '<second&read>' : Reflect.get(object, key);
      },
    });
  }
  const type = payload(['type', 'setupDate', 'scale', 'manager', 'managerWorkTime', 'company', 'benchmark'], 'ti');
  const fee = payload(['buyFee', 'sourceBuyFee', 'sellFee', 'manageFee', 'custodyFee'], 'fi');
  const variant = seed % 7;
  const typeState = [undefined, null, type, type, null, undefined, type][variant];
  const feeState = [undefined, null, fee, null, fee, fee, undefined][variant];
  function cache(value, tag) {
    return new Proxy({ '005844': value }, {
      get(object, key) { read(`${tag}.${String(key)}`); return Reflect.get(object, key); },
    });
  }
  const f = new Proxy({ code: '005844' }, {
    get(object, key) { read(`f.${String(key)}`); return Reflect.get(object, key); },
  });
  return { context: { f, fundTypeCache: cache(typeState, 'typeCache'), fundFeeCache: cache(feeState, 'feeCache') }, trace };
}

function evaluate(production, seed, throwAt = -1, changingReads = false) {
  const fixture = scenario(seed, throwAt, changingReads);
  const escape = production ? sourceEscape : `const esc = ${referenceEscape.toString()};`;
  const helper = production ? sourceHelper : '';
  const block = production ? renderBlock : referenceBlock;
  try {
    const output = runInNewContext(`${escape}\n${helper}\nvar html = '';\n${block}\nhtml;`, fixture.context);
    return { output, trace: fixture.trace };
  } catch (error) {
    return { error: { name: error.name, message: error.message }, trace: fixture.trace };
  }
}

test('fund information and fee rows preserve complete HTML and read/coercion order across 98 cases', () => {
  let maximumReads = 0;
  for (let seed = 0; seed < 98; seed++) {
    const expected = evaluate(false, seed);
    assert.equal(expected.error, undefined);
    assert.deepEqual(evaluate(true, seed), expected, `seed ${seed}`);
    maximumReads = Math.max(maximumReads, expected.trace.length);
  }
  assert.equal(maximumReads, 34);
});

test('fund information and fee rows preserve each getter/coercion exception boundary across 2030 cases', () => {
  let cases = 0;
  for (let seed = 0; seed < 98; seed++) {
    const expected = evaluate(false, seed);
    for (let readIndex = 1; readIndex <= expected.trace.length + 1; readIndex++) {
      assert.deepEqual(evaluate(true, seed, readIndex), evaluate(false, seed, readIndex), `seed ${seed}, read ${readIndex}`);
      cases++;
    }
  }
  assert.equal(cases, 2030);
});

test('fund information and fee rows do not memoize repeated field reads', () => {
  for (let seed = 0; seed < 98; seed++) {
    const expected = evaluate(false, seed, -1, true);
    assert.equal(expected.error, undefined);
    assert.deepEqual(evaluate(true, seed, -1, true), expected, `changing-read seed ${seed}`);
  }
});
