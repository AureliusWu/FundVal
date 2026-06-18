const STORAGE_KEY = 'fuyu_holdings_v1';
const CACHE_KEY = 'fuyu_funds_cache_v1';
const GIST_TOKEN_KEY = 'fuyu_gist_token';
const GIST_ID_KEY = 'fuyu_gist_id';
const GIST_SYNC_TIME_KEY = 'fuyu_gist_sync_time';
const GIST_FILENAME = 'fuyu-holdings.json';
const DAILY_LOG_KEY = 'fuyu_daily_log';
const SYNC_META_KEY = 'fuyu_sync_meta_v1';
const GOLD_CACHE_KEY = 'fuyu_gold_cache_v2';
// ── 时间/超时配置（集中管理，便于统一调整） ────────
const TIMING = {
  FUND_JSONP_TIMEOUT: 7000,       // 天天基金 JSONP 超时
  INDEX_JSONP_TIMEOUT: 8000,      // 腾讯指数行情 JSONP 超时
  CLOUD_SYNC_TIMEOUT: 15000,      // GitHub Gist API 超时
  INDEX_REFRESH_MS: 30000,        // 指数行情刷新间隔（兜底值，动态调整）
  MKT_STATUS_MS: 30000,           // 市场状态文字刷新间隔
  SW_UPDATE_MS: 1800000,          // Service Worker 更新检查间隔（30min）
  AUTO_PUSH_DELAY: 5000,          // 数据变更后自动推送延迟
  AUTO_PULL_INTERVAL: 60000,      // 后台自动拉取间隔
  CLOUD_COOLDOWN_MS: 30000        // 切 Tab 云端拉取冷却
};
// ── 缓存持久化黑名单（这些字段为瞬时 UI 状态，不写入 localStorage） ──
const SKIP_CACHE_KEYS = ['_cached', 'message'];
// ── 指数行情配置（腾讯 JSONP + 黄金独立源） ──
const INDEX_CONFIG = [
  { code: 'usIXIC',   name: '纳斯达克' },
  { code: 'usINX',    name: '标普500' },
  { code: 'hf_XAU',   name: '伦敦金', source: 'gold' },
  { code: 'sh000001', name: '上证指数' },
  { code: 'sh000300', name: '沪深300' }
];
let indexCache = INDEX_CONFIG.map(function(cfg) {
  return { name: cfg.name, price: NaN, changePct: NaN };
});
let holdings = [];
let fundsData = [];
let editingCode = null;
let sortBy = 'est_change_desc';
let expandedFund = null;
const holdingsCache = {};
let fundTypeCache = {};      // 基金类型/基本信息缓存
let fundFeeCache = {};       // 费率信息缓存
let loadingDetails = null;   // 当前正在加载详情的基金代码（防重入）
const pendingRequests = new Map();
let _codeGen = {};             // JSONP 请求代数计数器，防止旧回调污染新请求
let isRefreshing = false;
let refreshQueued = false;
let autoRefreshTimer = null;
let syncPending = false;       // 是否有待推送的本地变更
let syncDebounceTimer = null;  // 防抖定时器
let autoPullTimer = null;      // 定时拉取
let isSyncing = false;         // 是否正在同步中
let goldCache = { price: NaN, changePct: NaN, time: 0 };  // 金价缓存，API 全部失败时兜底

// ── 持仓存取 ─────────────────────────────────────────────
function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    holdings = normalizeHoldings(data);
    // 给旧数据补上时间戳（没有 updated_at 的条目初始化为当前时间）
    var now = nowISO();
    var needsBackfill = false;
    holdings.forEach(function(h) { if (!h.updated_at) { h.updated_at = now; needsBackfill = true; } });
    if (needsBackfill) saveHoldings();
  } catch(e) { holdings = []; }
}

function saveHoldings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
}

function normalizeHoldings(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  return data.reduce((acc, item) => {
    const code = String(item && item.code || '').trim();
    if (!/^\d{6}$/.test(code) || seen.has(code)) return acc;

    const shares = toNonNegativeNumber(item.shares);
    const cost = toNonNegativeNumber(item.cost);
    const name = String(item.name || '').trim();
    var updated_at = (typeof item.updated_at === 'string' && item.updated_at) ? item.updated_at : '';
    seen.add(code);
    acc.push({code, name: name || code, shares, cost, updated_at});
    return acc;
  }, []);
}

function toNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isRealFundName(name, code) {
  const value = String(name || '').trim();
  return Boolean(value && value !== code);
}

function nowISO() { return new Date().toISOString(); }

