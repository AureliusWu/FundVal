import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlipayHoldingParser,
  detectAlipayHoldingSourceEvidence,
  detectAlipayHoldingOcr,
  extractFundCode,
  groupOcrBlocksIntoCards,
  groupOcrBlocksIntoLines,
  matchFundCandidate,
  normalizeFundName,
  parseAlipayHoldingScreenshot,
  parseAlipayNumber
} from '../js/alipay-ocr-parser.js';

const catalog = [
  { code: '005827', name: '易方达蓝筹精选混合' },
  { code: '012920', name: '易方达全球成长精选混合(QDII)人民币A' },
  { code: '012921', name: '易方达全球成长精选混合(QDII)人民币C' },
  { code: '005844', name: '东方人工智能主题混合A' },
  { code: '005845', name: '东方人工智能主题混合C' }
];

function block(text, x, y, width = 80, height = 18) {
  return { text, bbox: { x0: x, y0: y, x1: x + width, y1: y + height } };
}

test('normalizes names without discarding QDII, currency, or A/C share class', () => {
  assert.equal(normalizeFundName(' 易方达 全球成长精选混合（ qdii ） 人民币 A '), '易方达全球成长精选混合(QDII)人民币A');
  assert.notEqual(normalizeFundName('东方人工智能主题混合A'), normalizeFundName('东方人工智能主题混合C'));
  assert.equal(extractFundCode('基金 005827 持有中'), '005827');
});

test('parses signed amounts, thousands separators, and percentages', () => {
  assert.equal(parseAlipayNumber('¥2,356.72'), 2356.72);
  assert.equal(parseAlipayNumber('+253.20'), 253.2);
  assert.equal(parseAlipayNumber('-128.53'), -128.53);
  assert.equal(parseAlipayNumber('+16.10%', 'percent'), 16.1);
  assert.equal(parseAlipayNumber('-5.17%', 'percent'), -5.17);
});

test('only applies common OCR digit correction in a labelled numeric context and reports it', () => {
  const parsed = parseAlipayHoldingScreenshot({
    source: 'alipay',
    text: '支付宝 基金持有\n005827 易方达蓝筹精选混合\n持有金额 2,3S6.72\n持有收益 -128.53'
  }, catalog);
  assert.equal(parsed.holdings[0].holdingAmount, 2356.72);
  assert.equal(parsed.holdings[0].name, '易方达蓝筹精选混合');
  assert.match(parsed.holdings[0].warnings.join('\n'), /OCR 字符/);
});

test('uses coordinates to keep repeated cards and their labelled values separate', () => {
  const result = {
    blocks: [
      block('支付宝', 20, 20), block('基金持有', 20, 48),
      block('易方达蓝筹精选混合', 20, 100), block('005827', 220, 100),
      block('持有金额', 20, 132), block('持有收益', 220, 132),
      block('2,356.72', 20, 160), block('-128.53', 220, 160),
      block('易方达全球成长精选混合(QDII)人民币A', 20, 250, 210), block('012920', 250, 250),
      block('持有金额', 20, 282), block('持有收益', 220, 282),
      block('1,825.30', 20, 310), block('+253.20', 220, 310)
    ]
  };
  const parsed = parseAlipayHoldingScreenshot(result, catalog);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.holdings.length, 2);
  assert.deepEqual(parsed.holdings.map(item => item.holdingAmount), [2356.72, 1825.3]);
  assert.deepEqual(parsed.holdings.map(item => item.holdingProfit), [-128.53, 253.2]);
  assert.deepEqual(parsed.holdings.map(item => item.match.strategy), ['code', 'code']);
});

test('merges a wrapped name before parsing adjacent holding fields', () => {
  const result = {
    text: '支付宝 基金持有',
    blocks: [
      block('支付宝', 20, 20), block('基金持有', 20, 48),
      block('易方达全球成长精选混合', 20, 100),
      block('(QDII)人民币A', 20, 126),
      block('012920', 240, 126),
      block('持有金额 1,825.30', 20, 160, 180),
      block('持有收益 +253.20', 220, 160, 180),
      block('持有收益率 +16.10%', 20, 188, 180)
    ]
  };
  const parsed = parseAlipayHoldingScreenshot(result, catalog);
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].name, '易方达全球成长精选混合(QDII)人民币A');
  assert.equal(parsed.holdings[0].holdingAmount, 1825.3);
  assert.equal(parsed.holdings[0].holdingProfit, 253.2);
  assert.equal(parsed.holdings[0].holdingProfitRate, 16.1);
  assert.equal(Object.hasOwn(parsed.holdings[0], 'rawText'), false);
});

test('matches a correct six-digit code before an OCR-different name', () => {
  const match = matchFundCandidate({ code: '005827', name: '易方达蓝筹精迭混合' }, catalog);
  assert.equal(match.status, 'matched');
  assert.equal(match.strategy, 'code');
  assert.equal(match.fund.code, '005827');
  assert.equal(match.code, '005827');
  assert.ok(match.warnings.length);
});

