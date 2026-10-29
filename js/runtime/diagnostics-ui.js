import { APP_VERSION } from '../version.js';
import { safeGetItem, safeStorageKeys } from '../storage.js';
import { normalizeOcrDiagnosticForDisplay, selectSafeDiagnosticEvents } from '../integrity.js';
import { HOLDINGS_BACKUP_LATEST_KEY } from '../storage/holdings-repository.js';
import { classifyMarketKind } from './market-session.js';
import { marketClock } from './market-clock.js';

export function createDiagnosticsCenter({ getHoldings, getHoldingsDocument, refreshCoordinator, getRefreshDiagnostics, showToast, esc, now = Date.now }) {
let diagnosticsLastSummary = '';

function diagnosticJson(key, fallback) {
  try {
    var parsed = JSON.parse(safeGetItem(key) || 'null');
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function diagnosticTime(value) {
  var timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp));
}

function recentSafeDiagnostics() {
  var rows = diagnosticJson('fuyu_diagnostics_v1', []);
  return selectSafeDiagnosticEvents(rows).map(function(entry) {
    return {
      time: diagnosticTime(entry.time),
      type: entry.type,
    };
  });
}

function latestBackupTime() {
  var backup = diagnosticJson(HOLDINGS_BACKUP_LATEST_KEY, null);
  return backup && backup.createdAt ? diagnosticTime(backup.createdAt) : '无记录';
}

function ocrDiagnosticSummary() {
  var baseline = typeof Worker === 'function'
    && typeof createImageBitmap === 'function'
    && typeof OffscreenCanvas === 'function'
    && typeof WebAssembly !== 'undefined';
  var ledger = diagnosticJson('fuyu_ocr_performance_ledger_v1', []);
  var entries = Array.isArray(ledger) ? ledger.slice(-20) : [];
  var latest = entries.length ? entries[entries.length - 1] : null;
  var capability = baseline ? (navigator.gpu ? 'WebGPU 可尝试 / WASM 可用' : 'WASM 可用') : '当前浏览器能力不足';
  if (!latest) return capability + '；暂无识别记录';
  var safeLatest = normalizeOcrDiagnosticForDisplay(latest);
  return capability + '；最近后端 ' + safeLatest.backend
    + (safeLatest.fallback ? '（已回退：' + safeLatest.fallbackReason + '）' : '')
    + '；结果 ' + safeLatest.errorCategory
    + (safeLatest.consistency === 'inconsistent' ? '；遥测异常' : '');
}

function marketDiagnosticSummary() {
  var current = now();
  var markets = new Set(getHoldings().filter(function(item) { return !item.deleted; }).map(function(item) {
    return classifyMarketKind(item.name || '');
  }));
  if (!markets.size) markets.add('cn');
  var stateLabels = { open: '交易中', break: '休市中', preopen: '盘前', closed: '已收盘', holiday: '节假日', unknown: '未知' };
  return Array.from(markets).sort().map(function(market) {
    var state = marketClock(market, current).marketState;
    return market + ' ' + (stateLabels[state] || state);
  }).join('；');
}

function requestServiceWorkerVersion() {
  return new Promise(function(resolve) {
    var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!controller || typeof MessageChannel !== 'function') { resolve('未控制当前页面'); return; }
    var channel = new MessageChannel();
    var settled = false;
    var timeout = setTimeout(function() {
      if (!settled) { settled = true; resolve('未响应'); }
    }, 800);
    channel.port1.onmessage = function(event) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(String(event.data && event.data.cache || '未知'));
    };
    try { controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]); }
    catch (_) { clearTimeout(timeout); resolve('查询失败'); }
  });
}

