import { isQuoteEligibleForNotification } from '../runtime/notification-policy.js';

const TARGET_MINUTE = 14 * 60 + 30;

function chinaParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(nowMs));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function notificationDate(nowMs) {
  const parts = chinaParts(nowMs);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function afterDailyTarget(nowMs) {
  const parts = chinaParts(nowMs);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  return Number(parts.hour) * 60 + Number(parts.minute) >= TARGET_MINUTE;
}

export function buildEligibleNotificationLines(holdings, funds, { now = Date.now(), limit = 8 } = {}) {
  const activeCodes = new Set((Array.isArray(holdings) ? holdings : [])
    .filter(holding => holding && !holding.deleted && holding.code)
    .map(holding => String(holding.code)));
  const lines = [];
  for (const fund of Array.isArray(funds) ? funds : []) {
    if (!fund || !activeCodes.has(String(fund.code))) continue;
    if (!isQuoteEligibleForNotification(fund.quote, { now })) continue;
    const change = fund.quote.changePct;
    const name = String(fund.name || fund.code).replace(/\s+/g, '').slice(0, 8);
    lines.push(`${name} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);
  }
  return {
    lines: lines.slice(0, limit),
    truncated: lines.length > limit,
    eligibleCount: lines.length,
  };
}

async function displayNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(title, {
          body,
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          tag: 'fuyu-daily-1430',
          renotify: true,
          data: { url: location.href },
        });
        return true;
      }
    }
    new Notification(title, { body, icon: 'icon-192.png', tag: 'fuyu-daily-1430' });
    return true;
  } catch (_) {
    return false;
  }
}

export function createNotificationController({
  getHoldings,
  getFunds,
  refresh,
  readLastSent,
  writeLastSent,
  intervalMs,
  onPermissionChange = () => {},
  now = () => Date.now(),
} = {}) {
  let timer = null;

  function permission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }

  async function enable() {
    if (!('Notification' in window)) {
      onPermissionChange('unsupported');
      return 'unsupported';
    }
    let state = Notification.permission;
    if (state === 'default') state = await Notification.requestPermission();
    onPermissionChange(state);
    if (state === 'granted') await check();
    return state;
  }

  async function check() {
    const nowMs = Number(now());
    if (!Number.isFinite(nowMs) || permission() !== 'granted' || !afterDailyTarget(nowMs)) return false;
    const today = notificationDate(nowMs);
    if (readLastSent() === today) return false;
    const currentHoldings = getHoldings();
    if (!Array.isArray(currentHoldings) || !currentHoldings.some(item => item && !item.deleted)) return false;
    await refresh();
    const result = buildEligibleNotificationLines(getHoldings(), getFunds(), { now: Number(now()) });
    if (!result.lines.length) return false;
    const body = result.lines.join('\n') + (result.truncated ? '\n...' : '');
    const sent = await displayNotification('蜉蝣基金 14:30 自选涨跌幅', body);
    if (sent) writeLastSent(today);
    return sent;
  }

  function start() {
    onPermissionChange(permission());
    check().catch(() => {});
    if (!timer) timer = setInterval(() => check().catch(() => {}), intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ check, enable, permission, start, stop });
}
