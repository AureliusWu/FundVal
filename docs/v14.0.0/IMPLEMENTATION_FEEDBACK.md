# 蜉蝣基金（FundVal）v14.0.0 实施反馈

实施日期：2026-08-12
发布状态：`DEPLOYED / DEVICE_VALIDATION_PENDING`

> 功能发布提交 `58c24e029235914516b02689b97979cc8bef99ab` 已推送至 `origin/main`，GitHub Actions/Pages 运行 `31563016789` 成功。生产桌面 Chromium 已完成真实长图复验；Android、iOS/已安装 PWA 仍无实机证据，因此不得宣称全部门禁通过。

## 结论摘要

- v14 主 OCR 已由 Tesseract 切换为 `@paddleocr/paddleocr-js@0.4.2` + PP-OCRv6 tiny；Tesseract 仅保留降级/回归用途。
- 用户提供的 1440×9317 真实支付宝长截图仅在本机桌面 Chromium/IAB 中处理，未加入仓库。坐标重建得到 15 条持仓记录：10 条自动匹配，5 条进入人工确认并默认跳过。
- 15 条记录的持有金额、昨日收益、持有收益、持有收益率四类数值字段均完成重建（15/15）；不确定基金没有被静默匹配或写入。
- 从选图到结果页的本地完整处理约 18.3 秒。浏览器只请求当前站点的 OCR 引擎、Worker、WASM 和模型，没有图片上传请求。
- PaddleOCR 主链当前构建资源总量为 120,057,620 bytes（Tesseract 降级/回归资产另计）；OCR 资产不进入首页首屏请求，也不加入 Service Worker `CORE` 预缓存。
- 生产 Pages、线上 Service Worker、同源 Worker/模型/ORT/WASM 与真实长图桌面流程已验证；Android Chrome、iOS Safari/已安装 PWA 仍为 `NOT_RUN`，因此状态为 `DEVICE_VALIDATION_PENDING`。

## 本地方案与数据流

```text
本地 File / Blob
  → 文件头与像素上限校验
  → 按需加载 PaddleOCR JS 0.4.2
  → PP-OCRv6 tiny 长截图分片识别（Worker + ONNX Runtime/WASM）
  → 保留文字与坐标、去重重叠片段
  → 按支付宝双列布局重建 15 条记录
  → 同源基金目录匹配
  → 10 条自动匹配 + 5 条人工确认（默认跳过）
  → 用户填写/确认真实份额
  → 备份后写入既有 canonical 持仓
  → 返回主页面安排 Gist 同步与估值刷新
```

原图、图片 Base64、完整 OCR 原文和坐标块不会进入持久化、诊断日志、仓库或网络；只有用户最终确认后的结构化持仓沿用 FundVal 既有同步链路。

## 任务书第 44 节逐项反馈（34 项）