// ── 导出 / 导入 ───────────────────────────────────────────
function exportData() {
  const blob = new Blob([JSON.stringify(holdings, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fuyu-holdings.json';
  a.click();
  showToast('已导出持仓文件');
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!Array.isArray(parsed)) throw new Error();
      const data = normalizeHoldings(parsed);
      if (parsed.length && !data.length) throw new Error();
      // 给没有时间戳的条目加上当前时间
      data.forEach(function(h) { if (!h.updated_at) h.updated_at = nowISO(); });
      holdings = data;
      saveHoldings();
      scheduleAutoPush();
      renderHoldingsList();
      showToast('导入成功，共 ' + holdings.length + ' 条');
      refresh();
    } catch(err) { showToast('文件格式错误'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── 云同步 (GitHub Gist) — 双向自动同步 ────────────────────
function getGistToken() { return localStorage.getItem(GIST_TOKEN_KEY) || ''; }
function setGistToken(t) { localStorage.setItem(GIST_TOKEN_KEY, t); }
function getGistId() { return localStorage.getItem(GIST_ID_KEY) || ''; }
function setGistId(id) { localStorage.setItem(GIST_ID_KEY, id); }
function getSyncTime() { return localStorage.getItem(GIST_SYNC_TIME_KEY) || ''; }
function setSyncTime(t) { localStorage.setItem(GIST_SYNC_TIME_KEY, t); }

// 同步元数据：记录上次 push 时数据的快照 hash，用于判断是否需要推送
function loadSyncMeta() {
  try {
    var raw = localStorage.getItem(SYNC_META_KEY);
    return raw ? JSON.parse(raw) : { last_push_hash: '', last_pull: '' };
  } catch(e) { return { last_push_hash: '', last_pull: '' }; }
}
function saveSyncMeta(meta) {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
}

// 计算本地持仓的数据指纹（只比较 code + updated_at）
function holdingsHash(h) {
  return h.map(function(x) { return x.code + ':' + (x.updated_at||'0'); }).sort().join(';');
}

function hasCloudConfig() {
  return !!(getGistToken());  // 有 Token 即可，Gist ID 可自动发现
}

function renderCloudStatus() {
  var el = document.getElementById('cloud-status');
  if (!el) return;
  var syncTime = getSyncTime();
  if (syncTime) {
    var d = new Date(syncTime);
    el.textContent = '上次同步: ' + d.toLocaleString('zh-CN');
    el.style.color = 'var(--up)';
  } else {
    el.textContent = '配置 Token 后自动同步';
    el.style.color = 'var(--muted)';
  }
}

// ── 核心：双向合并 ─────────────────────────────────────────
// 按 code 匹对，逐条比较 updated_at，时间戳新的胜出
function mergeFromCloud(cloudItems) {
  var localMap = {};
  holdings.forEach(function(h) { localMap[h.code] = h; });

  var merged = [];
  var cloudMap = {};
  cloudItems.forEach(function(c) { cloudMap[c.code] = c; });

  // 处理云端条目 + 共有条目
  cloudItems.forEach(function(c) {
    var local = localMap[c.code];
    if (!local) {
      // 仅云端有 → 直接加入
      merged.push(c);
    } else {
      // 两边都有 → 比时间戳，新的胜出
      var localTime = local.updated_at || '';
      var cloudTime = c.updated_at || '';
      if (cloudTime > localTime) {
        merged.push(c);
      } else {
        merged.push(local);
      }
    }
  });

  // 处理仅本地有的条目（未被云端删除的保留）
  holdings.forEach(function(h) {
    if (!cloudMap[h.code]) {
      merged.push(h);
    }
  });

  return merged;
}

// ── 从云端拉取并合并 ───────────────────────────────────────
async function pullFromCloud(silent) {
  if (isSyncing) return;
  var token = getGistToken();
  if (!token) return;

  var gistId = getGistId();
  if (!gistId) {
    // 尝试自动发现云端存档
    var found = await findExistingGist(token);
    if (found) setGistId(found);
    else return;
  }

  isSyncing = true;
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMING.CLOUD_SYNC_TIMEOUT);

    var resp = await fetch('https://api.github.com/gists/' + gistId, {
      headers: { 'Authorization': 'token ' + token },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      if (resp.status === 404) { setGistId(''); renderCloudStatus(); }
      return;
    }

    var data = await resp.json();
    var file = data.files[GIST_FILENAME];
    if (!file || !file.content) return;

    var parsed = JSON.parse(file.content);
    var cloudItems = normalizeHoldings(parsed);
    if (!cloudItems.length) return;

    var oldHash = holdingsHash(holdings);
    holdings = mergeFromCloud(cloudItems);
    var newHash = holdingsHash(holdings);

    if (oldHash !== newHash) {
      saveHoldings();
      setSyncTime(nowISO());
      var meta = loadSyncMeta();
      meta.last_pull = nowISO();
      meta.last_push_hash = newHash;
      saveSyncMeta(meta);
      // 数据变更后刷新界面（silent 模式也要刷，否则用户看到的是旧数据）
      renderHoldingsList();
      renderCloudStatus();
      refresh();
    }
  } catch(e) {
    // 静默失败，下次自动重试
  } finally {
    isSyncing = false;
  }
}

// ── 推送本地变更到云端 ─────────────────────────────────────
async function pushToCloud(silent) {
  if (isSyncing) return;
  var token = getGistToken();
  if (!token) return;

  var gistId = getGistId();
  if (!gistId) {
    // 尝试自动发现云端存档
    var found = await findExistingGist(token);
    if (found) setGistId(found);
    else return;
  }

  var hash = holdingsHash(holdings);
  var meta = loadSyncMeta();
  if (hash === meta.last_push_hash) {
    syncPending = false;
    return;  // 没有新变更，跳过
  }

  isSyncing = true;
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMING.CLOUD_SYNC_TIMEOUT);

    var payload = {
      description: 'FundVal 持仓数据 | ' + nowISO(),
      files: { [GIST_FILENAME]: { content: JSON.stringify(holdings, null, 2) } }
    };

    var resp = await fetch('https://api.github.com/gists/' + gistId, {
      method: 'PATCH',
      headers: { 'Authorization': 'token ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      if (resp.status === 401) { if (!silent) showToast('Token 无效，请检查'); }
      else if (resp.status === 404) { setGistId(''); renderCloudStatus(); }
      return;
    }

    await resp.json();
    meta.last_push_hash = hash;
    meta.last_pull = nowISO();
    saveSyncMeta(meta);
    setSyncTime(nowISO());
    syncPending = false;
    renderCloudStatus();
  } catch(e) {
    // 静默失败，保留 syncPending 标志以便下次重试
  } finally {
    isSyncing = false;
  }
}

// ── 防抖：数据变更后延迟推送 ──────────────────────────────
function scheduleAutoPush() {
  if (!hasCloudConfig()) return;
  syncPending = true;
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(function() {
    pushToCloud(true);
  }, TIMING.AUTO_PUSH_DELAY);
}

// ── 后台定时拉取 ──────────────────────────────────────────
function startAutoPull() {
  if (autoPullTimer) clearInterval(autoPullTimer);
  autoPullTimer = setInterval(function() {
    pullFromCloud(true);
  }, TIMING.AUTO_PULL_INTERVAL);
}

// ── 页面启动时拉取 ────────────────────────────────────────
async function autoPullOnLoad() {
  if (!hasCloudConfig()) return;
  var meta = loadSyncMeta();
  var isFirstSync = !meta.last_pull;
  await pullFromCloud(true);
  // 首次同步成功：清理本地硬编码模板数据，云端为准
  if (isFirstSync && getSyncTime() && holdings.length > 0) {
    saveHoldings();
    renderHoldingsList();
    renderCloudStatus();
  }
}

// ── 首次创建 Gist（手动触发） ──────────────────────────────
async function uploadToCloud() {
  var token = document.getElementById('gist-token').value.trim();
  if (!token) { showToast('请输入 GitHub Token'); return; }
  if (!holdings.length) { showToast('没有持仓数据可上传'); return; }
  setGistToken(token);

  var uploadBtn = document.getElementById('cloud-upload-btn');
  uploadBtn.textContent = '上传中...';
  uploadBtn.disabled = true;

  // 确保所有持仓都有时间戳
  holdings.forEach(function(h) {
    if (!h.updated_at) h.updated_at = nowISO();
  });
  saveHoldings();

  var content = JSON.stringify(holdings, null, 2);
  var gistId = getGistId();
  var desc = 'FundVal 持仓数据 | ' + nowISO();

  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMING.CLOUD_SYNC_TIMEOUT);

    var resp;
    if (gistId) {
      resp = await fetch('https://api.github.com/gists/' + gistId, {
        method: 'PATCH',
        headers: { 'Authorization': 'token ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, files: { [GIST_FILENAME]: { content } } }),
        signal: controller.signal
      });
    } else {
      resp = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Authorization': 'token ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, public: false, files: { [GIST_FILENAME]: { content } } }),
        signal: controller.signal
      });
    }
    clearTimeout(timer);

    if (!resp.ok) {
      var err = await resp.json().catch(function() { return {}; });
      if (resp.status === 401) { showToast('Token 无效，请检查（需勾选 gist 权限）'); }
      else if (resp.status === 404) { showToast('云端存档不存在，请重新上传'); setGistId(''); renderCloudStatus(); }
      else { showToast('上传失败: ' + (err.message || resp.status)); }
      return;
    }

    var data = await resp.json();
    setGistId(data.id);
    var hash = holdingsHash(holdings);
    var meta = loadSyncMeta();
    meta.last_push_hash = hash;
    meta.last_pull = nowISO();
    saveSyncMeta(meta);
    setSyncTime(nowISO());
    syncPending = false;
    renderCloudStatus();
    showToast('已上传，后续将自动同步');
    // 启动自动拉取
    startAutoPull();
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('请求超时，api.github.com 可能被墙，需科学上网');
    } else {
      showToast('网络错误: ' + (e.message || '连接失败，检查网络'));
    }
  } finally {
    uploadBtn.textContent = '上传到云端';
    uploadBtn.disabled = false;
  }
}

// ── 搜索已存在的云端存档 ──────────────────────────────────
async function findExistingGist(token) {
  try {
    // 列出用户的所有 Gist，找包含 fuyu-holdings.json 的那个
    var resp = await fetch('https://api.github.com/gists?per_page=100', {
      headers: { 'Authorization': 'token ' + token }
    });
    if (!resp.ok) return null;
    var gists = await resp.json();
    for (var i = 0; i < gists.length; i++) {
      if (gists[i].files && gists[i].files[GIST_FILENAME]) {
        return gists[i].id;
      }
    }
    return null;
  } catch(e) { return null; }
}

