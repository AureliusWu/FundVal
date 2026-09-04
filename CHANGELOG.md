# Changelog

## 15.0.1 - 2026-09-04

- 修复已安装 v14 PWA 首次收到 v15 HTML 时可能仍执行旧 `app-shell.js`，导致新版 `data-action="apply-update"` 按钮与旧版全局更新函数断开、点击“安全更新”无响应的问题。
- 新增独立同源 `js/update-compat.js`：仅在旧缓存脚本确实暴露 `applyPendingServiceWorkerUpdate` 时转交点击，完整复用旧版的未保存输入、云同步、跨标签页与刷新排空保护；当前 v15 委托事件路径不受拦截。
- 将兼容脚本纳入 Service Worker `CORE`、发布指纹、构建不变量、CI 产物/生产 smoke、Node 回归与 Playwright 混合版本测试；不恢复 inline handler，不直接发送 `SKIP_WAITING`。
- MuMu Android 15 / Brave 已复现 `v15 HTML + v14 JS` 混合态；手动激活 v15 Worker 后五项指数恢复，确认行情 Bridge 与数据源正常，问题位于升级过渡而非缺失值回填。模拟器证据不替代物理 Android/iOS 门禁。

## 15.0.0 - 2026-08-29

- 关闭基金代码与同代码股票碰撞：基金主报价链不再把证券 `stock/get` 结果当作净值，无法确认身份时保持 `-- / unavailable`。
- 将东方财富、腾讯 JSONP 迁入无同源存储权限的 `sandbox="allow-scripts"` 隔离桥；主页面 CSP 只执行同源脚本，Bridge 请求、响应、代码、数量和有限数值均再次校验。
- 对重仓证券代码、名称、占比和数组长度执行严格规范化并完整转义远端文本，补齐恶意 HTML/SVG/JavaScript fixture 回归。
- 删除持仓后统一裁剪行情卡、详情、缓存和在途请求；启动只建立一个刷新 generation，主卡先显示，正式净值、重仓和海外模型在后台 enrichment。
- 云同步、重仓、通知与 JSONP Bridge 改为按需 chunk；首页冷启动图从 52,241 B gzip 降至 51,597 B，硬门禁没有上调，并生成带 SHA-256 的 `js/app-chunks.json`。
- 14:30 通知改为用户显式启用，且仅允许当日、10 分钟内、`realtime/delayed + intraday_estimate` 的有限涨跌（含 0）触发。
- OCR 基金目录建立一次性精确/份额类别/trigram 索引与会话复用；未知成本继续为 `null / --`，冲突写入保持 fail-closed，性能账本不记录截图、原文或金融字段。
- 增加本地只读数据代理、浏览器 E2E、PWA 离线/更新、恶意重仓、云同步读回不一致和 OCR 确认边界验证；Android MuMu/Brave 用真实长截图识别出 15 条候选（12 自动匹配、3 人工核对）。
- 修复正式净值 UTC+8 日期偏差、正式净值/重仓异步返回顺序导致估值基准不一致、首次创建云归档期间并发本地编辑被误标为已同步，以及 partial 数据源记录错误；均补充回归测试。
- 站点构建在未显式提供 `SOURCE_DATE_EPOCH` 时使用当前 Git 提交时间生成 OCR manifest，保证同一提交连续构建的发布指纹一致。
- 物理 Android Chrome/PWA 与 iOS Safari/PWA 尚未执行，实体设备验收状态按方案记为 `BLOCKED_FOR_DEVICE_VALIDATION`，模拟器证据不替代真机门禁。

## 14.0.4 - 2026-08-29