| # | 要求 | 本地证据 / 当前状态 |
| ---: | --- | --- |
| 1 | 项目中文名 | 蜉蝣基金。 |
| 2 | 项目英文名 | FundVal。 |
| 3 | 仓库路径 | `D:\AI项目\FundVal`。 |
| 4 | 开始 HEAD | `a2129a522d858d18b09bf3613c4513261c4f4a73`（v13.0.0）。 |
| 5 | 结束 HEAD | 功能与已部署运行时提交为 `58c24e029235914516b02689b97979cc8bef99ab`；本文发布证据回填为后续 docs-only 提交，不改变运行时代码。 |
| 6 | 当前分支 | `main`。 |
| 7 | 工作区状态 | 功能提交后工作区为 clean；真实金融截图始终位于仓库外，路径、原图、OCR 原文、凭据均未提交。 |
| 8 | OCR 库及版本 | 主引擎：`@paddleocr/paddleocr-js@0.4.2` + PP-OCRv6 tiny；运行时 `onnxruntime-web@1.27.0`。Tesseract.js 7.0.0 只保留降级/回归。 |
| 9 | 选型原因 | Tesseract 对微信压缩的 1440×9317 长图无法稳定形成多行坐标表；PaddleOCR tiny 能在纯浏览器环境返回更可靠的中文文本框，结合固定双列布局可重建全部 15 行，速度也明显优于 PP-OCRv6 small 的 PoC。 |
| 10 | 是否 100% 客户端执行 | 是。识别在独立 `ocr-import.html` 页面、浏览器 Worker 与本地 WASM 中执行；没有 OCR 后端。 |
| 11 | Worker/WASM/中文模型路径 | 引擎：`assets/ocr/paddle/engine/paddle-ocr-engine.mjs`；Worker 与打包 WASM：`assets/ocr/paddle/engine/assets/`；模型：`assets/ocr/paddle/models/PP-OCRv6_tiny_*_onnx_infer.tar`；ORT：`assets/ocr/paddle/ort/`。构建使用相对基址生成 Worker 模块 URL，并校验其适配 GitHub Pages 项目子路径。 |
| 12 | OCR 静态资源体积 | PaddleOCR 主链当前构建证据：120,057,620 bytes；Tesseract 降级/回归资产另计。资源只在选图后加载，首屏和 SW `CORE` 均不包含。 |
| 13 | 依赖与许可证 | `@paddleocr/paddleocr-js@0.4.2`、PP-OCRv6 tiny、`@techstark/opencv-js@4.10.0-release.1`：Apache-2.0；`onnxruntime-web@1.27.0`、`js-yaml@4.3.1`：MIT；`clipper-lib@6.4.2`：BSL；Tesseract.js/Core 7.0.0：Apache-2.0；`@tesseract.js-data/chi_sim@1.0.0`：MIT。详见 `THIRD_PARTY_NOTICES.md`。 |
| 14 | 支付宝 Parser 规则 | 先校验支付宝/蚂蚁财富来源证据，再按坐标识别基金名称锚点、跨行合并名称、按行带重叠去重，分别解析中列“持有金额/昨日收益”和右列“持有收益/收益率”。严格保留正负号与百分比；布局或字段证据不足时保持 `null`，不跨行猜测。 |
| 15 | 基金匹配规则 | 六位代码优先；否则使用标准化名称、份额类别隔离和同源 `data/fund-catalog.json`。只有达到置信阈值且与第二候选拉开差距才自动匹配；其余进入人工确认。真实图结果为 10 自动匹配、5 人工确认。 |
| 16 | 持仓模型映射 | 复用 `{code,name,shares,cost,updated_at,deleted}`；截图金额/收益只作快照核对。必须提供大于 0 的真实份额，成本净值才可按 `(持有金额 - 累计收益) / 真实份额` 计算；严禁按盘中估值反推份额。 |
| 17 | 确认与合并策略 | 识别后不自动写入；逐条新增、更新或跳过。5 条不确定记录默认跳过；截图外旧持仓保持不变。确认批次先备份并建立无敏感数据的待同步恢复标志，再写入、清理相关缓存并安排既有 Gist 同步与估值刷新；恢复标志无法持久化时不会改动主持仓。 |
| 18 | Android 测试 | `NOT_RUN`。未取得 Android Chrome 实机/PWA 证据。 |
| 19 | iOS/Safari 测试 | `NOT_RUN`。未取得 iOS Safari 或已安装 PWA 实机证据。 |
| 20 | PWA 测试 | `PARTIAL`：生产 manifest、`fuyu-v14.0.0` Service Worker 及 network-only OCR 路由已验证；移动端已安装 PWA 仍为 `NOT_RUN`。 |
| 21 | 首次 OCR 加载耗时 | 本机 localhost 首次选图到确认结果页约 18.3 秒。生产 Pages 冷加载也完成识别，但自动化在大资源下载期间多次超时，未取得可复现的精确总耗时；不得用本地 18.3 秒冒充线上或移动端性能。 |
| 22 | 单张支付宝截图 OCR 耗时 | 1440×9317 真实长截图本机桌面 Chromium/IAB 完整处理约 18.3 秒；该数字不是 Android/iOS 性能承诺。 |
| 23 | 真实截图结果 | 15 条记录重建；10 条自动匹配、5 条人工确认默认跳过；持有金额/昨日收益/持有收益/持有收益率四字段均为 15/15。未展示、记录或提交任何真实金额。 |
| 24 | 单元测试 | 最终候选源码已运行 `npm test`，114 项全部通过。 |
| 25 | Production build | 最终源码 `npm ci`、114 项测试、语法检查、生产构建、模型摘要、Worker 相对路径及静态产物校验均通过；依赖安全审计为 0 漏洞。Actions `31563016789` 的 build/deploy 均成功。 |
| 26 | Network 隐私验证 | 本机流程仅访问 localhost/同源资源；生产真实图流程同样完成 15/10/5 结果。隔离页 CSP 仅允许同源连接，截图为本地 `File`，GitHub Pages 无上传端点；页面控制台无应用错误。自动化未导出逐请求 HAR，因此不把该证据扩展为移动端 Network 证明。 |
| 27 | 图片上传 | 0。页面只接受本地 `File`/`Blob`，没有图片上传端点；真实图流程未观察到上传请求。 |
| 28 | 收费 API | 0。没有 OCR API Key，没有百度/腾讯/阿里/Google/OpenAI/Gemini 等云 OCR 调用。 |
| 29 | 新增运行费用 | OCR 0 元/次；持续新增费用 0 元；新增资源成本仅为现有 GitHub Pages 静态资源流量。 |
| 30 | 已知限制 | 仅针对当前支付宝/蚂蚁财富持仓双列布局；微信压缩、页面版本变化、暗色模式和极端模糊图可能降低匹配率；生产首次加载体积大且可能需要较长等待；5 条模糊身份仍需人工选择；必须人工补充真实份额。 |
| 31 | 未完成项 | Android Chrome、iOS Safari/已安装 PWA 的选图、OCR、确认、返回与同步流程仍为 `NOT_RUN`；生产桌面流程、线上 SW 和最终 CI 已完成。 |
| 32 | `git diff --stat` | 发布候选暂存区为 49 个文件、6456 行新增、39 行删除（另含两份 hash 固定的二进制模型）；范围均属于 v14 OCR、可靠性、构建、测试与文档。 |
| 33 | `git status` | 提交前 `git status --short` 已确认仅包含预期 v14 变更；真实截图、参考资料路径、私钥与真实 Token 均未纳入。提交后须再确认工作区 clean。 |
| 34 | 发布状态 | `DEPLOYED / DEVICE_VALIDATION_PENDING`。代码、CI、Pages 与生产桌面真实图已完成；因 Android/iOS/已安装 PWA 无实机证据，仍不标记 `READY_TO_RELEASE`。 |