// ── 手动从云端下载（完整覆盖 + 合并） ─────────────────────
async function downloadFromCloud() {
  var token = document.getElementById('gist-token').value.trim();
  if (!token) { showToast('请输入 GitHub Token'); return; }
  setGistToken(token);

  var gistId = getGistId();
  if (!gistId) {
    // 没有本地记录，尝试搜索已有云端存档
    showToast('正在搜索云端存档...');
    gistId = await findExistingGist(token);
    if (!gistId) { showToast('未找到云端存档，请先在另一台设备上传'); return; }
    setGistId(gistId);
  }

  var downloadBtn = document.getElementById('cloud-download-btn');
  downloadBtn.textContent = '下载中...';
  downloadBtn.disabled = true;

  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMING.CLOUD_SYNC_TIMEOUT);

    var resp = await fetch('https://api.github.com/gists/' + gistId, {
      headers: { 'Authorization': 'token ' + token },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      if (resp.status === 401) { showToast('Token 无效'); }
      else if (resp.status === 404) { showToast('云端存档不存在，请重新上传'); setGistId(''); renderCloudStatus(); }
      else { showToast('下载失败: ' + resp.status); }
      return;
    }

    var data = await resp.json();
    var file = data.files[GIST_FILENAME];
    if (!file || !file.content) { showToast('云端存档为空'); return; }

    var parsed = JSON.parse(file.content);
    var cloudItems = normalizeHoldings(parsed);
    if (!cloudItems.length) { showToast('云端数据格式错误'); return; }

    // 用合并算法，不是简单覆盖
    var before = holdings.length;
    holdings = mergeFromCloud(cloudItems);
    saveHoldings();
    renderHoldingsList();
    var hash = holdingsHash(holdings);
    var meta = loadSyncMeta();
    meta.last_push_hash = hash;
    meta.last_pull = nowISO();
    saveSyncMeta(meta);
    setSyncTime(nowISO());
    syncPending = false;
    renderCloudStatus();
    if (holdings.length > before) {
      showToast('已合并，新增 ' + (holdings.length - before) + ' 条，共 ' + holdings.length + ' 条');
    } else {
      showToast('已同步，共 ' + holdings.length + ' 条');
    }
    refresh();
    startAutoPull();
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('请求超时，api.github.com 可能被墙，需科学上网');
    } else {
      showToast('下载失败: ' + (e.message || '连接失败，检查网络'));
    }
  } finally {
    downloadBtn.textContent = '从云端下载';
    downloadBtn.disabled = false;
  }
}

function clearCloudConfig() {
  if (!confirm('清除云端同步配置？（不会删除云端 Gist 数据）')) return;
  localStorage.removeItem(GIST_TOKEN_KEY);
  localStorage.removeItem(GIST_ID_KEY);
  localStorage.removeItem(GIST_SYNC_TIME_KEY);
  localStorage.removeItem(SYNC_META_KEY);
  document.getElementById('gist-token').value = '';
  syncPending = false;
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  if (autoPullTimer) { clearInterval(autoPullTimer); autoPullTimer = null; }
  renderCloudStatus();
  showToast('已清除云端配置');
}

// ── 缓存 ──────────────────────────────────────────────────
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (!cache.data || !Array.isArray(cache.data) || !cache.data.length) return null;
    return cache;
  } catch(e) { return null; }
}

function saveCache(data) {
  try {
    var slim = data.map(function(d) {
      var out = {};
      Object.keys(d).forEach(function(k) {
        if (SKIP_CACHE_KEYS.indexOf(k) === -1) out[k] = d[k];
      });
      return out;
    });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: slim, time: Date.now() }));
  } catch(e) {}
}

// ── 全局回调（天天基金 JSONP 接口） ──────────────────────
window.jsonpgz = function(data) {
  if (!data || !data.fundcode) return;
  const code = data.fundcode;
  const entry = pendingRequests.get(code);
  if (!entry) return;
  pendingRequests.delete(code);
  clearTimeout(entry.timer);
  try {
    entry.resolve({
      code: code,
      name: data.name || code,
      last_nav: parseNav(data.dwjz),
      est_nav: parseNav(data.gsz),
      est_change: parseNav(data.gszzl),
      nav_date: data.jzrq || '',
      est_time: data.gztime || '',
      status: 'ok'
    });
  } catch(e) {
    entry.resolve({code, status:'error', message:'数据解析失败'});
  }
};

// ── 主数据源：天天基金 JSONP ──────────────────────────────
function fetchFund(code) {
  return new Promise((resolve) => {
    _codeGen[code] = (_codeGen[code] || 0) + 1;
    var gen = _codeGen[code];

    const script = document.createElement('script');
    script.src = 'https://fundgz.1234567.com.cn/js/' + code + '.js?rt=' + Date.now();

    const timer = setTimeout(() => {
      var entry = pendingRequests.get(code);
      if (entry && entry.gen === gen) {
        pendingRequests.delete(code);
        script.remove();
        resolve({code, status:'error', message:'主源超时'});
      }
    }, TIMING.FUND_JSONP_TIMEOUT);

    pendingRequests.set(code, {resolve: resolve, timer: timer, gen: gen});

    script.onerror = function() {
      var entry = pendingRequests.get(code);
      if (entry && entry.gen === gen) {
        clearTimeout(entry.timer);
        pendingRequests.delete(code);
        script.remove();
        entry.resolve({code, status:'error', message:'主源请求失败'});
      }
    };
    script.onload = function() { script.remove(); };
    document.head.appendChild(script);
  });
}

// ── 备选数据源：东方财富 push2 API（CORS 友好） ──────────
async function fetchFromEastmoney(code) {
  try {
    const resp = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=0.${code}&fields=f43,f169,f170&_=${Date.now()}`
    );
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!json || !json.data) throw new Error('无数据');
    return {
      code,
      name: '',
      last_nav: parseNav(json.data.f43),
      est_nav: NaN,
      est_change: NaN,
      nav_date: '',
      est_time: '',
      status: 'ok_fallback',
      yesterday_change: parseNav(json.data.f169),
      ytd_change: parseNav(json.data.f170)
    };
  } catch(e) {
    return {code, status:'error', message:'备选源不可用'};
  }
}

// ── 合并获取：主源 + 备选源并行 ──────────────────────────
async function fetchFundFull(code) {
  const [primary, em] = await Promise.all([
    fetchFund(code),
    fetchFromEastmoney(code)
  ]);

  if (primary.status !== 'ok') {
    if (em.status === 'ok_fallback') {
      return { ...em, name: primary.name || code, status: 'ok_fallback' };
    }
    return primary;
  }

  if (em.status === 'ok_fallback') {
    primary.yesterday_change = em.yesterday_change;
    primary.ytd_change = em.ytd_change;
  }
  return primary;
}

// ── 刷新所有持仓数据 ─────────────────────────────────────
async function refresh() {
  if (isRefreshing) {
    refreshQueued = true;
    return;
  }
  isRefreshing = true;
  refreshQueued = false;
  const btn = document.getElementById('ref-btn');
  btn.classList.add('loading');
  btn.disabled = true;
  btn.textContent = '↻ 获取中';

  try {
    if (holdings.length === 0) {
      renderFundList([]);
      return;
    }

    const snapshot = holdings.map(h => ({...h}));
    const results = await Promise.all(snapshot.map(h => fetchFundFull(h.code)));

    let holdingsChanged = false;
    let anyOk = false;
    fundsData = results.map((r, i) => {
      const h = snapshot[i];
      const fetchedName = (r.status === 'ok' || r.status === 'ok_fallback') && isRealFundName(r.name, h.code) ? String(r.name).trim() : '';
      const holdingName = String(h.name || '').trim();
      const d = {
        ...r,
        name: fetchedName || holdingName || h.code,
        shares: h.shares || 0,
        cost: h.cost || 0
      };

      if (fetchedName) {
        const current = holdings.find(item => item.code === h.code);
        if (current && !isRealFundName(current.name, current.code)) {
          current.name = fetchedName;
          holdingsChanged = true;
        }
      }

      const hasEst = isUsableNav(d.est_nav);
      const hasLast = isUsableNav(d.last_nav);

      if ((d.status === 'ok' || d.status === 'ok_fallback') && (hasEst || hasLast)) {
        if (d.shares > 0) {
          // 有持仓 → 计算盈亏
          if (hasEst && hasLast) {
            var curr = d.est_nav * d.shares;
            d.today_profit = (d.est_nav - d.last_nav) * d.shares;
            d.total_profit = curr - d.cost * d.shares;
            d.total_profit_rate = (d.cost > 0) ? (d.total_profit / (d.cost * d.shares) * 100) : NaN;
            d.curr_value = curr;
          } else if (hasLast) {
            d.curr_value = d.last_nav * d.shares;
            d.total_profit = d.curr_value - d.cost * d.shares;
            d.total_profit_rate = (d.cost > 0) ? (d.total_profit / (d.cost * d.shares) * 100) : NaN;
            d.today_profit = NaN;
          }
        } else {
          // 仅关注（0份额）：展示净值，不计算盈亏
          d.curr_value = 0;
          d.today_profit = NaN;
          d.total_profit = NaN;
          d.total_profit_rate = NaN;
        }
        anyOk = true;
      }

      if ((d.status === 'ok' || d.status === 'ok_fallback') && !hasLast && !hasEst) {
        d.status = 'error';
        d.message = '净值数据无效';
      }
      return d;
    });

    if (holdingsChanged) { saveHoldings(); scheduleAutoPush(); renderHoldingsList(); }
    if (anyOk) saveCache(fundsData);

    renderFundList(fundsData);
    const now = new Date();
    document.getElementById('last-upd').textContent =
      `估算时间 ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    if (now.getHours() >= 15) saveTodayLog();
  } catch(e) {
    if (!tryShowCache()) renderFundList([]);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.textContent = '↻ 刷新';
    isRefreshing = false;
    if (refreshQueued) refresh();
  }
}