- 修复 OCR 初始化失败或 WebGPU 回退到 WASM 后识别失败时丢失后端诊断的问题；账本只保留固定枚举、布尔值和有界性能数值，不记录截图、OCR 原文、文件路径或底层错误。
- 增加 WebGPU 成功、WASM-only、WebGPU→WASM 成功、回退后识别失败与双后端初始化耗尽的行为测试；诊断中心显式标记矛盾遥测，不再把未知后端伪装为 WASM。
- Service Worker 新版本安装、版本桶首次运行时缓存和 OCR manifest 强制向部署源重取；OCR JS/MJS 使用允许 304 复用的条件重验证，避免相同资产 URL 的旧 HTTP 缓存污染新 app-shell、按需模块或 Paddle engine/Worker，同时避免 11 MB Worker 每次全量重下；部署 smoke 会比对发布关键文件的构建指纹，并逐个下载 manifest 中 23 个 OCR 资产核验字节数与 SHA-256。
- Schema 3 真实 Gist sidecar 已完成新增与规范化读回；2026-08-29 只读复核确认 legacy 内容相对迁移前版本完全未变。本维护版不改变持仓 Schema、OCR 模型、识别策略或同步授权边界。
- Android 15 x86_64 模拟器完成生产首页/SW/移动布局与能力缺失 fail-closed 验证；物理 Android Chrome/PWA 与 iOS Safari/PWA 仍为 `NOT_RUN`，v15.0.0 继续受实体设备门禁约束。

## 14.0.3 - 2026-08-28

- 发布 v15 前置兼容桥：统一 Quote Envelope、市场时钟、刷新代际、请求取消、单基金失败隔离、数据源 cooldown/恢复与可信状态展示，缺失值不再被展示层推断为 0。
- 本地持仓升级为可恢复的 Schema 3 仓储；云端使用按设备隔离的 V3 Gist 分片，永久保留旧 Schema 2 文件，合并较新的旧版变更并阻止旧客户端复活 tombstone 或降写 revision/note。
- 云同步增加原始双文件备份、本地稳定快照、显式升级、PATCH 后 GET 读回与待同步恢复标志；损坏或未来 Schema 保持 fail-closed。
- OCR 增加 WebGPU 能力探测、初始化失败后单次回退 WASM、资产 manifest/hash 校验与不含识别内容的性能账本；真实份额缺失时仍在持仓事务前阻断。
- Service Worker 按资源类型执行 network-first、SWR 与 network-only，并通过受控更新握手保护未保存输入；生产首页构建为单一无 OCR `app-shell.js`，gzip 51,948 B，低于 v14.0.2 冷启动图 +20% 的 52,254 B 门禁。
- Android/iOS 实机仍为 `NOT_RUN`；本版本用于先部署兼容读写边界和建立可回滚的 Schema 3 迁移路径，不冒充 v15.0.0 最终验收。

## 14.0.2 - 2026-08-24

- 修复海外模型把“上一季度最新已披露持仓”立即判为过期的问题；未配置 `valid_until` 时允许披露季度滞后一季，但两季前模型仍明确降级。
- 将 `539002`、`018147` 和 `012920` 更新为 2026Q2 已披露的十大重仓穿透模型，在配置中保留披露日期和来源；新增韩国/日本行情当地时间转化，不让一小时偏移干扰新鲜度判断。
- GitHub Actions 升级为 Node 24 对应的官方版本并固定完整提交 SHA；Pages/OIDC 写权限仅保留在部署 job，PR/build 只保留仓库读权限。
- CI 新增官方 npm registry 高危漏洞审计，构建产物上传前补齐 Paddle Worker 与 ORT JSEP 文件检查；同时启用 GitHub 依赖漏洞告警和每周 npm/Actions 更新检查。
- 构建工具升级至 Vite 8.2.2，并显式固定其 OCR 压缩流程需要的 esbuild 0.28.2，避免可选 peer 缺失导致自动更新 PR 构建失败。

## 14.0.1 - 2026-08-12