function refreshDiagnosticRows() {
  if (typeof getRefreshDiagnostics !== 'function') return [];
  try {
    var snapshot = getRefreshDiagnostics();
    var record = snapshot && snapshot.current;
    if (!record) return [['刷新诊断', '暂无记录 / observed=false']];
    var labels = { running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
    var count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未观测';
    var identity = row => '第' + count(row.generation) + '代 / ' + (labels[row.status] || '未知')
      + ' / observed=' + (row.observed === true ? 'true' : 'false');
    var requests = row => {
      var c = row.observed === true && row.counters;
      if (!c) return '未观测';
      return [['实际请求', c.requests], ['缓存命中', c.cacheHits], ['去重', c.deduped],
        ['已进入请求中止', c.abortedRequests], ['资源取消拒绝', c.cancelledResources],
        ['失败请求', c.failedRequests], ['写尝试', c.writeAttempts], ['缓存写入', c.cacheWrites]]
        .map(item => item[0] + ' ' + count(item[1])).join('；');
    };
    var kinds = ['estimates', 'nav', 'holdings', 'meta', 'indices', 'gold', 'securities', 'model-quotes'];
    var plan = Array.isArray(record.plan) ? record.plan.filter(row => kinds.includes(row.kind)).slice(0, 8)
      .map(row => row.kind + ' cache=' + count(row.cache) + ' fetch=' + count(row.fetch) + ' skip=' + count(row.skip)).join('；') : '';
    var reasons = record.skipReasons;
    var planReasons = record.planReasons;
    var reasonSummary = planReasons && [
      ['fresh_cache', '缓存新鲜'], ['cache_miss', '缓存缺失'], ['cache_metadata_invalid', '元数据无效'],
      ['cache_quality_unusable', '缓存质量不可用'], ['cache_expired', '缓存过期'], ['force_live', '强制实时'],
      ['force_stable', '强制稳定'], ['market_ineligible', '市场不适用'], ['phase_pending', '阶段待定'],
      ['no_active_holdings', '无活动持仓'],
    ].map(item => item[1] + ' ' + count(planReasons[item[0]])).join('；');
    var executionSkips = record.observed === true && record.executionSkips;
    var executionSummary = executionSkips && [
      ['estimate_claim_denied', '估值源拒绝'], ['holdings_claim_denied', '重仓源拒绝'],
      ['holdings_probe_used', '重仓半开额度已用'], ['model_claim_denied', '模型源拒绝'],
      ['model_probe_used', '模型半开额度已用'],
    ].map(item => item[1] + ' ' + count(executionSkips[item[0]])).join('；');
    var providers = record.counters && record.counters.providers;
    var providerNames = ['sinan-estimate-proxy', 'sinan-holdings-proxy', 'eastmoney-official-nav',
      'eastmoney-security-quote', 'tencent-market-quote', 'gold', 'model-config'];
    var providerSummary = providers && providerNames.filter(name => Object.prototype.hasOwnProperty.call(providers, name))
      .map(name => name + '=' + count(providers[name])).join('；');
    var rows = [
      ['刷新诊断', identity(record)],
      ['刷新计划', plan || '未观测'],
      ['计划原因', reasonSummary ? reasonSummary + '；仅表示计划时决策；实际执行 gate 细因未记录' : '未观测'],
      ['执行跳过', executionSummary ? executionSummary + '；按门控检查次数统计，非请求或唯一资源数；拒绝细因未记录' : '未观测'],
      ['刷新请求', requests(record)],
      ['跳过原因', reasons ? '不适用市场 ' + count(reasons.market_ineligible) + '；无活动持仓 ' + count(reasons.no_active_holdings) : '未观测'],
      ['请求来源', providerSummary || (providers ? '无已派发请求' : '未观测')],
      ['最终报价', '请查看各基金详情 → 数据说明；本摘要不复制报价或金额'],
    ];
    if (snapshot.lastCancelled && snapshot.lastCancelled.generation !== record.generation) {
      rows.push(['最近取消代', identity(snapshot.lastCancelled) + '；' + requests(snapshot.lastCancelled)]);
    }
    return rows;
  } catch (_) { return [['刷新诊断', '读取失败 / observed=false']]; }
}

function diagnosticRows(swVersion) {
  var holdingsDocument = getHoldingsDocument();
  var snapshot = refreshCoordinator.snapshot();
  var boot = window.__FUNDVAL_BOOTSTRAP_STATUS__ || {};
  var sources = snapshot.sourceRegistry && snapshot.sourceRegistry.sources || [];
  var sourceSummary = sources.map(function(entry) {
    var health = entry.health || {};
    return entry.descriptor.id + ' ' + health.status
      + (health.consecutiveFailures ? ' / 连续失败 ' + health.consecutiveFailures : '')
      + (Number.isFinite(health.lastResponseMs) ? ' / ' + Math.round(health.lastResponseMs) + 'ms' : '');
  }).join('；') || '无记录';
  var ledger = diagnosticJson('fuyu_ocr_performance_ledger_v1', []);
  var cacheCount = safeStorageKeys().filter(function(key) { return key.startsWith('fuyu_'); }).length;
  return [
    ['应用版本', APP_VERSION],
    ['Service Worker', swVersion],
    ['网络', navigator.onLine === false ? '离线（缓存一律按旧数据处理）' : '在线'],
    ['最近启动自检', [boot.migration || '未知', boot.integrity || '未知', boot.cacheRepaired ? '已修复缓存' : '缓存无需修复'].join(' / ')],
    ['持仓 Schema', holdingsDocument ? 'Schema ' + holdingsDocument.schema : '不可用'],
    ['最近本地备份', latestBackupTime()],
    ['最后完整刷新', snapshot.lastCompleted ? diagnosticTime(snapshot.lastCompleted.completedAt) + ' / ' + snapshot.lastCompleted.trigger : '无记录'],
    ['数据源健康', sourceSummary],
    ['当前市场', marketDiagnosticSummary()],
    ['本地缓存条目', String(cacheCount)],
    ['OCR 能力', ocrDiagnosticSummary()],
    ['OCR 账本条目', String(Array.isArray(ledger) ? ledger.length : 0)],
    ['运行错误条目', String(recentSafeDiagnostics().length)],
  ].concat(refreshDiagnosticRows());
}

async function refreshDiagnosticsCenter() {
  var content = document.getElementById('diagnostics-content');
  if (!content) return '';
  content.textContent = '正在读取本机诊断…';
  var swVersion = await requestServiceWorkerVersion();
  var rows = diagnosticRows(swVersion);
  var errors = recentSafeDiagnostics();
  content.innerHTML = '<div class="diagnostics-grid">' + rows.map(function(row) {
    return '<div class="diagnostics-row"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong></div>';
  }).join('') + '</div>' + (errors.length
    ? '<ol class="diagnostics-log">' + errors.map(function(entry) { return '<li>' + esc(entry.time + ' · ' + entry.type) + '</li>'; }).join('') + '</ol>'
    : '<div class="diagnostics-log">最近没有记录到运行错误</div>');
  diagnosticsLastSummary = ['蜉蝣基金运行诊断'].concat(rows.map(function(row) { return row[0] + '：' + row[1]; }))
    .concat(errors.length ? ['最近脱敏错误：'].concat(errors.map(function(entry) { return entry.time + ' · ' + entry.type; })) : ['最近脱敏错误：无'])
    .join('\n');
  return diagnosticsLastSummary;
}

async function copyDiagnosticsSummary() {
  var summary = await refreshDiagnosticsCenter();
  if (!summary) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(summary);
    else {
      var area = document.createElement('textarea');
      area.value = summary;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    showToast('已复制脱敏诊断摘要');
  } catch (_) {
    showToast('复制失败，请手动选择诊断内容');
  }
}

return { refreshDiagnosticsCenter, copyDiagnosticsSummary };
}
