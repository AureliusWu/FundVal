# AGENTS.md

## 项目识别

- 目录名：`FundVal`
- 中文名：蜉蝣基金
- 当用户说「蜉蝣基金」时，指的就是本项目：`FundVal`
- 线上形态：GitHub Pages 托管的个人基金盘中估值监控 PWA

## 项目定位

蜉蝣基金是一个纯前端、零框架、移动端优先的基金盘中估值与持仓监控工具。核心目标是快速查看自选基金估值、持仓市值、今日盈亏、主要指数与黄金行情，并通过 GitHub Gist 在多设备同步持仓。

## 技术与结构

- 技术栈：原生 HTML/CSS/JavaScript，无构建工具、无 npm 依赖。
- 入口文件：`index.html`
- 业务逻辑：`js/app.js`
- 样式：`css/style.css`
- PWA：`manifest.json`、`sw.js`
- 部署：推送 `main` 后由 GitHub Pages/Actions 发布。

## 数据源与关键约定

- 基金估值主源：天天基金 `fundgz.1234567.com.cn/js/{code}.js`，依赖全局 `window.jsonpgz` 回调。
- 基金净值备源：东方财富 `push2.eastmoney.com/api/qt/stock/get`。
- 基金详情：东方财富 `FundArchivesDatas.aspx`，通过 script 注入读取 `window.apidata`，不同 type 必须顺序加载，避免全局变量互相覆盖。
- 指数行情：腾讯行情 JSONP；黄金行情有独立缓存兜底。
- 本地存储 key 使用 `fuyu_` 前缀，例如 `fuyu_holdings_v1`。
- 涨跌幅字段可以为负或 0，不能用只适合净值/价格的 `isUsableNav()` 判空。

## 开发规则

- 保持零依赖和纯前端形态，不引入 Vue/React/Vite/打包流程。
- 修改估值、持仓、同步逻辑时，同时考虑缓存、失败降级、离线兜底和移动端展示。
- 修改 Service Worker 或静态资源缓存时，同步检查版本更新提示是否仍然有效。
- 涉及 GitHub Token/Gist 的改动不得输出、记录或硬编码任何密钥。

## 项目边界

- 不要把本项目与 `pan`（盘中宝）混淆：两者功能相近，但存储 key、视觉主题和仓库独立。
- 不要把本项目与 `fund-compass`（司南基金）混淆：司南基金是 Vue/FastAPI 的选基、择时、资产分析系统。
