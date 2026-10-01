import { chinaTimeParts, marketClock } from './runtime/market-clock.js';

export const TIMING = Object.freeze({
  FUND_JSONP_TIMEOUT: 7000, INDEX_JSONP_TIMEOUT: 8000, MODEL_LOAD_TIMEOUT: 8000, CLOUD_SYNC_TIMEOUT: 15000,
  MKT_STATUS_MS: 30000, SW_UPDATE_MS: 1800000, AUTO_PUSH_DELAY: 5000,
  AUTO_PULL_INTERVAL: 60000, CLOUD_COOLDOWN_MS: 30000, DAILY_NOTIFY_CHECK_MS: 30000
});

export const TTL = Object.freeze({
  INTRADAY: 60000, INDEX: 60000, GOLD: 120000, OFFICIAL_NAV: 600000,
  HOLDINGS: 12 * 3600000, FUND_META: 7 * 86400000
});

export const MODEL_URL = './data/overseas-models.json';

const REMOTE_DATA_ORIGIN = 'https://sinan-estimate-push.ligugu69.workers.dev';

export function fundDataApiUrl(endpoint, runtimeLocation = globalThis.location) {
  if (!['estimates', 'holdings'].includes(endpoint)) throw new Error('unsupported_fund_data_endpoint');
  const hostname = String(runtimeLocation?.hostname || '').toLowerCase();
  if (hostname === '127.0.0.1' || hostname === 'localhost') return `/__fundval_dev/${endpoint}`;
  return `${REMOTE_DATA_ORIGIN}/${endpoint}`;
}

export function refreshInterval(now) {
  const parts = chinaTimeParts(now);
  if (!parts || marketClock('cn', now).calendarStatus !== 'valid') return 300000;
  const minute = parts.hour * 60 + parts.minute;
  if (marketClock('cn', now).isTradingDay === false) return 15 * 60000;
  if (minute >= 565 && minute < 690) return 60000;
  if (minute >= 690 && minute < 780) return 180000;
  if (minute >= 780 && minute < 900) return 60000;
  if (minute >= 900 && minute < 930) return 120000;
  return 300000;
}
