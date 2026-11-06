import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoldingImportPlan } from '../js/holding-import-plan.js';
import {
  dedupeOcrTableTokens,
  parseStrictOcrNumber,
  reconstructOcrTableLayout
} from '../js/ocr-table-layout.js';

const catalog = new Map([
  ['财通成长优选混合C', { status: 'matched', code: '021528', name: '财通成长优选混合C' }],
  ['永赢先进半导体智选混合发起C', { status: 'matched', code: '025209', name: '永赢先进半导体智选混合发起C' }],
  ['东方人工智能主题混合A', { status: 'matched', code: '005844', name: '东方人工智能主题混合A' }],
  ['易方达全球成长精选混合(QDII)A', { status: 'matched', code: '012920', name: '易方达全球成长精选混合(QDII)A' }]
]);

function matchFund(name) {
  return catalog.get(String(name).replace(/\s/g, '')) || null;
}

function token(text, x0, y0, x1 = x0 + 90, y1 = y0 + 24, score = 0.95) {
  return { text, x0, y0, x1, y1, score };
}

function tableHeader(y = 80) {
  return [
    token('名称', 60, y, 140, y + 24),
    token('金额/昨日收益', 640, y, 840, y + 24),
    token('持有收益/率', 1060, y, 1260, y + 24)
  ];
}

test('deduplicates only adjacent overlap-seam tokens and preserves stable reading order', () => {
  const output = dedupeOcrTableTokens([
    token('财通成长优选混合C', 50, 200, 350, 224, 0.82),
    token('财通成长优选混合C', 51, 202, 351, 226, 0.98),
    token('财通成长优选混合C', 50, 520, 350, 544, 0.91),
    token('+12.50', 680, 240)
  ]);
  assert.equal(output.length, 3);
  assert.equal(output[0].score, 0.98);
  assert.deepEqual(output.map(item => item.y0), [202, 240, 520]);
});

test('reconstructs wrapped fund names and three separated numeric columns', () => {
  const result = reconstructOcrTableLayout({
    imageWidth: 1440,
    matchFund,
    tokens: [
      ...tableHeader(),
      token('财通成长优选', 55, 160, 280, 184),
      token('混合C', 55, 188, 140, 212),
      token('6,946.13', 670, 162, 790, 186),
      token('-9.60', 690, 202, 770, 226),
      token('-926.53', 1110, 162, 1225, 186),
      token('-11.77%', 1120, 202, 1225, 226),
      token('东方人工智能主题混合A', 55, 320, 350, 344),
      token('507.91', 680, 322, 780, 346),
      token('+14.94', 680, 362, 780, 386),
      token('+13.68', 1110, 322, 1210, 346),
      token('+2.77%', 1120, 362, 1210, 386)
    ]
  });

  assert.equal(result.schema.header.reliable, true);
  assert.equal(result.schema.geometry.reliable, true);
  assert.equal(result.schema.importable, true);
  assert.equal(result.previewRows.length, 2);
  assert.deepEqual(result.previewRows.map(row => row.match.code), ['021528', '005844']);
  assert.deepEqual(result.previewRows.map(row => row.holdingAmount), [6946.13, 507.91]);
  assert.deepEqual(result.previewRows.map(row => row.dailyProfit), [-9.6, 14.94]);
  assert.deepEqual(result.previewRows.map(row => row.holdingProfit), [-926.53, 13.68]);
  assert.deepEqual(result.previewRows.map(row => row.holdingProfitRate), [-11.77, 2.77]);
  assert.equal(result.previewRows[0].numericTokens.middle.length, 2);
  assert.equal(result.previewRows[0].numericTokens.right.length, 2);
});

