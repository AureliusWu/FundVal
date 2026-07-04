const STORAGE_KEY = 'fuyu_holdings_v1';
const CACHE_KEY = 'fuyu_funds_cache_v1';
const GIST_TOKEN_KEY = 'fuyu_gist_token';
const GIST_ID_KEY = 'fuyu_gist_id';
const GIST_SYNC_TIME_KEY = 'fuyu_gist_sync_time';
const GIST_FILENAME = 'fuyu-holdings.json';
const SYNC_META_KEY = 'fuyu_sync_meta_v1';
const GOLD_CACHE_KEY = 'fuyu_gold_cache_v2';
const NOTIFY_DATE_KEY = 'fuyu_notify_1430_date_v1';
const APP_VERSION = 'V8.0.11';   // 应用版本号，与 sw.js 的 CACHE 版本保持一致，每次发布同步 bump
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
  CLOUD_COOLDOWN_MS: 30000,       // 切 Tab 云端拉取冷却
  DAILY_NOTIFY_CHECK_MS: 30000    // 14:30 通知检查间隔
};
// ── 缓存持久化黑名单（这些字段为瞬时 UI 状态，不写入 localStorage） ──
const SKIP_CACHE_KEYS = ['_cached', 'message'];
// ── 指数行情配置（腾讯 JSONP + 黄金 AU9999 独立源） ──
const INDEX_CONFIG = [
  { code: 'AU9999',   name: '黄金9999', source: 'gold' },
  { code: 'sh000001', name: '上证' },
  { code: 'sh000300', name: '沪深300' },
  { code: 'usNDX',    name: '纳指100' },
  { code: 'usINX',    name: '标普500' }
];

const OVERSEAS_MODEL_BY_CODE = {
  // 2026Q1 public holdings from EastMoney jjcc. Use live constituent quotes when
  // available, then normalize by the usable weight. KR names fall back to EWY.
  '539002': {
    label: '2026Q1重仓穿透模型',
    minWeight: 30,
    fallback: { legs: [{ code: 'usSMH', weight: 70 }, { code: 'usEWY', weight: 20 }, { code: 'usEEM', weight: 10 }], label: '半导体+韩国兜底模型' },
    legs: [
      { code: 'usTSM', weight: 10.26 },
      { code: 'usNVDA', weight: 10.14 },
      { code: 'usEWY', weight: 8.65, note: 'SK海力士代理' },
      { code: 'usAVGO', weight: 8.52 },
      { code: 'usEWY', weight: 6.76, note: '三星电子代理' },
      { code: 'usSNDK', weight: 4.91 },
      { code: 'usGLW', weight: 4.29 },
      { code: 'usWDC', weight: 3.73 },
      { code: 'usLITE', weight: 3.58 },
      { code: 'usMPWR', weight: 3.49 }
    ]
  },
  '012920': {
    label: '2026Q1风格因子模型',
    minWeight: 100,
    adjustment: { scale: 1.4 },
    fallback: {
      label: '2026Q1重仓穿透模型',
      minWeight: 25,
      legs: [
        { code: 'usTSM', weight: 8.88 },
        { code: 'usLITE', weight: 8.68 },
        { code: 'sz300502', weight: 6.02 },
        { code: 'usGLW', weight: 4.67 },
        { code: 'usAXTI', weight: 4.67 },
        { code: 'sz300308', weight: 4.67 },
        { code: 'sh688498', weight: 4.49 },
        { code: 'usTSEM', weight: 3.72 },
        { code: 'usGOOGL', weight: 3.36 },
        { code: 'sz002384', weight: 2.67 }
      ]
    },
    legs: [
      { code: 'usQQQ', weight: 45 },
      { code: 'usSOXX', weight: 30 },
      { code: 'sh000300', weight: 25 }
    ]
  },
  '018147': {
    label: '2026Q1重仓穿透模型',
    minWeight: 30,
    fallback: { legs: [{ code: 'usSMH', weight: 70 }, { code: 'usEWY', weight: 20 }, { code: 'usEEM', weight: 10 }], label: '半导体+韩国兜底模型' },
    legs: [
      { code: 'usTSM', weight: 10.26 },
      { code: 'usNVDA', weight: 10.14 },
      { code: 'usEWY', weight: 8.65, note: 'SK海力士代理' },
      { code: 'usAVGO', weight: 8.52 },
      { code: 'usEWY', weight: 6.76, note: '三星电子代理' },
      { code: 'usSNDK', weight: 4.91 },
      { code: 'usGLW', weight: 4.29 },
      { code: 'usWDC', weight: 3.73 },
      { code: 'usLITE', weight: 3.58 },
      { code: 'usMPWR', weight: 3.49 }
    ]
  }
};

