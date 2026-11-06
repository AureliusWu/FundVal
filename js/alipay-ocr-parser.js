// 支付宝基金持仓 OCR 的纯解析层。
//
// 这个文件不读取图片、不调用网络、也不写入持仓；它只把本地 OCR 的 text / blocks
// 转成供确认页使用的候选项。任何 fuzzy 匹配都仍然需要确认页的用户确认后才能同步。

// A fund code must not be part of a decimal/comma-separated amount. The
// surrounding punctuation check prevents e.g. `123456.78` from becoming code
// `123456`.
const FUND_CODE_RE = /(?:^|[^\d.,])(\d{6})(?![\d.,])/g;
const AMOUNT_TOKEN_RE = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g;
const PERCENT_TOKEN_RE = /[+-]?\d+(?:[.,]\d+)?\s*%/g;
const HOLDING_LABEL_RE = /持有(?:金额|市值|资产|收益|收益率)|累计收益(?:率)?|持仓(?:金额|市值|收益)|(?:今日|昨日)收益|收益率/;
const NAME_HINT_RE = /基金|混合|股票|债券|指数|联接|ETF|QDII|货币|LOF|FOF|理财/i;
const HEADER_RE = /^(?:支付宝|理财|基金|我的基金|持有基金|基金持有|持有|全部|筛选|搜索|总资产|昨日收益|今日收益|累计收益|持有金额|持有收益|收益率)$/;
const EXACT_ALIPAY_BRAND_RE = /支付宝|蚂蚁财富/;
const WEAK_ANT_FORTUNE_BRAND_RE = /财富/;
const FUND_HOLDING_CONTEXT_RE = /(?:我的|全部)?持有(?:基金)?|基金(?:持有|持仓)?|持仓/;
const ANT_FORTUNE_UI_ANCHORS = Object.freeze([
  /收益明细/,
  /持仓分析/,
  /交易记录/,
  /投资计划/,
  /清仓分析/,
  /基金市场/,
]);
const ANT_HOLDINGS_TABLE_RE = /金额\s*(?:[\/／|｜]\s*)?(?:昨日|今日)\s*收益[\s\S]*持有\s*收益\s*(?:[\/／|｜]\s*)?率|持有\s*收益\s*(?:[\/／|｜]\s*)?率[\s\S]*金额\s*(?:[\/／|｜]\s*)?(?:昨日|今日)\s*收益/;
const SOURCE_FALLBACK_MIN_IDENTITIES = 3;
const SOURCE_FALLBACK_MIN_FUZZY_SCORE = 0.9;
const FIELD_DEFINITIONS = [
  { key: 'holdingProfitRate', labels: /持有收益率|累计收益率|收益率/, kind: 'percent' },
  { key: 'holdingAmount', labels: /持有金额|持有市值|持有资产|持仓金额|持仓市值|当前市值/, kind: 'amount' },
  { key: 'holdingProfit', labels: /持有收益(?!率)|累计收益(?!率)|持仓收益|收益金额/, kind: 'amount' },
  { key: 'dailyProfit', labels: /今日收益|昨日收益/, kind: 'amount' }
];

function textOf(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b\ufeff]/g, '')
    .trim();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values, fallback = 16) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeBox(raw) {
  const box = raw && (raw.bbox || raw.boundingBox || raw.rect || raw.box) || {};
  const x = finite(raw && (raw.x ?? raw.left ?? box.x0 ?? box.left ?? box.x), 0);
  const y = finite(raw && (raw.y ?? raw.top ?? box.y0 ?? box.top ?? box.y), 0);
  const right = finite(raw && (raw.right ?? box.x1 ?? box.right), NaN);
  const bottom = finite(raw && (raw.bottom ?? box.y1 ?? box.bottom), NaN);
  const width = finite(raw && (raw.width ?? box.width), Number.isFinite(right) ? right - x : 0);
  const height = finite(raw && (raw.height ?? box.height), Number.isFinite(bottom) ? bottom - y : 0);
  return {
    x,
    y,
    width: Math.max(0, width),
    height: Math.max(0, height),
    right: Number.isFinite(right) ? right : x + Math.max(0, width),
    bottom: Number.isFinite(bottom) ? bottom : y + Math.max(0, height)
  };
}

function ocrText(result) {
  if (typeof result === 'string') return textOf(result);
  return textOf(result && (result.text ?? result.data?.text ?? result.rawText));
}

function sourceBlocks(result) {
  if (Array.isArray(result)) return result;
  const data = result && result.data || {};
  const lists = [result?.blocks, data.blocks, result?.words, data.words, result?.lines, data.lines];
  return lists.find(Array.isArray) || [];
}

/**
 * Convert common OCR block shapes (Tesseract words/lines/blocks and simple
 * `{ text, x, y }` fixtures) to one predictable, coordinate-preserving form.
 */
export function normalizeOcrBlocks(result) {
  const blocks = sourceBlocks(result)
    .map((raw, index) => {
      const text = textOf(raw && (raw.text ?? raw.value ?? raw.word ?? raw.line));
      if (!text) return null;
      const box = normalizeBox(raw || {});
      return { text, ...box, index };
    })
    .filter(Boolean);

  if (blocks.length) return blocks;

  return ocrText(result)
    .split('\n')
    .map((text, index) => textOf(text) ? {
      text: textOf(text), x: 0, y: index * 24, width: 0, height: 16,
      right: 0, bottom: index * 24 + 16, index
    } : null)
    .filter(Boolean);
}