test('reconstructs a fund name split into same-line fragments and a wrapped line', () => {
  const result = reconstructOcrTableLayout({
    imageWidth: 1440,
    matchFund,
    tokens: [
      ...tableHeader(),
      token('易方达全球', 55, 160, 175, 184),
      token('成长精选', 184, 162, 285, 186),
      token('混合(QDII)A', 55, 190, 210, 214),
      token('3,036.97', 670, 162, 790, 186),
      token('+49.20', 690, 202, 770, 226),
      token('+416.97', 1110, 162, 1225, 186),
      token('+15.91%', 1120, 202, 1225, 226),
      token('东方人工智能主题混合A', 55, 340, 350, 364),
      token('507.91', 680, 342, 780, 366),
      token('+14.94', 680, 382, 780, 406),
      token('+13.68', 1110, 342, 1210, 366),
      token('+2.77%', 1120, 382, 1210, 406)
    ]
  });
  assert.deepEqual(result.previewRows.map(row => row.match.code), ['012920', '005844']);
  assert.equal(result.previewRows[0].holdingAmount, 3036.97);
  assert.equal(result.previewRows[0].holdingProfitRate, 15.91);
});

test('drops a joined Alipay plan badge after a wrapped QDII share class without changing geometry or amounts', () => {
  const cleanName = '合成全球配置混合(QDII)C';
  const matcher = name => {
    if (name === cleanName) return { status: 'matched', strategy: 'exact_name', code: '001001', name };
    if (name === `${cleanName}定 投`) return { status: 'matched', strategy: 'fuzzy', code: '001009', name: '合成全球配置混合(QDII)A' };
    return null;
  };
  const read = suffix => reconstructOcrTableLayout({ imageWidth: 1440, matchFund: matcher, tokens: [
    ...tableHeader(), token('合成全球配置', 50, 180, 220, 204),
    token(`混合(QDII)C${suffix}`, 50, 210, 290, 234),
    token('147.15', 670, 180), token('-2.50', 670, 220),
    token('+31.20', 1110, 180), token('+26.91%', 1110, 220),
  ] });
  const joined = read('定 投');
  assert.deepEqual(joined, read(''));
  const [row] = joined.previewRows;
  assert.equal(row.name, cleanName);
  assert.equal(row.match.code, '001001');
  assert.equal(row.holdingAmount, 147.15);
  assert.equal(row.dailyProfit, -2.5);
  assert.equal(row.holdingProfit, 31.2);
  assert.equal(row.holdingProfitRate, 26.91);
});

test('treats a separate wrapped plan badge as a boundary, never a name or fuzzy continuation', () => {
  const queried = [];
  const names = new Map([['合成稳健混合A', '001001'], ['合成定投精选混合C', '001002']]);
  const result = reconstructOcrTableLayout({ imageWidth: 1440, matchFund(name) {
    queried.push(name);
    const code = names.get(name);
    if (code) return { status: 'matched', code, name };
    if (name.includes('定 投')) return { status: 'matched', strategy: 'fuzzy', code: '001009', name: '错误的模糊匹配' };
    return null;
  }, tokens: [
    ...tableHeader(), token('合成稳健', 50, 180, 230, 204), token('混合A', 50, 210, 150, 234),
    token('定 投', 50, 240, 100, 256),
    token('81.13', 670, 180), token('-1.28', 670, 220),
    token('+6.21', 1110, 180), token('+8.29%', 1110, 220),
    token('合成定投精选混合C', 50, 274, 310, 298),
    token('172.11', 670, 274), token('+4.12', 670, 314),
    token('-19.33', 1110, 274), token('-10.10%', 1110, 314),
  ] });
  assert.equal(result.schema.importable, true);
  assert.deepEqual(result.previewRows.map(row => row.name), [...names.keys()]);
  assert.deepEqual(result.previewRows.map(row => row.match.code), [...names.values()]);
  assert.equal(queried.some(name => name.includes('定 投') || name.includes('混合A合成')), false);
  assert.deepEqual(result.previewRows.map(row => [row.holdingAmount, row.dailyProfit, row.holdingProfit, row.holdingProfitRate]),
    [[81.13, -1.28, 6.21, 8.29], [172.11, 4.12, -19.33, -10.1]]);
});

