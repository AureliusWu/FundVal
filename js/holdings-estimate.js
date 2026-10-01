import { normalizeQuoteDate, nullableNumber, parseQuoteTimestamp } from './runtime/quote-contract.js';
import { chinaDateKey, isSingleMarketSession } from './runtime/market-clock.js';
import { validateHoldingSet } from './runtime/holding-set-contract.js';

const MIN_COVERAGE = 50;
const MIN_QUOTES = 5;
const MAX_REPORT_AGE_MS = 185 * 24 * 60 * 60 * 1000;

export function formatChinaQuoteTime(timestampSeconds) {
  const timestamp = Number(timestampSeconds) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) return '';
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

export function parseTencentQuoteTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : '';
}

function localTimeInZoneToUtc(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let index = 0; index < 3; index += 1) {
    const actual = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += target - represented;
  }
  return guess;
}

export function normalizeTencentQuoteTime(value, quoteCode = '') {
  const compact = parseTencentQuoteTime(value);
  const text = compact || String(value || '').trim();
  const match = text.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || !normalizeQuoteDate(`${match[1]}-${match[2]}-${match[3]}`)
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59) return '';
  const code = String(quoteCode || '').toLowerCase();
  const timeZone = code.startsWith('us')
    ? 'America/New_York'
    : code.startsWith('kr')
      ? 'Asia/Seoul'
      : code.startsWith('jp')
        ? 'Asia/Tokyo'
        : '';
  if (!timeZone) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6] || '00'}`;
  const utc = localTimeInZoneToUtc({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || '0'),
  }, timeZone);
  return formatChinaQuoteTime(utc / 1000);
}

function parseChinaQuoteTime(value) {
  return parseQuoteTimestamp(value) ?? NaN;
}

export function isCurrentHoldingsReport(reportDate, now = Date.now()) {
  const text = String(reportDate || '').trim();
  if (!normalizeQuoteDate(text) || text > chinaDateKey(now)) return false;
  const reportMs = Date.parse(`${text}T23:59:59+08:00`);
  const nowMs = Number(now);
  return Number.isFinite(reportMs) && Number.isFinite(nowMs)
    && reportMs <= nowMs + 24 * 60 * 60 * 1000
    && nowMs - reportMs <= MAX_REPORT_AGE_MS;
}

export function calculateHoldingsEstimate(stocks, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const today = chinaDateKey(now);
  const minCoverage = Number.isFinite(options.minCoverage) ? options.minCoverage : MIN_COVERAGE;
  const minQuotes = Number.isFinite(options.minQuotes) ? options.minQuotes : MIN_QUOTES;
  const reportDate = String(options.reportDate || '').trim();
  const validation = validateHoldingSet(stocks, { reportDate, now, wireVersion: 1 });
  const blockingReasons = validation.reasonCodes.filter(code => options.requireCurrentReport || !code.startsWith('HOLDINGS_REPORT_'));
  if (blockingReasons.length) return { available: false, change: null, coverage: 0, quoteCount: 0, sourceTime: null, reportDate,
    reason: '重仓集合或披露日期无效', reasonCodes: blockingReasons };
  if (options.requireCurrentReport && !isCurrentHoldingsReport(reportDate, now)) {
    return {
      available: false,
      change: null,
      coverage: 0,
      quoteCount: 0,
      sourceTime: null,
      reportDate,
      reason: '重仓披露日期缺失或已过期',
      reasonCodes: ['HOLDINGS_REPORT_EXPIRED'],
    };
  }
  const usable = [];

  (stocks || []).forEach((stock) => {
    const ratio = nullableNumber(stock && stock.ratio);
    const change = nullableNumber(stock && stock.change);
    const quoteMs = parseChinaQuoteTime(stock && stock.quoteTime);
    if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(change) || !Number.isFinite(quoteMs)) return;
    if (chinaDateKey(quoteMs) !== today || quoteMs > now) return;
    usable.push({ ratio, change, quoteMs });
  });

  const coverage = usable.reduce((sum, stock) => sum + stock.ratio, 0);
  if (usable.length < minQuotes || coverage < minCoverage) {
    return {
      available: false,
      change: null,
      coverage,
      quoteCount: usable.length,
      sourceTime: null,
      reportDate,
      reason: `当日重仓行情覆盖不足（${usable.length}只，${coverage.toFixed(1)}%）`,
      reasonCodes: ['HOLDINGS_QUOTE_COVERAGE_INSUFFICIENT'],
    };
  }

  const change = usable.reduce((sum, stock) => sum + stock.ratio * stock.change / 100, 0);
  const latestQuoteMs = Math.max(...usable.map((stock) => stock.quoteMs));
  return {
    available: true,
    change,
    coverage,
    quoteCount: usable.length,
    sourceTime: formatChinaQuoteTime(latestQuoteMs / 1000),
    reportDate,
    reason: '',
    reasonCodes: [],
  };
}

export function latestOfficialNavBase(fund) {
  const usable = source => source && source.status !== 'stale' && source.status !== 'unavailable'
    && !source.stale && (!source.cacheState || source.cacheState === 'fresh')
    && (source.sourceTier !== 'cache' || source.cacheState === 'fresh');
  const quote = fund.source_quote;
  const hasProvenance = Boolean(quote || fund.latest_nav_move);
  return [
    ...(usable(fund.latest_nav_move) ? [{ nav: fund.latest_nav_move.nav, date: fund.latest_nav_move.date }] : []),
    ...(usable(quote) ? [quote.valueKind === 'official_nav'
      ? { nav: quote.value, date: quote.officialNavDate }
      : { nav: quote.baseNav, date: quote.baseNavDate }] : []),
    ...(!hasProvenance && fund.est_kind === 'official_nav'
      ? [{ nav: fund.est_nav, date: fund.value_date || fund.est_time }] : []),
    ...(!hasProvenance ? [{ nav: fund.last_nav, date: fund.nav_date }] : []),
  ].map(value => ({ nav: typeof value.nav === 'boolean' ? NaN : Number(value.nav), date: normalizeQuoteDate(value.date) }))
    .filter(value => value.nav > 0 && Number.isFinite(value.nav) && value.date)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
}

export function applyHoldingsEstimate(fund, estimate) {
  if (!fund || !estimate || !estimate.available || !Number.isFinite(estimate.change)) return fund;
  if (fund.est_realtime === true && fund.est_kind !== 'official_nav') return fund;

  const official = latestOfficialNavBase(fund);
  const targetDate = normalizeQuoteDate(String(estimate.sourceTime || '').slice(0, 10));
  // A one-session stock move cannot bridge missing NAV days, and must never be
  // added a second time when that session is already in the published NAV.
  if (!official || !targetDate || !isSingleMarketSession(official.date, targetDate, fund.market || 'cn')) return fund;

  fund.last_nav = official.nav;
  fund.nav_date = official.date;
  fund.est_change = estimate.change;
  fund.est_nav = official.nav * (1 + estimate.change / 100);
  fund.est_time = estimate.sourceTime;
  fund.est_kind = 'holdings_model';
  fund.est_label = '重仓估算';
  fund.est_realtime = false;
  fund.est_holdings_model = true;
  fund.est_holdings_base_nav = official.nav;
  fund.est_holdings_base_date = official.date;
  fund.est_holdings_target_date = targetDate;
  fund.est_holdings_coverage = estimate.coverage;
  fund.est_holdings_quote_count = estimate.quoteCount;
  fund.est_holdings_report_date = String(estimate.reportDate || '');
  fund.est_note = `按已披露十大重仓${estimate.reportDate ? `（截至${estimate.reportDate}）` : ''}的当日行情估算；覆盖净值${estimate.coverage.toFixed(1)}%，未披露资产、汇率与调仓影响为未知误差，不是基金公司官方估值`;
  fund.source = 'quarterly-holdings-model';
  return fund;
}

/**
 * Rebuild enrichment from the immutable primary quote so asynchronous detail
 * sources cannot make the displayed NAV depend on their completion order.
 * Official NAV is always installed before a holdings estimate chooses its
 * base NAV.
 */
export function composeFundEnrichment(rawFund, options = {}) {
  const fund = { ...(rawFund || {}) };
  if (options.officialNavMove) {
    fund.latest_nav_move = { ...options.officialNavMove };
  }
  if (options.holdingsEstimate) {
    applyHoldingsEstimate(fund, options.holdingsEstimate);
  }
  return fund;
}