function tryShowCache() {
  const cache = loadCache();
  if (!cache) return false;
  fundsData = cache.data.map(d => ({ ...d, _cached: true }));
  renderFundList(fundsData);
  const ct = new Date(cache.time);
  document.getElementById('last-upd').textContent =
    `缓存数据 ${pad(ct.getMonth()+1)}/${pad(ct.getDate())} ${pad(ct.getHours())}:${pad(ct.getMinutes())}`;
  return true;
}

function pad(n) { return String(n).padStart(2,'0'); }
function isUsableNav(n) { return Number.isFinite(n) && n > 0; }
function parseNav(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// ── 排序 ─────────────────────────────────────────────────
function sortFunds(data) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    const va = (a.status === 'ok' || a.status === 'ok_fallback') ? a : null;
    const vb = (b.status === 'ok' || b.status === 'ok_fallback') ? b : null;
    if (va && !vb) return -1;
    if (!va && vb) return 1;
    if (!va && !vb) return 0;
    switch (sortBy) {
      case 'est_change_desc': return (b.est_change || -Infinity) - (a.est_change || -Infinity);
      case 'est_change_asc':  return (a.est_change || Infinity) - (b.est_change || Infinity);
      case 'today_profit_desc': return (b.today_profit || -Infinity) - (a.today_profit || -Infinity);
      case 'today_profit_asc':  return (a.today_profit || Infinity) - (b.today_profit || Infinity);
      case 'curr_value_desc': return (b.curr_value || 0) - (a.curr_value || 0);
      case 'curr_value_asc':  return (a.curr_value || 0) - (b.curr_value || 0);
      case 'total_profit_desc': return (b.total_profit || -Infinity) - (a.total_profit || -Infinity);
      case 'total_profit_asc':  return (a.total_profit || Infinity) - (b.total_profit || Infinity);
      case 'profit_rate_desc': return (b.total_profit_rate || -Infinity) - (a.total_profit_rate || -Infinity);
      case 'profit_rate_asc':  return (a.total_profit_rate || Infinity) - (b.total_profit_rate || Infinity);
      default: return 0;
    }
  });
  return sorted;
}

function setSort(by) {
  sortBy = by;
  renderFundList(fundsData);
}

function updateSortBar() {
  document.querySelectorAll('.sort-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.sort === sortBy);
  });
}

// ── 重仓股 ───────────────────────────────────────────────
function toggleFundDetail(code) {
  if (expandedFund === code) {
    expandedFund = null;
    loadingDetails = null;
    renderFundList(fundsData);
    return;
  }
  expandedFund = code;
  renderFundList(fundsData);
  if (loadingDetails !== code) fetchFundDetails(code);
}

// ── 通用 script 注入（Promise 化，解决 window.apidata 全局冲突） ──
function injectFundScript(url) {
  return new Promise(function(resolve, reject) {
    var script = document.createElement('script');
    script.src = url;
    script.onload = function() {
      var data = window.apidata;
      delete window.apidata;
      script.remove();
      resolve(data || {});
    };
    script.onerror = function() {
      delete window.apidata;
      script.remove();
      reject(new Error('script load failed'));
    };
    document.head.appendChild(script);
  });
}

// ── 顺序加载基金详情（重仓股 → 基金类型 → 费率） ──
async function fetchFundDetails(code) {
  loadingDetails = code;

  // 1. 重仓股 (jjcc)
  if (holdingsCache[code] === undefined) {
    try {
      var d1 = await injectFundScript(
        'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=' + code + '&topline=10&_=' + Date.now());
      holdingsCache[code] = parseHoldingsData(d1) || [];
    } catch(e) { holdingsCache[code] = []; }
    if (expandedFund !== code) { loadingDetails = null; return; }
    renderFundList(fundsData);

    if (holdingsCache[code].length) {
      await fetchHoldingsQuotes(code, holdingsCache[code]);
      if (expandedFund !== code) { loadingDetails = null; return; }
      renderFundList(fundsData);
    }
  }

  // 2. 基金类型/基本信息 (jjxx)
  if (fundTypeCache[code] === undefined) {
    try {
      var d3 = await injectFundScript(
        'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjxx&code=' + code + '&_=' + Date.now());
      fundTypeCache[code] = parseFundTypeData(d3) || null;
    } catch(e) { fundTypeCache[code] = null; }
    if (expandedFund !== code) { loadingDetails = null; return; }
    renderFundList(fundsData);
  }

  // 3. 基金费率 (jjfl)
  if (fundFeeCache[code] === undefined) {
    try {
      var d4 = await injectFundScript(
        'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjfl&code=' + code + '&_=' + Date.now());
      fundFeeCache[code] = parseFundFeeData(d4) || null;
    } catch(e) { fundFeeCache[code] = null; }
    if (expandedFund !== code) { loadingDetails = null; return; }
    renderFundList(fundsData);
  }

  loadingDetails = null;
}

// ── 重仓股解析 ─────────────────────────────────────────────
function parseHoldingsData(data) {
  if (!data || !data.content) return null;
  var div = document.createElement('div');
  div.innerHTML = data.content;
  var rows = div.querySelectorAll('table tbody tr');
  if (!rows.length) return null;
  var stocks = [];
  for (var i = 0; i < rows.length && stocks.length < 10; i++) {
    var cells = rows[i].children;
    if (cells.length < 7) continue;
    var codeEl = cells[1].querySelector('a');
    var nameEl = cells[2].querySelector('a');
    var ratioText = (cells[6].textContent || '').trim();
    stocks.push({
      code: codeEl ? codeEl.textContent.trim() : '',
      name: nameEl ? nameEl.textContent.trim() : '',
      ratio: parseFloat(ratioText) || 0
    });
  }
  return stocks.length ? stocks : null;
}

// ── 重仓股实时涨跌幅（jjcc 接口本身只有「占净值比例」，不含涨跌幅，需额外查一次行情） ──
function secidFor(stockCode) {
  // 沪市（6/9 开头）→ 1.code；深市（0/2/3 开头）→ 0.code
  return (/^[69]/.test(stockCode) ? '1.' : '0.') + stockCode;
}

async function fetchHoldingsQuotes(code, stocks) {
  await Promise.all([
    fetchAStockHoldingQuotes(stocks),
    fetchTencentHoldingQuotes(stocks)
  ]);
}

async function fetchAStockHoldingQuotes(stocks) {
  var aStocks = stocks.filter(function(s) { return /^\d{6}$/.test(s.code); });
  if (!aStocks.length) return;
  var secids = aStocks.map(function(s) { return secidFor(s.code); });
  try {
    var resp = await fetch(
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f3&secids=' + secids.join(',') + '&_=' + Date.now());
    if (!resp.ok) return;
    var json = await resp.json();
    var diff = json && json.data && json.data.diff;
    if (!diff) return;
    var list = Array.isArray(diff) ? diff : Object.keys(diff).map(function(k) { return diff[k]; });
    var changeMap = {};
    list.forEach(function(item) { changeMap[item.f12] = parseNav(item.f3); });
    stocks.forEach(function(s) {
      if (Number.isFinite(changeMap[s.code])) s.change = changeMap[s.code];
    });
  } catch(e) {
    // 静默失败，涨跌幅列保持 '--'
  }
}

function tencentQuoteCodeFor(stockCode) {
  var code = String(stockCode || '').trim().toUpperCase();
  if (/^\d{5}$/.test(code)) return 'hk' + code;
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(code)) return 'us' + code.replace(/\./g, '_');
  return '';
}

function tencentQuoteVarName(quoteCode) {
  return 'v_' + String(quoteCode || '').replace(/\./g, '_');
}

