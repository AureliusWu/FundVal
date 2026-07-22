const API = 'https://api.fund.eastmoney.com/FundGuZhi/GetFundGZList';
const PAGE_SIZE = 100;
const TIMEOUT = 8000;
let callbackId = 0;

function numberOrNaN(value) {
  const n = Number(String(value ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : NaN;
}

export function normalizeEstimateRow(row) {
  if (!row || !/^\d{6}$/.test(String(row.bzdm || ''))) return null;
  return {
    code: String(row.bzdm),
    name: String(row.jjjc || row.bzdm),
    type: String(row.FType || ''),
    last_nav: numberOrNaN(row.dwjz),
    est_nav: numberOrNaN(row.gsz),
    est_change: numberOrNaN(row.gszzl),
    nav_date: String(row.gzrq || ''),
    est_time: String(row.gxrq || ''),
    source_time_precision: 'date',
    est_label: '盘中估值',
    est_kind: 'estimate',
    est_realtime: false,
    est_note: '东方财富 Choice 盘中估算；上游仅提供行情日期，未提供精确分钟',
    status: 'ok',
    source: 'eastmoney-estimate-table',
  };
}

function loadPage(pageIndex) {
  return new Promise((resolve, reject) => {
    const callback = `__fuyuEstimatePage${++callbackId}`;
    const script = document.createElement('script');
    let done = false;
    const finish = (error, payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.remove();
      try { delete window[callback]; } catch (_) { window[callback] = undefined; }
      error ? reject(error) : resolve(payload);
    };
    const timer = setTimeout(() => finish(new Error('估值表请求超时')), TIMEOUT);
    window[callback] = (payload) => {
      if (!payload || payload.ErrCode !== 0 || !payload.Data || !Array.isArray(payload.Data.list)) {
        finish(new Error((payload && payload.ErrMsg) || '估值表响应无效'));
        return;
      }
      finish(null, payload);
    };
    script.onerror = () => finish(new Error('估值表请求失败'));
    const query = new URLSearchParams({
      type: '0', sort: '1', orderType: 'asc', canbuy: '0',
      pageIndex: String(pageIndex), pageSize: String(PAGE_SIZE), callback,
      _: String(Date.now()),
    });
    script.src = `${API}?${query}`;
    document.head.appendChild(script);
  });
}

export async function fetchEstimateRows(codes) {
  const wanted = Array.from(new Set((codes || []).map(String).filter((code) => /^\d{6}$/.test(code)))).sort();
  const output = new Map(wanted.map((code) => [code, null]));
  if (!wanted.length) return output;
  const pages = new Map();
  const page = (index) => {
    if (!pages.has(index)) pages.set(index, loadPage(index));
    return pages.get(index);
  };
  const firstPayload = await page(1);
  const pageCount = Math.max(1, Math.ceil(Number(firstPayload.TotalCount || 0) / PAGE_SIZE));

  async function locate(group, low, high) {
    if (!group.length || low > high) return;
    const mid = Math.floor((low + high) / 2);
    const payload = await page(mid);
    const rows = payload.Data.list || [];
    if (!rows.length) return;
    const first = String(rows[0].bzdm || '');
    const last = String(rows[rows.length - 1].bzdm || '');
    const byCode = new Map(rows.map((row) => [String(row.bzdm), row]));
    const left = [];
    const right = [];
    for (const code of group) {
      if (code < first) left.push(code);
      else if (code > last) right.push(code);
      else if (byCode.has(code)) output.set(code, normalizeEstimateRow(byCode.get(code)));
    }
    await Promise.all([locate(left, low, mid - 1), locate(right, mid + 1, high)]);
  }

  const firstRows = firstPayload.Data.list || [];
  const firstMap = new Map(firstRows.map((row) => [String(row.bzdm), row]));
  const remaining = [];
  for (const code of wanted) {
    if (firstMap.has(code)) output.set(code, normalizeEstimateRow(firstMap.get(code)));
    else remaining.push(code);
  }
  await locate(remaining, 2, pageCount);
  return output;
}
