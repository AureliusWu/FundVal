import { normalizeEstimateQuote } from './runtime/quote-normalizer.js';
import { createRequestSignal, throwIfAborted } from './runtime/request-signal.js';
import { fundDataApiUrl } from './config.js';

const TIMEOUT = 10000;

function numberOrNaN(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return NaN;
  const n = Number(String(value ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : NaN;
}

function normalizedUpstreamStatus(row) {
  const status = String(row?.status || '').trim().toLowerCase();
  // Some successful proxy responses describe the kind of value rather than a
  // transport outcome. Keep those rows usable, while preserving explicit
  // unavailable/error states for the refresh fallback chain.
  if (!status || ['ok', 'success', 'latest_official', 'official', 'delayed', 'realtime'].includes(status)) return 'ok';
  return status;
}

export function normalizeEstimateRow(row, options = {}) {
  const code = String(row?.code || row?.bzdm || '');
  if (!/^\d{6}$/.test(code)) return null;
  const sourceTime = String(row.source_time || row.est_time || row.gxrq || '');
  const normalized = {
    code,
    name: String(row.name || row.jjjc || code),
    type: String(row.type || row.FType || ''),
    last_nav: numberOrNaN(row.base_nav ?? row.last_nav ?? row.dwjz),
    est_nav: numberOrNaN(row.value_nav ?? row.est_nav ?? row.gsz),
    est_change: numberOrNaN(row.value_change ?? row.estimate_change ?? row.est_change ?? row.gszzl),
    nav_date: String(row.base_nav_date || row.nav_date || row.gzrq || ''),
    est_time: String(row.source_time || row.est_time || row.value_date || row.gxrq || ''),
    source_time_precision: /\d{1,2}:\d{2}/.test(sourceTime) ? 'minute' : 'date',
    est_label: String(row.est_label || '延迟估值'),
    est_kind: (row.kind || row.est_kind) === 'official_nav' ? 'official_nav' : 'estimate',
    est_realtime: row.est_realtime === true,
    est_note: String(row.est_note || '东方财富盘中估算；上游仅提供行情日期，未提供精确分钟'),
    status: normalizedUpstreamStatus(row),
    source_status: String(row.status || 'ok').trim() || 'ok',
    message: String(row.message || row.error || row.fallback_reason || ''),
    source: String(row.source || 'sinan-estimate-proxy'),
    kind: String(row.kind || ''),
    is_fallback: row.is_fallback === true,
    source_time: sourceTime,
    value_date: String(row.value_date || ''),
    base_nav_date: String(row.base_nav_date || ''),
    base_nav: numberOrNaN(row.base_nav ?? row.last_nav ?? row.dwjz),
    coverage: numberOrNaN(row.coverage ?? row.model_coverage),
    quote_count: numberOrNaN(row.quote_count ?? row.model_quote_count),
    report_date: String(row.report_date || row.model_report_date || ''),
    fallback_reason: String(row.fallback_reason || ''),
    diagnostics: row.diagnostics && typeof row.diagnostics === 'object' ? { ...row.diagnostics } : {},
  };
  normalized.source_quote = normalizeEstimateQuote({ ...row, ...normalized }, {
    fetchedAt: options.fetchedAt || row.fetched_at,
    now: options.now,
  });
  if (normalized.status === 'ok' && normalized.source_quote.status === 'unavailable') {
    normalized.status = 'error';
    if (!normalized.message) normalized.message = '估值源未提供可用行情';
  }
  return normalized;
}

export async function fetchEstimateRows(codes, options = {}) {
  const wanted = Array.from(new Set((codes || []).map(String).filter((code) => /^\d{6}$/.test(code))));
  const output = new Map(wanted.map((code) => [code, null]));
  if (!wanted.length) return output;

  throwIfAborted(options.signal);
  const requestSignal = createRequestSignal(options.signal, options.timeout ?? TIMEOUT);
  try {
    const query = new URLSearchParams({ codes: wanted.join(',') });
    if (options.force) query.set('_', String(Date.now()));
    const response = await fetch(`${options.api || fundDataApiUrl('estimates')}?${query}`, {
      cache: 'no-store',
      signal: requestSignal.signal,
    });
    if (!response.ok) throw new Error(`估值代理 HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.items)) throw new Error('估值代理响应无效');
    payload.items.forEach((row) => {
      const normalized = normalizeEstimateRow(row, { fetchedAt: payload.fetched_at, now: options.now });
      if (normalized && output.has(normalized.code)) output.set(normalized.code, normalized);
    });
    return output;
  } catch (error) {
    throw requestSignal.normalizeError(error);
  } finally {
    requestSignal.cleanup();
  }
}
