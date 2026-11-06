import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlipayHoldingParser,
  buildFundMatchIndex,
  createFundMatchSession,
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
  { code: '012922', name: '易方达全球成长精选混合(QDII)人民币C' },
  { code: '005844', name: '东方人工智能主题混合A' },
  { code: '005845', name: '东方人工智能主题混合C' }
];

test('builds exact/share-class/trigram indexes once and narrows fuzzy Levenshtein work', () => {
  const largeCatalog = [
    ...catalog,
    ...Array.from({ length: 600 }, (_, index) => ({
      code: String(100000 + index),
      name: `完全无关债券基金${index}A`,
    })),
  ];
  const index = buildFundMatchIndex(largeCatalog);
  assert.equal(index.byCode.get('005844').name, '东方人工智能主题混合A');
  assert.equal(index.byExactNormalizedName.get('东方人工智能主题混合A').length, 1);
  assert.equal(index.byBaseNameAndShareClass.get('东方人工智能主题混合\u0000A').length, 1);
  assert.ok(index.trigramIndex.get('东方人').size >= 2);

  const session = createFundMatchSession(largeCatalog, { fuzzyThreshold: 0.6 });
  const match = session.match({ name: '东方人工智能主颢混合A' });
  const metrics = session.metrics();
  assert.equal(match.code, '005844');
  assert.ok(metrics.lastFuzzyCandidateCount < largeCatalog.length / 4);
  assert.ok(metrics.levenshteinComparisons <= 96);
});

test('fund match session memo avoids repeating fuzzy work and keeps share classes isolated', () => {
  const session = createFundMatchSession(catalog, { fuzzyThreshold: 0.6 });
  const first = session.match({ name: '东方人工智能主颢混合A' });
  const comparisons = session.metrics().levenshteinComparisons;
  const second = session.match({ name: '东方人工智能主颢混合A' });
  assert.equal(first.code, '005844');
  assert.deepEqual(second, first);
  assert.equal(session.metrics().levenshteinComparisons, comparisons);
  assert.equal(session.metrics().memoHits, 1);

  const classless = session.match({ name: '东方人工智能主题混合' });
  assert.equal(classless.status, 'needs_confirmation');
  assert.deepEqual(classless.candidates.map(item => item.code), ['005844', '005845']);
  session.clear();
  assert.equal(session.metrics().memoSize, 0);
});

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

test('requires review rather than trusting a code paired with an OCR-different name', () => {
  const match = matchFundCandidate({ code: '005827', name: '易方达蓝筹精迭混合' }, catalog);
  assert.equal(match.status, 'needs_confirmation');
  assert.equal(match.strategy, 'code_name_conflict');
  assert.equal(match.fund, null);
  assert.equal(match.code, null);
  assert.ok(match.warnings.length);
});

const verifiedProducts = [
  ['建信新兴市场优选混合（QDII）A', '539002', '建信新兴市场混合(QDII)A'],
  ['建信新兴市场优选混合(QDII)C', '018147', '建信新兴市场混合(QDII)C'],
  ['永赢先锋半导体智选混合 A', '025208', '永赢先锋半导体智选混合发起A'],
  ['永赢先锋半导体智选混合C', '025209', '永赢先锋半导体智选混合发起C'],
  ['华泰柏瑞质量成长混合A', '008528', '华泰柏瑞质量成长A'],
  ['华泰柏瑞质量成长混合 C', '011452', '华泰柏瑞质量成长C'],
];
const aliasCatalog = verifiedProducts.map(([, code, name]) => ({ code, name }));

test('only trusts exact public abbreviations with their verified catalog code and spelling', () => {
  for (const [alias, code, canonical] of verifiedProducts) {
    const match = matchFundCandidate({ name: alias }, aliasCatalog);
    assert.equal(match.status, 'matched');
    assert.equal(match.strategy, 'verified_alias');
    assert.equal(match.code, code);
    assert.equal(match.name, canonical);
    assert.equal(matchFundCandidate({ code, name: alias }, aliasCatalog).strategy, 'code');
    assert.equal(matchFundCandidate({ name: canonical }, aliasCatalog).strategy, 'exact_name');
  }
});

test('rejects alias drift or collision rather than weakening to fuzzy auto-selection', () => {
  const [name, code, canonical] = verifiedProducts[0];
  const drifted = [
    { code, name: '建信完全不同混合(QDII)A' },
    { code: '999999', name: canonical },
  ];
  const unverified = matchFundCandidate({ name }, drifted);
  assert.equal(unverified.strategy, 'alias_unverified');
  assert.equal(unverified.fund, null);
  assert.equal(matchFundCandidate({ code, name }, drifted).strategy, 'code_name_conflict');
  const wrongLiteral = [{ code: '999999', name }];
  assert.equal(matchFundCandidate({ name }, wrongLiteral).strategy, 'alias_unverified');
  assert.equal(matchFundCandidate({ code: '999999', name }, wrongLiteral).strategy, 'code_name_conflict');
  const wrongClassSpelling = [{ code: '999999', name: `${name}类` }];
  assert.equal(matchFundCandidate({ name }, wrongClassSpelling).strategy, 'alias_unverified');
  assert.equal(matchFundCandidate({ code: '999999', name }, wrongClassSpelling).strategy, 'code_name_conflict');
  const literal = [{ code, name }];
  assert.equal(matchFundCandidate({ name }, literal).strategy, 'exact_name');
  const collision = matchFundCandidate({ code, name }, [...aliasCatalog, { code: '999999', name }]);
  assert.equal(collision.strategy, 'exact_name_ambiguous');
  assert.equal(collision.fund, null);
});

