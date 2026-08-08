const MIN_COVERAGE = 50;
const MIN_QUOTES = 5;
const MAX_REPORT_AGE_MS = 185 * 24 * 60 * 60 * 1000;

function chinaDateKey(timestamp) {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

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
  if (compact) return compact;
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '';
  if (!String(quoteCode).startsWith('us')) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6] || '00'}`;
  const utc = localTimeInZoneToUtc({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || '0'),
  }, 'America/New_York');
  return formatChinaQuoteTime(utc / 1000);
}

function parseChinaQuoteTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+08:00`);
}

export function isCurrentHoldingsReport(reportDate, now = Date.now()) {
  const text = String(reportDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
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
  if (options.requireCurrentReport && !isCurrentHoldingsReport(reportDate, now)) {
    return {
      available: false,
      change: null,
      coverage: 0,
      quoteCount: 0,
      sourceTime: null,
      reportDate,
      reason: '重仓披露日期缺失或已过期',
    };
  }
  const usable = [];

  (stocks || []).forEach((stock) => {
    const ratio = Number(stock && stock.ratio);
    const change = Number(stock && stock.change);
    const quoteMs = parseChinaQuoteTime(stock && stock.quoteTime);
    if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(change) || !Number.isFinite(quoteMs)) return;
    if (chinaDateKey(quoteMs) !== today) return;
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
  };
}

export function applyHoldingsEstimate(fund, estimate) {
  if (!fund || !estimate || !estimate.available || !Number.isFinite(estimate.change)) return fund;
  if (fund.est_realtime === true && fund.est_kind !== 'official_nav') return fund;

  const official = fund.latest_nav_move && Number.isFinite(Number(fund.latest_nav_move.nav))
    ? { nav: Number(fund.latest_nav_move.nav), date: String(fund.latest_nav_move.date || '') }
    : fund.est_kind === 'official_nav' && Number.isFinite(Number(fund.est_nav))
      ? { nav: Number(fund.est_nav), date: String(fund.est_time || fund.nav_date || '') }
      : Number.isFinite(Number(fund.last_nav))
        ? { nav: Number(fund.last_nav), date: String(fund.nav_date || '') }
        : null;
  if (!official || official.nav <= 0) return fund;

  fund.last_nav = official.nav;
  fund.nav_date = official.date;
  fund.est_change = estimate.change;
  fund.est_nav = official.nav * (1 + estimate.change / 100);
  fund.est_time = estimate.sourceTime;
  fund.est_kind = 'holdings_model';
  fund.est_label = '重仓估算';
  fund.est_realtime = false;
  fund.est_holdings_model = true;
  fund.est_holdings_coverage = estimate.coverage;
  fund.est_holdings_quote_count = estimate.quoteCount;
  fund.est_holdings_report_date = String(estimate.reportDate || '');
  fund.est_note = `按已披露十大重仓${estimate.reportDate ? `（截至${estimate.reportDate}）` : ''}的当日行情估算；覆盖净值${estimate.coverage.toFixed(1)}%，未披露部分按0贡献处理，不是基金公司官方估值`;
  fund.source = 'quarterly-holdings-model';
  return fund;
}
