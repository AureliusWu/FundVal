(function () {
  'use strict';

  var TARGET_CODE = '017811';
  var TARGET_NAME = '东方人工智能主题混合C';
  var HOLDINGS_KEY = 'fuyu_holdings_v1';
  var FUNDS_CACHE_KEY = 'fuyu_funds_cache_v1';
  var SYNC_META_KEY = 'fuyu_sync_meta_v1';
  var GIST_TOKEN_KEY = 'fuyu_gist_token';
  var GIST_ID_KEY = 'fuyu_gist_id';
  var GIST_SYNC_TIME_KEY = 'fuyu_gist_sync_time';
  var GIST_FILENAME = 'fuyu-holdings.json';
  var MIGRATION_KEY = 'fuyu_migration_remove_017811_v1';
  var CLOUD_PENDING_KEY = 'fuyu_migration_remove_017811_cloud_pending_v1';

  function parseJson(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; }
    catch (_) { return fallback; }
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function codeOf(item) {
    return String(item && item.code || '').trim();
  }

  function backupHoldings(holdings) {
    try {
      var latest = localStorage.getItem('fuyu_backup_latest');
      if (latest) localStorage.setItem('fuyu_backup_previous', latest);
      localStorage.setItem('fuyu_backup_latest', JSON.stringify({
        created_at: nowISO(),
        holdings: holdings
      }));
    } catch (_) {}
  }

  function ensureLocalTombstone() {
    var holdings = parseJson(localStorage.getItem(HOLDINGS_KEY), []);
    if (!Array.isArray(holdings)) holdings = [];

    var target = holdings.find(function (item) { return codeOf(item) === TARGET_CODE; });
    var changed = false;

    if (!target) {
      backupHoldings(holdings);
      holdings.push({
        code: TARGET_CODE,
        name: TARGET_NAME,
        shares: 0,
        cost: 0,
        updated_at: nowISO(),
        deleted: true
      });
      changed = true;
    } else if (target.deleted !== true || !target.updated_at) {
      backupHoldings(holdings);
      target.deleted = true;
      target.updated_at = nowISO();
      changed = true;
    }

    if (changed) localStorage.setItem(HOLDINGS_KEY, JSON.stringify(holdings));
    return holdings;
  }

  function purgeCachedFund() {
    var cache = parseJson(localStorage.getItem(FUNDS_CACHE_KEY), null);
    if (cache && Array.isArray(cache.data)) {
      var filtered = cache.data.filter(function (item) { return codeOf(item) !== TARGET_CODE; });
      if (filtered.length !== cache.data.length) {
        cache.data = filtered;
        localStorage.setItem(FUNDS_CACHE_KEY, JSON.stringify(cache));
      }
    }
    localStorage.removeItem('fuyu_nav_move_' + TARGET_CODE);
  }

  function forceNextCloudWrite() {
    var meta = parseJson(localStorage.getItem(SYNC_META_KEY), {});
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
    meta.last_push_hash = '';
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  }

  function normalizeHoldings(value) {
    if (!Array.isArray(value)) return [];
    var seen = {};
    return value.reduce(function (result, item) {
      var code = codeOf(item);
      if (!/^\d{6}$/.test(code) || seen[code]) return result;
      seen[code] = true;
      result.push({
        code: code,
        name: String(item && item.name || code).trim() || code,
        shares: Number.isFinite(Number(item && item.shares)) && Number(item.shares) >= 0 ? Number(item.shares) : 0,
        cost: Number.isFinite(Number(item && item.cost)) && Number(item.cost) >= 0 ? Number(item.cost) : 0,
        updated_at: typeof (item && item.updated_at) === 'string' ? item.updated_at : '',
        deleted: Boolean(item && item.deleted === true)
      });
      return result;
    }, []);
  }

  function mergeByTimestamp(localItems, cloudItems) {
    var merged = {};
    cloudItems.concat(localItems).forEach(function (item) {
      var code = codeOf(item);
      if (!code) return;
      var current = merged[code];
      if (!current || String(item.updated_at || '') >= String(current.updated_at || '')) {
        merged[code] = item;
      }
    });
    return Object.keys(merged).map(function (code) { return merged[code]; });
  }

  function holdingsHash(holdings) {
    return holdings.map(function (item) {
      return item.code + ':' + (item.updated_at || '0');
    }).sort().join(';');
  }

  async function findExistingGist(token) {
    for (var page = 1; page <= 5; page++) {
      var response = await fetch('https://api.github.com/gists?per_page=100&page=' + page, {
        headers: { Authorization: 'token ' + token }
      });
      if (!response.ok) return '';
      var gists = await response.json();
      if (!Array.isArray(gists) || !gists.length) return '';
      for (var i = 0; i < gists.length; i++) {
        if (gists[i].files && gists[i].files[GIST_FILENAME]) return gists[i].id || '';
      }
      if (gists.length < 100) return '';
    }
    return '';
  }

  async function syncDeletionToCloud() {
    if (localStorage.getItem(CLOUD_PENDING_KEY) !== '1') return;

    var token = localStorage.getItem(GIST_TOKEN_KEY) || '';
    if (!token) {
      localStorage.removeItem(CLOUD_PENDING_KEY);
      return;
    }

    try {
      var gistId = localStorage.getItem(GIST_ID_KEY) || '';
      if (!gistId) {
        gistId = await findExistingGist(token);
        if (!gistId) return;
        localStorage.setItem(GIST_ID_KEY, gistId);
      }

      var response = await fetch('https://api.github.com/gists/' + gistId, {
        headers: { Authorization: 'token ' + token }
      });
      if (!response.ok) return;

      var gist = await response.json();
      var file = gist.files && gist.files[GIST_FILENAME];
      var parsed = file && file.content ? parseJson(file.content, {}) : {};
      var cloudItems = normalizeHoldings(Array.isArray(parsed) ? parsed : parsed.holdings);
      var localItems = normalizeHoldings(parseJson(localStorage.getItem(HOLDINGS_KEY), []));
      var merged = mergeByTimestamp(localItems, cloudItems);
      var target = merged.find(function (item) { return item.code === TARGET_CODE; });
      var stamp = nowISO();

      if (!target) {
        target = { code: TARGET_CODE, name: TARGET_NAME, shares: 0, cost: 0 };
        merged.push(target);
      }
      target.deleted = true;
      target.updated_at = stamp;

      var payload = {
        schema: 2,
        updated_at: stamp,
        device_id: '',
        holdings: merged
      };
      var patchBody = {
        description: 'FundVal 持仓数据 | ' + stamp,
        files: {}
      };
      patchBody.files[GIST_FILENAME] = { content: JSON.stringify(payload, null, 2) };
      var updateResponse = await fetch('https://api.github.com/gists/' + gistId, {
        method: 'PATCH',
        headers: {
          Authorization: 'token ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(patchBody)
      });
      if (!updateResponse.ok) return;

      localStorage.setItem(HOLDINGS_KEY, JSON.stringify(merged));
      var meta = parseJson(localStorage.getItem(SYNC_META_KEY), {});
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
      meta.last_push_hash = holdingsHash(merged);
      meta.last_pull = stamp;
      localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
      localStorage.setItem(GIST_SYNC_TIME_KEY, stamp);
      localStorage.removeItem(CLOUD_PENDING_KEY);
    } catch (_) {
      // Keep the pending marker so the next page load can retry.
    }
  }

  var migrationDone = localStorage.getItem(MIGRATION_KEY) === 'done';
  var cloudPending = localStorage.getItem(CLOUD_PENDING_KEY) === '1';

  if (!migrationDone || cloudPending) {
    ensureLocalTombstone();
    purgeCachedFund();
    forceNextCloudWrite();
    localStorage.setItem(MIGRATION_KEY, 'done');
    if (localStorage.getItem(GIST_TOKEN_KEY)) {
      localStorage.setItem(CLOUD_PENDING_KEY, '1');
    }
  }

  window.addEventListener('load', function () {
    syncDeletionToCloud();
  }, { once: true });
})();