const currencyCatalog = [
  ...catalog,
  { code: '012921', name: '易方达全球成长精选混合(QDII)美元现汇A' },
  { code: '012923', name: '易方达全球成长精选混合(QDII)美元现汇C' },
  { code: '539001', name: '建信纳斯达克100指数(QDII)A人民币' },
  { code: '012751', name: '建信纳斯达克100指数(QDII)A美元现汇' },
  { code: '012752', name: '建信纳斯达克100指数(QDII)C人民币' },
  { code: '017641', name: '摩根标普500指数(QDII)人民币A' },
  { code: '019305', name: '摩根标普500指数(QDII)人民币C' },
  { code: '017642', name: '摩根标普500指数(QDII)美钞' },
  { code: '017643', name: '摩根标普500指数(QDII)美汇' },
];

test('requires a QDII currency decision when the same share class has several currencies', () => {
  for (const [name, codes] of [
    ['易方达全球成长精选混合(QDII)A', ['012920', '012921']],
    ['易方达全球成长精选混合(QDII)C', ['012922', '012923']],
    ['建信纳斯达克100指数(QDII)A', ['539001', '012751']],
  ]) {
    const match = matchFundCandidate({ name }, currencyCatalog);
    assert.equal(match.status, 'needs_confirmation');
    assert.equal(match.strategy, 'currency_ambiguous');
    assert.equal(match.code, null);
    assert.deepEqual(match.candidates.map(item => item.code), codes);
    assert.equal(matchFundCandidate({ code: codes[0], name }, currencyCatalog).strategy, 'code');
  }
  const singleCurrency = matchFundCandidate({ name: '易方达全球成长精选混合(QDII)A' }, catalog);
  assert.equal(singleCurrency.strategy, 'currency_ambiguous');
  assert.equal(singleCurrency.fund, null);
  assert.deepEqual(singleCurrency.candidates.map(item => item.code), ['012920']);
});

test('keeps unclear foreign-currency classes visible as explicitly unclassified, not opposite RMB classes', () => {
  const name = '摩根标普500指数(QDII)C';
  const match = matchFundCandidate({ name }, currencyCatalog);
  assert.equal(match.strategy, 'currency_ambiguous');
  assert.deepEqual(match.candidates.map(item => [item.code, item.shareClassUnspecified ?? false]), [
    ['019305', false], ['017642', true], ['017643', true],
  ]);
  assert.match(match.warnings[0], /未注明份额类别/);
  assert.equal(matchFundCandidate({ code: '017642', name }, currencyCatalog).strategy, 'code_name_conflict');
});

test('allows equivalent explicit currency spelling but never silently swaps cash, wire, currency or class', () => {
  const base = '易方达全球成长精选混合(QDII)';
  assert.equal(matchFundCandidate({ name: `${base}A(人民币份额)` }, currencyCatalog).code, '012920');
  assert.equal(matchFundCandidate({ name: `${base}CNya` }, currencyCatalog).code, '012920');
  assert.equal(matchFundCandidate({ name: `${base}A美元现汇` }, currencyCatalog).code, '012921');
  assert.equal(matchFundCandidate({ name: `${base}美元现汇(A类)` }, currencyCatalog).code, '012921');
  assert.equal(matchFundCandidate({ name: `${base}A美元现钞` }, currencyCatalog).fund, null);
  assert.equal(matchFundCandidate({ code: '012920', name: `${base}美元现汇A` }, currencyCatalog).strategy, 'code_name_conflict');
  assert.equal(matchFundCandidate({ code: '012920', name: `${base}人民币C` }, currencyCatalog).strategy, 'code_name_conflict');
  assert.equal(matchFundCandidate({ code: '012920', name: `${base}人民币A美元现汇` }, currencyCatalog).strategy, 'currency_ambiguous');
  const wrongClass = matchFundCandidate({ name: `${base}美元现汇(C类)` }, currencyCatalog.filter(entry => entry.code !== '012923'));
  assert.equal(wrongClass.fund, null);
  assert.deepEqual(wrongClass.candidates, []);
  assert.equal(matchFundCandidate({ code: '025208', name: '永赢先锋半导体智选混合C' }, aliasCatalog).strategy, 'code_name_conflict');
});

test('does not collapse conflicting printed codes or conflicting catalog codes to a match', () => {
  assert.equal(extractFundCode('005844 / 005845'), null);
  assert.equal(extractFundCode('005844 / 005844'), '005844');
  const session = createFundMatchSession(catalog);
  const name = '东方人工智能主题混合A';
  assert.equal(session.match({ name }).strategy, 'exact_name');
  assert.equal(session.match({ code: '005844 005845', name }).strategy, 'code_ambiguous');
  const duplicate = [...catalog, { code: '005844', name: '不同主题混合A' }];
  assert.equal(matchFundCandidate({ code: '005844', name }, duplicate).strategy, 'code_ambiguous');
  assert.equal(matchFundCandidate({ name }, duplicate).strategy, 'code_ambiguous');
  const parsed = parseAlipayHoldingScreenshot({
    text: '支付宝 基金持有\n东方人工智能主题混合A 005844 / 005845\n持有金额 12.00\n持有收益 +2.00',
  }, catalog);
  assert.equal(parsed.holdings[0].code, null);
  assert.equal(parsed.holdings[0].match.strategy, 'code_ambiguous');
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
  assert.deepEqual(match.candidates.map(item => item.code), ['012920', '012922']);
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
