import { createRequestSignal, throwIfAborted } from './runtime/request-signal.js';
import { fundDataApiUrl } from './config.js';
import { parseWorkerEnvelope } from './runtime/worker-contract.js';

const TIMEOUT = 10000;

function numberOrNaN(value) {
  if (value == null || typeof value === 'boolean') return NaN;
  const raw = String(value).trim();
  const body = raw.endsWith('%') ? raw.slice(0, -1) : raw;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(body)) return NaN;
  const number = Number(body);
  return Number.isFinite(number) ? number : NaN;
}

const HOLDING_CODE_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;
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
  const market = String(row.market || '').trim().toLowerCase();
  return { code, name, ratio, ...(market ? { market: /^(cn|sh|sz|hk|us|jp|kr)$/.test(market) ? market : 'unknown' } : {}) };
}

// Unqualified numeric codes are shared by different exchanges. Only mainland
// funds may use the legacy A-share inference; overseas disclosures need a market.
export function holdingQuoteCode(row, { allowMainland = false } = {}) {
  const code = String(row.code || '').toUpperCase();
  const market = String(row.market || '').toLowerCase();
  if (!market && !allowMainland) return '';
  if (/^(cn|sh|sz)$/.test(market) || (!market && allowMainland)) {
    if (!/^[036689]\d{5}$/.test(code)) return '';
    return (market === 'sh' || market === 'sz' ? market : /^[69]/.test(code) ? 'sh' : 'sz') + code;
  }
  if (market === 'hk' && /^\d{5}$/.test(code)) return 'hk' + code;
  if (market === 'kr' && /^\d{6}$/.test(code)) return 'kr' + code;
  if (market === 'jp' && /^[A-Z0-9]{4,5}$/.test(code)) return 'jp' + code;
  if (market === 'us' && /^[A-Z][A-Z0-9.]{0,9}$/.test(code)) return 'us' + code.replace(/\./g, '_');
  return '';
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
    const envelope = parseWorkerEnvelope(payload, { endpoint: 'holdings', requestedCodes: [fundCode], now: options.now });
    const items = envelope.items;
    return {
      status: items.length ? (envelope.status === 'ok' ? 'ok' : 'degraded')
        : (envelope.status === 'unavailable' ? 'unavailable' : 'empty'),
      sourceStatus: envelope.status,
      wireVersion: envelope.wireVersion,
      reportDate: envelope.reportDate,
      fetchedAt: envelope.fetchedAt,
      source: envelope.source || 'sinan-holdings-proxy',
      items,
    };
  } catch (error) {
    throw requestSignal.normalizeError(error);
  } finally {
    requestSignal.cleanup();
  }
}