function joinLineText(blocks) {
  let output = '';
  let previous = null;
  for (const block of blocks) {
    const gap = previous ? block.x - previous.right : 0;
    const addSpace = previous && gap > Math.max(12, previous.height * 0.8) &&
      /[A-Za-z0-9)]$/.test(previous.text) && /^[A-Za-z0-9(+\-]/.test(block.text);
    output += `${addSpace ? ' ' : ''}${block.text}`;
    previous = block;
  }
  return output.trim();
}

/** Group coordinate blocks into reading lines without discarding their boxes. */
export function groupOcrBlocksIntoLines(input) {
  const blocks = Array.isArray(input) && input.every(block => Number.isFinite(block?.x) && Number.isFinite(block?.y) && Number.isFinite(block?.right))
    ? input : normalizeOcrBlocks(input);
  if (!blocks.length) return [];
  const ordered = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
  const typicalHeight = median(ordered.map(block => block.height).filter(height => height > 0), 16);
  const tolerance = Math.max(8, typicalHeight * 0.75);
  const lines = [];

  for (const block of ordered) {
    const center = block.y + block.height / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs(center - last.center) <= tolerance) {
      last.blocks.push(block);
      last.center = (last.center * (last.blocks.length - 1) + center) / last.blocks.length;
      last.y = Math.min(last.y, block.y);
      last.bottom = Math.max(last.bottom, block.bottom);
      continue;
    }
    lines.push({ blocks: [block], center, y: block.y, bottom: block.bottom });
  }

  return lines.map((line, index) => {
    const lineBlocks = [...line.blocks].sort((a, b) => a.x - b.x || a.index - b.index);
    const x = Math.min(...lineBlocks.map(block => block.x));
    const right = Math.max(...lineBlocks.map(block => block.right));
    return {
      index,
      text: joinLineText(lineBlocks),
      blocks: lineBlocks,
      x,
      right,
      y: line.y,
      bottom: line.bottom,
      height: Math.max(1, line.bottom - line.y)
    };
  });
}

/**
 * Normalize fund names only for matching. It intentionally preserves share
 * class and currency suffixes such as A/C/E, 人民币A and 美元份额.
 */
export function normalizeFundName(value) {
  return textOf(value)
    .replace(/[（）]/g, char => char === '（' ? '(' : ')')
    .replace(/[【】]/g, char => char === '【' ? '[' : ']')
    .replace(/[，﹐]/g, ',')
    .replace(/\s+/g, '')
    .replace(/q\s*d\s*i\s*i/gi, 'QDII')
    .replace(/e\s*t\s*f/gi, 'ETF')
    .replace(/\(QDII\)/gi, '(QDII)')
    .replace(/\[QDII\]/gi, '[QDII]')
    .trim();
}

function fundCodeMentions(value) {
  const source = textOf(value);
  const codes = new Set();
  FUND_CODE_RE.lastIndex = 0;
  let match;
  while ((match = FUND_CODE_RE.exec(source))) {
    const code = match[1];
    const start = match.index + match[0].lastIndexOf(code);
    const before = source.slice(Math.max(0, start - 20), start);
    const after = source.slice(start + code.length, start + code.length + 8);
    // A plain six-digit number after a holding/profit label is an amount, not
    // a fund identity. A currency/sign prefix is likewise never a code.
    if (/(?:持有金额|持有市值|持有资产|持仓金额|持仓市值|当前市值|持有收益|累计收益|持仓收益|今日收益|昨日收益|收益率)\s*[：:\s¥￥+\-]*$/u.test(before)) continue;
    if (/[¥￥+\-]$/.test(before) || /^[.,]/.test(after)) continue;
    codes.add(code);
  }
  return [...codes];
}

/** Return a six-digit fund code when the source contains one distinct code. */
export function extractFundCode(value) {
  const codes = fundCodeMentions(value);
  return codes.length === 1 ? codes[0] : null;
}