function fetchTencentHoldingQuotes(stocks) {
  var items = stocks.map(function(s) {
    return { stock: s, quoteCode: tencentQuoteCodeFor(s.code) };
  }).filter(function(item) { return item.quoteCode; });

  if (!items.length) return Promise.resolve();

  return new Promise(function(resolve) {
    var script = document.createElement('script');
    var done = false;
    var timeout = setTimeout(finish, TIMING.INDEX_JSONP_TIMEOUT);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      script.remove();
      items.forEach(function(item) {
        try {
          var varName = tencentQuoteVarName(item.quoteCode);
          var parsed = parseTencentQuote(window[varName]);
          delete window[varName];
          if (parsed && Number.isFinite(parsed.changePct)) {
            item.stock.change = parsed.changePct;
          }
        } catch(e) {}
      });
      resolve();
    }

    script.onload = finish;
    script.onerror = finish;
    script.src = 'https://qt.gtimg.cn/q=' + items.map(function(item) {
      return item.quoteCode;
    }).join(',') + '&_t=' + Date.now();
    document.head.appendChild(script);
  });
}

// ── 基金基本类型解析 ──────────────────────────────────────
function parseFundTypeData(data) {
  if (!data || !data.content) return null;
  var div = document.createElement('div');
  div.innerHTML = data.content;
  var rows = div.querySelectorAll('table tr');
  var result = {};
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].children;
    if (cells.length < 2) continue;
    var key = (cells[0].textContent || '').replace(/[：:\s]/g, '').trim();
    var val = (cells[1].textContent || '').trim();
    if (!key || !val) continue;
    if (/基金类型/.test(key)) result.type = val;
    if (/成立日/.test(key)) result.setupDate = val;
    if (/规模/.test(key)) result.scale = val;
    if (/管理人/.test(key)) result.company = val;
    if (/跟踪标的/.test(key)) result.benchmark = val;
  }
  return Object.keys(result).length ? result : null;
}

// ── 费率信息解析 ──────────────────────────────────────────
function parseFundFeeData(data) {
  if (!data || !data.content) return null;
  var div = document.createElement('div');
  div.innerHTML = data.content;
  var rows = div.querySelectorAll('table tr');
  var result = {};
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].children;
    if (cells.length < 2) continue;
    var key = (cells[0].textContent || '').replace(/[：:\s]/g, '').trim();
    var val = (cells[1].textContent || '').trim();
    if (!key || !val) continue;
    if (/申购费|购买费/.test(key)) result.buyFee = val;
    if (/赎回费/.test(key)) result.sellFee = val;
    if (/管理费/.test(key)) result.manageFee = val;
    if (/托管费/.test(key)) result.custodyFee = val;
  }
  return Object.keys(result).length ? result : null;
}

// ── 渲染基金列表 ─────────────────────────────────────────
function renderFundList(data) {
  var list = document.getElementById('fund-list');
  if (!data || data.length === 0) {
    list.innerHTML = '<div class="empty-hint">暂无持仓<br>在「持仓」页添加基金代码</div>';
    ['s-today','s-total','s-profit'].forEach(function(id) {
      document.getElementById(id).textContent = '--';
      document.getElementById(id).className = 'sum-val';
    });
    return;
  }

  var sorted = sortFunds(data);
  var todaySum = 0, totalVal = 0, profitSum = 0;
  var html = '';

  sorted.forEach(function(f) {
    var isFallback = f.status === 'ok_fallback';
    if (f.status !== 'ok' && !isFallback) {
      html += '<div class="fund-card"><div class="fund-top"><div><div class="fund-name">' + esc(f.name||f.code) + '</div><div class="fund-code">' + f.code + '</div></div></div><div class="fund-error">获取失败 · ' + esc(f.message||'') + '</div></div>';
      return;
    }
    var hasEst = Number.isFinite(f.est_change);
    var cc = hasEst ? (f.est_change > 0 ? 'up' : f.est_change < 0 ? 'down' : 'flat') : '';
    var sign = hasEst && f.est_change >= 0 ? '+' : '';
    var hasToday = Number.isFinite(f.today_profit);
    var hasProfit = Number.isFinite(f.total_profit);
    var hasRate = Number.isFinite(f.total_profit_rate);
    if (hasToday) todaySum += f.today_profit;
    totalVal += f.curr_value || 0;
    profitSum += hasProfit ? f.total_profit : 0;

    var yesterdayHtml = Number.isFinite(f.yesterday_change)
      ? ' · <span class="yest-chg ' + (f.yesterday_change >= 0 ? 'up' : 'down') + '">昨' + (f.yesterday_change >= 0 ? '+' : '') + fmt(f.yesterday_change) + '%</span>'
      : '';

    var fallbackTag = isFallback || f._cached
      ? ' <span class="cache-tag">备选</span>' : '';

    var profitRateHtml = hasRate
      ? ' <span class="profit-rate ' + (f.total_profit_rate >= 0 ? 'up' : 'down') + '">' + (f.total_profit_rate >= 0 ? '+' : '') + fmt(f.total_profit_rate) + '%</span>'
      : '';

    var isExpanded = expandedFund === f.code;
    var isWatchOnly = !f.shares;

    var watchTag = isWatchOnly ? ' <span class="watch-tag">仅关注</span>' : '';

    html += '<div class="fund-card ' + cc + (isExpanded ? ' expanded' : '') + (isWatchOnly ? ' watch-only' : '') + '" onclick="toggleFundDetail(\'' + f.code + '\')" title="点击展开详情">';
    html += '<div class="fund-top"><div><div class="fund-name">' + esc(f.name) + fallbackTag + watchTag + '</div><div class="fund-code">' + f.code + ' · ' + (f.nav_date||'') + yesterdayHtml + '</div></div>';
    html += '<div><div class="fund-pct ' + cc + '">' + (hasEst ? sign + fmt(f.est_change) + '%' : '--') + '</div><div class="fund-pct-time">' + (f.est_time||'--') + '</div></div></div>';

    html += '<div class="fund-stats">';
    html += '<div><div class="stat-label">盘中估值</div><div class="stat-val">' + fmt4(f.est_nav) + '</div></div>';
    html += '<div><div class="stat-label">上一净值</div><div class="stat-val">' + fmt4(f.last_nav) + '</div></div>';
    html += '<div><div class="stat-label">今日估算</div><div class="stat-val ' + (hasToday ? (f.today_profit>=0?'up':'down') : '') + '">' + (f.shares>0 && hasToday ? fmtM(f.today_profit) : '--') + '</div></div>';
    if (f.shares > 0) {
      html += '<div><div class="stat-label">持有份额</div><div class="stat-val">' + fmt(f.shares) + '</div></div>';
      html += '<div><div class="stat-label">持仓市值</div><div class="stat-val">' + fmt(f.curr_value) + '</div></div>';
      html += '<div><div class="stat-label">累计盈亏</div><div class="stat-val ' + (hasProfit ? (f.total_profit>=0?'up':'down') : '') + '">' + (hasProfit ? fmtM(f.total_profit) + profitRateHtml : '--') + '</div></div>';
    }
    html += '</div>';

    if (isExpanded) {
      html += '<div class="holdings-detail">';
      html += '<div class="holdings-actions"><button class="edit-holdings-btn" onclick="event.stopPropagation();editFund(\'' + f.code + '\')">编辑持仓</button></div>';

      // 重仓股
      if (holdingsCache[f.code] === undefined) {
        html += '<div class="holdings-loading">加载重仓股...</div>';
      } else if (!holdingsCache[f.code] || !holdingsCache[f.code].length) {
        html += '<div class="holdings-empty">暂无重仓股数据</div>';
      } else {
        html += '<div class="holdings-table"><div class="holdings-header"><span>股票名称</span><span>占比</span><span>涨跌幅</span></div>';
        holdingsCache[f.code].forEach(function(s) {
          var sc = Number.isFinite(s.change) ? (s.change >= 0 ? 'up' : 'down') : '';
          html += '<div class="holdings-row"><span class="stock-name">' + esc(s.name) + '<em>' + s.code + '</em></span><span>' + fmt(s.ratio) + '%</span><span class="' + sc + '">' + (Number.isFinite(s.change) ? (s.change >= 0 ? '+' : '') + fmt(s.change) + '%' : '--') + '</span></div>';
        });
        html += '</div>';
      }

      // 基金信息 & 费率
      var hasType = fundTypeCache[f.code] !== undefined;
      var hasFee = fundFeeCache[f.code] !== undefined;
      if (!hasType && !hasFee) {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        html += '<div class="rules-loading">加载中...</div>';
        html += '</div>';
      } else if (fundTypeCache[f.code] === null && fundFeeCache[f.code] === null) {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        html += '<div class="rules-empty">暂无数据</div>';
        html += '</div>';
      } else {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        if (fundTypeCache[f.code]) {
          var ti = fundTypeCache[f.code];
          html += '<div class="rules-table">';
          if (ti.type) html += '<div class="rules-row"><span class="rules-label">基金类型</span><span class="rules-val">' + esc(ti.type) + '</span></div>';
          if (ti.setupDate) html += '<div class="rules-row"><span class="rules-label">成立日期</span><span class="rules-val">' + esc(ti.setupDate) + '</span></div>';
          if (ti.scale) html += '<div class="rules-row"><span class="rules-label">基金规模</span><span class="rules-val">' + esc(ti.scale) + '</span></div>';
          if (ti.company) html += '<div class="rules-row"><span class="rules-label">管理人</span><span class="rules-val">' + esc(ti.company) + '</span></div>';
          if (ti.benchmark) html += '<div class="rules-row"><span class="rules-label">跟踪标的</span><span class="rules-val">' + esc(ti.benchmark) + '</span></div>';
          html += '</div>';
        }
        if (fundFeeCache[f.code]) {
          var fi = fundFeeCache[f.code];
          html += '<div class="rules-table" style="margin-top:6px">';
          if (fi.buyFee) html += '<div class="rules-row"><span class="rules-label">申购费率</span><span class="rules-val">' + esc(fi.buyFee) + '</span></div>';
          if (fi.sellFee) html += '<div class="rules-row"><span class="rules-label">赎回费率</span><span class="rules-val">' + esc(fi.sellFee) + '</span></div>';
          if (fi.manageFee) html += '<div class="rules-row"><span class="rules-label">管理费率</span><span class="rules-val">' + esc(fi.manageFee) + '</span></div>';
          if (fi.custodyFee) html += '<div class="rules-row"><span class="rules-label">托管费率</span><span class="rules-val">' + esc(fi.custodyFee) + '</span></div>';
          html += '</div>';
        }
        html += '</div>';
      }

      html += '</div>';
    }

    html += '</div>';
  });

  list.innerHTML = html;

  setSumVal('s-today', todaySum);
  document.getElementById('s-total').textContent = fmtM2(totalVal);
  document.getElementById('s-total').className = 'sum-val';
  setSumVal('s-profit', profitSum);

  updateSortBar();
}

