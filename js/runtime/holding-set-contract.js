import { normalizeQuoteDate, nullableNumber } from './quote-contract.js';
import { chinaDateKey } from './market-clock.js';

const MAX_REPORT_AGE_MS = 185 * 86400000;
const MARKETS = new Set(['cn', 'sh', 'sz', 'hk', 'us', 'jp', 'kr']);
export const contractOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const contractRecord = value => value != null && typeof value === 'object' && !Array.isArray(value);

export function contractClock(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}
export function contractChinaDay(now) { return chinaDateKey(now); }
export function contractText(value, max = 160) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result.length <= max && !/[<>\u0000-\u001f\u007f]/.test(result) ? result : '';
}
export function contractNumber(value, percent = false) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // Percent signs belong only to changes/weights, never a NAV or price.
  const body = percent && raw.endsWith('%') ? raw.slice(0, -1) : raw;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(body)) return null;
  return nullableNumber(body);
}

/** Small pure whole-set guard, kept independent of HTTP response/estimate parsing. */
export function validateHoldingSet(items, { reportDate = '', now = Date.now(), wireVersion = 1 } = {}) {
  const reasonCodes = [];
  const output = [];
  const identities = new Set();
  let totalRatio = 0;
  const date = normalizeQuoteDate(reportDate);
  const nowMs = contractClock(now);
  const add = code => { if (!reasonCodes.includes(code)) reasonCodes.push(code); };
  if (!date) add('HOLDINGS_REPORT_DATE_INVALID');
  else if (date > contractChinaDay(nowMs)) add('HOLDINGS_REPORT_DATE_FUTURE');
  else if (nowMs - Date.parse(`${date}T23:59:59+08:00`) > MAX_REPORT_AGE_MS) add('HOLDINGS_REPORT_EXPIRED');
  if (!Array.isArray(items)) add('HOLDINGS_ROW_INVALID');
  else if (items.length > 10) add('HOLDINGS_TOO_MANY_ROWS');
  else for (const row of items) {
    if (!contractRecord(row)) { add('HOLDINGS_ROW_INVALID'); continue; }
    const code = contractText(row.code, 12).toUpperCase();
    const name = contractText(row.name, 80);
    const ratio = contractNumber(row.ratio, true);
    const market = contractText(row.market, 8).toLowerCase();
    if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(code) || !name || ratio == null || ratio < 0 || ratio > 100
      || (market && !MARKETS.has(market)) || (wireVersion === 2 && !market)
      || (contractOwn(row, 'market') && row.market != null && row.market !== '' && !market)) {
      add('HOLDINGS_ROW_INVALID'); continue;
    }
    const identity = `${market || 'unqualified'}:${code}`;
    if (identities.has(identity)) add('HOLDINGS_DUPLICATE_IDENTITY');
    identities.add(identity);
    totalRatio += ratio;
    output.push({ code, name, ratio, ...(market ? { market } : {}) });
  }
  // Roundoff tolerance is only for floating-point addition, not a weight budget.
  if (totalRatio > 100 + 1e-9) add('HOLDINGS_TOTAL_RATIO_EXCEEDED');
  return { valid: reasonCodes.length === 0, items: reasonCodes.length ? [] : output,
    totalRatio, reportDate: date || '', reasonCodes };
}
