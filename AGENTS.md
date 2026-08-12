# AGENTS.md

## 当前架构（V14.0.0）

- `js/bootstrap.js` 负责启动顺序，必须先执行迁移与完整性检查，再加载 `app.js`。
- `js/resilience.js` 负责本地数据恢复、缓存清理、错误日志和跨标签页提示。
- `js/integrity.js` 只放可测试的持仓、缓存、诊断纯函数。
- `js/app.js` 负责页面编排和刷新队列；`js/eastmoney-estimate.js` 负责调用司南服务端估值代理并保留部分结果；`js/fund-holdings.js` 负责通过同一只读代理获取带披露日期的十大重仓。
- `js/freshness.js` 负责行情时间解析、市场分类和统一数据状态。
- `js/holdings-estimate.js` 负责按披露权重计算十大重仓当日行情贡献；非当日行情和覆盖不足不得参与估算。
- `js/config.js` 负责 TTL、超时和交易时段刷新间隔。
- `js/calculator.js` 只放纯计算与显示来源优先级。
- `js/storage.js` 负责带时间戳缓存、Gist Schema 和本地备份；所有读写失败必须可降级。
- `js/overseas-model.js` 读取 `data/overseas-models.json`，不得回填硬编码基金规则。
- `js/accuracy.js` 记录海外模型预测、官方净值结算和 MAE/方向准确率。
- `js/paddle-local-ocr.js` 只接受本地 `File`/`Blob`，按需加载 `@paddleocr/paddleocr-js@0.4.2`、PP-OCRv6 tiny、同源 Worker/WASM/模型并输出坐标块；不得接受 URL、Base64 或上传截图。
- `js/ocr-table-layout.js` 负责按坐标重建支付宝长截图中的基金行和四类数值字段；缺失字段必须保持 `null`，不得跨行猜测。
- `js/local-ocr.js` 仅保留 Tesseract 降级/回归链路，不得被写回为 v14 长截图主方案。
- `ocr-import.html` 必须维持严格同源 CSP，且不得加载 `app.js`、`bootstrap.js`、行情或第三方 JSONP；截图和 OCR 原文只能存在于该页内存。
- `js/alipay-ocr-parser.js`、`js/holding-import-plan.js` 是可测试的 OCR 解析和确认映射层；OCR 未识别到真实份额时，确认页必须要求用户填写大于 0 的真实份额。
- `js/fund-catalog.js` 只按需读取同源 `data/fund-catalog.json`；目录维护脚本可以解析上游公开文本，但浏览器端不得执行任何第三方 JSONP。
- 变更后必须运行 `npm test`、`npm run check`、`npm run build`，并保持 `js/version.js` 与 `sw.js` 缓存版本一致。
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
- `js/bootstrap.js`：启动前迁移、自检和主程序加载。
- `js/resilience.js`：损坏恢复、缓存一致性、运行时保护。
- `js/integrity.js`：可测试的状态修复规则。
- `js/app.js`：估值抓取、持仓管理、Gist 同步、海外模型、通知、渲染逻辑。
- `css/style.css`：基础行情页移动端优先样式；`css/ocr.css`：OCR 独立页按需样式。
- `manifest.json`：PWA 名称、图标、启动配置。
- `sw.js`：Service Worker 缓存与通知点击。

## 数据源与关键约定

- 东方财富 FundGuZhi 估值表 JSONP：盘中估算主源；仅提供更新日期时必须标为延迟。
- 东方财富备源：`push2.eastmoney.com`，用于最新净值、净值日涨跌幅、涨跌额。
- 东方财富净值趋势：`fund.eastmoney.com/pingzhongdata/{code}.js`，写入全局 `Data_netWorthTrend`，必须串行读取。
- 基金重仓：浏览器不得直连要求来源标头的 `FundArchivesDatas.aspx`；统一调用司南 Worker `/holdings` 只读代理，并保留披露截止日期。
- 本地存储统一使用 `fuyu_` 前缀。
- QDII/海外基金要区分「最新公布净值涨跌」和「下一净值模型估算」。

## 开发规则

- 保持零框架和基础页面零启动负担；V14 主 OCR 为固定版本的 PaddleOCR JS 0.4.2 + PP-OCRv6 tiny，Tesseract 仅作降级/回归。所有 OCR 资产只可在用户选择截图后按需加载，不能加入首屏或 SW `CORE` 预缓存。
- 涨跌幅允许为负数或 0，不能用只适合净值/价格的可用性判断。
- 修改估值、持仓、同步、SW 缓存时，必须同时考虑失败降级、旧缓存、离线和移动端展示。
- 持仓修复不得改变用户原有顺序；重复记录按更新时间择新，同时间戳删除标记优先。
- 任何诊断日志必须脱敏 Token，不得记录或提交真实密钥。
- 诊断日志不得记录截图、Base64/data URL、完整 OCR 文本、持有金额或其他 OCR 原始数据。
- OCR 导入只能在用户确认后批量写入：先备份，再保存、安排 Gist 同步并刷新估值。截图外的旧持仓不得删除；跳过项不得改动；不可用本期估值反推份额。
- 本地 OCR 静态资产必须指向同源路径，Paddle Worker URL 必须保持相对于 OCR 引擎模块的项目子路径安全形式，模型与 ONNX Runtime/WASM 路径必须显式固定；Tesseract 降级链路继续使用 `workerBlobURL: false`、`cacheMethod: 'none'`。任何链路均不得回退 CDN。
- 涉及 GitHub Token/Gist 的代码或文档不得硬编码真实密钥。

## 项目边界

- `FundVal` 是蜉蝣基金，不是 `pan`（盘中宝）。
- `fund-compass`（司南基金）是 Vue/FastAPI 选基择时系统，不能在本仓库里改它的功能。