function setSumVal(id, val) {
  const el = document.getElementById(id);
  el.textContent = fmtM(val);
  el.className = 'sum-val ' + (val > 0 ? 'up' : val < 0 ? 'down' : 'flat');
}

function fmt(n)  { return isNaN(n) ? '--' : Number(n).toFixed(2); }
function fmt4(n) { return isNaN(n) ? '--' : Number(n).toFixed(4); }
function fmtM(n) {
  if (isNaN(n)) return '--';
  const s = n >= 0 ? '+' : '';
  const a = Math.abs(n);
  return s + (a >= 10000 ? (n/10000).toFixed(2)+'万' : n.toFixed(2));
}
function fmtM2(n) {
  if (isNaN(n)) return '--';
  return n >= 10000 ? (n/10000).toFixed(2)+'万' : n.toFixed(2);
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 持仓编辑 ─────────────────────────────────────────────
function renderHoldingsList() {
  const list = document.getElementById('holdings-list');
  if (!holdings.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:4px 0">暂无持仓</div>';
    return;
  }
  list.innerHTML = holdings.map((h,i) => `
    <div class="holding-item" onclick="editFund('${h.code}')" style="cursor:pointer">
      <div>
        <div class="h-name">${esc(h.name||h.code)}</div>
        <div class="h-detail">${h.code} · ${h.shares}份 · 成本${h.cost}</div>
      </div>
      <button class="del-btn" onclick="event.stopPropagation();delFund(${i})">×</button>
    </div>`).join('');
}

function editFund(code) {
  const fund = holdings.find(h => h.code === code);
  if (!fund) return;
  editingCode = code;
  document.getElementById('i-code').value = fund.code;
  document.getElementById('i-code').disabled = true;
  document.getElementById('i-name').value = fund.name !== fund.code ? fund.name : '';
  document.getElementById('i-shares').value = fund.shares;
  document.getElementById('i-cost').value = fund.cost;
  document.getElementById('add-btn').textContent = '✓ 保存修改';
  document.getElementById('cancel-edit-btn').style.display = 'block';
  switchPage('edit');
}

function cancelEdit() {
  editingCode = null;
  document.getElementById('i-code').value = '';
  document.getElementById('i-code').disabled = false;
  document.getElementById('i-name').value = '';
  document.getElementById('i-shares').value = '';
  document.getElementById('i-cost').value = '';
  document.getElementById('add-btn').textContent = '+ 添加';
  document.getElementById('cancel-edit-btn').style.display = 'none';
}

function saveFund() {
  const code = document.getElementById('i-code').value.trim();
  const name = document.getElementById('i-name').value.trim();
  const shares = toNonNegativeNumber(document.getElementById('i-shares').value);
  const cost = toNonNegativeNumber(document.getElementById('i-cost').value);
  if (!code || !/^\d{6}$/.test(code)) { showToast('请输入6位数字基金代码'); return; }

  if (editingCode) {
    const idx = holdings.findIndex(h => h.code === editingCode);
    if (idx === -1) { showToast('基金不存在'); cancelEdit(); return; }
    holdings[idx].name = name || code;
    holdings[idx].shares = shares;
    holdings[idx].cost = cost;
    holdings[idx].updated_at = nowISO();
    saveHoldings();
    scheduleAutoPush();
    renderHoldingsList();
    cancelEdit();
    showToast('已更新 ' + (name || code));
    refresh();
  } else {
    if (holdings.find(h => h.code === code)) { showToast('该基金已在列表中'); return; }
    holdings.push({code, name: name||code, shares, cost, updated_at: nowISO()});
    saveHoldings();
    scheduleAutoPush();
    renderHoldingsList();
    document.getElementById('i-code').value='';
    document.getElementById('i-name').value='';
    document.getElementById('i-shares').value='';
    document.getElementById('i-cost').value='';
    showToast('已添加 ' + (name||code));
    refresh();
  }
}

function delFund(i) {
  const h = holdings[i];
  if (!confirm(`删除「${h.name||h.code}」？`)) return;
  holdings.splice(i,1);
  saveHoldings();
  scheduleAutoPush();
  renderHoldingsList();
  refresh();
}

// ── 页面切换 ─────────────────────────────────────────────
let lastEditPull = 0;
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  document.getElementById('nav-'+name).classList.add('active');
  if (name==='edit') {
    renderHoldingsList();
    renderCloudStatus();
    if (hasCloudConfig() && Date.now() - lastEditPull > TIMING.CLOUD_COOLDOWN_MS) {
      lastEditPull = Date.now();
      pullFromCloud(true);
    }
  }
  else if (editingCode) cancelEdit();
  if (name==='status') fetchDeploymentStatus();
}