const OVERSEAS_MODEL_RULES = [
  { re: /新兴市场|新兴|印度|越南|东盟|亚洲/i, legs: [{ code: 'usEEM', weight: 1 }], label: '新兴市场EEM模型' },
  { re: /中国互联网|中概|海外互联网|互联网/i, legs: [{ code: 'r_hkHSTECH', weight: 0.5 }, { code: 'usQQQ', weight: 0.5 }], label: '中概互联网模型' },
  { re: /恒生科技|港股科技/i, legs: [{ code: 'r_hkHSTECH', weight: 1 }], label: '恒生科技模型' },
  { re: /恒生|港股|香港/i, legs: [{ code: 'r_hkHSI', weight: 1 }], label: '恒生模型' },
  { re: /纳斯达克100|纳指100|NASDAQ\s*100|Nasdaq\s*100|纳斯达克/i, legs: [{ code: 'usQQQ', weight: 1 }], label: '纳指100ETF模型' },
  { re: /科技|成长|创新|互联网|AI|人工智能|半导体|信息技术/i, legs: [{ code: 'usQQQ', weight: 0.75 }, { code: 'usSPY', weight: 0.25 }], label: '全球成长模型' },
  { re: /标普|S&P|SP500|500/i, legs: [{ code: 'usSPY', weight: 1 }], label: '标普500ETF模型' },
  { re: /黄金|金价|贵金属|Gold/i, legs: [{ code: 'AU9999', weight: 1 }], label: '黄金模型' },
  { re: /全球|海外|美国|美元|QDII/i, legs: [{ code: 'usSPY', weight: 0.6 }, { code: 'usQQQ', weight: 0.4 }], label: '全球股市模型' }
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
let navMoveQueue = Promise.resolve(); // pingzhongdata 共用 Data_netWorthTrend，全局变量需串行读取
let isRefreshing = false;
let refreshQueued = false;
let autoRefreshTimer = null;
let syncPending = false;       // 是否有待推送的本地变更
let syncDebounceTimer = null;  // 防抖定时器
let autoPullTimer = null;      // 定时拉取
let isSyncing = false;         // 是否正在同步中
let goldCache = { price: NaN, changePct: NaN, time: 0 };  // 金价缓存，API 全部失败时兜底
let notificationPrompted = false;

// ── 清理过期 tombstone（删除标记保留30天，供多设备同步消费后自动清理） ──
function pruneOldTombstones() {
  var cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  var before = holdings.length;
  holdings = holdings.filter(function(h) {
    return !h.deleted || (h.updated_at && h.updated_at > cutoff);
  });
  if (holdings.length !== before) saveHoldings();
}

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
  pruneOldTombstones();
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
    var deleted = item.deleted === true;
    acc.push({code, name: name || code, shares, cost, updated_at, deleted});
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
// 返回"UTC值等于北京时间"的 Date，用于所有市场时段判断
// 防止非 CST 时区设备（如 JST）导致刷新策略、市场状态、日志保存偏移1小时
function getChinaDate() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}

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
    for (var page = 1; page <= 5; page++) {
      var resp = await fetch('https://api.github.com/gists?per_page=100&page=' + page, {
        headers: { 'Authorization': 'token ' + token }
      });
      if (!resp.ok) return null;
      var gists = await resp.json();
      if (!gists.length) return null;  // 无更多数据
      for (var i = 0; i < gists.length; i++) {
        if (gists[i].files && gists[i].files[GIST_FILENAME]) {
          return gists[i].id;
        }
      }
      if (gists.length < 100) return null;  // 最后一页，没找到
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
    var normalized = normalizeFundEstimate(data);
    entry.resolve({
      code: code,
      name: data.name || code,
      last_nav: normalized.last_nav,
      est_nav: normalized.est_nav,
      est_change: normalized.est_change,
      nav_date: data.jzrq || '',
      est_time: data.gztime || '',
      est_label: normalized.est_label,
      est_kind: normalized.est_kind,
      est_realtime: normalized.est_realtime,
      est_note: normalized.est_note,
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
      yesterday_change: parseNav(json.data.f170),   // f170=涨跌幅(%)，原来误用f169当百分比显示
      nav_change_amt: parseNav(json.data.f169)       // f169=涨跌额(元/份)，用于推算今日盈亏
    };
  } catch(e) {
    return {code, status:'error', message:'备选源不可用'};
  }
}

function formatChinaDateFromMs(ms) {
  var d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function fetchLatestNavMove(code) {
  var task = navMoveQueue.then(function() { return fetchLatestNavMoveRaw(code); });
  navMoveQueue = task.catch(function() {});
  return task;
}

function fetchLatestNavMoveRaw(code) {
  return new Promise(function(resolve) {
    var script = document.createElement('script');
    var done = false;
    var timer = setTimeout(function() { finish(null); }, TIMING.FUND_JSONP_TIMEOUT);

    function finish(move) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.remove();
      try { window.Data_netWorthTrend = undefined; } catch(e) {}
      resolve(move);
    }

    script.onload = function() {
      try {
        var arr = window.Data_netWorthTrend;
        if (!Array.isArray(arr) || arr.length < 2) { finish(null); return; }
        var cur = arr[arr.length - 1];
        var prev = arr[arr.length - 2];
        var nav = parseNav(cur && cur.y);
        var prevNav = parseNav(prev && prev.y);
        if (!isUsableNav(nav) || !isUsableNav(prevNav)) { finish(null); return; }
        finish({
          date: formatChinaDateFromMs(cur.x),
          prevDate: formatChinaDateFromMs(prev.x),
          nav: nav,
          prevNav: prevNav,
          change: (nav - prevNav) / prevNav * 100,
          changeAmt: nav - prevNav
        });
      } catch(e) {
        finish(null);
      }
    };
    script.onerror = function() { finish(null); };
    script.src = 'https://fund.eastmoney.com/pingzhongdata/' + code + '.js?v=' + Date.now();
    document.head.appendChild(script);
  });
}