function correctedNumericText(value) {
  const source = textOf(value).replace(/[，]/g, ',').replace(/[．。]/g, '.').replace(/[％]/g, '%');
  if (!/[OIlSB]/i.test(source) || !/\d/.test(source)) return { value: source, corrected: false };
  const corrected = source
    .replace(/[Oo]/g, '0')
    .replace(/[Il]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8');
  return { value: corrected, corrected: corrected !== source };
}

function parseNumberDetailsList(value, kind = 'amount') {
  const normalized = correctedNumericText(value);
  const matcher = kind === 'percent' ? PERCENT_TOKEN_RE : AMOUNT_TOKEN_RE;
  matcher.lastIndex = 0;
  const details = [];
  let match;
  while ((match = matcher.exec(normalized.value))) {
    // Do not let an amount parser consume the numeric part of a percentage.
    if (kind === 'amount' && normalized.value[match.index + match[0].length] === '%') continue;
    const token = match[0].replace(/\s/g, '');
    const cleaned = kind === 'percent' ? token.replace(/%$/, '') : token;
    const number = Number(cleaned.replace(/,/g, ''));
    if (Number.isFinite(number)) details.push({ value: number, corrected: normalized.corrected, token });
  }
  return details;
}

function parseNumberDetails(value, kind = 'amount') {
  return parseNumberDetailsList(value, kind)[0] || { value: null, corrected: false, token: '' };
}

/** Parse a signed amount or percentage. Percentages are returned in percentage points. */
export function parseAlipayNumber(value, kind = 'amount') {
  return parseNumberDetails(value, kind).value;
}

function labelMatch(text, definition) {
  const matcher = new RegExp(definition.labels.source, definition.labels.flags.replace('g', ''));
  return matcher.exec(text);
}

function hasFieldLabel(text) {
  return HOLDING_LABEL_RE.test(text);
}

function numberFromLabelledLine(line, definition) {
  const match = labelMatch(line.text, definition);
  if (!match) return null;
  const after = line.text.slice(match.index + match[0].length);
  const direct = parseNumberDetails(after, definition.kind);
  return direct.value == null ? null : direct;
}

function numberFromNearbyLine(lines, lineIndex, definition) {
  const line = lines[lineIndex];
  for (let index = lineIndex + 1; index < Math.min(lines.length, lineIndex + 3); index += 1) {
    const next = lines[index];
    if (hasFieldLabel(next.text)) break;
    if (next.y - line.bottom > Math.max(80, line.height * 4)) break;
    const detail = parseNumberDetails(next.text, definition.kind);
    if (detail.value != null) return detail;
  }
  return null;
}

function numberFromSpatialNeighbour(lines, definition) {
  const blocks = lines.flatMap(line => line.blocks);
  const typicalHeight = median(blocks.map(block => block.height).filter(height => height > 0), 16);
  const candidates = blocks
    .filter(block => !hasFieldLabel(block.text) && fundCodeMentions(block.text).length === 0)
    .map(block => ({ block, detail: parseNumberDetails(block.text, definition.kind) }))
    .filter(item => item.detail.value != null);
  let best = null;

  for (const label of blocks) {
    if (!labelMatch(label.text, definition)) continue;
    for (const candidate of candidates) {
      const sameLine = Math.abs(candidate.block.y - label.y) <= typicalHeight;
      const below = candidate.block.y >= label.y && candidate.block.y - label.bottom <= typicalHeight * 3.5;
      if (!sameLine && !below) continue;
      const horizontal = Math.abs((candidate.block.x + candidate.block.width / 2) - (label.x + label.width / 2));
      if (below && horizontal > Math.max(180, label.width * 3)) continue;
      if (sameLine && candidate.block.x + candidate.block.width < label.x - 4) continue;
      const score = Math.abs(candidate.block.y - label.y) * 3 + horizontal;
      if (!best || score < best.score) best = { ...candidate.detail, score };
    }
  }
  return best;
}

function labelsInLine(line) {
  const labels = [];
  for (const definition of FIELD_DEFINITIONS) {
    const matcher = new RegExp(definition.labels.source, 'g');
    let match;
    while ((match = matcher.exec(line.text))) {
      labels.push({ definition, start: match.index, end: match.index + match[0].length });
    }
  }
  return labels.sort((left, right) => left.start - right.start || left.end - right.end);
}

// Alipay can render a row of labels followed by a row of values. When there
// are multiple labels of the same kind, map them one-to-one in reading order;
// never reuse the first value for every label.
function numberFromPairedLabelRow(lines, lineIndex, definition) {
  const line = lines[lineIndex];
  const labels = labelsInLine(line).filter(item => item.definition.kind === definition.kind);
  if (labels.length < 2) return { header: false, detail: null };
  const position = labels.findIndex(item => item.definition.key === definition.key);
  if (position < 0) return { header: false, detail: null };
  for (let index = lineIndex + 1; index < Math.min(lines.length, lineIndex + 3); index += 1) {
    const next = lines[index];
    if (labelsInLine(next).length) break;
    if (next.y - line.bottom > Math.max(80, line.height * 4)) break;
    const details = parseNumberDetailsList(next.text, definition.kind);
    if (!details.length) continue;
    return { header: true, detail: details[position] || null };
  }
  return { header: true, detail: null };
}

function extractFields(lines) {
  const fields = {};
  const warnings = [];
  for (const definition of FIELD_DEFINITIONS) {
    let detail = null;
    let pairedHeaderSeen = false;
    for (let index = 0; index < lines.length && !detail; index += 1) {
      detail = numberFromLabelledLine(lines[index], definition);
    }
    for (let index = 0; index < lines.length && !detail; index += 1) {
      const paired = numberFromPairedLabelRow(lines, index, definition);
      pairedHeaderSeen ||= paired.header;
      detail = paired.detail;
    }
    // A common Alipay layout uses a row of field labels followed by a row of
    // values. Prefer x/y proximity before a text-only next-line fallback so
    // the first amount cannot be assigned to every label in the header row.
    if (!detail && !pairedHeaderSeen) {
      detail = numberFromSpatialNeighbour(lines, definition);
      for (let index = 0; index < lines.length && !detail; index += 1) {
        if (labelMatch(lines[index].text, definition)) detail = numberFromNearbyLine(lines, index, definition);
      }
    }
    fields[definition.key] = detail ? detail.value : null;
    if (detail?.corrected) warnings.push(`${definition.key}: 已按数字上下文纠正 OCR 字符`);
    if (!detail && pairedHeaderSeen) warnings.push(`${definition.key}: 标签和值无法一一对应，等待人工核对`);
  }
  return { fields, warnings };
}

// The current Ant Fortune (支付宝生态) holdings list uses a compact two-column
// layout: `金额/昨日收益` and `持有收益/率`. Individual rows often have no
// repeated field labels, so only when that exact page header is present do we
// map the card's reading-order values to its four visible slots.
function extractAntTableFields(lines, catalog) {
  const amounts = [];
  const percentages = [];
  for (const line of lines) {
    if (lineLooksLikeName(line, catalog) || hasFieldLabel(line.text)) continue;
    let value = line.text;
    for (const code of fundCodeMentions(value)) value = value.replaceAll(code, ' ');
    amounts.push(...parseNumberDetailsList(value, 'amount'));
    percentages.push(...parseNumberDetailsList(value, 'percent'));
  }
  return {
    holdingAmount: amounts[0] || null,
    holdingProfit: amounts[1] || null,
    dailyProfit: amounts[2] || null,
    holdingProfitRate: percentages[0] || null,
  };
}

function mergeTableFields(fields, warnings, lines, catalog, tableLayout) {
  if (!tableLayout) return { fields, warnings };
  const table = extractAntTableFields(lines, catalog);
  let derived = false;
  for (const key of Object.keys(table)) {
    if (fields[key] == null && table[key]) {
      fields[key] = table[key].value;
      if (table[key].corrected) warnings.push(`${key}: 已按数字上下文纠正 OCR 字符`);
      derived = true;
    }
  }
  if (derived) warnings.push('按蚂蚁财富列表列顺序解析金额/收益，请在确认页核对');
  return { fields, warnings };
}

function cleanNamePart(value) {
  let text = textOf(value)
    .replace(/(?<![\d.,])\d{6}(?![\d.,])/g, ' ')
    .replace(/[¥￥]\s*[+\-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g, ' ')
    .replace(/[+\-](?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g, ' ')
    .replace(PERCENT_TOKEN_RE, ' ')
    .replace(HOLDING_LABEL_RE, ' ')
    .replace(/(?:净值|估值|详情|查看|展开|收起|份额|金额|收益|持有|累计|昨日|今日|定投|我的)/g, ' ')
    .replace(/[：:|·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = text.replace(/\s+/g, '');
  const alipayHeader = /^(?:支付宝|蚂蚁财富)(?:理财|基金|持有|持仓|资产)*$/.test(compact);
  if (!text || HEADER_RE.test(compact) || alipayHeader || !/[\u3400-\u9fffA-Za-z]/.test(text)) return '';
  return text;
}

function catalogEntry(value) {
  const code = textOf(value && (value.code ?? value.fundCode ?? value.fund_code));
  const name = textOf(value && (value.name ?? value.fundName ?? value.fund_name ?? value.title));
  if (!/^\d{6}$/.test(code) || !name) return null;
  return { code, name, normalizedName: normalizeFundName(name) };
}

const fundMatchIndexCache = new WeakMap();

function normalizedCatalogEntries(fundCatalog) {
  const unique = new Map();
  for (const value of Array.isArray(fundCatalog) ? fundCatalog : []) {
    const entry = catalogEntry(value);
    if (entry) {
      const key = `${entry.code}\u0000${entry.normalizedName}`;
      if (!unique.has(key)) unique.set(key, entry);
    }
  }
  return [...unique.values()];
}

// These are exact public product identities, not general word-deletion rules.
// Sources: CCB Fund's 018147 product summary, Maxwealth's 025208/025209
// offering notice, and Huatai-PineBridge's 008528/011452 fund disclosures.
// Require the matching code AND catalog spelling before trusting an alias.
const VERIFIED_ALIASES = new Map([
  ['建信新兴市场优选混合(QDII)A', ['539002', '建信新兴市场混合(QDII)A']],
  ['建信新兴市场优选混合(QDII)C', ['018147', '建信新兴市场混合(QDII)C']],
  ['永赢先锋半导体智选混合A', ['025208', '永赢先锋半导体智选混合发起A']],
  ['永赢先锋半导体智选混合C', ['025209', '永赢先锋半导体智选混合发起C']],
  ['华泰柏瑞质量成长混合A', ['008528', '华泰柏瑞质量成长A']],
  ['华泰柏瑞质量成长混合C', ['011452', '华泰柏瑞质量成长C']],
]);

const CURRENCY_CODES = new Map([
  ['人民币', 'CNY'], ['CNY', 'CNY'], ['RMB', 'CNY'],
  ['美元', 'USD'], ['USD', 'USD'],
  ['美元现汇', 'USD_WIRE'], ['美汇', 'USD_WIRE'],
  ['美元现钞', 'USD_CASH'], ['美钞', 'USD_CASH'],
  ['港币', 'HKD'], ['港元', 'HKD'], ['HKD', 'HKD'],
  ['欧元', 'EUR'], ['EUR', 'EUR'], ['日元', 'JPY'], ['JPY', 'JPY'],
  ['英镑', 'GBP'], ['GBP', 'GBP'], ['新加坡元', 'SGD'], ['SGD', 'SGD'],
]);
const CURRENCY_TOKEN = [...CURRENCY_CODES.keys()].sort((a, b) => b.length - a.length).join('|');
const CURRENCY_SUFFIX = new RegExp(`(?:\\((${CURRENCY_TOKEN})(?:份额)?\\)|(${CURRENCY_TOKEN})(?:份额)?)$`, 'i');

function splitCurrencySuffix(name) {
  const match = CURRENCY_SUFFIX.exec(name);
  return match
    ? { base: name.slice(0, match.index), currency: CURRENCY_CODES.get((match[1] || match[2]).toUpperCase()) }
    : { base: name, currency: null };
}

function nameIdentity(normalizedName) {
  const after = splitCurrencySuffix(normalizedName);
  const share = /(?:\(([A-Z])(?:类|份额)?\)|(?:份额)?([A-Z])(?:类|份额)?)$/i.exec(after.base);
  const possibleBase = share && after.base.slice(0, share.index);
  // Do not treat the final letter of ETF, QDII, or an English word as a class.
  const hasClass = possibleBase && (!/[A-Za-z]$/.test(possibleBase)
    || /(?:ETF|LOF|QDII|FOF)$/i.test(possibleBase) || splitCurrencySuffix(possibleBase).currency);
  const before = splitCurrencySuffix(hasClass ? possibleBase : after.base);
  return {
    baseName: before.base,
    shareClass: hasClass ? (share[1] || share[2]).toUpperCase() : null,
    currency: after.currency || before.currency,
    currencyConflict: Boolean(after.currency && before.currency && after.currency !== before.currency),
  };
}

function searchName(value) {
  return normalizeFundName(value).toUpperCase();
}

function trigramTokens(value) {
  const source = searchName(value);
  if (!source) return [];
  if (source.length <= 3) return [source];
  const tokens = new Set();
  for (let index = 0; index <= source.length - 3; index += 1) {
    tokens.add(source.slice(index, index + 3));
  }
  return [...tokens];
}

function appendMapList(map, key, value) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

/**
 * Build the local-only OCR matching index once per catalog array. The index
 * contains fund identity only; it never receives OCR text, amounts or images.
 */
export function buildFundMatchIndex(fundCatalog) {
  if (fundCatalog?.kind === 'fund-match-index') return fundCatalog;
  if (Array.isArray(fundCatalog) && fundMatchIndexCache.has(fundCatalog)) {
    return fundMatchIndexCache.get(fundCatalog);
  }
  const entries = normalizedCatalogEntries(fundCatalog).map(entry => ({
    ...entry,
    searchName: searchName(entry.normalizedName),
    ...nameIdentity(entry.normalizedName),
  }));
  const byCode = new Map();
  const entriesByCode = new Map();
  const byBaseName = new Map();
  const byExactNormalizedName = new Map();
  const byBaseNameAndShareClass = new Map();
  const byShareClass = new Map();
  const trigramIndex = new Map();
  for (const entry of entries) {
    appendMapList(entriesByCode, entry.code, entry);
    appendMapList(byExactNormalizedName, entry.normalizedName, entry);
    appendMapList(byBaseName, entry.baseName, entry);
    appendMapList(byBaseNameAndShareClass, `${entry.baseName}\u0000${entry.shareClass || ''}`, entry);
    appendMapList(byShareClass, entry.shareClass || '', entry);
    for (const token of trigramTokens(entry.searchName)) {
      const matches = trigramIndex.get(token) || new Set();
      matches.add(entry);
      trigramIndex.set(token, matches);
    }
  }
  const conflictingCodes = new Set();
  for (const [code, matches] of entriesByCode) {
    if (matches.length > 1 || matches[0].currencyConflict) conflictingCodes.add(code);
    else byCode.set(code, matches[0]);
  }
  const index = Object.freeze({
    kind: 'fund-match-index',
    entries: Object.freeze(entries),
    byCode,
    conflictingCodes,
    byBaseName,
    byExactNormalizedName,
    byBaseNameAndShareClass,
    byShareClass,
    trigramIndex,
  });
  if (Array.isArray(fundCatalog)) fundMatchIndexCache.set(fundCatalog, index);
  fundMatchIndexCache.set(index.entries, index);
  return index;
}

function normalizedCatalog(fundCatalog) {
  return buildFundMatchIndex(fundCatalog).entries;
}

function fuzzyCandidatePool(index, normalizedName, identity, maximum) {
  const tokens = trigramTokens(normalizedName);
  if (!tokens.length) return [];
  const counts = new Map();
  for (const token of tokens) {
    for (const entry of index.trigramIndex.get(token) || []) {
      if (index.conflictingCodes.has(entry.code)
        || (identity.shareClass && entry.shareClass !== identity.shareClass)
        || (identity.currency && entry.currency !== identity.currency)) continue;
      counts.set(entry, (counts.get(entry) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([entry, overlap]) => ({
      entry,
      overlap,
      lengthDistance: Math.abs(entry.searchName.length - searchName(normalizedName).length),
    }))
    .sort((left, right) => right.overlap - left.overlap
      || left.lengthDistance - right.lengthDistance
      || left.entry.code.localeCompare(right.entry.code))
    .slice(0, maximum)
    .map(item => item.entry);
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left, right) {
  const longest = Math.max(left.length, right.length, 1);
  return 1 - levenshtein(left, right) / longest;
}

/** Match a local catalog identity without conflating share class or currency. */
export function matchFundCandidate(candidate, fundCatalog, options = {}) {
  const index = options.index?.kind === 'fund-match-index'
    ? options.index
    : buildFundMatchIndex(fundCatalog);
  const catalog = index.entries;
  const codes = fundCodeMentions(candidate?.code);
  const code = codes.length === 1 ? codes[0] : null;
  const name = textOf(candidate?.name);
  const normalizedName = normalizeFundName(name);
  const identity = nameIdentity(normalizedName);
  const exact = index.byExactNormalizedName.get(normalizedName) || [];
  const aliasFingerprint = VERIFIED_ALIASES.get(normalizedName);
  const aliasEntry = aliasFingerprint && index.byCode.get(aliasFingerprint[0]);
  const alias = aliasEntry && aliasEntry.normalizedName === aliasFingerprint[1] ? aliasEntry : null;
  const verifiedLiteral = aliasFingerprint && exact.find(entry => entry.code === aliasFingerprint[0]);
  const classKey = `${identity.baseName}\u0000${identity.shareClass}`;
  const classIdentities = identity.shareClass
    ? (index.byBaseNameAndShareClass.get(classKey) || []).filter(entry => entry.currency === identity.currency)
    : [];
  const family = (index.byBaseName.get(alias?.baseName ?? identity.baseName) || [])
    .filter(entry => !identity.shareClass || entry.shareClass === identity.shareClass
      || (!entry.shareClass && entry.currency));
  const unmarkedCurrency = !identity.currency && identity.shareClass && family.some(entry => entry.currency)
    && (family.length > 1 || !exact.length);

  const toCandidate = ({ code: itemCode, name: itemName, score, shareClass, currency }) => ({
    code: itemCode,
    name: itemName,
    ...(score == null ? {} : { score: Number(score.toFixed(3)) }),
    ...(!shareClass && currency ? { shareClassUnspecified: true } : {}),
  });
  const reviewed = (strategy, entries, warning) => ({
    status: 'needs_confirmation', strategy, code: null, name: null, fund: null,
    candidates: [...new Map(entries.filter(entry => !index.conflictingCodes.has(entry.code))
      .map(entry => [entry.code, toCandidate(entry)])).values()],
    warnings: [warning],
  });
  const matched = (strategy, entry, warnings = []) => {
    const fund = toCandidate(entry);
    return { status: 'matched', strategy, code: fund.code, name: fund.name, fund, candidates: [fund], warnings };
  };
  const names = [...new Set([...exact, ...classIdentities, ...(alias ? [alias] : [])])];
  const nameCandidates = unmarkedCurrency ? [...new Set([...names, ...family])] : names;

  if (codes.length > 1 || (code && index.conflictingCodes.has(code))
    || (!code && nameCandidates.some(entry => index.conflictingCodes.has(entry.code)))) {
    return reviewed('code_ambiguous', [], '识别到多个不同基金代码或基金目录代码不唯一，未自动选择');
  }
  if (identity.currencyConflict) {
    return reviewed('currency_ambiguous', [], 'OCR 名称中币种互相冲突，请核对原平台基金代码');
  }
  if ((alias || verifiedLiteral) && exact.some(entry => entry.code !== aliasFingerprint[0])) {
    return reviewed('exact_name_ambiguous', names, '基金目录中的同名候选与已验证简称冲突，请核对');
  }
  if (aliasFingerprint && !alias && !verifiedLiteral) {
    return reviewed(code ? 'code_name_conflict' : 'alias_unverified', [], '当前基金目录无法验证此简称和基金代码，请核对');
  }

  if (code) {
    const codeMatch = index.byCode.get(code);
    if (!codeMatch) {
      return reviewed('code_not_found', nameCandidates, 'OCR 识别到的基金代码不在基金库中，未自动改用名称匹配');
    }
    const codeResolvesCurrency = unmarkedCurrency && codeMatch.shareClass === identity.shareClass
      && family.includes(codeMatch);
    if (!normalizedName || names.includes(codeMatch) || codeResolvesCurrency) {
      return matched('code', codeMatch);
    }
    // Do not offer an incompatible class or currency under the conflicting
    // code; the user must explicitly verify it against the source.
    return reviewed('code_name_conflict', nameCandidates, 'OCR 基金代码与名称、份额类别或币种无法互相验证，请核对');
  }

  if (!normalizedName) {
    return { status: 'unmatched', strategy: 'none', code: null, name: null, fund: null, candidates: [], warnings: ['未识别到基金代码或基金名称'] };
  }

  if (unmarkedCurrency) {
    const unclassified = nameCandidates.some(entry => !entry.shareClass && entry.currency);
    return reviewed('currency_ambiguous', nameCandidates, unclassified
      ? '截图未注明币种；部分外币目录候选未注明份额类别，请按原平台基金代码核对'
      : '截图未注明币种，请按原平台基金代码核对人民币或外币份额');
  }
  if (names.length > 1) {
    return reviewed('exact_name_ambiguous', names, '基金名称和份额类别存在多个精确候选');
  }
  if (exact.length === 1 || classIdentities.length === 1) {
    return matched('exact_name', exact[0] || classIdentities[0]);
  }
  if (alias) return matched('verified_alias', alias);

  const threshold = Number.isFinite(options.fuzzyThreshold) ? options.fuzzyThreshold : 0.72;
  const ambiguityGap = Number.isFinite(options.ambiguityGap) ? options.ambiguityGap : 0.08;
  const maximum = Math.max(16, Math.min(256, Number(options.maxFuzzyCandidates) || 96));
  const narrowed = fuzzyCandidatePool(index, normalizedName, identity, maximum);
  if (options.metrics && typeof options.metrics === 'object') {
    options.metrics.catalogSize = catalog.length;
    options.metrics.fuzzyCandidateCount = narrowed.length;
    options.metrics.levenshteinComparisons = narrowed.length;
  }
  const fuzzy = narrowed
    .map(item => ({ ...item, score: similarity(normalizedName, item.normalizedName) }))
    .filter(item => item.score >= threshold)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  if (!fuzzy.length) {
    return { status: 'unmatched', strategy: 'none', code: null, name: null, fund: null, candidates: [], warnings: ['基金名称未匹配到基金库'] };
  }

  const closeCandidates = fuzzy.filter(item => item.score >= fuzzy[0].score - ambiguityGap);
  if (closeCandidates.length > 1) {
    return {
      status: 'needs_confirmation', strategy: 'fuzzy_ambiguous', code: null, name: null, fund: null, candidates: closeCandidates.map(toCandidate),
      warnings: ['多个基金名称相似候选，未自动选择']
    };
  }
  return matched('fuzzy', fuzzy[0], ['基金名称为 OCR 模糊匹配，请在确认页核对']);
}

/** A bounded in-memory memo for one OCR confirmation session. */
export function createFundMatchSession(fundCatalog, options = {}) {
  const index = buildFundMatchIndex(fundCatalog);
  const memo = new Map();
  const memoLimit = Math.max(16, Math.min(512, Number(options.memoLimit) || 128));
  const stats = {
    queries: 0,
    memoHits: 0,
    levenshteinComparisons: 0,
    lastFuzzyCandidateCount: 0,
  };
  return Object.freeze({
    index,
    match(candidate) {
      stats.queries += 1;
      const key = `${fundCodeMentions(candidate?.code).sort().join(',')}\u0000${normalizeFundName(candidate?.name)}`;
      if (memo.has(key)) {
        stats.memoHits += 1;
        return memo.get(key);
      }
      const metrics = {};
      const result = matchFundCandidate(candidate, index.entries, { ...options, index, metrics });
      stats.levenshteinComparisons += metrics.levenshteinComparisons || 0;
      stats.lastFuzzyCandidateCount = metrics.fuzzyCandidateCount || 0;
      if (memo.size >= memoLimit) memo.delete(memo.keys().next().value);
      memo.set(key, result);
      return result;
    },
    metrics() {
      return Object.freeze({ ...stats, memoSize: memo.size, catalogSize: index.entries.length });
    },
    clear() {
      memo.clear();
    },
  });
}

function lineLooksLikeName(line, catalog) {
  const clean = cleanNamePart(line.text);
  if (!clean) return false;
  const normalized = normalizeFundName(clean);
  return NAME_HINT_RE.test(clean) || catalog.some(item => item.normalizedName === normalized || item.normalizedName.includes(normalized) || normalized.includes(item.normalizedName));
}

function identityCodesAt(lines, index, catalog) {
  const line = lines[index];
  if (!line || hasFieldLabel(line.text)) return [];
  const codes = fundCodeMentions(line.text);
  if (!codes.length) return [];
  const previous = lines[index - 1];
  // A bare six-digit number directly below a value label is an amount. It is
  // not allowed to start a new holding card or override a name match.
  if (previous && hasFieldLabel(previous.text) && !lineLooksLikeName(line, catalog)) return [];
  return codes;
}

function extractIdentityFundCodes(lines, catalog) {
  const codes = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    for (const code of identityCodesAt(lines, index, catalog)) codes.add(code);
  }
  return [...codes];
}

function cardStartIndexes(lines, catalog) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (identityCodesAt(lines, index, catalog).length) {
      const previous = lines[index - 1];
      starts.push(previous && lineLooksLikeName(previous, catalog) ? index - 1 : index);
      continue;
    }
    if (lineLooksLikeName(line, catalog)) starts.push(index);
  }
  return [...new Set(starts)].sort((a, b) => a - b).filter((index, position, all) => position === 0 || index - all[position - 1] > 1);
}

/**
 * Split a vertical Alipay list into cards. Explicit fund-code/name anchors are
 * preferred; vertical gaps offer a conservative fallback for OCR layouts with
 * no code text.
 */
export function groupOcrBlocksIntoCards(input, fundCatalog = []) {
  const lines = Array.isArray(input) && input[0]?.blocks ? input : groupOcrBlocksIntoLines(input);
  if (!lines.length) return [];
  const catalog = normalizedCatalog(fundCatalog);
  const starts = cardStartIndexes(lines, catalog);
  if (starts.length) {
    return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length));
  }

  const typicalHeight = median(lines.map(line => line.height), 16);
  const cards = [];
  let current = [];
  for (const line of lines) {
    const previous = current[current.length - 1];
    if (previous && line.y - previous.bottom > typicalHeight * 2.8) {
      cards.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) cards.push(current);
  return cards;
}

function extractName(lines, catalog) {
  const fragments = [];
  for (const line of lines) {
    if (hasFieldLabel(line.text)) break;
    const clean = cleanNamePart(line.text);
    if (!clean) continue;
    const normalized = normalizeFundName(clean);
    if (catalog.some(item => item.normalizedName === normalized)) return clean;
    fragments.push(clean);
    if (fragments.length >= 3) break;
  }
  if (!fragments.length) return '';
  // Wrapped Chinese names often arrive as two successive OCR lines. Preserve
  // the visual text, while matching uses the whitespace-insensitive normalizer.
  return fragments.join('');
}

function parseCard(lines, catalog, options) {
  const codes = extractIdentityFundCodes(lines, catalog);
  const code = codes.length === 1 ? codes[0] : null;
  const name = extractName(lines, catalog);
  if (!codes.length && !name) return null;
  const base = extractFields(lines);
  const { fields, warnings } = mergeTableFields(base.fields, base.warnings, lines, catalog, options.tableLayout === true);
  const match = matchFundCandidate({ code: codes.join(' '), name }, catalog, options);
  return {
    code,
    name: name || null,
    rawFundName: name || null,
    normalizedName: name ? normalizeFundName(name) : '',
    ...fields,
    match,
    warnings: [...warnings, ...match.warnings],
    bbox: {
      x: Math.min(...lines.map(line => line.x)),
      y: Math.min(...lines.map(line => line.y)),
      right: Math.max(...lines.map(line => line.right)),
      bottom: Math.max(...lines.map(line => line.bottom))
    }
  };
}

function hasAntHoldingsTableSignature(text) {
  return ANT_HOLDINGS_TABLE_RE.test(textOf(text));
}

function sourceTextFromBlocks(result, blocks) {
  return [ocrText(result), ...blocks.map(block => block.text)].join('\n');
}

/**
 * Build candidate holdings before the final source decision. This is safe because
 * it is pure local parsing/matching: no image, raw text, or holding is written
 * anywhere. The source gate below is still authoritative for the returned list.
 */
function deriveHoldingCandidates(result, fundCatalog, options = {}) {
  const blocks = normalizeOcrBlocks(result);
  const lines = groupOcrBlocksIntoLines(blocks);
  const catalog = normalizedCatalog(fundCatalog);
  const text = sourceTextFromBlocks(result, blocks);
  const tableLayout = hasAntHoldingsTableSignature(text);
  const cards = groupOcrBlocksIntoCards(lines, catalog);
  const holdings = cards.map(card => parseCard(card, catalog, { ...options, tableLayout })).filter(Boolean);
  return { blocks, lines, catalog, text, tableLayout, holdings };
}

function highConfidenceCatalogIdentityCodes(holdings) {
  const codes = new Set();
  for (const holding of holdings) {
    const match = holding?.match;
    if (match?.status !== 'matched' || !/^\d{6}$/.test(match.code || '')) continue;
    if (['code', 'exact_name', 'verified_alias'].includes(match.strategy)) {
      codes.add(match.code);
      continue;
    }
    // Match display scores are rounded to three decimals. Recompute from the
    // normalized identity so a 0.8996 score cannot round up and pass this
    // conservative source gate.
    const fuzzyScore = similarity(holding.normalizedName, normalizeFundName(match.fund?.name));
    if (match.strategy === 'fuzzy' && fuzzyScore >= SOURCE_FALLBACK_MIN_FUZZY_SCORE) {
      codes.add(match.code);
    }
  }
  return [...codes];
}

function detectAlipayHoldingCandidateContext(context) {
  const text = context.text;
  if (!text.trim()) return { supported: false, source: 'empty', reason: 'no_text' };

  const hasExactBrand = EXACT_ALIPAY_BRAND_RE.test(text);
  const hasFundHoldingContext = FUND_HOLDING_CONTEXT_RE.test(text);
  if (hasExactBrand && hasFundHoldingContext) {
    return { supported: true, source: 'alipay', reason: 'text_signature' };
  }

  // Some low-resolution Ant Fortune captures lose “蚂蚁” during local OCR and
  // retain only “财富”. Accept that weak clue only when three independent,
  // high-confidence catalog identities and both column headers corroborate it.
  const identityCodes = highConfidenceCatalogIdentityCodes(context.holdings);
  const weakAntFortuneFallback = !hasExactBrand &&
    WEAK_ANT_FORTUNE_BRAND_RE.test(text) &&
    hasFundHoldingContext &&
    context.tableLayout &&
    identityCodes.length >= SOURCE_FALLBACK_MIN_IDENTITIES;
  if (weakAntFortuneFallback) {
    return {
      supported: true,
      source: 'ant_fortune_fallback',
      reason: 'weak_brand_table_catalog_identities',
      identityCount: identityCodes.length
    };
  }

  // Compressed long captures sometimes lose the small brand word while still
  // retaining Ant Fortune's distinctive navigation cluster. This fallback is
  // intentionally conjunctive: a valid three-column holdings table, at least
  // three independent catalog identities, the holding-page context, and two
  // separate Ant UI anchors must all agree. Generic portfolio screenshots do
  // not pass on catalog matches alone.
  const antUiAnchorCount = ANT_FORTUNE_UI_ANCHORS.filter(pattern => pattern.test(text)).length;
  const structuredAntPageFallback = !hasExactBrand &&
    hasFundHoldingContext &&
    context.tableLayout &&
    identityCodes.length >= SOURCE_FALLBACK_MIN_IDENTITIES &&
    antUiAnchorCount >= 2;
  if (structuredAntPageFallback) {
    return {
      supported: true,
      source: 'ant_fortune_layout',
      reason: 'distinctive_ui_table_catalog_identities',
      identityCount: identityCodes.length,
      uiAnchorCount: antUiAnchorCount,
    };
  }

  return { supported: false, source: 'unsupported', reason: 'not_alipay_holding' };
}

/**
 * Validate source evidence already reconstructed by a coordinate OCR engine.
 * The caller supplies only in-memory OCR tokens and matched preview rows; this
 * helper performs no network, storage, or image operation.
 */
export function detectAlipayHoldingSourceEvidence({ tokens = [], holdings = [], tableLayout = false } = {}) {
  const text = (Array.isArray(tokens) ? tokens : [])
    .map(token => textOf(token && token.text))
    .filter(Boolean)
    .join('\n');
  return detectAlipayHoldingCandidateContext({ text, holdings, tableLayout: tableLayout === true });
}

/**
 * Strict source gate: only OCR text and local catalog matches may identify an
 * Alipay/Ant Fortune holding page. `source`/`sourceHint` fields are ignored.
 */
export function detectAlipayHoldingOcr(result, fundCatalog = [], options = {}) {
  return detectAlipayHoldingCandidateContext(deriveHoldingCandidates(result, fundCatalog, options));
}

/**
 * Parse an Alipay fund-holding OCR result. This function is deliberately pure:
 * it never uploads the image/OCR content and it never writes FundVal holdings.
 */
export function parseAlipayHoldingScreenshot(result, fundCatalog = [], options = {}) {
  const candidates = deriveHoldingCandidates(result, fundCatalog, options);
  const detection = detectAlipayHoldingCandidateContext(candidates);
  if (!detection.supported) {
    return {
      ...detection,
      holdings: [],
      warnings: [detection.source === 'empty' ? '未识别到有效文字' : '未识别到支付宝基金持仓截图']
    };
  }

  return {
    ...detection,
    holdings: candidates.holdings,
    warnings: candidates.holdings.length ? [] : ['未识别到支付宝基金持仓条目']
  };
}

export class AlipayHoldingParser {
  constructor({ fundCatalog = [], ...options } = {}) {
    this.fundCatalog = fundCatalog;
    this.options = options;
  }

  parse(result, fundCatalog = this.fundCatalog, options = {}) {
    return parseAlipayHoldingScreenshot(result, fundCatalog, { ...this.options, ...options });
  }
}
