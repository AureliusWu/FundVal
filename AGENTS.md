# AGENTS.md

## 当前架构（V10.0.0）

- `js/app.js` 负责页面编排和第三方 JSONP 适配。
- `js/config.js` 负责 TTL、超时和交易时段刷新间隔。
- `js/calculator.js` 只放纯计算与显示来源优先级。
- `js/storage.js` 负责带时间戳缓存、Gist Schema 2 和本地备份。
- `js/overseas-model.js` 读取 `data/overseas-models.json`，不得回填硬编码基金规则。
- `js/accuracy.js` 记录海外模型预测、官方净值结算和 MAE/方向准确率。
- 变更后必须运行 `npm test`、`node --check js/app.js`，并保持 `js/version.js` 与 `sw.js` 缓存版本一致。
- 缺失值必须保持缺失，禁止以 `0` 代替；旧缓存必须显示 `旧`。

## 项目识别

- 目录名：`FundVal`
- 中文名：蜉蝣基金
- 用户说「蜉蝣基金」时，指本项目。
- 线上形态：GitHub Pages 托管的个人基金盘中估值监控 PWA。

## 项目定位

蜉蝣基金是纯前端、零框架、移动端优先的基金盘中估值与持仓监控工具。它用于快速查看基金估值、持仓市值、今日盈亏、指数/黄金行情，并通过 GitHub Gist 同步持仓。

## 技术结构

- `index.html`：单页入口、PWA meta、行情/持仓页面结构。
- `js/app.js`：估值抓取、持仓管理、Gist 同步、海外模型、通知、渲染逻辑。
- `css/style.css`：移动端优先样式。
- `manifest.json`：PWA 名称、图标、启动配置。
- `sw.js`：Service Worker 缓存与通知点击。

## 数据源与关键约定

- 天天基金 JSONP：`fundgz.1234567.com.cn/js/{code}.js`，依赖全局 `window.jsonpgz`。
- 东方财富备源：`push2.eastmoney.com`，用于最新净值、净值日涨跌幅、涨跌额。
- 东方财富净值趋势：`fund.eastmoney.com/pingzhongdata/{code}.js`，写入全局 `Data_netWorthTrend`，必须串行读取。
- 基金详情：`fundf10.eastmoney.com/FundArchivesDatas.aspx`，写入全局 `window.apidata`，不同 type 必须顺序加载。
- 本地存储统一使用 `fuyu_` 前缀。
- QDII/海外基金要区分「最新公布净值涨跌」和「下一净值模型估算」。

## 开发规则

- 保持零依赖，不引入框架、构建工具或 npm 流程。
- 涨跌幅允许为负数或 0，不能用只适合净值/价格的可用性判断。
- 修改估值、持仓、同步、SW 缓存时，必须同时考虑失败降级、旧缓存、离线和移动端展示。
- 涉及 GitHub Token/Gist 的代码或文档不得硬编码真实密钥。
- 修改 `js/app.js` 后至少运行 `node --check js/app.js`。

## 项目边界

- `FundVal` 是蜉蝣基金，不是 `pan`（盘中宝）。
- `fund-compass`（司南基金）是 Vue/FastAPI 选基择时系统，不能在本仓库里改它的功能。