test('does not silently replace an unrecognized OCR code with a name match', () => {
  const match = matchFundCandidate({ code: '999999', name: '易方达蓝筹精选混合' }, catalog);
  assert.equal(match.status, 'needs_confirmation');
  assert.equal(match.strategy, 'code_not_found');
  assert.equal(match.fund, null);
  assert.deepEqual(match.candidates.map(item => item.code), ['005827']);
});

test('exposes the selected catalog identity for name-only imports', () => {
  const match = matchFundCandidate({ name: '易方达蓝筹精选混合' }, catalog);
  assert.equal(match.status, 'matched');
  assert.equal(match.strategy, 'exact_name');
  assert.equal(match.code, '005827');
  assert.equal(match.name, '易方达蓝筹精选混合');
});

test('does not silently match A and C share classes', () => {
  const match = matchFundCandidate({ name: '东方人工智能主题混合A' }, catalog);
  assert.equal(match.status, 'matched');
  assert.equal(match.fund.code, '005844');

  const fuzzy = matchFundCandidate({ name: '东方人工智能主题混合' }, catalog);
  assert.equal(fuzzy.status, 'needs_confirmation');
  assert.deepEqual(fuzzy.candidates.map(item => item.code), ['005844', '005845']);
});

test('does not use a classless fuzzy result for an OCR name that explicitly has class A/C/E', () => {
  const classlessCatalog = [{ code: '000001', name: '华夏成长混合' }];
  const match = matchFundCandidate({ name: '华夏成长混合A' }, classlessCatalog, { fuzzyThreshold: 0.6 });
  assert.equal(match.status, 'unmatched');
  assert.equal(match.fund, null);
});

test('never treats a six-digit monetary value as a fund code', () => {
  const parsed = parseAlipayHoldingScreenshot({
    text: '支付宝 基金持有\n易方达蓝筹精选混合\n持有金额 123456.78\n持有收益 +10.00'
  }, catalog);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].code, null);
  assert.equal(parsed.holdings[0].match.strategy, 'exact_name');
  assert.equal(parsed.holdings[0].match.code, '005827');
});

test('pairs a text-only row of amount labels and values without reusing the first value', () => {
  const parsed = parseAlipayHoldingScreenshot({
    text: '支付宝 基金持有\n005827 易方达蓝筹精选混合\n持有金额 持有收益\n2,356.72 -128.53'
  }, catalog);
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].holdingAmount, 2356.72);
  assert.equal(parsed.holdings[0].holdingProfit, -128.53);
});

test('parses the current Ant Fortune two-column holdings layout without per-card labels', () => {
  const result = {
    text: [
      '蚂蚁财富 基金 我的持有',
      '名称 金额/昨日收益 持有收益/率',
      '易方达全球成长精选混合(QDII)人民币A',
      '3,036.97 +416.97',
      '+49.20 +15.91%',
      '广发远见智选混合C',
      '1,222.98 -98.08',
      '-29.57 -7.42%'
    ].join('\n')
  };
  const parsed = parseAlipayHoldingScreenshot(result, catalog);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.holdings.length, 2);
  assert.deepEqual(parsed.holdings.map(item => item.match.code), ['012920', null]);
  assert.deepEqual(parsed.holdings.map(item => item.holdingAmount), [3036.97, 1222.98]);
  assert.deepEqual(parsed.holdings.map(item => item.holdingProfit), [416.97, -98.08]);
  assert.deepEqual(parsed.holdings.map(item => item.dailyProfit), [49.2, -29.57]);
  assert.deepEqual(parsed.holdings.map(item => item.holdingProfitRate), [15.91, -7.42]);
  assert.match(parsed.holdings[0].warnings.join('\n'), /蚂蚁财富列表/);
});

test('accepts a weak Ant Fortune brand only when the holdings table and three catalog identities corroborate it', () => {
  const fallbackCatalog = [
    { code: '012920', name: '易方达全球成长精选混合(QDII)人民币A' },
    { code: '005844', name: '东方人工智能主题混合A' },
    { code: '021528', name: '财通成长优选混合C' }
  ];
  const result = {
    text: [
      '财富',
      '我的持有',
      '名称 金额/昨日收益 持有收益/率',
      '易方达全球成长精选混合(QDII)人民帀A',
      '3,036.97 +416.97',
      '+49.20 +15.91%',
      '东方人工智能主题混合A',
      '507.91 +13.68',
      '+14.94 +2.77%',
      '财通成长优选混合C',
      '6,946.13 -926.53',
      '-9.60 -11.77%'
    ].join('\n')
  };

  const detected = detectAlipayHoldingOcr(result, fallbackCatalog);
  const parsed = parseAlipayHoldingScreenshot(result, fallbackCatalog);
  assert.equal(detected.supported, true);
  assert.equal(detected.source, 'ant_fortune_fallback');
  assert.equal(detected.identityCount, 3);
  assert.equal(parsed.supported, true);
  assert.deepEqual(parsed.holdings.map(item => item.match.code), ['012920', '005844', '021528']);
  assert.equal(parsed.holdings[0].match.strategy, 'fuzzy');
});

