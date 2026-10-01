import { normalizeEstimateQuote } from './runtime/quote-normalizer.js';
import { createRequestSignal, throwIfAborted } from './runtime/request-signal.js';
import { fundDataApiUrl } from './config.js';
import { normalizeWorkerEstimateRow, parseWorkerEnvelope, WorkerContractError } from './runtime/worker-contract.js';

const TIMEOUT = 10000;

function safeText(value, maximum = 300) {
  const text = String(value ?? '').trim();
  return text.length <= maximum && !/[<>\u0000-\u001f\u007f]/.test(text) ? text : '';
}

export function normalizeEstimateRow(row, options = {}) {
  const code = String(row?.code || row?.bzdm || '');
  if (!/^\d{6}$/.test(code)) return null;
  let wire;
  try {
    wire = normalizeWorkerEstimateRow(row, { wireVersion: options.wireVersion ?? 1, now: options.now });
  } catch (error) {
    if (!(error instanceof WorkerContractError) || error.code !== 'WORKER_ROW_INVALID') throw error;
    // Direct legacy callers can receive a safe unusable row. The HTTP client
    // validates the complete envelope first, so this never rescues bad wire data.
    wire = { code, name: safeText(row.name || row.jjjc || code), source: 'unavailable', kind: 'unavailable',
      status: 'error', source_status: safeText(row.status || 'ok', 32), base_nav: null, value_nav: null,
      est_nav: null, est_change: null, source_time: null, value_date: null, coverage: null, quote_count: null,
      diagnostics: {}, message: '估值契约不完整', fallback_reason: 'invalid_response' };
  }
  const sourceTime = wire.source_time || '';
  const normalized = {
    ...wire,
    code,
    name: safeText(wire.name || code, 160),
    type: safeText(row.type || row.FType || '', 80),
    last_nav: wire.base_nav ?? NaN,
    est_nav: wire.est_nav ?? NaN,
    est_change: wire.est_change ?? NaN,
    nav_date: wire.base_nav_date || '',
    est_time: sourceTime,
    source_time_precision: /\d{1,2}:\d{2}/.test(sourceTime) ? 'minute' : 'date',
    est_label: safeText(row.est_label || '延迟估值', 80),
    est_kind: wire.est_kind || 'estimate',
    est_realtime: row.est_realtime === true && wire.kind === 'intraday_estimate'
      && ['fresh', 'ok', 'success', 'realtime'].includes(wire.source_status),
    est_note: safeText(row.est_note || row.note || '东方财富盘中估算；上游仅提供行情日期，未提供精确分钟'),
    message: safeText(wire.message || row.message || row.error || row.fallback_reason || ''),
    is_fallback: row.is_fallback === true,
    source_time: sourceTime,
    value_date: wire.value_date || '',
    base_nav_date: wire.base_nav_date || '',
    coverage: wire.coverage ?? NaN,
    quote_count: wire.quote_count ?? NaN,
    report_date: wire.report_date || '',
    fallback_reason: safeText(wire.fallback_reason || '', 80),
    diagnostics: row.diagnostics && typeof row.diagnostics === 'object' ? { ...row.diagnostics } : {},
  };
  normalized.source_quote = normalizeEstimateQuote({ ...normalized, status: wire.source_status }, {
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
    const envelope = parseWorkerEnvelope(payload, { endpoint: 'estimates', requestedCodes: wanted, now: options.now });
    envelope.items.forEach((row) => {
      const normalized = normalizeEstimateRow(row, { wireVersion: envelope.wireVersion, fetchedAt: envelope.fetchedAt, now: options.now });
      if (normalized && output.has(normalized.code)) output.set(normalized.code, normalized);
    });
    return output;
  } catch (error) {
    throw requestSignal.normalizeError(error);
  } finally {
    requestSignal.cleanup();
  }
}