test('keeps exact catalog names and does not substitute an uncertain stripped candidate', () => {
  const exact = '合成定投目标混合C定投';
  const uncertain = '合成平衡混合A定投';
  const result = reconstructOcrTableLayout({ imageWidth: 1440, matchFund(name) {
    if (name === exact || name === '合成定投目标混合C') return { status: 'matched', strategy: 'exact_name', code: name === exact ? '001001' : '001002', name };
    if (name === uncertain || name === '合成平衡混合A') return { status: 'matched', strategy: 'fuzzy', code: name === uncertain ? '001003' : '001004', name: '合成模拟混合A' };
    return null;
  }, tokens: [
    ...tableHeader(), token(exact, 50, 180, 310, 204), token(uncertain, 50, 340, 310, 364),
  ] });
  assert.deepEqual(result.previewRows.map(row => [row.name, row.match.code]), [[exact, '001001'], [uncertain, '001003']]);
});

test('keeps negative amounts and percentages strict, without partial text extraction', () => {
  assert.equal(parseStrictOcrNumber('-98.08'), -98.08);
  assert.equal(parseStrictOcrNumber('-7.42%', 'percent'), -7.42);
  assert.equal(parseStrictOcrNumber('收益-98.08'), null);
  assert.equal(parseStrictOcrNumber('+7.42%', 'amount'), null);
  assert.equal(parseStrictOcrNumber('12.345'), null);
});

test('allows a geometry-only preview but never marks a headerless table importable', () => {
  const result = reconstructOcrTableLayout({
    imageWidth: 1440,
    matchFund,
    tokens: [
      token('财通成长优选混合C', 50, 180, 350, 204),
      token('6,946.13', 670, 180), token('-9.60', 670, 220),
      token('-926.53', 1110, 180), token('-11.77%', 1110, 220),
      token('东方人工智能主题混合A', 50, 340, 350, 364),
      token('507.91', 670, 340), token('+14.94', 670, 380),
      token('+13.68', 1110, 340), token('+2.77%', 1110, 380)
    ]
  });
  assert.equal(result.schema.header.reliable, false);
  assert.equal(result.schema.geometry.reliable, true);
  assert.equal(result.schema.semanticReliable, true);
  assert.equal(result.schema.importable, false);
  assert.equal(result.previewRows[0].holdingAmount, 6946.13);
  assert.equal(result.previewRows[0].holdingProfitRate, -11.77);
});

test('does not assign semantic numbers when neither a reliable header nor clear geometry exists', () => {
  const result = reconstructOcrTableLayout({
    imageWidth: 1440,
    matchFund,
    tokens: [
      token('财通成长优选混合C', 50, 180, 350, 204),
      token('6,946.13', 670, 180), token('-926.53', 1110, 180)
    ]
  });
  assert.equal(result.schema.semanticReliable, false);
  assert.equal(result.schema.importable, false);
  assert.equal(result.previewRows[0].holdingAmount, null);
  assert.equal(result.previewRows[0].holdingProfit, null);
  assert.equal(result.previewRows[0].dailyProfit, null);
  assert.equal(result.previewRows[0].holdingProfitRate, null);
});

test('retains an unnamed numeric record for explicit manual confirmation instead of dropping it', () => {
  const result = reconstructOcrTableLayout({
    imageWidth: 1440,
    matchFund,
    tokens: [
      ...tableHeader(),
      token('财通成长优选混合C', 50, 180, 350, 204),
      token('6,946.13', 670, 180), token('-9.60', 670, 220),
      token('-926.53', 1110, 180), token('-11.77%', 1110, 220),
      // The second name is unreadable, but the four fields still establish a
      // complete row. Its identity must remain empty and therefore default to
      // manual confirmation/skip in the import-plan layer.
      token('3,440.91', 670, 340), token('+35.73', 670, 380),
      token('+40.91', 1110, 340), token('+1.20%', 1110, 380)
    ]
  });
  assert.equal(result.previewRows.length, 2);
  assert.equal(result.previewRows[0].match.code, '021528');
  assert.equal(result.previewRows[1].name, '');
  assert.equal(result.previewRows[1].match, null);
  assert.equal(result.previewRows[1].holdingAmount, 3440.91);
  assert.equal(result.previewRows[1].holdingProfitRate, 1.2);
});

