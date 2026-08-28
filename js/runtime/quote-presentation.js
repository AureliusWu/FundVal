import {
  normalizeConfidence,
  parseQuoteTimestamp,
  quoteStatusLabel,
  quoteValueKindLabel,
} from './quote-contract.js';

const STATUS_LABELS = Object.freeze({
  realtime: '实时',
  delayed: '延迟',
  model: '模型估算',
  official: '正式净值',
  stale: '旧数据',
  unavailable: '暂不可用',
});

const SOURCE_LABELS = Object.freeze({
  'sinan-estimate-proxy': '盘中估值服务',
  'eastmoney-official-nav': '最新正式净值',
  'eastmoney-security-quote': '证券行情备源',
  'tencent-market-quote': '市场行情备源',
  'market-model': '下一净值海外模型',
  'quarterly-holdings-model': '十大重仓穿透模型',
  'local-cache': '本地缓存',
  unavailable: '无可用数据源',
  unknown: '未知数据源',
});

const MARKET_LABELS = Object.freeze({
  cn: '中国内地',
  hk: '香港',
  us: '美国',
  jp: '日本',
  kr: '韩国',
  gold: '黄金',
  qdii: 'QDII 底层市场',
  unknown: '未知市场',
});

const REASON_LABELS = Object.freeze({
  MISSING_QUOTE_VALUE: '数据源未返回可用数值',
  SOURCE_TIME_IN_FUTURE: '数据源时间异常',
  OFFICIAL_NAV_FALLBACK: '盘中估值不可用，显示正式净值',
  LATEST_PUBLISHED_NAV: '显示最近公布的正式净值',
  MODEL_ESTIMATE: '使用下一净值模型估算',
  HOLDINGS_LOOKTHROUGH: '使用已披露重仓估算',
  REFRESH_FAILED: '本轮刷新失败，保留上次结果',
  NO_QUOTE_CANDIDATE: '没有可用估值来源',
  LEGACY_CACHE_MISSING_QUOTE: '旧缓存缺少可信行情',
  CACHE_EXPIRED: '本地缓存已经过期',
  CACHE_FRESH_TTL: '使用有效期内的本地缓存',
  CACHE_SOURCE_STALE: '缓存中的源行情已经过期',
  SOURCE_TIME_DATE_ONLY: '数据源只提供净值日期',
  SOURCE_TIME_MISSING: '数据源未提供行情时间，无法确认新鲜度',
  SOURCE_TIME_UNPARSEABLE: '数据源行情时间无法解析',
  SOURCE_TIME_EXPIRED: '行情时间已过期',
  SOURCE_TIME_DELAYED: '行情时间已超过实时更新窗口',
  SOURCE_NOT_REALTIME: '数据源未声明为实时行情',
  SOURCE_MARKED_STALE: '数据源已明确标记该行情过期',
  MARKET_NOT_OPEN: '当前市场不在连续交易时段',
});

function finiteNow(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function chinaParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: String(values.hour || '00').padStart(2, '0'),
    minute: String(values.minute || '00').padStart(2, '0'),
    second: String(values.second || '00').padStart(2, '0'),
  };
}

function dateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dateDayIndex(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function timestampOf(value) {
  const quoteTimestamp = parseQuoteTimestamp(value);
  if (quoteTimestamp != null) return quoteTimestamp;
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatQuoteDateTime(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const timestamp = timestampOf(text);
  if (timestamp == null) return '--';
  const parts = chinaParts(timestamp);
  return `${dateKey(parts)} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatQuoteDataTime(quote, { now = Date.now() } = {}) {
  if (quote?.status === 'official' || quote?.valueKind === 'official_nav') {
    return String(quote?.officialNavDate || '').trim() || '--';
  }
  const raw = String(quote?.observedAt || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const timestamp = timestampOf(raw);
  if (timestamp == null) return '--';
  const source = chinaParts(timestamp);
  const current = chinaParts(finiteNow(now));
  const difference = dateDayIndex(current) - dateDayIndex(source);
  const clock = `${source.hour}:${source.minute}`;
  if (difference === 0) return clock;
  if (difference === 1) return `昨日 ${clock}`;
  return `${dateKey(source)} ${clock}`;
}

export function quoteConfidenceLabel(value) {
  const normalized = normalizeConfidence(value);
  if (normalized == null) return '未知';
  if (normalized >= 0.8) return '高';
  if (normalized >= 0.5) return '中';
  return '低';
}

export function quoteCoverageLabel(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return '未知';
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) return '未知';
  const rounded = Math.round(number * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function quoteReasonSummary(reasonCodes, status = 'unavailable') {
  const labels = [];
  for (const reason of Array.isArray(reasonCodes) ? reasonCodes : []) {
    const code = String(reason || '').trim().toUpperCase();
    let label = REASON_LABELS[code];
    if (!label && code.startsWith('CACHED_FROM_')) label = '当前显示来自本地缓存';
    if (!label && code.startsWith('REMOTE_')) label = '远端数据暂不可用';
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (!labels.length) {
    if (status === 'delayed') return '当前行情不是实时更新，时间仅供参考';
    if (status === 'stale') return '行情时间已过期，当前显示仅供参考';
    if (status === 'unavailable') return '无可用数据源';
    return '无降级原因';
  }
  return `${labels.slice(0, 2).join('；')}${labels.length > 2 ? '等' : ''}`;
}

function modelLike(quote) {
  return quote?.status === 'model'
    || ['model_estimate', 'holding_lookthrough_estimate'].includes(quote?.valueKind);
}

export function createQuotePresentation(quote, { now = Date.now() } = {}) {
  const safeQuote = quote && typeof quote === 'object' ? quote : {};
  const status = STATUS_LABELS[safeQuote.status] ? safeQuote.status : 'unavailable';
  const isModel = modelLike(safeQuote);
  const coverage = safeQuote.coverage == null ? null : quoteCoverageLabel(safeQuote.coverage);
  const confidence = safeQuote.confidence == null ? null : quoteConfidenceLabel(safeQuote.confidence);
  const trustParts = [];
  if (coverage != null || isModel) trustParts.push(`覆盖率 ${coverage || '未知'}`);
  if (confidence != null || isModel) trustParts.push(`置信度 ${confidence || '未知'}`);
  if (!trustParts.length && status === 'official') trustParts.push('基金公司已公布');
  if (!trustParts.length && status === 'stale') trustParts.push('当前数据源未更新');
  if (!trustParts.length && status === 'unavailable') trustParts.push('无可用数据源');

  const officialNavDate = String(safeQuote.officialNavDate || '').trim() || null;
  const sourceId = String(safeQuote.sourceId || 'unknown').trim() || 'unknown';
  const reasonSummary = quoteReasonSummary(safeQuote.reasonCodes, status);
  const kindLabel = status === 'unavailable'
    ? '暂不可估值'
    : quoteValueKindLabel(safeQuote.valueKind);

  return Object.freeze({
    status,
    statusClass: `status-${status}`,
    statusLabel: STATUS_LABELS[status] || quoteStatusLabel(status),
    kindLabel,
    dataTimeLabel: formatQuoteDataTime(safeQuote, { now }),
    sourceTimeLabel: formatQuoteDateTime(safeQuote.observedAt),
    fetchedTimeLabel: formatQuoteDateTime(safeQuote.fetchedAt),
    officialNavDate,
    coverageLabel: coverage,
    confidenceLabel: confidence,
    trustText: trustParts.join(' · '),
    sourceLabel: SOURCE_LABELS[sourceId] || '其他数据源',
    marketLabel: MARKET_LABELS[safeQuote.market] || MARKET_LABELS.unknown,
    reasonSummary,
    modelVersion: String(safeQuote.modelVersion || '').trim() || null,
    targetNavLabel: isModel ? `下一公布日${officialNavDate ? `（基于 ${officialNavDate} 正式净值）` : ''}` : null,
  });
}