// ── 合并获取：主源 + 备选源并行 ──────────────────────────
async function fetchFundFull(code) {
  const [primary, em, navMove] = await Promise.all([
    fetchFund(code),
    fetchFromEastmoney(code),
    fetchLatestNavMove(code)
  ]);

  if (primary.status !== 'ok') {
    if (em.status === 'ok_fallback') {
      return { ...em, name: primary.name || code, status: 'ok_fallback', latest_nav_move: navMove };
    }
    return primary;
  }

  if (em.status === 'ok_fallback') {
    primary.yesterday_change = em.yesterday_change;
    primary.nav_change_amt = em.nav_change_amt;
  }
  primary.latest_nav_move = navMove;
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

  try {
    if (holdings.filter(h => !h.deleted).length === 0) {
      renderFundList([]);
      return;
    }

    const snapshot = holdings.filter(h => !h.deleted).map(h => ({...h}));
    const [results, modelQuotes] = await Promise.all([
      Promise.all(snapshot.map(h => fetchFundFull(h.code))),
      fetchOverseasModelQuotes()
    ]);

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

      applyOverseasModelEstimate(d, modelQuotes);

      const hasEstNav = isUsableNav(d.est_nav);
      const hasEstChange = Number.isFinite(d.est_change);
      const hasLast = isUsableNav(d.last_nav);
      const canDeriveEstNav = !hasEstNav && hasLast && hasEstChange;
      if (canDeriveEstNav) d.est_nav = d.last_nav * (1 + d.est_change / 100);
      const hasEst = isUsableNav(d.est_nav);
      const dailyMove = preferredDailyMove(d);
      d.primary_change = dailyMove ? dailyMove.change : d.est_change;
      d.primary_nav = dailyMove && isUsableNav(dailyMove.nav) ? dailyMove.nav : d.est_nav;
      d.primary_base_nav = dailyMove && isUsableNav(dailyMove.baseNav) ? dailyMove.baseNav : d.last_nav;
      d.primary_label = dailyMove ? dailyMove.label : '';
      d.primary_note = dailyMove ? dailyMove.sourceNote : '';
      d.today_is_latest_nav = Boolean(dailyMove && dailyMove.isLatestNav);

      if ((d.status === 'ok' || d.status === 'ok_fallback') && (hasEst || hasLast || hasEstChange)) {
        if (d.shares > 0) {
          // 有持仓 → 计算盈亏
          if (dailyMove && isUsableNav(dailyMove.nav) && isUsableNav(dailyMove.baseNav)) {
            var curr = dailyMove.nav * d.shares;
            d.today_profit = (dailyMove.nav - dailyMove.baseNav) * d.shares;
            d.total_profit = curr - d.cost * d.shares;
            d.total_profit_rate = (d.cost > 0) ? (d.total_profit / (d.cost * d.shares) * 100) : NaN;
            d.curr_value = curr;
          } else if (hasEst && hasLast) {
            var currEst = d.est_nav * d.shares;
            d.today_profit = (d.est_nav - d.last_nav) * d.shares;
            d.total_profit = currEst - d.cost * d.shares;
            d.total_profit_rate = (d.cost > 0) ? (d.total_profit / (d.cost * d.shares) * 100) : NaN;
            d.curr_value = currEst;
          } else if (hasLast) {
            d.curr_value = d.last_nav * d.shares;
            d.total_profit = d.curr_value - d.cost * d.shares;
            d.total_profit_rate = (d.cost > 0) ? (d.total_profit / (d.cost * d.shares) * 100) : NaN;
            // 没有盘中估算净值时（QDII常见、或主源失败降级），
            // 用备源的「净值日增长值」直接推算最近一次盈亏，避免一直显示 --
            if (Number.isFinite(d.nav_change_amt)) {
              d.today_profit = d.nav_change_amt * d.shares;
              d.today_is_latest_nav = true;  // 标记：非盘中实时估算，是最近一次已公布净值的涨跌
            } else {
              d.today_profit = NaN;
            }
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

      if ((d.status === 'ok' || d.status === 'ok_fallback') && !hasLast && !hasEst && !hasEstChange) {
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
  } catch(e) {
    if (!tryShowCache()) renderFundList([]);
  } finally {
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

function isOverseasFundEstimate(name, estTime) {
  var text = String(name || '');
  var isOverseasFund = /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(text);
  var m = String(estTime || '').match(/\s(\d{1,2}):(\d{2})$/);
  var hour = m ? Number(m[1]) : NaN;
  return isOverseasFund && Number.isFinite(hour) && (hour < 9 || hour >= 15);
}

function isOverseasLikeFund(fund) {
  if (fund && (fund.est_kind === 'overseas' || fund.est_kind === 'overseas_model')) return true;
  var text = String((fund && (fund.name || fund.type)) || '');
  return /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(text);
}

function navMoveFromEastmoneyFields(fund) {
  if (!fund || !Number.isFinite(fund.yesterday_change) || !isUsableNav(fund.last_nav)) return null;
  var changeAmt = Number.isFinite(fund.nav_change_amt)
    ? fund.nav_change_amt
    : fund.last_nav * fund.yesterday_change / (100 + fund.yesterday_change);
  var prevNav = fund.last_nav - changeAmt;
  if (!isUsableNav(prevNav)) return null;
  return {
    date: fund.nav_date || '',
    prevDate: '',
    nav: fund.last_nav,
    prevNav: prevNav,
    change: fund.yesterday_change,
    changeAmt: changeAmt
  };
}

function latestNavMoveOf(fund) {
  if (fund && fund.latest_nav_move && Number.isFinite(fund.latest_nav_move.change)) return fund.latest_nav_move;
  return navMoveFromEastmoneyFields(fund);
}

function preferredDailyMove(fund) {
  var move = latestNavMoveOf(fund);
  if (move && isOverseasLikeFund(fund)) {
    return {
      change: move.change,
      baseNav: move.prevNav,
      nav: move.nav,
      label: '净',
      sourceNote: '最新公布净值涨跌' + (move.prevDate || move.date ? '：' + [move.prevDate, move.date].filter(Boolean).join(' → ') : ''),
      isLatestNav: true
    };
  }
  if (fund && Number.isFinite(fund.est_change) && isUsableNav(fund.last_nav)) {
    return {
      change: fund.est_change,
      baseNav: fund.last_nav,
      nav: isUsableNav(fund.est_nav) ? fund.est_nav : fund.last_nav * (1 + fund.est_change / 100),
      label: fund.est_realtime === false ? '海外非实时' : '估',
      sourceNote: fund.est_note || '',
      isLatestNav: false
    };
  }
  return null;
}

function normalizeFundEstimate(data) {
  var lastNav = parseNav(data.dwjz);
  var estNav = parseNav(data.gsz);
  var estChange = parseNav(data.gszzl);

  if (!Number.isFinite(estChange) && isUsableNav(lastNav) && isUsableNav(estNav)) {
    estChange = (estNav - lastNav) / lastNav * 100;
  }
  if (!isUsableNav(estNav) && isUsableNav(lastNav) && Number.isFinite(estChange)) {
    estNav = lastNav * (1 + estChange / 100);
  }

  var overseas = isOverseasFundEstimate(data.name, data.gztime);
  return {
    last_nav: lastNav,
    est_nav: estNav,
    est_change: estChange,
    est_kind: overseas ? 'overseas' : 'intraday',
    est_label: overseas ? '海外估值' : '盘中估值',
    est_realtime: !overseas,
    est_note: overseas
      ? '天天基金当前仅返回海外基金收盘后/延迟估值，未提供实时盘中估值'
      : '天天基金盘中估值'
  };
}

function fetchTencentQuotes(codes) {
  return new Promise(function(resolve) {
    var script = document.createElement('script');
    var done = false;
    var timer = setTimeout(function() { finish(false); }, TIMING.INDEX_JSONP_TIMEOUT);

    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.remove();
      var out = {};
      codes.forEach(function(code) {
        var parsed = null;
        try {
          parsed = ok ? parseTencentQuote(window['v_' + code]) : null;
          delete window['v_' + code];
        } catch(e) {}
        out[code] = parsed;
      });
      resolve(out);
    }

    script.onload = function() { finish(true); };
    script.onerror = function() { finish(false); };
    script.src = 'https://qt.gtimg.cn/q=' + codes.join(',') + '&_t=' + Date.now();
    document.head.appendChild(script);
  });
}

async function fetchOverseasModelQuotes() {
  var tencentCodes = ['usEEM', 'usQQQ', 'usSPY', 'usNDX', 'usIXIC', 'usINX', 'usSMH', 'usSOXX', 'usEWY', 'r_hkHSTECH', 'r_hkHSI'];
  collectOverseasModelCodes(OVERSEAS_MODEL_BY_CODE, tencentCodes);
  collectOverseasModelCodes(OVERSEAS_MODEL_RULES, tencentCodes);
  var results = await Promise.all([fetchTencentQuotes(tencentCodes), fetchGoldPrice()]);
  var q = results[0] || {};
  var gold = results[1];
  if (gold && Number.isFinite(gold.changePct)) {
    q.AU9999 = { price: gold.price, changePct: gold.changePct };
  }
  return q;
}

function collectOverseasModelCodes(models, out) {
  var seen = {};
  out.forEach(function(code) { seen[code] = true; });
  var list = Array.isArray(models) ? models : Object.keys(models || {}).map(function(k) { return models[k]; });
  list.forEach(function(model) {
    var legs = [];
    if (model && Array.isArray(model.legs)) legs = legs.concat(model.legs);
    if (model && model.fallback && Array.isArray(model.fallback.legs)) legs = legs.concat(model.fallback.legs);
    legs.forEach(function(leg) {
      if (leg && leg.code && !seen[leg.code]) {
        seen[leg.code] = true;
        out.push(leg.code);
      }
    });
  });
}

function chooseOverseasModel(fund) {
  var code = String(fund && fund.code || '');
  var text = String(fund && fund.name || '');
  if (OVERSEAS_MODEL_BY_CODE[code]) return OVERSEAS_MODEL_BY_CODE[code];
  for (var i = 0; i < OVERSEAS_MODEL_RULES.length; i++) {
    if (OVERSEAS_MODEL_RULES[i].re.test(text)) return OVERSEAS_MODEL_RULES[i];
  }
  return null;
}

function calcModelChange(model, quotes) {
  var sum = 0;
  var weight = 0;
  var usable = [];
  for (var i = 0; i < model.legs.length; i++) {
    var leg = model.legs[i];
    var quote = quotes && quotes[leg.code];
    if (!quote || !Number.isFinite(quote.changePct)) continue;
    sum += quote.changePct * leg.weight;
    weight += leg.weight;
    usable.push(leg);
  }
  var minWeight = Number.isFinite(model.minWeight) ? model.minWeight : 0;
  if (weight <= 0 || weight < minWeight) return { changePct: NaN, weight: weight, legs: usable };
  var rawChange = sum / weight;
  var scale = model.adjustment && Number.isFinite(model.adjustment.scale) ? model.adjustment.scale : 1;
  var bias = model.adjustment && Number.isFinite(model.adjustment.bias) ? model.adjustment.bias : 0;
  return { changePct: rawChange * scale + bias, weight: weight, legs: usable };
}

function applyOverseasModelEstimate(fund, quotes) {
  if (!fund || fund.est_realtime !== false) return;
  var model = chooseOverseasModel(fund);
  if (!model) return;
  var result = calcModelChange(model, quotes);
  if ((!result || !Number.isFinite(result.changePct)) && model.fallback) {
    result = calcModelChange(model.fallback, quotes);
    if (result && Number.isFinite(result.changePct)) model = model.fallback;
  }
  var changePct = result && result.changePct;
  if (!Number.isFinite(changePct)) return;

  fund.est_change = changePct;
  if (isUsableNav(fund.last_nav)) {
    fund.est_nav = fund.last_nav * (1 + changePct / 100);
  }
  fund.est_kind = 'overseas_model';
  fund.est_label = '海外模型估算';
  fund.est_realtime = true;
  fund.est_model = true;
  fund.est_model_code = model.legs.map(function(leg) { return leg.code + ':' + leg.weight; }).join(',');
  fund.est_model_label = model.label;
  fund.est_model_weight = result.weight;
  fund.est_note = model.label + ' · 可用权重' + fmt(result.weight) + '% · 基于实时市场行情自建估算，不是基金官方实时净值';
}

// ── 排序 ─────────────────────────────────────────────────
function safeN(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function displayChangeOf(fund) {
  if (fund && Number.isFinite(fund.primary_change)) return fund.primary_change;
  var move = preferredDailyMove(fund);
  return move ? move.change : NaN;
}

function sortFunds(data) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    const va = (a.status === 'ok' || a.status === 'ok_fallback') ? a : null;
    const vb = (b.status === 'ok' || b.status === 'ok_fallback') ? b : null;
    if (va && !vb) return -1;
    if (!va && vb) return 1;
    if (!va && !vb) return 0;
    switch (sortBy) {
      case 'est_change_desc': return safeN(displayChangeOf(b), -Infinity) - safeN(displayChangeOf(a), -Infinity);
      case 'est_change_asc':  return safeN(displayChangeOf(a),  Infinity) - safeN(displayChangeOf(b),  Infinity);
      case 'today_profit_desc': return safeN(b.today_profit, -Infinity) - safeN(a.today_profit, -Infinity);
      case 'today_profit_asc':  return safeN(a.today_profit,  Infinity) - safeN(b.today_profit,  Infinity);
      case 'curr_value_desc': return safeN(b.curr_value, 0) - safeN(a.curr_value, 0);
      case 'curr_value_asc':  return safeN(a.curr_value, 0) - safeN(b.curr_value, 0);
      case 'total_profit_desc': return safeN(b.total_profit, -Infinity) - safeN(a.total_profit, -Infinity);
      case 'total_profit_asc':  return safeN(a.total_profit,  Infinity) - safeN(b.total_profit,  Infinity);
      case 'profit_rate_desc': return safeN(b.total_profit_rate, -Infinity) - safeN(a.total_profit_rate, -Infinity);
      case 'profit_rate_asc':  return safeN(a.total_profit_rate,  Infinity) - safeN(b.total_profit_rate,  Infinity);
      default: return 0;
    }
  });
  return sorted;
}

function toggleEstSort() {
  sortBy = (sortBy === 'est_change_desc') ? 'est_change_asc' : 'est_change_desc';
  renderFundList(fundsData);
}

function updateSortBar() {
  var btn = document.getElementById('sort-est-btn');
  if (btn) btn.textContent = '估值涨跌 ' + (sortBy === 'est_change_desc' ? '↓' : '↑');
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
      code: (codeEl ? codeEl.textContent : cells[1].textContent || '').trim(),
      name: (nameEl ? nameEl.textContent : cells[2].textContent || '').trim(),
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
    return;
  }

  var sorted = sortFunds(data);
  var html = '';

  sorted.forEach(function(f) {
    var isFallback = f.status === 'ok_fallback';
    if (f.status !== 'ok' && !isFallback) {
      html += '<div class="fund-card"><div class="fund-main"><div class="fund-id"><div class="fund-name">' + esc(f.name||f.code) + '</div><div class="fund-code">' + f.code + '</div></div></div><div class="fund-error">获取失败 · ' + esc(f.message||'') + '</div></div>';
      return;
    }
    var displayChange = displayChangeOf(f);
    var hasEst = Number.isFinite(displayChange);
    var cc = hasEst ? (displayChange > 0 ? 'up' : displayChange < 0 ? 'down' : 'flat') : '';
    var sign = hasEst && displayChange >= 0 ? '+' : '';
    var hasToday = Number.isFinite(f.today_profit);
    var hasProfit = Number.isFinite(f.total_profit);
    var hasRate = Number.isFinite(f.total_profit_rate);
    var yesterdayHtml = Number.isFinite(f.yesterday_change)
      ? ' · <span class="yest-chg ' + (f.yesterday_change >= 0 ? 'up' : 'down') + '">昨' + (f.yesterday_change >= 0 ? '+' : '') + fmt(f.yesterday_change) + '%</span>'
      : '';

    // 「缓存」= 离线旧数据（整批来自 localStorage 兜底）；「备选」= 实时拉取但主源失败、降级到东财备源
    var sourceTag = f._cached
      ? ' <span class="cache-tag">缓存</span>'
      : (isFallback ? ' <span class="cache-tag">备选</span>' : '');
    var estimateTag = f.est_model
      ? ' <span class="cache-tag">模型估算</span>'
      : (f.est_realtime === false ? ' <span class="cache-tag">海外非实时</span>' : '');
    if (f.today_is_latest_nav) estimateTag += ' <span class="cache-tag">最新净值</span>';
    var estimateLabel = f.est_model ? '海外模型估算' : (f.est_realtime === false ? '海外非实时估值' : (f.est_label || '盘中估值'));
    var estimateTime = f.est_model
      ? (f.est_model_label || '模型估算')
      : (f.est_realtime === false && f.est_time ? '非实时 · ' + f.est_time : (f.est_time || '--'));
    if (f.today_is_latest_nav) {
      estimateLabel = '最新净值涨跌';
      estimateTime = f.primary_note || f.nav_date || estimateTime;
    }

    var profitRateHtml = hasRate
      ? ' <span class="profit-rate ' + (f.total_profit_rate >= 0 ? 'up' : 'down') + '">' + (f.total_profit_rate >= 0 ? '+' : '') + fmt(f.total_profit_rate) + '%</span>'
      : '';

    var isExpanded = expandedFund === f.code;
    var isWatchOnly = !f.shares;

    var watchTag = isWatchOnly ? ' <span class="watch-tag">仅关注</span>' : '';

    html += '<div class="fund-card ' + cc + (isExpanded ? ' expanded' : '') + (isWatchOnly ? ' watch-only' : '') + '" onclick="toggleFundDetail(\'' + f.code + '\')" title="点击展开详情">';
    html += '<div class="fund-main">';
    html += '<div class="fund-id"><div class="fund-name">' + esc(f.name) + sourceTag + watchTag + estimateTag + '</div><div class="fund-code">' + f.code + ' · ' + (f.nav_date||'') + yesterdayHtml + '</div></div>';
    html += '<div class="fund-est"><div class="fund-pct ' + cc + '">' + (hasEst ? sign + fmt(displayChange) + '%' : '--') + '</div><div class="fund-pct-time">' + estimateTime + '</div></div>';
    html += '<div class="fund-nav"><div class="nav-cur">' + fmt4(f.primary_nav || f.est_nav) + '</div><div class="nav-prev">' + fmt4(f.primary_base_nav || f.last_nav) + '</div></div>';
    html += '</div>';

    if (isExpanded) {
      var todayTag = f.today_is_latest_nav ? ' <span class="cache-tag">最新净值</span>' : '';
      var estimateNote = f.est_note && !f.today_is_latest_nav ? '<div class="cache-note">' + esc(f.est_note) + '</div>' : '';
      var primaryNote = f.primary_note && f.primary_note !== f.est_note ? '<div class="cache-note">' + esc(f.primary_note) + '</div>' : '';
      var modelNote = f.today_is_latest_nav && f.est_model && Number.isFinite(f.est_change)
        ? '<div class="cache-note">下一净值模型：' + (f.est_change >= 0 ? '+' : '') + fmt(f.est_change) + '%，估算净值 ' + fmt4(f.est_nav) + '。' + esc(f.est_note || '') + '</div>'
        : '';
      var refCols = f.shares > 0 ? 3 : 2;
      html += '<div class="holdings-detail">';

      // 折叠的次要数据：盘中/上一净值（手机端，PC 已在行内列显示故隐藏）+ 持仓金额
      html += '<div class="detail-stats">';
      html += '<div class="detail-nav stats-grid" style="grid-template-columns:repeat(' + refCols + ',1fr)">';
      html += '<div><div class="stat-label">' + estimateLabel + '</div><div class="stat-val">' + fmt4(f.primary_nav || f.est_nav) + '</div>' + primaryNote + estimateNote + modelNote + '</div>';
      html += '<div><div class="stat-label">基准净值</div><div class="stat-val">' + fmt4(f.primary_base_nav || f.last_nav) + '</div></div>';
      if (f.shares > 0) {
        html += '<div><div class="stat-label">持有份额</div><div class="stat-val">' + fmt(f.shares) + '</div></div>';
      }
      html += '</div>';
      if (f.shares > 0) {
        html += '<div class="detail-money stats-grid">';
        html += '<div><div class="stat-label">今日估算' + todayTag + '</div><div class="stat-val money ' + (hasToday ? (f.today_profit>=0?'up':'down') : '') + '">' + (hasToday ? fmtM(f.today_profit) : '--') + '</div></div>';
        html += '<div><div class="stat-label">累计盈亏</div><div class="stat-val money ' + (hasProfit ? (f.total_profit>=0?'up':'down') : '') + '">' + (hasProfit ? fmtM(f.total_profit) + profitRateHtml : '--') + '</div></div>';
        html += '</div>';
      }
      html += '</div>';

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

  updateSortBar();
}

function fmt(n)  { return isNaN(n) ? '--' : Number(n).toFixed(2); }
function fmt4(n) { return isNaN(n) ? '--' : Number(n).toFixed(4); }
function fmtM(n) {
  if (isNaN(n)) return '--';
  const s = n >= 0 ? '+' : '';
  const a = Math.abs(n);
  return s + (a >= 10000 ? (n/10000).toFixed(2)+'万' : n.toFixed(2));
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 持仓编辑 ─────────────────────────────────────────────
function renderHoldingsList() {
  const list = document.getElementById('holdings-list');
  if (!holdings.filter(h => !h.deleted).length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:4px 0">暂无持仓</div>';
    return;
  }
  list.innerHTML = holdings.filter(h => !h.deleted).map(h => `
    <div class="holding-item" onclick="editFund('${h.code}')" style="cursor:pointer">
      <div>
        <div class="h-name">${esc(h.name||h.code)}</div>
        <div class="h-detail">${h.code} · ${h.shares}份 · 成本${h.cost}</div>
      </div>
      <button class="del-btn" onclick="event.stopPropagation();delFund('${h.code}')">×</button>
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

function delFund(code) {
  const h = holdings.find(item => item.code === code);
  if (!h || h.deleted) return;
  if (!confirm(`删除「${h.name||h.code}」？`)) return;
  h.deleted = true;
  h.updated_at = nowISO();
  saveHoldings();
  scheduleAutoPush();
  renderHoldingsList();
  refresh();
}

// ── 页面切换 ─────────────────────────────────────────────
let lastEditPull = 0;
function switchPage(name) {
  var page = document.getElementById('page-' + name);
  var nav = document.getElementById('nav-' + name);
  if (!page || !nav) return;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  page.classList.add('active');
  nav.classList.add('active');
  if (name==='edit') {
    renderHoldingsList();
    renderCloudStatus();
    if (hasCloudConfig() && Date.now() - lastEditPull > TIMING.CLOUD_COOLDOWN_MS) {
      lastEditPull = Date.now();
      pullFromCloud(true);
    }
  }
  else if (editingCode) cancelEdit();
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

// ── 黄金 AU9999 实时金价（复刻司南基金：东方财富 push2 + 持久缓存兜底） ──
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
  var secids = ['118.AU9999', '113.AU9999', '114.AU9999'];
  for (var i = 0; i < secids.length; i++) {
    var result = await fetchGoldFromEastmoneySecid(secids[i]);
    if (result && Number.isFinite(result.price)) return result;
  }
  return null;
}

async function fetchGoldPrice() {
  var result = await fetchGoldFromEastmoney();
  if (result && Number.isFinite(result.price)) {
    saveGoldCache(result);
    return result;
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
    html += '<div class="index-price">' + (hasData ? fmtIndexPrice(idx.price) : '--') + '</div>';
    html += '<div class="index-change ' + cc + '">' + (hasData ? sign + fmt(idx.changePct) + '%' : '--') + '</div>';
    html += '</div>';
  });
  el.innerHTML = html;
}

function fmtIndexPrice(n) {
  if (!Number.isFinite(n)) return '--';
  return Math.round(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
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
  const now = getChinaDate();
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
  const now = getChinaDate();
  const d = now.getDay();
  const t = now.getHours() * 60 + now.getMinutes();
  if (d === 0 || d === 6) return 300000;       // 周末 5min
  if (t >= 565 && t < 690) return 60000;       // 上午盘 9:25-11:30 每60s
  if (t >= 690 && t < 780) return 180000;      // 午休 11:30-13:00 每3min
  if (t >= 780 && t < 900) return 60000;       // 下午盘 13:00-15:00 每60s
  if (t >= 900 && t < 930) return 120000;      // 收盘后 15:00-15:30 每2min
  return 300000;                                // 其余时段 5min
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => { refresh(); }, 60000);
}

// ── 下拉刷新 ─────────────────────────────────────────────
function initPullToRefresh() {
  var tip = document.getElementById('pull-refresh');
  if (!tip) return;
  var startY = 0;
  var pulling = false;
  var threshold = 72;

  window.addEventListener('touchstart', function(e) {
    if (window.scrollY > 0 || isRefreshing || !e.touches.length) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  window.addEventListener('touchmove', function(e) {
    if (!pulling || !e.touches.length) return;
    var distance = e.touches[0].clientY - startY;
    if (distance <= 0) return;
    var height = Math.min(48, distance * 0.45);
    tip.style.height = height + 'px';
    tip.textContent = distance >= threshold ? '松开刷新' : '下拉刷新';
    tip.classList.toggle('ready', distance >= threshold);
    tip.classList.add('visible');
  }, { passive: true });

  window.addEventListener('touchend', function(e) {
    if (!pulling) return;
    pulling = false;
    var endY = e.changedTouches && e.changedTouches.length ? e.changedTouches[0].clientY : startY;
    var shouldRefresh = endY - startY >= threshold;
    if (shouldRefresh) {
      tip.style.height = '34px';
      tip.textContent = '刷新中...';
      refresh().finally(function() {
        tip.style.height = '0px';
        tip.classList.remove('ready', 'visible');
        tip.textContent = '下拉刷新';
      });
    } else {
      tip.style.height = '0px';
      tip.classList.remove('ready', 'visible');
      tip.textContent = '下拉刷新';
    }
  }, { passive: true });
}

// ── 交易日 14:30 本地通知 ────────────────────────────────
function setupNotificationPermissionPrompt() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  var ask = function() {
    if (notificationPrompted || Notification.permission !== 'default') return;
    notificationPrompted = true;
    Notification.requestPermission().catch(function() {});
  };
  ['click', 'touchstart', 'keydown'].forEach(function(evt) {
    window.addEventListener(evt, ask, { once: true, passive: true });
  });
}

function isWeekdayTradingDate(d) {
  var day = d.getDay();
  return day !== 0 && day !== 6;
}

function chinaDateKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function buildDailyChangeBody() {
  var activeCodes = holdings.filter(function(h) { return !h.deleted; }).map(function(h) { return h.code; });
  var lines = activeCodes.map(function(code) {
    var f = fundsData.find(function(item) { return item.code === code; });
    var chg = displayChangeOf(f);
    if (!f || !Number.isFinite(chg)) return null;
    var sign = chg >= 0 ? '+' : '';
    var name = String(f.name || f.code).replace(/\s+/g, '').slice(0, 8);
    return name + ' ' + sign + fmt(chg) + '%';
  }).filter(Boolean);
  if (!lines.length) return '当前自选暂无可用估值数据';
  return lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n...' : '');
}

async function showDailyNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  var body = buildDailyChangeBody();
  var title = '蜉蝣基金 14:30 自选涨跌幅';
  try {
    if ('serviceWorker' in navigator) {
      var reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        await reg.showNotification(title, {
          body: body,
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          tag: 'fuyu-daily-1430',
          renotify: true,
          data: { url: location.href }
        });
        return true;
      }
    }
    new Notification(title, { body: body, icon: 'icon-192.png', tag: 'fuyu-daily-1430' });
    return true;
  } catch(e) {
    return false;
  }
}

async function checkDailyNotification() {
  var now = getChinaDate();
  if (!isWeekdayTradingDate(now)) return;
  var minute = now.getHours() * 60 + now.getMinutes();
  if (minute < 14 * 60 + 30) return;
  var today = chinaDateKey(now);
  if (localStorage.getItem(NOTIFY_DATE_KEY) === today) return;
  if (!holdings.filter(function(h) { return !h.deleted; }).length) return;
  await refresh();
  var sent = await showDailyNotification();
  if (sent) localStorage.setItem(NOTIFY_DATE_KEY, today);
}

function startDailyNotifications() {
  setupNotificationPermissionPrompt();
  checkDailyNotification();
  setInterval(checkDailyNotification, TIMING.DAILY_NOTIFY_CHECK_MS);
}

// ── Toast ────────────────────────────────────────────────
function showToast(msg, ms=2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
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
var appVersionLabel = document.getElementById('app-version-label');
if (appVersionLabel) appVersionLabel.textContent = APP_VERSION;
updateMktStatus();
setInterval(updateMktStatus, TIMING.MKT_STATUS_MS);
refresh();
startAutoRefresh();
startIndexRefresh();
initPullToRefresh();
startDailyNotifications();
autoPullOnLoad();
startAutoPull();
if (getGistToken()) document.getElementById('gist-token').value = getGistToken();
