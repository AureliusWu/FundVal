const MIN_COVERAGE = 50;
const MIN_QUOTES = 5;

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

function parseChinaQuoteTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+08:00`);
}

export function calculateHoldingsEstimate(stocks, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const today = chinaDateKey(now);
  const minCoverage = Number.isFinite(options.minCoverage) ? options.minCoverage : MIN_COVERAGE;
  const minQuotes = Number.isFinite(options.minQuotes) ? options.minQuotes : MIN_QUOTES;
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
  fund.est_note = `按已披露十大重仓的当日行情估算；覆盖净值${estimate.coverage.toFixed(1)}%，未披露部分按0贡献处理，不是基金公司官方估值`;
  fund.source = 'quarterly-holdings-model';
  return fund;
}
