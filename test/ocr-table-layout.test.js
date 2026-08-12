import test from 'node:test';
import assert from 'node:assert/strict';
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
