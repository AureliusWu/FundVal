import { TTL } from '../config.js';

const INDEX_CODES = Object.freeze(['sh000001', 'sh000300', 'usINX', 'usNDX']);
export const REFRESH_INDEX_KEY = `indices:${INDEX_CODES.join(',')}`;
export const policyOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const policyRecord = value => value != null && typeof value === 'object' && !Array.isArray(value);
export const policyEpoch = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;

/** Shared lazy acquisition policy; payload and cache validation remain at their boundaries. */
export function refreshResourcePolicy(key) {
  if (typeof key !== 'string') return null;
  const fund = /^(nav|holdings|meta):(\d{6})$/.exec(key);
  if (fund) return Object.freeze({ kind: fund[1], code: fund[2],
    source: fund[1] === 'holdings' ? 'sinan-holdings-proxy' : 'eastmoney-official-nav',
    tier: fund[1] === 'holdings' ? 'primary' : 'secondary',
    ttlMs: TTL[{ nav: 'OFFICIAL_NAV', holdings: 'HOLDINGS', meta: 'FUND_META' }[fund[1]]] });
  if (key === 'gold:AU9999') return Object.freeze({ kind: 'gold', code: 'AU9999',
    source: 'eastmoney-security-quote', tier: 'secondary', ttlMs: TTL.GOLD });
  if (key === REFRESH_INDEX_KEY) return Object.freeze({ kind: 'indices', codes: INDEX_CODES,
    source: 'tencent-market-quote', tier: 'secondary', ttlMs: TTL.INDEX });
  if (key.startsWith('estimates:')) {
    const codes = key.slice(10).split(',');
    if (codes.length && codes.length <= 50 && codes.every(code => /^\d{6}$/.test(code))
      && new Set(codes).size === codes.length && [...codes].sort().join(',') === codes.join(',')) {
      return Object.freeze({ kind: 'estimates', codes: Object.freeze(codes),
        source: 'sinan-estimate-proxy', tier: 'primary', ttlMs: TTL.INTRADAY });
    }
  }
  return null;
}
