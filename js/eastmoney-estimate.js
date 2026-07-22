const API = 'https://sinan-estimate-push.ligugu69.workers.dev/estimates';
const TIMEOUT = 10000;

function numberOrNaN(value) {
  const n = Number(String(value ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : NaN;
}

export function normalizeEstimateRow(row) {
  const code = String(row?.code || row?.bzdm || '');
  if (!/^\d{6}$/.test(code)) return null;
  return {
    code,
    name: String(row.name || row.jjjc || code),
    type: String(row.type || row.FType || ''),
    last_nav: numberOrNaN(row.last_nav ?? row.dwjz),
    est_nav: numberOrNaN(row.est_nav ?? row.gsz),
    est_change: numberOrNaN(row.est_change ?? row.gszzl),
    nav_date: String(row.nav_date || row.gzrq || ''),
    est_time: String(row.est_time || row.gxrq || ''),
    source_time_precision: 'date',
    est_label: String(row.est_label || '延迟估值'),
    est_kind: 'estimate',
    est_realtime: false,
    est_note: String(row.est_note || '东方财富盘中估算；上游仅提供行情日期，未提供精确分钟'),
    status: 'ok',
    source: 'sinan-estimate-proxy',
  };
}

export async function fetchEstimateRows(codes, options = {}) {
  const wanted = Array.from(new Set((codes || []).map(String).filter((code) => /^\d{6}$/.test(code))));
  const output = new Map(wanted.map((code) => [code, null]));
  if (!wanted.length) return output;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const query = new URLSearchParams({ codes: wanted.join(',') });
    if (options.force) query.set('_', String(Date.now()));
    const response = await fetch(`${options.api || API}?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`估值代理 HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.items)) throw new Error('估值代理响应无效');
    payload.items.forEach((row) => {
      const normalized = normalizeEstimateRow(row);
      if (normalized && output.has(normalized.code)) output.set(normalized.code, normalized);
    });
    return output;
  } finally {
    clearTimeout(timer);
  }
}
