import { createRequestSignal, throwIfAborted } from './runtime/request-signal.js';
import { fundDataApiUrl } from './config.js';

const TIMEOUT = 10000;

function numberOrNaN(value) {
  if (value == null || String(value).trim() === '') return NaN;
  const number = Number(String(value).replace('%', '').trim());
  return Number.isFinite(number) ? number : NaN;
}

const HOLDING_CODE_PATTERN = /^(?:\d{5}|\d{6}|[A-Z][A-Z0-9.-]{0,9})$/;
const UNSAFE_TEXT_PATTERN = /[<>\u0000-\u001f\u007f]/;

function safeHoldingText(value, maximumLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || UNSAFE_TEXT_PATTERN.test(text)) return '';
  return text;
}

export function normalizeHoldingRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const code = safeHoldingText(row.code, 12).toUpperCase();
  const name = safeHoldingText(row.name, 80);
  const ratio = numberOrNaN(row?.ratio);
  if (!HOLDING_CODE_PATTERN.test(code) || !name || !Number.isFinite(ratio) || ratio < 0 || ratio > 100) return null;
  return { code, name, ratio };
}

export async function fetchFundHoldings(code, options = {}) {
  const fundCode = String(code || '').trim();
  if (!/^\d{6}$/.test(fundCode)) throw new Error('基金代码无效');

  throwIfAborted(options.signal);
  const requestSignal = createRequestSignal(options.signal, options.timeout ?? TIMEOUT);
  try {
    const query = new URLSearchParams({ code: fundCode });
    if (options.force) query.set('_', String(Date.now()));
    const response = await fetch(`${options.api || fundDataApiUrl('holdings')}?${query}`, {
      cache: 'no-store',
      signal: requestSignal.signal,
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
  } catch (error) {
    throw requestSignal.normalizeError(error);
  } finally {
    requestSignal.cleanup();
  }
}