test('a joined plan badge is removed even when the verified name still needs currency review', () => {
  const name = '合成海外指数(QDII)A';
  const candidates = [
    { code: '001001', name: '合成海外指数(QDII)人民币A' },
    { code: '001002', name: '合成海外指数(QDII)美元A' },
  ];
  const result = reconstructOcrTableLayout({ imageWidth: 1440,
    matchFund: text => text === name ? { status: 'needs_confirmation', strategy: 'currency_ambiguous', candidates } : null,
    tokens: [...tableHeader(), token(`${name}定投`, 50, 180, 400, 204),
      token('200.00', 670, 180), token('+2.00', 670, 220),
      token('+10.00', 1110, 180), token('+5.26%', 1110, 220)],
  });
  assert.equal(result.previewRows.length, 1);
  assert.equal(result.previewRows[0].name, name);
  assert.equal(result.previewRows[0].holdingAmount, 200);
  assert.equal(result.previewRows[0].match.code, undefined);
  assert.deepEqual(result.previewRows[0].match.candidates, candidates);
});

test('keeps A/C ambiguity as a preview candidate without choosing a fund identity', () => {
  const candidates = [
    { code: '001001', name: '合成成长混合A' },
    { code: '001002', name: '合成成长混合C' },
  ];
  const result = reconstructOcrTableLayout({
    imageWidth: 1440,
    matchFund: name => name === '合成成长混合'
      ? { status: 'ambiguous', candidates } : null,
    tokens: [...tableHeader(), token('合成成长混合', 50, 180, 350, 204),
      token('100.00', 670, 180), token('-1.00', 670, 220),
      token('-10.00', 1110, 180), token('-9.09%', 1110, 220)],
  });
  assert.equal(result.previewRows.length, 1);
  assert.equal(result.previewRows[0].holdingAmount, 100);
  const [plan] = createHoldingImportPlan(result.previewRows, []);
  assert.equal(plan.code, '');
  assert.equal(plan.action, 'skip');
  assert.equal(plan.matchStatus, 'ambiguous');
  assert.deepEqual(plan.matchCandidates, candidates);
});

for (const missing of ['holdingAmount', 'dailyProfit', 'holdingProfit', 'holdingProfitRate']) {
  test(`missing ${missing} stays null without losing or shifting the other visual fields`, () => {
    const evidence = {
      holdingAmount: token('100.00', 670, 180),
      dailyProfit: token('-1.00', 670, 220),
      holdingProfit: token('-10.00', 1110, 180),
      holdingProfitRate: token('-9.09%', 1110, 220),
    };
    const expected = { holdingAmount: 100, dailyProfit: -1, holdingProfit: -10, holdingProfitRate: -9.09 };
    const result = reconstructOcrTableLayout({ imageWidth: 1440, matchFund,
      tokens: [...tableHeader(), token('财通成长优选混合C', 50, 180, 350, 204),
        ...Object.entries(evidence).filter(([field]) => field !== missing).map(([, value]) => value),
        token('东方人工智能主题混合A', 50, 340, 350, 364),
        token('500.00', 670, 340), token('+5.00', 670, 380),
        token('+50.00', 1110, 340), token('+11.11%', 1110, 380)],
    });
    assert.equal(result.previewRows.length, 2);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(result.previewRows[0][field], field === missing ? null : value, field);
    }
    assert.equal(result.previewRows[1].holdingAmount, 500);
    assert.equal(result.previewRows[1].dailyProfit, 5);
  });
}
