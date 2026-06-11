# 蜉蝣基金 (FundVal)

个人基金盘中估值监控 PWA，纯前端单页应用，托管在 GitHub Pages（`AureliusWu/FundVal`）。

## 技术栈

- **零框架**：HTML5 + CSS3 + 原生 JavaScript (ES6+)，无构建工具，无 npm 依赖
- **PWA**：Service Worker 离线缓存 + Web App Manifest（图标 192/512）
- **数据存储**：`localStorage`（持仓、缓存、收益日历、云同步配置）
- **云同步**：GitHub Gist API（`api.github.com/gists`）
- **CI/CD**：GitHub Actions（`.github/workflows/deploy.yml`），push main 自动触发

## 目录结构

```
FundVal/
├── index.html          # 单页三 Tab：行情(行情)、持仓(编辑)、状态
├── js/app.js           # 全部应用逻辑 (~1450 行)
├── css/style.css       # 全部样式 (~920 行)，Apple 风格设计
├── sw.js               # Service Worker v6，离线缓存 + 自动更新检测
├── manifest.json       # PWA 清单，"蜉蝣基金"
├── icon-192.png / icon-512.png
└── .github/workflows/deploy.yml
```

## 架构概览

### 页面结构（单页三 Tab + 指数行情条，底部导航切换）

| 区域 | DOM id | 功能 |
|------|--------|------|
| 指数条 | `#index-bar` | 横向滚动：纳斯达克/标普500/黄金/上证/沪深300 实时数值 |
| 行情 | `#page-market` | 基金卡片列表、排序、重仓股/经理/费率展开、收益日历 |
| 持仓 | `#page-edit` | 增删改持仓（支持0份额仅关注）、云同步、导入导出 JSON |
| 状态 | `#page-status` | GitHub 最近提交信息 |

### 数据流

1. **`loadHoldings()`** → 从 localStorage 读取持仓列表 `[{code, name, shares, cost}]`
2. **`refresh()`** → 并行获取每只基金数据（主源 + 备源），合并后渲染
3. **`renderFundList(data)`** → 动态生成 `.fund-card` HTML，写入 `#fund-list`
4. 成功后 **`saveCache()`** 写 localStorage，失败时 **`tryShowCache()`** 兜底

### 数据源

**基金净值（双源并行，取最优）**

| 角色 | 接口 | 方式 | 字段 |
|------|------|------|------|
| **主源** | `fundgz.1234567.com.cn/js/{code}.js` | JSONP (`jsonpgz` 全局回调) | 估算净值、涨跌幅、净值日期 |
| **备源** | `push2.eastmoney.com/api/qt/stock/get?secid=0.{code}` | fetch (CORS) | 最新净值、昨日涨幅、YTD |

- 主源成功 → 用主源，补上备源的 `yesterday_change` / `ytd_change`
- 主源失败 → 降级到备源，status 标记为 `ok_fallback`
- 两者都失败 → status 标记为 `error`

**指数行情**

| 接口 | 方式 | 覆盖 |
|------|------|------|
| `query1.finance.yahoo.com/v8/finance/chart/{symbol}` | fetch (CORS) | 纳斯达克/标普500/黄金/上证/沪深300 |

- 每 30s 刷新，离线时回退 indexCache
- A股休市时段指数显示上一交易日收盘价

**基金详情（顺序 script 注入，共用 window.apidata 管线）**

| type | 内容 | 缓存变量 |
|------|------|----------|
| `jjcc` | 十大重仓股 | `holdingsCache` |
| `jjjl` | 基金经理（姓名/任职日期/任职回报） | `managerCache` |
| `jjxx` | 基金类型、成立日期、规模 | `fundTypeCache` |
| `jjfl` | 申购/赎回/管理/托管费率 | `fundFeeCache` |

- 接口：`fundf10.eastmoney.com/FundArchivesDatas.aspx?type={type}&code={code}`
- 方式：`<script>` 标签注入 → `injectFundScript()` Promise 化
- **顺序加载**：`fetchFundDetails()` 逐一加载 4 个 type，避免 `window.apidata` 覆盖冲突
- 用户收起卡片时中断后续加载（`expandedFund !== code` 检查）

### localStorage 键名

| 键 | 内容 |
|----|------|
| `fuyu_holdings_v1` | 持仓列表 JSON |
| `fuyu_funds_cache_v1` | 上次成功刷新的数据缓存 `{data, time}` |
| `fuyu_gist_token` | GitHub Personal Access Token |
| `fuyu_gist_id` | GitHub Gist ID |
| `fuyu_gist_sync_time` | 上次同步时间 ISO 字符串 |
| `fuyu_daily_log` | 收益日历 `[{date, todayProfit, totalValue}]`（最多 90 天） |

## 代码风格

- 中文注释和 UI 文案，`esc()` 做 HTML 转义
- `var` 声明为主，函数表达式用 `function` 关键字（非箭头函数，保持老浏览器兼容）
- 格式化：`fmt(n)` 保留两位小数，`fmtM(n)` 带正负号+万单位，`fmtM2(n)` 无符号+万单位
- 状态码：`ok` / `ok_fallback` / `error`
- CSS：CSS Custom Properties 做设计 token，毛玻璃效果（`backdrop-filter`），`env(safe-area-inset-*)` 适配刘海屏

## 关键约定

- **不要引入框架或构建工具** — 项目刻意保持零依赖，直接用浏览器打开 `index.html` 就能跑
- **SW 缓存策略（v6）**：JS/CSS 用 network-first（确保最新），API 域名（`1234567.com.cn` + `eastmoney.com`）跳过 SW 始终走网络，其他静态资源用 stale-while-revalidate
- **SW 自动更新**：每 30 分钟 `reg.update()`，检测到新版本时弹 toast 提示用户刷新
- **不要动 `window.jsonpgz` 全局回调** — 天天基金 JSONP 接口靠这个函数名接收数据
- **不要动 `window.apidata` 全局变量** — 基金详情 4 个 type 共用此变量，必须顺序加载（`injectFundScript` + `fetchFundDetails`）
- 修改基金数据接口时，要同时处理主源失败→备源降级的逻辑
- 新增 localStorage key 时遵循现有命名规范：`fuyu_<name>_v<version>`

## 注意事项

- **重仓股接口已变更**（2026-06）：旧接口 `api.fund.eastmoney.com/f10/JJCC` 已下线(404)，当前使用 `fundf10.eastmoney.com/FundArchivesDatas.aspx`，返回 `var apidata={content:"HTML..."}` 格式而非 JSON
- **JSONP 并发安全**：`pendingRequests` Map 确保同只基金的 JSONP 回调不会错乱
- **自动刷新节奏**：交易时段 60s，收盘后 120s，周末/午休不刷新（见 `getRefreshInterval()`）
- **移动端优先**：768px 断点，桌面端居中 max-width 480px
- **GitHub API 可能被墙**：云同步超时 15s，网络错误提示用户科学上网
- 编辑基金时 `i-code` input 会被 disable，防止改代码导致重复
