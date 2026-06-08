const STORAGE_KEY = 'fuyu_holdings_v1';
let holdings = [];
let fundsData = [];
const pendingRequests = new Map();
let isRefreshing = false;
let refreshQueued = false;

// ── 持仓存取 ─────────────────────────────────────────────
function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [
      {code:'110020', name:'易方达沪深300ETF联接A', shares:1000, cost:1.50},
      {code:'270042', name:'广发纳斯达克100ETF联接A', shares:500, cost:2.80},
    ];
    holdings = normalizeHoldings(data);
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
    seen.add(code);
    acc.push({code, name: name || code, shares, cost});
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
      holdings = data;
      saveHoldings();
      renderHoldingsList();
      showToast('导入成功，共 ' + holdings.length + ' 条');
      refresh();
    } catch(err) { showToast('文件格式错误'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── 全局回调函数（接口固定返回此函数） ──────────────────
window.jsonpgz = function(data) {
  if (!data || !data.fundcode) return;
  const code = data.fundcode;
  if (pendingRequests.has(code)) {
    const resolve = pendingRequests.get(code);
    pendingRequests.delete(code);
    try {
      resolve({
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
      resolve({code, status:'error', message:'数据解析失败'});
    }
  }
};

// ── 获取单只基金盘中估值 ──────────────────────────────────
function fetchFund(code) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(code);
      resolve({code, status:'error', message:'请求超时'});
    }, 8000);

    // 存储 resolve 方便全局回调函数调用
    pendingRequests.set(code, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    // 直接请求，接口会返回 jsonpgz(...) 格式的数据
    const script = document.createElement('script');
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    script.onerror = () => {
      clearTimeout(timer);
      pendingRequests.delete(code);
      script.remove();
      resolve({code, status:'error', message:'网络请求失败'});
    };
    script.onload = () => {
      script.remove();
    };
    document.head.appendChild(script);
  });
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
    const results = await Promise.all(snapshot.map(h => fetchFund(h.code)));

    // 合并持仓信息，并把接口返回的基金名回填到本地持仓。
    let holdingsChanged = false;
    fundsData = results.map((r, i) => {
      const h = snapshot[i];
      const fetchedName = r.status === 'ok' && isRealFundName(r.name, h.code) ? String(r.name).trim() : '';
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

      if (d.status === 'ok' && d.shares > 0 && isUsableNav(d.est_nav) && isUsableNav(d.last_nav)) {
        const curr = d.est_nav * d.shares;
        const costVal = d.cost * d.shares;
        d.today_profit = (d.est_nav - d.last_nav) * d.shares;
        d.total_profit = curr - costVal;
        d.total_profit_rate = costVal > 0 ? (curr - costVal) / costVal * 100 : 0;
        d.curr_value = curr;
      }
      if (d.status === 'ok' && (!isUsableNav(d.est_nav) || !isUsableNav(d.last_nav))) {
        d.status = 'error';
        d.message = '净值数据无效';
      }
      return d;
    });
    if (holdingsChanged) {
      saveHoldings();
      renderHoldingsList();
    }

    renderFundList(fundsData);
    const now = new Date();
    document.getElementById('last-upd').textContent =
      `估算时间 ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.textContent = '↻ 刷新';
    isRefreshing = false;
    if (refreshQueued) refresh();
  }
}

function pad(n) { return String(n).padStart(2,'0'); }
function isUsableNav(n) { return Number.isFinite(n) && n > 0; }
function parseNav(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// ── 渲染基金列表 ─────────────────────────────────────────
function renderFundList(data) {
  const list = document.getElementById('fund-list');
  if (!data || data.length === 0) {
    list.innerHTML = '<div class="empty-hint">暂无持仓<br>在「持仓」页添加基金代码</div>';
    ['s-today','s-total','s-profit'].forEach(id => {
      document.getElementById(id).textContent = '--';
      document.getElementById(id).className = 'sum-val';
    });
    return;
  }

  let todaySum = 0, totalVal = 0, profitSum = 0;
  let html = '';

  data.forEach(f => {
    if (f.status !== 'ok') {
      html += `<div class="fund-card">
        <div class="fund-top">
          <div><div class="fund-name">${esc(f.name||f.code)}</div><div class="fund-code">${f.code}</div></div>
        </div>
        <div class="fund-error">获取失败 · ${esc(f.message||'')}</div>
      </div>`;
      return;
    }
    const cc = f.est_change > 0 ? 'up' : f.est_change < 0 ? 'down' : 'flat';
    const sign = f.est_change >= 0 ? '+' : '';
    todaySum += f.today_profit || 0;
    totalVal += f.curr_value || 0;
    profitSum += f.total_profit || 0;

    html += `<div class="fund-card ${cc}">
      <div class="fund-top">
        <div>
          <div class="fund-name">${esc(f.name)}</div>
          <div class="fund-code">${f.code} · ${f.nav_date}</div>
        </div>
        <div>
          <div class="fund-pct ${cc}">${sign}${fmt(f.est_change)}%</div>
          <div class="fund-pct-time">${f.est_time||'--'}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div><div class="stat-label">盘中估值</div><div class="stat-val">${fmt4(f.est_nav)}</div></div>
        <div><div class="stat-label">上一净值</div><div class="stat-val">${fmt4(f.last_nav)}</div></div>
        <div><div class="stat-label">今日估算</div><div class="stat-val ${f.today_profit>=0?'up':'down'}">${f.shares>0?fmtM(f.today_profit):'--'}</div></div>
        ${f.shares > 0 ? `
        <div><div class="stat-label">持有份额</div><div class="stat-val">${fmt2(f.shares)}</div></div>
        <div><div class="stat-label">持仓市值</div><div class="stat-val">${fmt2(f.curr_value)}</div></div>
        <div><div class="stat-label">累计盈亏</div><div class="stat-val ${f.total_profit>=0?'up':'down'}">${fmtM(f.total_profit)}</div></div>
        ` : ''}
      </div>
    </div>`;
  });

  list.innerHTML = html;

  setSumVal('s-today', todaySum);
  document.getElementById('s-total').textContent = fmtM2(totalVal);
  document.getElementById('s-total').className = 'sum-val';
  setSumVal('s-profit', profitSum);
}

function setSumVal(id, val) {
  const el = document.getElementById(id);
  el.textContent = fmtM(val);
  el.className = 'sum-val ' + (val > 0 ? 'up' : val < 0 ? 'down' : 'flat');
}

function fmt(n)  { return isNaN(n) ? '--' : Number(n).toFixed(2); }
function fmt2(n) { return isNaN(n) ? '--' : Number(n).toFixed(2); }
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
    <div class="holding-item">
      <div>
        <div class="h-name">${esc(h.name||h.code)}</div>
        <div class="h-detail">${h.code} · ${h.shares}份 · 成本${h.cost}</div>
      </div>
      <button class="del-btn" onclick="delFund(${i})">×</button>
    </div>`).join('');
}