test('accepts a compressed Ant long-page signature only with distinct UI, table, and three identities', () => {
  const holdings = [
    { normalizedName: '易方达全球成长精选混合(QDII)人民币A', match: { status: 'matched', strategy: 'exact_name', code: '012920' } },
    { normalizedName: '东方人工智能主题混合A', match: { status: 'matched', strategy: 'exact_name', code: '005844' } },
    { normalizedName: '财通成长优选混合C', match: { status: 'matched', strategy: 'exact_name', code: '021528' } },
  ];
  const tokens = ['基金', '持仓分析', '交易记录', '我的持有', '名称', '金额/昨日收益', '持有收益/率']
    .map(text => ({ text }));
  const detected = detectAlipayHoldingSourceEvidence({ tokens, holdings, tableLayout: true });
  assert.equal(detected.supported, true);
  assert.equal(detected.source, 'ant_fortune_layout');
  assert.equal(detected.identityCount, 3);

  const generic = detectAlipayHoldingSourceEvidence({
    tokens: [{ text: '我的持有' }, { text: '名称 金额/昨日收益 持有收益/率' }],
    holdings,
    tableLayout: true,
  });
  assert.equal(generic.supported, false);
});

test('rejects a weak 财富 fragment when the fallback corroboration is incomplete or has no Ant brand evidence', () => {
  const fallbackCatalog = [
    { code: '012920', name: '易方达全球成长精选混合(QDII)人民币A' },
    { code: '005844', name: '东方人工智能主题混合A' },
    { code: '021528', name: '财通成长优选混合C' }
  ];
  const threeHoldingRows = [
    '我的持有',
    '名称 金额/昨日收益 持有收益/率',
    '易方达全球成长精选混合(QDII)人民币A', '3,036.97 +416.97', '+49.20 +15.91%',
    '东方人工智能主题混合A', '507.91 +13.68', '+14.94 +2.77%',
    '财通成长优选混合C', '6,946.13 -926.53', '-9.60 -11.77%'
  ];
  const onlyTwoIdentities = { sourceHint: 'alipay', text: ['财富', ...threeHoldingRows.slice(0, 8)].join('\n') };
  const noAntBrand = { text: ['天天基金', ...threeHoldingRows].join('\n') };

  assert.equal(detectAlipayHoldingOcr(onlyTwoIdentities, fallbackCatalog).supported, false);
  assert.deepEqual(parseAlipayHoldingScreenshot(onlyTwoIdentities, fallbackCatalog).holdings, []);
  assert.equal(detectAlipayHoldingOcr(noAntBrand, fallbackCatalog).supported, false);
  assert.deepEqual(parseAlipayHoldingScreenshot(noAntBrand, fallbackCatalog).holdings, []);
});

test('keeps index digits in an ETF name instead of stripping them as an amount', () => {
  const indexCatalog = [{ code: '012345', name: '中证500ETF联接A' }];
  const parsed = parseAlipayHoldingScreenshot({
    text: '支付宝 基金持有\n012345 中证500ETF联接A\n持有金额 100.00\n持有收益 +1.00'
  }, indexCatalog);
  assert.equal(parsed.holdings[0].rawFundName, '中证500ETF联接A');
  assert.equal(parsed.holdings[0].match.strategy, 'code');
});

test('requires confirmation instead of selecting among close fuzzy candidates', () => {
  const match = matchFundCandidate({ name: '易方达全球成长精选混合(QDII)人民币' }, catalog);
  assert.equal(match.status, 'needs_confirmation');
  assert.equal(match.strategy, 'fuzzy_ambiguous');
  assert.deepEqual(match.candidates.map(item => item.code), ['012920', '012921']);
});

test('returns no holdings for empty or non-Alipay text', () => {
  assert.deepEqual(parseAlipayHoldingScreenshot('', catalog).holdings, []);
  const nonAlipay = parseAlipayHoldingScreenshot({ text: '天天基金 持有金额 2,356.72 易方达蓝筹精选混合' }, catalog);
  assert.equal(nonAlipay.supported, false);
  assert.deepEqual(nonAlipay.holdings, []);
  assert.equal(detectAlipayHoldingOcr({ text: '支付宝订单详情' }).supported, false);
  assert.equal(detectAlipayHoldingOcr({ source: 'alipay', text: '普通发票 123456' }).supported, false);
});

test('exposes coordinate line/card helpers and a small parser facade', () => {
  const blocks = [block('支付宝', 0, 0), block('基金', 60, 0), block('005827', 0, 60), block('持有金额 10', 0, 90)];
  const lines = groupOcrBlocksIntoLines(blocks);
  assert.equal(lines.length, 3);
  assert.equal(groupOcrBlocksIntoCards(lines, catalog).length, 1);
  const parser = new AlipayHoldingParser({ fundCatalog: catalog });
  assert.equal(parser.parse({ blocks }).holdings[0].match.fund.code, '005827');
});
