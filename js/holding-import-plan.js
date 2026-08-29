const FUND_CODE_RE = /^\d{6}$/;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function finite(value) {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number != null && number >= 0 ? number : null;
}

function formValue(value) {
  return value == null || (typeof value === 'string' && !value.trim()) ? '' : String(value);
}

function optionalCost(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return { ok: true, value: null };
  const number = nonNegative(value);
  return number == null ? { ok: false, value: null } : { ok: true, value: number };
}

export function resolveCandidateSelectionAction(existing, explicitlySkipped = false) {
  if (explicitlySkipped) return 'skip';
  return existing ? 'update' : 'add';
}

function activeHoldingByCode(holdings) {
  const byCode = new Map();
  (Array.isArray(holdings) ? holdings : []).forEach(item => {
    const code = text(item && item.code);
    if (FUND_CODE_RE.test(code) && item && item.deleted !== true) byCode.set(code, item);
  });
  return byCode;
}

export function screenshotCostTotal(candidate) {
  const amount = finite(candidate && candidate.holdingAmount);
  const profit = finite(candidate && candidate.holdingProfit);
  if (amount == null || profit == null) return null;
  const total = amount - profit;
  return total >= 0 ? total : null;
}

export function suggestCostFromScreenshot(candidate, shares) {
  const total = screenshotCostTotal(candidate);
  const realShares = positive(shares);
  return total != null && realShares != null ? total / realShares : null;
}

export function createHoldingImportPlan(candidates, holdings) {
  const existingByCode = activeHoldingByCode(holdings);
  return (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const match = candidate && candidate.match || {};
    const code = text(match.code || (match.fund && match.fund.code) || candidate && candidate.code);
    const existing = existingByCode.get(code) || null;
    const matched = match.status === 'matched' && FUND_CODE_RE.test(code);
    const name = text(match.name || (match.fund && match.fund.name) || candidate && candidate.name || candidate && candidate.rawFundName || code);
    const warnings = Array.isArray(candidate && candidate.warnings) ? [...candidate.warnings] : [];
    if (!matched) warnings.push('基金代码或名称需要人工确认');
    return {
      id: `alipay-${index + 1}`,
      rawFundName: text(candidate && candidate.rawFundName),
      code,
      name,
      matchStatus: matched ? 'matched' : (match.status || 'needs_confirmation'),
      matchCandidates: Array.isArray(match.candidates) ? match.candidates.map(item => ({ ...item })) : [],
      holdingAmount: finite(candidate && candidate.holdingAmount),
      holdingProfit: finite(candidate && candidate.holdingProfit),
      holdingProfitRate: finite(candidate && candidate.holdingProfitRate),
      dailyProfit: finite(candidate && candidate.dailyProfit),
      existing: existing ? { code: existing.code, name: existing.name, shares: existing.shares, cost: existing.cost } : null,
      action: matched ? (existing ? 'update' : 'add') : 'skip',
      shares: existing ? formValue(existing.shares) : '',
      // Unknown cost is canonical null. The form renders it as an empty value
      // with a "--" hint; never stringify null or silently coerce it to zero.
      cost: existing ? formValue(existing.cost) : '',
      useScreenshotCost: false,
      explicitSkip: false,
      warnings: [...new Set(warnings)],
    };
  });
}

function validateOne(row) {
  if (!row || row.action === 'skip') return { ok: true, skipped: true };
  const code = text(row.code);
  if (!FUND_CODE_RE.test(code)) return { ok: false, message: '请确认 6 位基金代码' };
  const name = text(row.name) || code;
  const shares = positive(row.shares);
  if (shares == null) return { ok: false, message: '请填写大于 0 的真实持有份额' };
  const submittedCost = optionalCost(row.cost);
  let cost = submittedCost.value;
  if (row.useScreenshotCost) cost = suggestCostFromScreenshot(row, shares);
  if ((row.useScreenshotCost && cost == null) || (!row.useScreenshotCost && !submittedCost.ok)) {
    return { ok: false, message: row.useScreenshotCost ? '截图金额或累计收益不完整，不能换算成本净值' : '请填写有效成本净值或留空表示未知' };
  }
  return { ok: true, value: { code, name, shares, cost } };
}

export function validateHoldingImportPlan(rows) {
  const values = [];
  const errors = [];
  const seen = new Set();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const result = validateOne(row);
    if (!result.ok) {
      errors.push({ id: row && row.id || '', message: result.message });
      return;
    }
    if (result.skipped) return;
    if (seen.has(result.value.code)) {
      errors.push({ id: row && row.id || '', message: '同一基金只能确认一次' });
      return;
    }
    seen.add(result.value.code);
    values.push({ row, ...result.value });
  });
  return { ok: errors.length === 0, values, errors };
}

export function applyHoldingImportPlan(holdings, rows, nowISO = new Date().toISOString()) {
  const validation = validateHoldingImportPlan(rows);
  if (!validation.ok) return { ...validation, holdings: Array.isArray(holdings) ? holdings.map(item => ({ ...item })) : [], applied: 0 };
  const next = (Array.isArray(holdings) ? holdings : []).map(item => ({ ...item }));
  const indexByCode = new Map(next.map((item, index) => [text(item && item.code), index]));
  let applied = 0;
  validation.values.forEach(change => {
    const index = indexByCode.get(change.code);
    if (index == null) {
      next.push({
        code: change.code,
        name: change.name,
        shares: change.shares,
        cost: change.cost,
        updated_at: nowISO,
        deleted: false,
      });
      indexByCode.set(change.code, next.length - 1);
      applied += 1;
      return;
    }
    const current = next[index];
    const changed = current.deleted === true
      || current.name !== change.name
      || Number(current.shares) !== change.shares
      || finite(current.cost) !== change.cost;
    if (!changed) return;
    next[index] = {
      ...current,
      code: change.code,
      name: change.name,
      shares: change.shares,
      cost: change.cost,
      updated_at: nowISO,
      deleted: false,
    };
    applied += 1;
  });
  return { ok: true, values: validation.values, errors: [], holdings: next, applied };
}

export function importPlanSummary(rows) {
  const summary = { total: 0, matched: 0, needsConfirmation: 0, add: 0, update: 0, skip: 0 };
  (Array.isArray(rows) ? rows : []).forEach(row => {
    summary.total += 1;
    if (row.matchStatus === 'matched') summary.matched += 1;
    else summary.needsConfirmation += 1;
    if (row.action === 'add') summary.add += 1;
    else if (row.action === 'update') summary.update += 1;
    else summary.skip += 1;
  });
  return summary;
}