// ── 指数行情条（腾讯行情 JSONP，全局可用无 CORS 限制） ────
function parseTencentQuote(raw) {
  // 腾讯行情返回 "~" 分隔字符串。实测所有指数（sh*/us*）字段布局一致：
  //   field 3 = 当前价, field 32 = 涨跌幅(%)
  if (!raw || typeof raw !== 'string') return null;
  var fields = raw.split('~');
  if (fields.length < 4) return null;
  var price = parseFloat(fields[3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  var changePct = parseFloat(fields[32]);
  if (!Number.isFinite(changePct)) {
    var prevClose = parseFloat(fields[4]);
    if (Number.isFinite(prevClose) && prevClose > 0) {
      changePct = (price - prevClose) / prevClose * 100;
    }
  }
  return { price: price, changePct: Number.isFinite(changePct) ? changePct : NaN };
}

// ── 黄金 AU9999 实时金价（新浪 JSONP + 东方财富 push2 + 持久缓存兜底） ──
function parseSinaGoldQuote(raw) {
  // 新浪 AU9999 返回逗号分隔: field[0]=名称, field[1]=今开, field[2]=昨收, field[3]=最新价
  if (!raw || typeof raw !== 'string') return null;
  var fields = raw.split(',');
  if (fields.length < 4) return null;
  var price = parseFloat(fields[3]);
  if (!isUsableNav(price)) return null;
  var prevClose = parseFloat(fields[2]);
  var changePct = NaN;
  if (Number.isFinite(prevClose) && prevClose > 0) {
    changePct = (price - prevClose) / prevClose * 100;
  }
  return { name: '黄金9999', price: price, changePct: changePct };
}

function parseTencentGoldQuote(raw) {
  // 腾讯国际贵金属行情逗号分隔：
  // field[0]=最新价(美元/盎司), field[1]=涨跌幅(%), field[12]=日期, field[13]=名称
  if (!raw || typeof raw !== 'string') return null;
  var fields = raw.split(',');
  if (fields.length < 14) return null;
  var price = parseNav(fields[0]);
  if (!isUsableNav(price)) return null;
  var changePct = parseNav(fields[1]);
  var quoteDate = fields[12] || '';
  if (quoteDate) {
    var d = new Date(quoteDate + 'T00:00:00');
    if (!isNaN(d.getTime()) && Date.now() - d.getTime() > 7 * 24 * 60 * 60 * 1000) return null;
  }
  var name = (fields[13] || '伦敦金').replace(/[（）]/g, function(ch) {
    return ch === '（' ? '(' : ')';
  });
  return { name: name, price: price, changePct: Number.isFinite(changePct) ? changePct : NaN };
}

function parseSinaGoldFutureQuote(raw) {
  if (!raw || typeof raw !== 'string') return null;
  var fields = raw.split(',');
  if (fields.length < 18) return null;
  var dateText = fields[17] || '';
  var quoteDate = dateText ? new Date(dateText + 'T00:00:00') : null;
  if (!quoteDate || isNaN(quoteDate.getTime())) return null;
  // AU0 偶尔会返回很旧的冻结数据，超过 7 天就不用，避免误导。
  if (Date.now() - quoteDate.getTime() > 7 * 24 * 60 * 60 * 1000) return null;
  var price = parseNav(fields[5]);
  if (!isUsableNav(price)) price = parseNav(fields[3]);
  if (!isUsableNav(price)) return null;
  var prevClose = parseNav(fields[10]);
  var changePct = (Number.isFinite(prevClose) && prevClose > 0)
    ? (price - prevClose) / prevClose * 100 : NaN;
  return { name: '黄金9999', price: price, changePct: changePct };
}

function loadGoldCache() {
  try {
    var raw = localStorage.getItem(GOLD_CACHE_KEY);
    var cache = raw ? JSON.parse(raw) : null;
    if (!cache || !Number.isFinite(cache.price)) return null;
    if (Date.now() - (cache.time || 0) > 7 * 24 * 60 * 60 * 1000) return null;
    return { name: '黄金9999', price: cache.price, changePct: cache.changePct };
  } catch(e) { return null; }
}

function saveGoldCache(result) {
  if (!result || !Number.isFinite(result.price)) return;
  goldCache = { price: result.price, changePct: result.changePct, time: Date.now() };
  try {
    localStorage.setItem(GOLD_CACHE_KEY, JSON.stringify(goldCache));
  } catch(e) {}
}

function fetchSinaGold(symbol, globalName, parser) {
  return new Promise(function(resolve) {
    var script = document.createElement('script');
    var done = false;
    var timer = setTimeout(function() {
      finish(null);
    }, TIMING.INDEX_JSONP_TIMEOUT);

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.remove();
      try { delete window[globalName]; } catch(e) {}
      resolve(result);
    }

    script.setAttribute('referrerpolicy', 'no-referrer');
    script.onload = function() {
      var parsed = null;
      try { parsed = parser(window[globalName]); } catch(e) {}
      finish(parsed);
    };
    script.onerror = function() { finish(null); };
    script.src = 'https://hq.sinajs.cn/list=' + symbol + '&_=' + Date.now();
    document.head.appendChild(script);
  });
}

function fetchTencentGold(symbol, globalName) {
  return new Promise(function(resolve) {
    var script = document.createElement('script');
    var done = false;
    var timer = setTimeout(function() {
      finish(null);
    }, TIMING.INDEX_JSONP_TIMEOUT);

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.remove();
      try { delete window[globalName]; } catch(e) {}
      resolve(result);
    }

    script.onload = function() {
      var parsed = null;
      try { parsed = parseTencentGoldQuote(window[globalName]); } catch(e) {}
      finish(parsed);
    };
    script.onerror = function() { finish(null); };
    script.src = 'https://qt.gtimg.cn/q=' + symbol + '&_t=' + Date.now();
    document.head.appendChild(script);
  });
}