- 修复 GitHub Pages 同时启用仓库根目录 Jekyll 与 Actions artifact 发布时的覆盖竞态；发布源统一为 GitHub Actions，并在 CI 中校验 Pages 模式及部署后 OCR 引擎、模型、ORT/WASM 资源均返回成功。
- 修复 Android 系统文件选择器可能返回空 MIME、`application/octet-stream` 或无后缀图片而被提前拒绝的问题，最终仍以本地图片魔数校验格式。
- 增加 Android 浏览器能力预检；缺少 Worker、`createImageBitmap`、OffscreenCanvas、WebAssembly 或 `structuredClone` 时，在下载大模型前提示升级最新版 Chrome。
- OCR 改为单任务锁，识别期间禁用选图、重试与确认，避免重复点击并行启动多个高内存 Worker。
- PaddleOCR 主线程包由约 10.49 MB 缩减为约 4.9 KB，重型 Paddle/OpenCV 只在单个官方协议 Worker 中运行；分片 `ImageBitmap` 直接转移，检测、识别和管线批次均降为 1，降低 Android 峰值内存。
- 本地真实 1440×9317 长截图回归仍得到 15 条候选、10 条自动匹配、5 条人工核对；实体 Android 设备验证仍明确保留为 `NOT_RUN`。

## 14.0.0 - 2026-08-12

- 新增支付宝基金持仓截图本地 OCR 导入：图片仅在独立的 `ocr-import.html` 页面内存中预处理和识别，选图后才加载 `@paddleocr/paddleocr-js@0.4.2`、PP-OCRv6 tiny、同源 Worker/ONNX Runtime/WASM/模型；不上传、不保存截图或完整 OCR 文本。Tesseract 仅保留为降级/回归链路。
- 支持当前支付宝生态“蚂蚁财富”基金持有双列表格：识别 `金额/昨日收益` 与 `持有收益/率` 的行内顺序，仍要求人工确认。
- 截图导入页不加载主盘、行情或第三方 JSONP，避免既有跨站行情脚本接触图片选择器；主页面只负责跳转和在返回后立即安排 Gist 同步、刷新估值。
- 新增支付宝 OCR 解析、坐标分组、正负金额/百分比解析、A/C 份额隔离、模糊候选人工确认和导入计划回归测试。
- 截图金额和累计收益仅作为快照核对；必须填写真实份额后才可换算成本净值。未确认、跳过或截图外的既有持仓均不会被改动；批量写入前自动备份。
- 新增同源静态基金目录（27,487 条，维护脚本只解析公开文本、不执行 JSONP），页面导入时按需读取该 JSON；移除浏览器端第三方目录脚本执行。
- 增加图片 data URL 诊断脱敏、同源 OCR 资产构建/许可证校验及 `npm run build` 静态 Pages 构建。
- 修复 PaddleOCR 构建产物中 Worker 根绝对路径在 GitHub Pages 项目子路径下失效的问题，通过相对构建基址生成并校验模块相对路径。
- 本地桌面 Chromium/IAB 已用 1440×9317 的真实支付宝长截图完成验证：重建 15 条持仓，10 条自动匹配、5 条需人工确认且默认跳过，四类数值字段 15/15，完整处理约 18.3 秒；浏览器只访问同源静态资源，无截图上传。
- 当前 PaddleOCR 主链构建资源总量为 120,057,620 bytes（Tesseract 降级/回归资产另计），两条 OCR 链路均保持首屏零加载且不进入 Service Worker `CORE` 预缓存。发布状态为 `DEPLOYED / DEVICE_VALIDATION_PENDING`：生产 Pages 已通过真实长图复验，Android、iOS/已安装 PWA 实机仍未验证。
- OCR 大体积运行资源改为 Service Worker network-only；Cache Storage 配额不足不会拖垮成功请求或淘汰应用核心缓存。
- 导入保存前先持久化无敏感数据的待同步恢复标志，避免主持仓已写入但刷新/Gist 安排丢失。

## 13.0.0 - 2026-08-08

