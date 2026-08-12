import { detectAlipayHoldingSourceEvidence, matchFundCandidate, normalizeFundName } from './alipay-ocr-parser.js';
import { loadFundCatalog } from './fund-catalog.js';
import { applyHoldingImportPlan, createHoldingImportPlan, importPlanSummary, validateHoldingImportPlan } from './holding-import-plan.js';
import { reconstructOcrTableLayout } from './ocr-table-layout.js';
import { runStartupIntegrityChecks } from './resilience.js';
import { backupHoldings, safeRemoveItem, safeSetItem } from './storage.js';

const STORAGE_KEY = 'fuyu_holdings_v1';
const CACHE_KEY = 'fuyu_funds_cache_v1';
const OCR_IMPORT_PENDING_KEY = 'fuyu_ocr_import_pending_v1';

let activeSession = 0;
let paddleOcrModulePromise = null;
let state = { rows: [], catalogWarning: '' };

function element(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function finite(value) {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatSnapshot(value, suffix = '') {
  const number = finite(value);
  if (number == null) return '未识别';
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${suffix}`;
}

function setStatus(message, { working = false, error = false } = {}) {
  const status = element('ocr-import-status');
  status.textContent = message;
  status.classList.toggle('working', working);
  status.classList.toggle('error', error);
}

function currentHoldings() {
  try {
    // This page can be opened directly, so it must run the same conservative
    // integrity gate as the main entry before it ever writes a merged batch.
    const checked = runStartupIntegrityChecks(globalThis.localStorage);
    if (checked.preservePrimary) return null;
    return Array.isArray(checked.holdings) ? checked.holdings.map(item => ({ ...item })) : null;
  } catch (_) {
    return null;
  }
}

function renderIntro() {
  state = { rows: [], catalogWarning: '' };
  element('ocr-import-body').innerHTML = `
    <div class="ocr-results-summary">
      <strong>开始前请确认</strong><br>
      请选择带有支付宝标识的完整「基金持有」页面截图。图片只在此独立页面的本机内存中处理；系统不会根据估值猜测份额。
    </div>`;
  element('ocr-import-confirm').hidden = true;
  element('ocr-import-retry').hidden = true;
  element('ocr-import-pick').hidden = false;
  setStatus('请选择一张带支付宝或蚂蚁财富标识的完整基金持有截图。');
}

function setWorking(session, phase) {
  if (session !== activeSession) return;
  const labels = {
    preparing: '正在本机读取并优化截图…',
    'loading-engine': '正在加载本地识别组件…',
    'loading-core': '正在加载本地识别核心…',
    'loading-language': '正在加载中文识别数据…',
    'loading-models': '正在加载本地中文识别模型…',
    initializing: '正在初始化本地识别器…',
    recognizing: '正在本机识别文字…',
    matching: '正在核对基金代码与名称…',
  };
  setStatus(labels[phase] || '正在本机处理截图…', { working: true });
}

function buildPaddleHoldingCandidates(recognition, catalog) {
  const holdingsTokens = (Array.isArray(recognition?.tokens) ? recognition.tokens : [])
    .filter(token => token && token.region === 'holdings');
  const layout = reconstructOcrTableLayout({
    tokens: holdingsTokens,
    imageWidth: recognition?.imageWidth,
    matchFund(name) {
      return matchFundCandidate({ name }, catalog, {
        fuzzyThreshold: 0.78,
        ambiguityGap: 0.06,
      });
    },
  });
  const holdings = layout.previewRows.map(row => {
    const warnings = [];
    if (!layout.schema.header.reliable) {
      warnings.push('表头未完整识别，金额与收益按支付宝三列布局定位，请逐项核对');
    }
    if (!layout.schema.geometry.reliable) {
      warnings.push('本行列位置证据不足，未识别字段保持为空');
    }
    if (row.match?.strategy === 'fuzzy') warnings.push('基金名称为 OCR 模糊匹配，请核对份额类别');
    return {
      code: row.match?.code || null,
      name: row.name || null,
      rawFundName: row.name || null,
      normalizedName: normalizeFundName(row.name),
      holdingAmount: row.holdingAmount,
      holdingProfit: row.holdingProfit,
      holdingProfitRate: row.holdingProfitRate,
      dailyProfit: row.dailyProfit,
      match: row.match,
      warnings,
      bbox: row.bbox,
    };
  });
  const detection = detectAlipayHoldingSourceEvidence({
    tokens: recognition.tokens,
    holdings,
    tableLayout: layout.schema.header.reliable,
  });
  return { detection, holdings, layout };
}

function candidateOptions(row) {
  const candidates = Array.isArray(row.matchCandidates) ? row.matchCandidates : [];
  const manual = '<option value="">手动填写 / 请选择候选</option>';
  return manual + candidates.map(candidate => {
    const value = `${candidate.code}|${candidate.name}`;
    return `<option value="${escapeHtml(value)}"${candidate.code === row.code ? ' selected' : ''}>${escapeHtml(candidate.name)} · ${escapeHtml(candidate.code)}</option>`;
  }).join('');
}

function actionOptions(row) {
  const primaryLabel = row.existing ? '更新此持仓' : '新增为持仓';
  const primaryValue = row.existing ? 'update' : 'add';
  return `<option value="${primaryValue}"${row.action === primaryValue ? ' selected' : ''}>${primaryLabel}</option><option value="skip"${row.action === 'skip' ? ' selected' : ''}>跳过，不改动</option>`;
}

function actionOptionsForExisting(existing, selectedAction) {
  return actionOptions({ existing, action: selectedAction === 'skip' ? 'skip' : (existing ? 'update' : 'add') });
}

function snapshotItem(label, value, suffix = '') {
  return `<div class="ocr-snapshot-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatSnapshot(value, suffix))}</strong></div>`;
}

function renderCandidate(row) {
  const needsConfirmation = row.matchStatus !== 'matched';
  const warnings = row.warnings.length
    ? `<ul class="ocr-warning-list">${row.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    : '';
  const snapshotCostAvailable = finite(row.holdingAmount) != null && finite(row.holdingProfit) != null;
  const existingHint = row.existing
    ? `当前：${escapeHtml(row.existing.name || row.existing.code)}，${escapeHtml(row.existing.shares)} 份`
    : '尚未写入 FundVal';
  return `
    <article class="ocr-candidate ${needsConfirmation ? 'needs-confirmation' : ''}" data-row-id="${escapeHtml(row.id)}">
      <div class="ocr-candidate-head">
        <div>
          <div class="ocr-candidate-name">${escapeHtml(row.name || row.rawFundName || '未识别基金')}</div>
          <div class="ocr-candidate-meta">${escapeHtml(existingHint)}</div>
        </div>
        <span class="ocr-match-badge ${needsConfirmation ? 'needs' : ''}">${needsConfirmation ? '需要核对' : '已匹配'}</span>
      </div>
      <div class="ocr-snapshot-grid">
        ${snapshotItem('截图持有金额', row.holdingAmount)}
        ${snapshotItem('截图累计收益', row.holdingProfit)}
        ${snapshotItem('截图收益率', row.holdingProfitRate, '%')}
        ${snapshotItem('截图日收益', row.dailyProfit)}
      </div>
      <div class="ocr-row"><label class="ocr-row-label">处理方式</label><select class="ocr-action-select" data-field="action">${actionOptions(row)}</select></div>
      <div class="ocr-row"><label class="ocr-row-label">基金候选（代码优先；同名 A/C 不会自动混用）</label><select class="ocr-match-choice" data-field="candidate">${candidateOptions(row)}</select></div>
      <div class="ocr-inline-grid">
        <label class="ocr-row"><span class="ocr-row-label">确认基金代码</span><input class="f-input" data-field="code" inputmode="numeric" maxlength="6" value="${escapeHtml(row.code)}" placeholder="6 位代码"></label>
        <label class="ocr-row"><span class="ocr-row-label">确认基金名称</span><input class="f-input" data-field="name" value="${escapeHtml(row.name)}" placeholder="基金全称"></label>
      </div>
      <div class="ocr-inline-grid">
        <label class="ocr-row"><span class="ocr-row-label">真实持有份额（必填）</span><input class="f-input" data-field="shares" inputmode="decimal" value="${escapeHtml(row.shares)}" placeholder="例如 1000"></label>
        <label class="ocr-row"><span class="ocr-row-label">成本净值</span><input class="f-input" data-field="cost" inputmode="decimal" value="${escapeHtml(row.cost)}" placeholder="例如 1.2345"></label>
      </div>
      ${snapshotCostAvailable ? `<label class="ocr-cost-option"><input type="checkbox" data-field="screenshot-cost"${row.useScreenshotCost ? ' checked' : ''}>以截图「持有金额 − 累计收益」和上方真实份额换算成本净值（请核对）</label>` : ''}
      ${warnings}
      <div class="ocr-form-error" data-field="error" hidden></div>
    </article>`;
}

function renderResults() {
  const summary = importPlanSummary(state.rows);
  const catalogWarning = state.catalogWarning ? `<br>${escapeHtml(state.catalogWarning)}` : '';
  element('ocr-import-body').innerHTML = `
    <div class="ocr-results-summary"><strong>识别结果仅为候选</strong><br>${escapeHtml(`${summary.total} 条候选；${summary.matched} 条已匹配，${summary.needsConfirmation} 条需人工核对。`)}${catalogWarning}<br>截图外的旧持仓将保持不变；选择“跳过”不会写入任何数据。</div>
    <div class="ocr-candidate-list">${state.rows.map(renderCandidate).join('')}</div>
    <label class="ocr-confirm-check"><input id="ocr-import-ack" type="checkbox">我已逐项核对基金身份和真实份额；我理解截图金额/收益只是快照，确认后才会同步到 FundVal。</label>`;
  element('ocr-import-confirm').hidden = false;
  element('ocr-import-retry').hidden = false;
  element('ocr-import-pick').hidden = true;
}

function readRowsFromForm() {
  return state.rows.map(row => {
    const root = element('ocr-import-body').querySelector(`[data-row-id="${row.id}"]`);
    if (!root) return { ...row };
    const value = field => root.querySelector(`[data-field="${field}"]`)?.value ?? '';
    return {
      ...row,
      action: value('action'),
      code: value('code').trim(),
      name: value('name').trim(),
      shares: value('shares').trim(),
      cost: value('cost').trim(),
      useScreenshotCost: Boolean(root.querySelector('[data-field="screenshot-cost"]')?.checked),
    };
  });
}

function clearValidationErrors() {
  element('ocr-import-body').querySelectorAll('[data-field="error"]').forEach(error => {
    error.hidden = true;
    error.textContent = '';
  });
}

function showValidationErrors(errors) {
  clearValidationErrors();
  errors.forEach(error => {
    const target = element('ocr-import-body').querySelector(`[data-row-id="${error.id}"] [data-field="error"]`);
    if (target) {
      target.textContent = error.message;
      target.hidden = false;
    }
  });
}

async function processSelectedFile(file) {
  const session = ++activeSession;
  if (!file) return;
  element('ocr-import-confirm').hidden = true;
  element('ocr-import-retry').hidden = false;
  element('ocr-import-pick').hidden = true;
  element('ocr-import-body').textContent = '';
  setWorking(session, 'preparing');
  try {
    paddleOcrModulePromise ||= import('./paddle-local-ocr.js');
    const localOcr = await paddleOcrModulePromise;
    const recognition = await localOcr.recognizeAlipayPaddleImage(file, {
      onProgress({ phase }) { setWorking(session, phase); },
    });
    if (session !== activeSession) return;
    setWorking(session, 'matching');
    let catalog = [];
    let catalogWarning = '';
    try {
      catalog = await loadFundCatalog();
    } catch (_) {
      catalogWarning = '基金目录暂不可用，请手动确认代码和名称。';
    }
    if (session !== activeSession) return;
    const parsed = buildPaddleHoldingCandidates(recognition, catalog);
    // Explicitly discard positioned OCR tokens as soon as candidates are built.
    recognition.text = '';
    recognition.tokens = [];
    if (!parsed.detection.supported || !parsed.holdings.length) {
      state = { rows: [], catalogWarning: '' };
      element('ocr-import-body').innerHTML = '<div class="ocr-results-summary">未识别到支付宝基金持仓条目。请使用清晰、完整的「基金持有」页面截图后重试。</div>';
      setStatus('未识别到可确认的基金条目。', { error: true });
      return;
    }
    const holdings = currentHoldings();
    if (holdings == null) {
      state = { rows: [], catalogWarning: '' };
      element('ocr-import-body').innerHTML = '<div class="ocr-results-summary">无法安全读取现有持仓。请返回主页面完成数据恢复后再导入。</div>';
      setStatus('现有持仓不可用，未改动任何数据。', { error: true });
      return;
    }
    state = { rows: createHoldingImportPlan(parsed.holdings, holdings), catalogWarning, holdings };
    renderResults();
    setStatus('识别完成：请逐项确认后再同步。');
  } catch (error) {
    if (session !== activeSession) return;
    state = { rows: [], catalogWarning: '' };
    element('ocr-import-body').innerHTML = '<div class="ocr-results-summary">本地识别没有完成。请检查图片格式或改用更清晰的支付宝基金持仓截图。</div>';
    const safeMessage = error && /^(?:PaddleLocalOcrError|LocalOcrError|FundCatalogError)$/.test(error.name)
      ? error.message
      : '本地识别失败，未改动任何持仓。';
    setStatus(safeMessage, { error: true });
  }
}

async function confirmImport() {
  if (!state.rows.length) return;
  if (!element('ocr-import-ack')?.checked) {
    setStatus('请先确认已核对基金身份和真实持有份额。', { error: true });
    return;
  }
  const rows = readRowsFromForm();
  const validation = validateHoldingImportPlan(rows);
  if (!validation.ok) {
    showValidationErrors(validation.errors);
    setStatus('请修正标出的条目；未填写真实份额不会导入。', { error: true });
    return;
  }
  const previousHoldings = currentHoldings();
  if (previousHoldings == null) {
    setStatus('无法安全读取现有持仓，未同步任何变更。', { error: true });
    return;
  }
  const result = applyHoldingImportPlan(previousHoldings, rows);
  if (!result.ok) {
    showValidationErrors(result.errors);
    setStatus('请修正标出的条目后重试。', { error: true });
    return;
  }
  if (!result.applied) {
    setStatus('没有需要同步的持仓变更。');
    return;
  }
  const confirmButton = element('ocr-import-confirm');
  confirmButton.disabled = true;
  try {
    if (!backupHoldings(previousHoldings)) throw new Error();
    // Establish the data-free recovery flag before mutating canonical holdings.
    // A harmless extra refresh is preferable to an unscheduled successful import.
    if (!safeSetItem(OCR_IMPORT_PENDING_KEY, '1')) throw new Error();
    if (!safeSetItem(STORAGE_KEY, JSON.stringify(result.holdings))) throw new Error();
    safeRemoveItem(CACHE_KEY);
    // The main page consumes the recovery flag on its next startup. If the
    // scheduled navigation is interrupted, a later open still triggers the
    // existing Gist retry and valuation refresh for this confirmed batch.
    setStatus('已保存确认持仓，正在返回主页面刷新估值…', { working: true });
    window.setTimeout(() => window.location.replace('./?ocr_import=1'), 180);
  } catch (_) {
    safeRemoveItem(OCR_IMPORT_PENDING_KEY);
    setStatus('无法安全保存持仓，未同步任何变更。请稍后重试。', { error: true });
    confirmButton.disabled = false;
  }
}

function chooseCandidate(event) {
  const select = event.target.closest('[data-field="candidate"]');
  if (!select || !select.value) return;
  const root = select.closest('[data-row-id]');
  const row = root && state.rows.find(item => item.id === root.dataset.rowId);
  if (!row) return;
  const candidate = row.matchCandidates.find(item => `${item.code}|${item.name}` === select.value);
  if (!candidate) return;
  root.querySelector('[data-field="code"]').value = candidate.code;
  root.querySelector('[data-field="name"]').value = candidate.name;
  refreshManualCandidateState(root);
}

function existingHoldingForCode(code) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null;
  const holdings = Array.isArray(state.holdings) ? state.holdings : currentHoldings();
  return Array.isArray(holdings)
    ? holdings.find(item => item.code === code && item.deleted !== true) || null
    : null;
}

function refreshManualCandidateState(root) {
  const code = root.querySelector('[data-field="code"]')?.value.trim() || '';
  const existing = existingHoldingForCode(code);
  const actionSelect = root.querySelector('[data-field="action"]');
  if (actionSelect) {
    const selectedAction = actionSelect.value;
    actionSelect.innerHTML = actionOptionsForExisting(existing, selectedAction);
  }
  const meta = root.querySelector('.ocr-candidate-meta');
  if (meta) meta.textContent = existing
    ? `当前：${existing.name || existing.code}，${existing.shares} 份`
    : '尚未写入 FundVal';
  const badge = root.querySelector('.ocr-match-badge');
  if (badge) {
    badge.classList.add('needs');
    badge.textContent = '已手动调整，请核对';
  }
}

function editCandidateIdentity(event) {
  const field = event.target.closest('[data-field="code"], [data-field="name"]');
  if (!field) return;
  const root = field.closest('[data-row-id]');
  if (!root) return;
  const picker = root.querySelector('[data-field="candidate"]');
  if (picker) picker.value = '';
  refreshManualCandidateState(root);
}

function requestFile() {
  element('ocr-image-input').click();
}

function clearSensitiveSession() {
  activeSession += 1;
  element('ocr-image-input').value = '';
  element('ocr-import-body').textContent = '';
  state = { rows: [], catalogWarning: '' };
  // PaddleOCR owns and disposes its Worker per recognition. Dropping the lazy
  // module reference ensures the independent import page retains no session.
  paddleOcrModulePromise = null;
}

function leaveImportPage() {
  clearSensitiveSession();
  window.location.assign('./');
}

function init() {
  element('ocr-import-pick').addEventListener('click', requestFile);
  element('ocr-import-retry').addEventListener('click', requestFile);
  element('ocr-import-close').addEventListener('click', leaveImportPage);
  element('ocr-import-manual').addEventListener('click', leaveImportPage);
  element('ocr-import-confirm').addEventListener('click', confirmImport);
  element('ocr-image-input').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) processSelectedFile(file);
  });
  element('ocr-import-body').addEventListener('change', chooseCandidate);
  element('ocr-import-body').addEventListener('input', editCandidateIdentity);
  window.addEventListener('pagehide', () => {
    clearSensitiveSession();
  }, { once: true });
  renderIntro();
}

init();