function fetchGoldFromEastmoneySecid(secid) {
  return new Promise(function(resolve) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMING.INDEX_JSONP_TIMEOUT);
    fetch('https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid + '&fields=f43,f57,f60,f170&fltt=2&_=' + Date.now(), {
      signal: controller.signal
    }).then(function(resp) {
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function(json) {
      var d = json && json.data;
      // f43=最新价(盘中), f57=收盘价(盘后), f60=昨收
      var price = d ? parseNav(d.f43) : NaN;
      if (!isUsableNav(price)) price = d ? parseNav(d.f57) : NaN;
      if (!isUsableNav(price)) price = d ? parseNav(d.f60) : NaN;
      if (!isUsableNav(price)) throw new Error('无数据');
      var changePct = d ? parseNav(d.f170) : NaN;
      if (!Number.isFinite(changePct)) {
        var prevClose = parseNav(d.f60);
        changePct = (Number.isFinite(prevClose) && prevClose > 0)
          ? (price - prevClose) / prevClose * 100 : NaN;
      }
      resolve({ name: '黄金9999', price: price, changePct: changePct });
    }).catch(function() {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function fetchGoldFromEastmoney() {
  var secids = ['118.AU9999', '113.AU9999', '114.AU9999', '113.AU0', '114.AU0'];
  var results = await Promise.all(secids.map(function(secid) {
    return fetchGoldFromEastmoneySecid(secid);
  }));
  for (var i = 0; i < results.length; i++) {
    if (results[i] && Number.isFinite(results[i].price)) return results[i];
  }
  return null;
}

async function fetchGoldPrice() {
  var sources = [
    function() { return fetchTencentGold('hf_XAU', 'v_hf_XAU'); },
    function() { return fetchTencentGold('hf_GC', 'v_hf_GC'); },
    function() { return fetchSinaGold('au9999', 'hq_str_au9999', parseSinaGoldQuote); },
    function() { return fetchSinaGold('AU0', 'hq_str_AU0', parseSinaGoldFutureQuote); },
    fetchGoldFromEastmoney
  ];

  for (var i = 0; i < sources.length; i++) {
    try {
      var result = await sources[i]();
      if (result && Number.isFinite(result.price)) {
        saveGoldCache(result);
        return result;
      }
    } catch(e) {}
  }

  var cached = loadGoldCache();
  if (cached) return cached;
  if (Number.isFinite(goldCache.price)) {
    return { name: '黄金9999', price: goldCache.price, changePct: goldCache.changePct };
  }
  return { name: '黄金9999', price: NaN, changePct: NaN };
}

function fetchIndices() {
  // 金价：独立 fetch，与下方腾讯指数行情并行，互不阻塞
  fetchGoldPrice().then(function(gold) {
    if (!Number.isFinite(gold.price)) return;
    for (var i = 0; i < INDEX_CONFIG.length; i++) {
      if (INDEX_CONFIG[i].source === 'gold') {
        indexCache[i] = gold;
        renderIndexBar(indexCache);
        break;
      }
    }
  });

  try {
    var tencentItems = INDEX_CONFIG.filter(function(cfg) { return cfg.source !== 'gold'; });

    var codes = tencentItems.map(function(cfg) { return cfg.code; }).join(',');
    if (!codes) {
      if (indexCache.length) renderIndexBar(indexCache);
      return;
    }

    var script = document.createElement('script');
    var called = false;

    var timeout = setTimeout(function() {
      if (!called) {
        called = true;
        script.remove();
        if (indexCache.length) renderIndexBar(indexCache);
      }
    }, TIMING.INDEX_JSONP_TIMEOUT);

    script.onload = function() {
      clearTimeout(timeout);
      script.remove();
      if (called) return;
      called = true;

      var data = INDEX_CONFIG.map(function(cfg, i) {
        if (cfg.source === 'gold') return indexCache[i];
        try {
          var raw = window['v_' + cfg.code];
          delete window['v_' + cfg.code];
          var parsed = parseTencentQuote(raw);
          if (parsed && Number.isFinite(parsed.price)) {
            return { name: cfg.name, price: parsed.price, changePct: parsed.changePct };
          }
        } catch(e) {}
        return { name: cfg.name, price: NaN, changePct: NaN };
      });

      var anyOk = data.some(function(d) { return Number.isFinite(d.price); });
      if (anyOk) indexCache = data;
      renderIndexBar(anyOk ? data : indexCache);
    };

    script.onerror = function() {
      clearTimeout(timeout);
      script.remove();
      if (called) return;
      called = true;
      if (indexCache.length) renderIndexBar(indexCache);
    };

    script.src = 'https://qt.gtimg.cn/q=' + codes + '&_t=' + Date.now();
    document.head.appendChild(script);
  } catch(e) {
    if (indexCache.length) renderIndexBar(indexCache);
  }
}

function renderIndexBar(data) {
  var el = document.getElementById('index-bar-inner');
  if (!el || !data.length) return;
  var html = '';
  data.forEach(function(idx) {
    var hasData = Number.isFinite(idx.price);
    var cc = hasData ? (idx.changePct > 0 ? 'up' : idx.changePct < 0 ? 'down' : 'flat') : '';
    var sign = hasData && idx.changePct >= 0 ? '+' : '';
    html += '<div class="index-item">';
    html += '<div class="index-name">' + esc(idx.name) + '</div>';
    html += '<div class="index-price">' + (hasData ? fmt(idx.price) : '--') + '</div>';
    html += '<div class="index-change ' + cc + '">' + (hasData ? sign + fmt(idx.changePct) + '%' : '--') + '</div>';
    html += '</div>';
  });
  el.innerHTML = html;
}

function startIndexRefresh() {
  fetchIndices();
  // 指数行情跟随市场状态动态调整刷新间隔
  function scheduleNext() {
    var interval = getRefreshInterval();
    if (interval > 0) {
      setTimeout(function() {
        fetchIndices();
        scheduleNext();
      }, interval);
    } else {
      // 非交易时段：每 5 分钟检查一次是否进入交易时段，不浪费请求
      setTimeout(scheduleNext, 300000);
    }
  }
  scheduleNext();
}

// ── 市场状态 ─────────────────────────────────────────────
function updateMktStatus() {
  const now = new Date();
  const d = now.getDay();
  const t = now.getHours()*60 + now.getMinutes();
  let s = '';
  if (d===0||d===6) s='休市';
  else if (t>=570&&t<690) s='上午盘';
  else if (t>=780&&t<900) s='下午盘';
  else if (t>=900) s='已收盘';
  else s='盘前';
  document.getElementById('mkt-status').textContent = s;
}

// ── 智能自动刷新 ─────────────────────────────────────────
function getRefreshInterval() {
  const now = new Date();
  const d = now.getDay();
  const t = now.getHours() * 60 + now.getMinutes();
  if (d === 0 || d === 6) return 0;           // 周末不刷新
  if (t >= 565 && t < 690) return 60000;       // 上午盘 9:25-11:30 每60s
  if (t >= 690 && t < 780) return 0;           // 午休 11:30-13:00 不刷新
  if (t >= 780 && t < 900) return 60000;       // 下午盘 13:00-15:00 每60s
  if (t >= 900 && t < 930) return 120000;      // 收盘后 15:00-15:30 每120s
  return 0;                                     // 其余时段不自动刷新
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (getRefreshInterval() > 0) refresh();
  }, 60000);
}

// ── 收益日历 ─────────────────────────────────────────────
function loadDailyLog() {
  try {
    var raw = localStorage.getItem(DAILY_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveTodayLog() {
  var today = new Date().toISOString().slice(0, 10);
  var totalVal = 0, todayProfit = 0;
  fundsData.forEach(function(d) {
    if (d.status === 'ok' || d.status === 'ok_fallback') {
      if (Number.isFinite(d.curr_value)) totalVal += d.curr_value;
      if (Number.isFinite(d.today_profit)) todayProfit += d.today_profit;
    }
  });
  if (!totalVal && !todayProfit) return;

  var log = loadDailyLog();
  var entry = { date: today, todayProfit: Math.round(todayProfit * 100) / 100, totalValue: Math.round(totalVal * 100) / 100 };
  if (log.length && log[log.length - 1].date === today) {
    log[log.length - 1] = entry;
  } else {
    log.push(entry);
  }
  if (log.length > 90) log = log.slice(-90);
  localStorage.setItem(DAILY_LOG_KEY, JSON.stringify(log));
}

function renderDailyLog() {
  var container = document.getElementById('daily-log-list');
  if (!container) return;
  var log = loadDailyLog();
  if (!log.length) {
    container.innerHTML = '<div class="daily-empty">暂无历史记录，收盘后自动保存</div>';
    return;
  }
  var recent = log.slice(-30).reverse();
  var html = '';
  recent.forEach(function(d) {
    var pc = d.todayProfit >= 0 ? 'up' : 'down';
    var sign = d.todayProfit >= 0 ? '+' : '';
    html += '<div class="daily-row"><span class="daily-date">' + d.date.slice(5) + '</span><span class="daily-profit ' + pc + '">' + sign + fmtM(d.todayProfit) + '</span><span class="daily-value">' + fmtM2(d.totalValue) + '</span></div>';
  });
  container.innerHTML = html;
}

// ── Toast ────────────────────────────────────────────────
function showToast(msg, ms=2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
}

// ── 获取部署状态 ─────────────────────────────────────────
async function fetchDeploymentStatus() {
  const REPO = 'AureliusWu/FundVal';
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=1`);
    if (!response.ok) throw new Error('请求失败');
    const commits = await response.json();
    if (!commits || commits.length === 0) {
      document.getElementById('status-time').textContent = '未找到提交';
      return;
    }
    const commit = commits[0];
    const date = new Date(commit.commit.author.date);
    const timeStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
    document.getElementById('status-time').textContent = timeStr;
    document.getElementById('status-commit').textContent = commit.commit.message.split('\n')[0];
    document.getElementById('status-hash').textContent = commit.sha.substring(0, 7);
  } catch(err) {
    document.getElementById('status-time').textContent = '获取失败（检查网络）';
    document.getElementById('status-commit').textContent = '--';
    document.getElementById('status-hash').textContent = '--';
  }
}

// ── Service Worker（含自动更新检测） ──────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(function(reg) {
    // 监听新版本安装完成
    reg.addEventListener('updatefound', function() {
      var newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', function() {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('✨ 有新版本可用，刷新页面即可更新', 6000);
        }
      });
    });
    // 每 30 分钟主动检查更新
    setInterval(function() { reg.update(); }, TIMING.SW_UPDATE_MS);
  }).catch(function() {});
}

// ── 页面可见性：切回标签页立即拉取（30s 冷却） ──────────
let lastVisibilityPull = 0;
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && hasCloudConfig() && Date.now() - lastVisibilityPull > TIMING.CLOUD_COOLDOWN_MS) {
    lastVisibilityPull = Date.now();
    pullFromCloud(true);
  }
});

// ── 初始化 ───────────────────────────────────────────────
loadHoldings();
updateMktStatus();
setInterval(updateMktStatus, TIMING.MKT_STATUS_MS);
refresh();
startAutoRefresh();
startIndexRefresh();
autoPullOnLoad();
startAutoPull();
if (getGistToken()) document.getElementById('gist-token').value = getGistToken();