- 启动、迁移、准确率台账和全部本地持久化改为可降级：隐私模式、配额不足或损坏数据不会白屏或把有效估值误报为失败。
- 持仓语义异常不再静默归零；同时间戳删除标记在本地/云端合并时优先，缓存与持仓指纹绑定，避免离线显示旧仓位金额。
- Gist 自动同步改为发现超时、读后合并再写入，并保存待同步标记以便网络恢复或下次启动补推。
- 估值时间增加未来时间校验；海外模型增加配置校验、请求超时、成分时间/披露季度失效规则，过期时回退到最近正式净值。
- 修复海外交易时段跨中国周末判断、腾讯港股斜杠时间解析、重仓披露缓存时效和正式净值备源显示。
- Service Worker 仅清理本应用缓存，离线无缓存时返回明确失败；CI 扩展启动链语法检查并隔离分支部署并发。
- 新增启动存储、缓存一致性、模型时效、同步合并、Service Worker 和海外市场时段回归测试。

## 12.0.2 - 2026-07-28

- QDII 模型以最新公布净值为基准时，同步使用该净值的实际公布日期，避免基准值已更新但副标题仍显示前一日。

## 12.0.1 - 2026-07-28

- QDII/全球基金主列改为优先显示未过期的“下一净值模型估算”，最近正式净值涨跌继续作为独立详情保留。
- 修复腾讯海外行情 `sourceTime` 丢失与美东时间未换算北京时间的问题，不再把 7 月 24 日正式净值误当作 7 月 28 日当前估值。
- 模型估算净值改用最新已公布净值作为基准；成分行情超过 36 小时自动回退到最新正式净值，不把旧模型标成当前行情。
- 增加夏令时/冬令时、模型时间、旧模型降级及显示优先级回归测试。

## 12.0.0 - 2026-07-27

- 当官方盘中估值不可用时，使用最新正式净值和已披露十大重仓的当日行情贡献生成可解释估算。
- A 股重仓行情增加腾讯备源，并保留东方财富/Tencent 的真实行情时间；非当日行情不得参与估算。
- 当日行情少于 5 只或覆盖净值低于 50% 时明确保持不可估算，不以旧涨跌或 0 补齐。
- 顶部行情摘要改为显示“今日 N/总数”，基金项明确标记“模型估算/十大重仓估算”和覆盖率。

## 11.0.3 - 2026-07-26

- 修复 GitHub Pages 直连东方财富重仓接口因来源校验返回 404、被误显示为“暂无重仓股数据”的问题。
- 十大重仓改走受限只读 Worker 代理，并显示季度披露截止日期。
- 区分“暂无公开重仓”和“重仓数据获取失败”；失败后重新展开可重试，不再缓存为无数据。
- 增加重仓字段、空披露、来源失败及代理链路回归测试。

## 11.0.2 - 2026-07-26

- 非交易日或盘中估值表不可用时，改为显示最近两个正式净值计算出的涨跌幅与净值日期。
- 正式净值降级明确标记为“最近净值/净”，不再显示空白、获取失败或误标为海外非实时估值。
- 增加非交易日正式净值语义和显示优先级回归测试。

## 11.0.1 - 2026-07-22

- Route browser valuation requests through the server-side estimate proxy so the upstream-required Referer is supplied reliably.
- Preserve partial results and missing values, and fall back to cached or model estimates without converting missing data to zero.
- Add proxy, partial-response, and model-rule regression coverage.

## 11.0.0 - 2026-07-22

- 将已下线的单基金估值 JSONP 替换为东方财富现行估值表 JSONP，并保留上游行情日期。
- 新增市场分类、统一数据新鲜度与六类可见状态；旧数据不参与估值排序。
- 页面打开、定时、手动、恢复前台和网络恢复均触发真实新请求，刷新请求按顺序应用。
- 修复顶部时间冒充行情时间、部分失败复用旧排序和 PWA 安装失败被吞掉的问题。
- GitHub Pages 工作流补齐锁定安装、测试、检查、产物上传与正式部署。
