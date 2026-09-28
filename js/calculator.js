const valid = value => Number.isFinite(value) && value > 0;
const numberOrNaN = value => value == null || typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '') ? NaN : Number(value);

export function normalizeFundEstimate(raw) {
  const last = numberOrNaN(raw?.dwjz);
  let nav = numberOrNaN(raw?.gsz);
  let change = numberOrNaN(raw?.gszzl);
  if (!Number.isFinite(nav) && valid(last) && Number.isFinite(change)) nav = last * (1 + change / 100);
  if (!Number.isFinite(change) && valid(last) && valid(nav)) change = (nav / last - 1) * 100;
  return { lastNav: valid(last) ? last : null, nav: valid(nav) ? nav : null, change: Number.isFinite(change) ? change : null };
}

export function calculateHolding(shares, cost, nav, baseNav) {
  shares = numberOrNaN(shares);
  const parsedCost = numberOrNaN(cost);
  const hasKnownCost = Number.isFinite(parsedCost) && parsedCost >= 0;
  if (!Number.isFinite(shares) || shares < 0 || !valid(nav)) return { value: null, todayProfit: null, totalProfit: null, totalProfitRate: null };
  const value = shares * nav;
  const totalProfit = shares > 0 && hasKnownCost ? value - shares * parsedCost : null;
  return {
    value,
    todayProfit: shares > 0 && valid(baseNav) ? shares * (nav - baseNav) : null,
    totalProfit,
    totalProfitRate: shares > 0 && hasKnownCost && parsedCost > 0 ? totalProfit / (shares * parsedCost) * 100 : null
  };
}

export function resolveQuoteBaseNav(fund = {}, quote = fund.quote) {
  // Never borrow an enrichment's baseline for a different selected candidate.
  // Older cached envelopes without a bound period retain NAV but no period P/L.
  return valid(quote?.baseNav) && quote.baseNavDate && quote.targetDate
    && quote.baseNavDate < quote.targetDate ? quote.baseNav : null;
}

export function chooseDisplayValue({ official, estimate, cached, overseas = false }) {
  if (overseas && estimate?.kind === 'overseas_model' && estimate.change != null && !estimate.stale) {
    return { nav: estimate.nav, change: estimate.change, kind: 'model', label: '模', stale: false };
  }
  if (overseas && official?.change != null) return { nav: official.nav, change: official.change, kind: 'official', label: '净', stale: false };
  if (estimate?.change != null) {
    if (estimate.kind === 'official_nav') {
      return { nav: estimate.nav, change: estimate.change, kind: 'official', label: '净', stale: false };
    }
    const model = estimate.kind === 'overseas_model';
    return { nav: estimate.nav, change: estimate.change, kind: model ? 'model' : 'estimate', label: model ? '模' : '估', stale: false };
  }
  if (official?.change != null) return { nav: official.nav, change: official.change, kind: 'official', label: '净', stale: false };
  return cached ? { ...cached, kind: 'cached', label: '旧', stale: true } : { nav: null, change: null, kind: 'cached', label: '旧', stale: true };
}
