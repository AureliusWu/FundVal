const API = 'https://sinan-estimate-push.ligugu69.workers.dev/holdings';
const TIMEOUT = 10000;

function numberOrNaN(value) {
  if (value == null || String(value).trim() === '') return NaN;
  const number = Number(String(value).replace('%', '').trim());
  return Number.isFinite(number) ? number : NaN;
}

export function normalizeHoldingRow(row) {
  const code = String(row?.code || '').trim().toUpperCase();
  const name = String(row?.name || '').trim();
  const ratio = numberOrNaN(row?.ratio);
  if (!code || !name || !Number.isFinite(ratio)) return null;
  return { code, name, ratio };
}

export async function fetchFundHoldings(code, options = {}) {
  const fundCode = String(code || '').trim();
  if (!/^\d{6}$/.test(fundCode)) throw new Error('基金代码无效');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const query = new URLSearchParams({ code: fundCode });
    if (options.force) query.set('_', String(Date.now()));
    const response = await fetch(`${options.api || API}?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`重仓代理 HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.items)) throw new Error('重仓代理响应无效');
    const items = payload.items.map(normalizeHoldingRow).filter(Boolean).slice(0, 10);
    return {
      status: items.length ? 'ok' : 'empty',
      reportDate: String(payload.report_date || ''),
      fetchedAt: String(payload.fetched_at || ''),
      source: String(payload.source || 'sinan-holdings-proxy'),
      items,
    };
  } finally {
    clearTimeout(timer);
  }
}