## 真实长截图验收

| 检查项 | 结果 |
| --- | --- |
| 输入 | 用户提供的真实支付宝长截图，1440×9317；仅从仓库外本地路径选择。 |
| 执行环境 | 本机桌面 Chromium/IAB。 |
| 生产复验 | `https://aureliuswu.github.io/FundVal/ocr-import.html` 使用同一原图完成 15/10/5 结果；确认页可用、应用控制台无错误。 |
| 识别/重建 | 15 条持仓行。 |
| 自动匹配 | 10 条。 |
| 人工确认 | 5 条，默认动作均为跳过，不会静默写入。 |
| 四字段覆盖 | 持有金额 15/15、昨日收益 15/15、持有收益 15/15、持有收益率 15/15。 |
| 完整处理耗时 | 约 18.3 秒。 |
| 图片上传 | 0；只加载同源 OCR 静态资源。 |
| 持久化 | 原图、OCR 原文与真实金额均未写入存储/日志/仓库。 |
| 安全跳过流程 | 15 条全部改为“跳过”并确认时，页面明确返回“没有需要同步的持仓变更”，不导航、不写入。 |

这项本地证据证明当前桌面浏览器能够处理用户给出的超长截图；它不替代 Android、iOS/已安装 PWA 或生产 Pages 的实机验收。

## 构建、性能与隐私边界

- OCR 模块不在首页 JS 依赖链中；打开基金主页面不会下载 PaddleOCR、模型、ORT 或 Tesseract 资源。
- Service Worker `CORE` 不预缓存 OCR 资源，且 `/assets/ocr/` 使用 network-only，避免把约 120 MB 的 Paddle 主链再复制进 Cache Storage 或淘汰应用核心缓存；浏览器仍可按 HTTP 缓存规则复用。用户选择截图后才按需请求，离线首次 OCR 不保证可用。
- 官方 PaddleOCR JS 经 Vite 默认基址构建时会生成根绝对 Worker URL，在 `/FundVal/` 项目子路径下请求错误位置；当前构建改用相对基址，并校验最终 URL 相对于引擎模块。
- OCR 隔离页不加载 `app.js`、`bootstrap.js`、行情 JSONP 或分析脚本。CSP 只允许同源脚本/Worker/连接、必要的本地 WASM 执行和 `blob:` 图片预览。
- 运行期间只保留必要的图像对象和坐标 token；转换为确认候选后立即丢弃原始 OCR token，离页释放 Worker。

## 发布前更新命令

以下命令必须针对准备提交的最终源码重新执行，并把精确结果补回本文件：

```powershell
npm ci
npm test
npm run check
npm run build
git diff --check
git diff --stat
git status --short
git rev-parse HEAD
```

发布后还必须补充 GitHub Actions、Pages 精确提交、干净会话首屏、`ocr-import.html`、同源模型/Worker/WASM、生产 Network 无图片上传和 Service Worker 更新证据。

## 尚未通过的发布门禁

| 门禁 | 当前结果 |
| --- | --- |
| 桌面 Chromium/IAB 真实 1440×9317 支付宝长图 | `PASS`（15 条、10 自动匹配、5 人工确认、四字段 15/15、约 18.3 秒、无上传） |
| Android Chrome 选图、本地 OCR、确认与同步 | `NOT_RUN` |
| iOS Safari / 已安装 PWA 选图、本地 OCR、确认与同步 | `NOT_RUN` |
| 生产 Pages / Service Worker 更新 | `PASS`（v14、OCR network-only、Worker/模型/ORT/WASM 均在线） |
| 生产域名桌面真实图 | `PASS`（15 条、10 自动匹配、5 人工核对、确认页可用） |
| 生产域名图片上传边界 | `PASS WITH LIMITATION`（本地 File + 同源 CSP + 静态 Pages 无上传端点；未导出逐请求 HAR） |
| 最终源码 npm/构建/差异/CI 闭环 | `PASS`（Actions `31563016789`） |

当前版本已经部署，但不得改写为 `READY_TO_RELEASE`：Android/iOS/已安装 PWA 仍无实机证据，必须继续明确保留 `NOT_RUN`，不得用桌面响应式模拟冒充。
