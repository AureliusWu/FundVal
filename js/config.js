export const TIMING = Object.freeze({
  FUND_JSONP_TIMEOUT: 7000, INDEX_JSONP_TIMEOUT: 8000, CLOUD_SYNC_TIMEOUT: 15000,
  MKT_STATUS_MS: 30000, SW_UPDATE_MS: 1800000, AUTO_PUSH_DELAY: 5000,
  AUTO_PULL_INTERVAL: 60000, CLOUD_COOLDOWN_MS: 30000, DAILY_NOTIFY_CHECK_MS: 30000
});

export const TTL = Object.freeze({
  INTRADAY: 60000, INDEX: 60000, GOLD: 120000, OFFICIAL_NAV: 600000,
  HOLDINGS: 12 * 3600000, FUND_META: 7 * 86400000
});

export const STALE_AFTER = Object.freeze({
  INTRADAY: 10 * 60000, INDEX: 5 * 60000, OVERSEAS: 15 * 60000, CACHE: 24 * 3600000
});

export const MODEL_URL = './data/overseas-models.json';

export function refreshInterval(now) {
  const day = now.getDay();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (day === 0 || day === 6) return 15 * 60000;
  if (minute >= 565 && minute < 690) return 60000;
  if (minute >= 690 && minute < 780) return 180000;
  if (minute >= 780 && minute < 900) return 60000;
  if (minute >= 900 && minute < 930) return 120000;
  return 300000;
}