function addFund() {
  const code = document.getElementById('i-code').value.trim();
  const name = document.getElementById('i-name').value.trim();
  const shares = toNonNegativeNumber(document.getElementById('i-shares').value);
  const cost = toNonNegativeNumber(document.getElementById('i-cost').value);
  if (!code || !/^\d{6}$/.test(code)) { showToast('请输入6位数字基金代码'); return; }
  if (holdings.find(h => h.code === code)) { showToast('该基金已在列表中'); return; }
  holdings.push({code, name: name||code, shares, cost});
  saveHoldings();
  renderHoldingsList();
  document.getElementById('i-code').value='';
  document.getElementById('i-name').value='';
  document.getElementById('i-shares').value='';
  document.getElementById('i-cost').value='';
  showToast('已添加' + (name||code));
  refresh();
}

function delFund(i) {
  const h = holdings[i];
  if (!confirm(`删除「${h.name||h.code}」？`)) return;
  holdings.splice(i,1);
  saveHoldings();
  renderHoldingsList();
  refresh();
}

// ── 页面切换 ─────────────────────────────────────────────
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  document.getElementById('nav-'+name).classList.add('active');
  if (name==='edit') renderHoldingsList();
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

// ── 自动刷新 ─────────────────────────────────────────────
function startAutoRefresh() {
  setInterval(() => {
    const now = new Date();
    const d = now.getDay(), t = now.getHours()*60+now.getMinutes();
    const trading = d>=1&&d<=5&&((t>=565&&t<695)||(t>=775&&t<905));
    if (trading) refresh();
  }, 60000);
}

// ── Toast ────────────────────────────────────────────────
function showToast(msg, ms=2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
}

// ── Service Worker ───────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}

// ── 初始化 ───────────────────────────────────────────────
loadHoldings();
updateMktStatus();
setInterval(updateMktStatus, 30000);
refresh();
startAutoRefresh();
