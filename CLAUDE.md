# 蜉蝣基金 · AI 协作指南

## V14 维护约定

本项目当前版本为 `14.0.1`。保持纯前端、零框架和移动端优先。主页面启动必须经过 `bootstrap.js`，先执行迁移、状态完整性检查和运行时保护，再加载 `app.js`。业务逻辑应按职责进入 `config`、`calculator`、`storage`、`freshness`、`eastmoney-estimate`、`fund-holdings`、`holdings-estimate`、`overseas-model`、`accuracy` 模块，`app.js` 只承担编排和浏览器适配。可测试的修复规则放在 `integrity.js`，浏览器侧恢复与提示放在 `resilience.js`。

数据展示优先级固定为：海外基金官方净值 `净` 优先，其次盘中估值 `估` 或海外模型 `模`，网络失败保留旧值并标记 `旧`。任何导入或云端覆盖前都要备份；Gist 新写入使用 Schema 2，但继续读取旧数组格式和可兼容的更高版本 Schema。

支付宝截图导入必须在独立的 `ocr-import.html` 页面中完成；该页必须保持严格同源 CSP，且不得加载 `app.js`、`bootstrap.js`、行情或第三方 JSONP。OCR 只接受本地 `File`/`Blob`，主引擎固定为 `@paddleocr/paddleocr-js@0.4.2` + PP-OCRv6 tiny，模型、Worker、ONNX Runtime 与 WASM 均使用同源资产并仅在选图后动态加载；Tesseract 只保留为降级/回归链路。识别出的金额和累计收益只可辅助计算成本，用户必须确认真实份额大于 0；不得用当前估值反推份额，不得删除截图外持仓。确认批次必须先备份，再写入 canonical 持仓，回主页面后立即触发 Gist 同步和估值刷新。

Android OCR 必须在启动重型资源前完成能力校验，并保持单任务串行。页面侧只保留轻量 Worker 协议门面；Paddle/OpenCV 只能在一个同源 Worker 中加载，所有识别批次固定为 1，分片 `ImageBitmap` 必须通过 transfer list 转移，禁止在主线程再引入完整 SDK。

完成修改后运行：

```bash
npm test
npm run check
npm run build
```

## 项目锚点

- 中文名：蜉蝣基金
- 目录名：`FundVal`
- 类型：纯前端基金盘中估值 PWA
- 部署：GitHub Pages

用户说「蜉蝣基金」时，优先定位到本仓库。

## 不可违背

1. 保持零框架；PaddleOCR/PP-OCRv6 tiny 主链和 Tesseract 降级链均只能使用固定版本的本地静态依赖，不能进入首屏、不能加入 SW `CORE` 预缓存、不能回退 CDN。
2. 不把本项目与 `pan`（盘中宝）或 `fund-compass`（司南基金）混改。
3. 不硬编码、不输出、不写入诊断日志任何 GitHub Token 或 Gist 私密信息。
4. 涨跌幅字段可为负或 0，判断时使用 `Number.isFinite()`。
5. 持仓恢复不得改变原有顺序；重复记录按 `updated_at` 择新，同时间戳下删除标记优先。
6. 本地存储、隐私模式、配额不足和损坏 JSON 都必须可降级，不能阻断主页面启动。
7. QDII/海外基金展示要区分：
   - 最新公布净值涨跌：用于主涨跌、排序、今日盈亏。
   - 下一净值模型估算：作为辅助说明，不冒充官方净值。
8. 截图、Base64/data URL、完整 OCR 文本和用户财务快照不得上传、写入 LocalStorage/IndexedDB、诊断日志或仓库。诊断必须继续脱敏图片 data URL。
9. 基金目录在浏览器端只能读取同源 `data/fund-catalog.json`；不得执行第三方 JSONP。更新目录只通过维护脚本解析公开数据文本，不能 `eval`。

## 关键文件

- `index.html`：页面结构、PWA meta、版本展示。
- `js/bootstrap.js`：迁移、自检、运行时保护与主程序加载顺序。
- `js/resilience.js`：损坏恢复、孤立缓存清理、错误日志和跨标签页提示。
- `js/integrity.js`：持仓去重、备份恢复、缓存校验和日志脱敏纯函数。
- `js/app.js`：核心业务逻辑。
- `ocr-import.html` 与 `js/ocr-import-page.js`：隔离的本地截图识别与人工确认页面。
- `js/paddle-local-ocr.js`：本地图片校验、PP-OCRv6 tiny 分片识别与同源 Worker 生命周期。
- `js/ocr-table-layout.js`：按坐标重建长截图持仓行和金额/收益列。
- `js/local-ocr.js`：Tesseract 降级/回归链路。
- `js/alipay-ocr-parser.js`、`js/holding-import-plan.js`、`js/fund-catalog.js`：纯解析、导入映射和同源基金目录。
- `js/storage.js`：安全存储、缓存和云端 Payload。
- `css/style.css`：基础行情页样式；`css/ocr.css`：OCR 独立页样式。
- `manifest.json`：PWA 名称与图标。
- `sw.js`：缓存版本、通知、离线策略。

## 数据源注意

- 东方财富 FundGuZhi 估值表通过动态 JSONP 回调读取；上游只给日期时不得标为实时。
- 东方财富 `FundArchivesDatas.aspx` 要求合法来源标头，浏览器端统一通过司南 Worker `/holdings` 只读代理获取，不再注入跨站脚本。
- 东方财富 `pingzhongdata` 依赖 `Data_netWorthTrend`，多基金并发时必须串行读取。
- Service Worker 不缓存基金/行情 API，避免估值过期。

## 自检

```bash
npm test
node --check js/app.js
node --check js/bootstrap.js
node --check js/resilience.js
node --check js/integrity.js
git status --short
```

静态项目通过 `npm run build` 复制 Pages 产物与按需 OCR 资产。修改入口、OCR 页面、manifest、SW 或主 JS 时，记得同步 bump `APP_VERSION` 和 `CACHE`；更新基金目录时显式执行 `npm run refresh:fund-catalog`。
