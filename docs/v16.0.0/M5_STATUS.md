# M5 OCR、移动端与 PWA：局部实施记录

> 10-28 最新本地冻结见 [LOCAL_QA_20261028.md §6](LOCAL_QA_20261028.md)：永久test/集2139 pass/3 skip（含Temp的宽发现计数另列）、281 syntax、74/74 E2E、两次确定性构建；新同页history导航含重复点击9/9 unit和2/2实际built browser通过。总量按新用户政策NOT_ENFORCED，cold51,283/52,241 B PASS；下文旧预算FAIL不改判。三类物理手机矩阵仅按[用户明确豁免](DEVICE_WAIVER_20261028.md)记NOT_RUN/USER_WAIVED，其余PWA两版升级、WASM/资源/生命周期及最终发布门禁未豁免；不是M5 EXIT或v16发布。

更新：2026-10-26。状态：`IMPLEMENTING / NOT_M5_EXIT / NO_RC / NOT_RELEASED`。应用版本仍为 **15.0.2**，HEAD `f67675746276173fd3b84b770287e1ab5bea27fb` 后未提交的工作树。按 [UPGRADE_PLAN §17](UPGRADE_PLAN.md) 既定分叉与 M4 并行，不代表 M4 已完成。预算失败、真实云端和物理设备等门禁全部保留。

## A. 导入授权 fail closed：已实施、局部验证

对应 `js/holding-import-plan.js`、`js/ocr-import-page.js`、`contracts/ocr-import-safety.contract.mjs`。

- 只有明确 `layout.importable === true`、行语义有效、唯一代码/精确名称匹配且无风险的行才可默认激活；未知来源、不可导入布局、歧义、模糊匹配等默认 skip。
- 风险行须逐项 checkbox 的真实独立授权事件；改 action、全局确认、直接给 DOM checked 赋值不能授权。授权仅保存在本页内存并绑定规范化代码/名称；编辑代码/名称/候选撤销授权。
- `validate/apply/commit` 各边界缺少或丢失策略一律拒绝，不能仅靠 UI disabled 保护。真实份额必须 >0；不由金额和当期估值推算份额；null 与成本 0 不混同。
- 实际锁内保存继续使用 canonical Schema 3 + expected-document 检查，先备份，不删截图外持仓，保留顺序/notes/tombstone。授权、OCR 原文和截图不落持久存储。
- 子任务最终定向 66/66、8 syntax；证据 `Temp/FundVal-m5a-gate-20261025-child/REPORT.md`。早期非 canonical E2E seed 的 stale_local_document 失败保留；改为实际 `canonicalHoldingsDocument` 生成 seed，不放松生产事务。
- 浏览器实际表单/锁内 commit 验证更新 shares=200、null cost、原 note、截图外持仓与顺序；风险身份编辑后不能写入。2026-10-25 最终 8/8 见 `Temp/m4-qa-20261025-parent/ocr-integration-2.*`。

## B. 解码前图片预检：已实施、真实 codec 桌面预检

对应 `js/ocr/image-header.js` 和 `js/paddle-local-ocr.js`。

- 只接受本地 File/Blob 的 PNG/JPEG/WebP；16 MiB 文件与 16×1024×1024 像素上限未放宽。在 createImageBitmap 和重型 SDK 前，有界读取最多 256 KiB、512 容器记录，拒绝伪格式、异常尺寸与动画。
- PNG 检查 IHDR/顺序/非 IDAT CRC/IEND；JPEG 是有界 marker/SOF/EOI 预检，不宣称完整熵解码器；WebP 验 RIFF 长度、静态尺寸、扩展 canvas 一致性并拒绝动画。实际 decode 后继续第二次像素检查。
- 合成 1440×9317 长图仍允许，不以降低尺寸上限绕过要求。固定安全错误不包含文件名、字节、截图、Base64 或 OCR 内容。
- 子任务 41/41，报告在系统 Temp `FundVal-m5-image-header-20261025-child/REPORT.md`。
- `e2e/v16-image-header.spec.js` 在真实桌面 Chrome 用 canvas 生成 PNG 1440×9317、JPEG/WebP 256×384，预检和真实 createImageBitmap 尺寸均一致，bitmap/canvas 清理；`codec-browser-1` native0、1/1，颜色环境告警保留。未加载实际 OCR、未使用个人截图，不是手机兼容或识别精度证据。

## C. 取消、重试与资源归属：部分完成

对应 `scripts/paddle-ocr-entry.mjs`、`js/ocr/engine.js`、`js/paddle-local-ocr.js`。

- 已 aborted 的请求在 Worker/engine 创建前拒绝；初始化 await 之后继续检查生命周期；取消不触发 WebGPU→WASM 回退，真实初始化失败仍保留原单次回退。
- 内部创建的 bitmap 在成功、异常、transfer 失败、late decode/abort 后关闭；借入 crop 由 caller 关闭。显式 abort 拒绝 late success；普通 dispose 仍保留既有 started-recognition drain 语义，未改变旧测试预期。
- 主 adapter 在 manifest/factory/engine 初始化/crop/predict 每个 await 后加取消检查；新增 5 控制实际先红 1 pass/4 fail 后 5/5。各 crop 和 source finally 归属保留。
- 子任务最终 49/49、3 syntax，真实中间失败保留，见 `Temp/M5-resource-20261026-child/REPORT.md`。FakeWorker 调用 terminate 不等于实测物理 CPU/内存已释放。
- 原主线程 createImageBitmap 的 promise 本身不可取消，永不 settle 时 dispose 可能等待。现已将生产 adapter 改为 `createLocalImagePreprocessor({signal})` → initialize(localBlob) → serial crop(rect)；解码原图只留在一个轻量 Worker，真实 crop transferable 给 caller，最外 finally **先同步终止预处理，再 await OCR dispose**。单重型 Paddle Worker/模型/版本不变，不引入主线程或 CDN fallback。
- 轻预处理组件最终 36/36、3 syntax；实际发现并修复迟到已转移 crop 的 receiver cleanup 和异常 errorCode 对象 coercion，保留 36 total/33 pass/3 fail RED。取消后安装无会话闭包的丢弃 receiver，终止并释放 pending；见 `Temp/M5-preprocess-20261026-child/REPORT.md`。组件报告中 NOT_INTEGRATED 是它冻结时的历史边界，后续生产接入以父级记录为准。
- 测试迁移先以新 factory 注入和禁止主页面 decode spy 对原 adapter 实测 46 total/32 pass/14 fail，再由新 adapter 通过，最终 **48/48、3 syntax**。原 86+29 条 assert 调用文字和相对顺序逐字保留。原 options-decode 兼容重试两用例现在执行实际 Worker handler，而非生产测试后门；新增 factory/signal/原 Blob/矩形、crop 同一性和慢 OCR dispose 前 source 已释放。见 `Temp/M5-adapter-worker-tests-20261026-child/REPORT.md`。
- `e2e/v16-preprocess-worker.spec.js` 真实 Chrome：三 codec 解码和 transferable crop/close；controlled held-decode 后实际原生 Worker close 事件 **<2 秒**、新 Worker 可重试；生产默认 adapter 在主页面 decode 被禁止时完成 1440×9317 的 8 片；实际 OCR 页取消默认 adapter 时也等待原生 close <2 秒、无 SDK/模型请求。初轮 4 total/3 pass/1 fail 为新测试错写 9 片（实际原计划是 1 个 source+7 个 holdings=8），保留原失败/trace，仅纠正该新期望；最终 `preprocess-adapter-browser-2` **4/4、native0、0 retry**。
- **仍未闭合：** held-decode 是受控不 settle 的 native-operation 边界，不是制造真实解码器卡死；成功 adapter 测试替换的只有重型引擎预测，不是实际 Paddle 精度/性能。桌面原生 Worker close 不等于手机物理 CPU/内存回收，更不能关闭三类手机的 ≤2 秒门禁。manifest/factory 动态加载、重型初始化/识别及后台恢复仍须组合验证；不能继承 fake Worker 测试或整个测试用时为实际停止时间。

### 实际重型初始化/推理取消：桌面有界预检

- 新 `e2e/v16-ocr-real-cancel.spec.js` 使用固定永久PNG、原SDK/模型/Workers，只有被动postMessage/DOM观测；真实`init`或`predict`已发送、真实light+heavy均active后点击取消。原30s/0retry不变，原生关闭和实际finally解锁分别测量≤2s，再实际同图重试，不注入预测或hold网络。
- `Temp/M5-actual-cancel-20261026-child/REPORT.md`（SHA `d3a7042b3b7b10f0e214ec6c7c2975a818ed80120b16623a9367ae3cdb49637f`）最终`native-cancel-2` **2/2/native0**：init native close保守上界155.289ms、finally2.200ms、retry9,212ms；predict close1,643.735ms、finally6.800ms、retry7,468ms。两次retry均15行、WebGPU、8片/106块，canonical持仓hash未变、无确认、无外部/写请求、页面/console错误0。
- 原`native-cancel-1`为1pass/1fail：init在点击前因Playwright Worker-created事件晚于页面postMessage递送而缺active快照，`cancelPageMs=null`；不是生产init取消失败或通过。仅新harness改为选图前注册真实heavy事件、等待消息和事件均到，原active断言及限时不变，保留RED/trace。原predict通过的close上界1,783.957ms也保留，不挑最快。
- native close从click调用前Node时刻计，含actionability/事件递送开销，是批准的保守桌面观测上界。UI finally早于native close，本测试等待两者结束才重试，**未证明close前立即连点重试无瞬时资源重叠**；200ms late窗口有界、动态import本身仍不可取消，也不等于物理GPU/内存释放或手机三类验收。最终全套仍须在同一候选上重跑。

## D. 独立页导航、更新保护、窄屏：部分完成

对应 `js/ocr/page-guard.js`、`js/ocr-import-page.js`、`ocr-import.html`、`css/ocr.css`。

- 识别时有取消按钮；取消后立即撤销会话/拒绝 late preview，但重试控件须等原任务真实 finally 完成才解锁，不用 Promise.race 假装资源已停止。
- 显式关闭/返回有脏结果确认；保存事务进行中拒绝该离页入口。beforeunload 尽力保护浏览器导航；pagehide 清理内存、断开监听与 channel；bfcache 恢复重建空状态。移动系统可能不触发 beforeunload，硬件返回/后台杀进程不声称已可靠拦截。
- 同源 `fuyu_sw_update_v1` 只接收有界 prepare requestId，有未保存工作时回复固定 blocked；不发送截图/持仓/Token，不自行注册 SW 或发送 SKIP_WAITING。
- visualViewport 高度/offset 驱动模态高度，聚焦输入滚入可视区；保持 16px 表单文字、44px 控件和 sticky 确认栏。真实键盘、safe-area 与 installed PWA 仍需真机。
- 6 项 page guard 单测及实际 AST page harness 合跑 20/20。浏览器新增两项先红（10 total/8 pass/2 fail），实现后 `page-guard-green-1` **10/10，native0，0 retry**，2026-10-26T07:00:27.654Z→07:00:41.244Z。320/360/390px 实际预览无横溢、确认栏首尾可见；320px 合成截图已人工查看。
- 浏览器取消用 held synthetic recognition，仅证明任务/UI 生命周期；另有实际 BroadcastChannel 与 native confirm 的脏预览/放弃导航测试。以上不是实际长图 OCR 时延或物理设备停止时间。

### 排空刷新期间其他页面变脏：有限修复及原生组合验证

- `js/runtime/pwa-update-controller.js` 在真实 `stopAndDrain` 和原本页复查之后，再执行一次已有450ms peer观察，await后再检查本页。被阻止时保留 waiting worker、恢复按钮和刷新，不激活、不重载、不丢弃OCR结果。
- 完整当前controller+真实OCR guard组件新增7项；初6项实际6/6 RED→GREEN，最终关联103/103、6 syntax，见 `Temp/M5-pwa-drain-guard-20261026-child/REPORT.md`。旧v15 oracle字节未改，但旧28配对现明确是只排除这一个精确SHA/AST block的 **M5 delta-excluding compatibility projection**，不能再声称完整当前/旧实现全等或继承M3签收。新组件和原生E2E不经过投影。
- `e2e/v16-app-update-guards.spec.js` 新真实built-App/实际OCR页guard/native等待SW组合：原产物 `pwa-drain-browser-red-1` native1，dirty peer未能阻止激活；新产物 `pwa-drain-browser-green-1` native0、1/1，07:39:31.745Z→07:39:46.707Z。实际持有估值Response跨第一次观察和drain，OCR在drain期间变busy；新检查阻断，取消后clean重试只重载请求页。保存独立安全事件JSON、产物SHA、导航计数、stdout/stderr；新版附件以outputPath落盘，不依赖list reporter保留passed body。
- 此补丁不是跨context原子锁：peer已经clean处理最后prepare之后才变dirty仍可能漏；BroadcastChannel不可用时仅本地保护；旧v15 OCR页不能假定有新guard。仍是同版本SW尾注实验，不是已安装v15→v16迁移或真机证明。

## E. PWA身份与可见离线壳：部分完成

- `manifest.json` 新增 `id: /FundVal/`、`scope: ./`，保留 `start_url: .`。2026-10-26实际HTTP200读取旧生产manifest确认无id/start_url为`.`；新id按origin解析后等于原生产默认身份，而不是错误地写`./`后变成origin根。依据 [W3C id processing](https://www.w3.org/TR/appmanifest/#id-member)，并新增4项测试实际4/4 RED→4/4 GREEN。此身份绑定当前GitHub Pages `/FundVal/`部署；不声称自定义根路径部署/旧手机安装已验证。
- `index.html` 加同源已有192px Apple touch icon。原192/512图像字节未改，只声明`any`，撤销未经safe-zone验收的`maskable`声称；**专用maskable图、真实iOS桌面裁切仍未完成**。不凭已有文件尺寸宣布图标验收。
- 复用bootstrap/resilience已有`data-network` owner，`index.html`+`css/style.css`增加持续的“离线 · 当前仅显示本地数据，行情可能过期”。没有新网络状态闭包/定时器/监听，也没有把离线职责延迟搬入App或controller；联网后自动隐藏。
- 新 `e2e/v16-offline-shell.spec.js` 使用实际构建、原生SW、固定390×844、三fresh context；专用静态server不代理第三方，真实合成UI保存后离线重开并进入可编辑持仓。原 `offline-shell-red-1` 3/3因无可见提示失败。第一次GREEN尝试2pass/1fail是测试预热未等实际首次安装reload、测量前context被销毁；保留失败，测试改为明确等待原生第二次主框架导航，不改生产或时限。
- `offline-shell-green-2` **3/3/native0/0retry**，07:56:16.047Z→07:56:23.972Z。浏览器`performance.now()`从离线导航起到持仓编辑可用：**292.9/278.2/272.1 ms，median278.2、worst292.9，均≤3000ms**；三轮各自canonical持仓原文/SHA不变，真实成本0仍显示0，提示可见、联网消失，未发生写请求/页面异常。JSON和390px截图实际落盘，截图已查看。与实际Paddle重推理不并行。
- 这是同版本、已缓存本地桌面壳、单合成持仓、无真实行情的绝对时限观察；不是OS冷启动、相对p95回归、手机/已安装PWA或v15→v16升级签收。OCR仍按原策略不预缓存重型资源，不能由该结果推断离线OCR可用。

### 原生manifest解析与子路径预热修复

- `Temp/M5-manifest-native-20261026-child/REPORT.md`：Chrome155真实`Page.getAppManifest/getAppId`均支持；fresh context旧manifest字段回放与当前manifest的原生id/start/scope一致，当前manifest无解析errors，图标实际字节匹配。只是本地原生解析，旧回放不是完整v15构建，没有安装/升级/真机证据。
- 该probe还真实发现每场景7条root-absolute `/js/chunks/...`失败请求，原警告保留；后续只读溯源 `ROOT_PRELOAD_REPORT.md` 确认Vite默认base=`/`使**预热helper**丢`/FundVal/`，40条真实ES imports却仍为相对路径，所以列P2预热/重复请求问题，不误报整站无法启动。
- 新 `e2e/v16-subpath-preload.spec.js` 在contained `/FundVal/`静态server真实启动和操作行情/持仓导航。前两次RED先遇新测试/Playwright向opaque sandbox iframe注入storage/SW访问的SecurityError，未改生产sandbox或过滤pageerror。仅将新测试的fresh-storage观测限定top，并用server端固定503拒绝SW脚本、断言无registration/controller；这是预热测试隔离，不是SW通过。第三次 `BASELINE_3` 只在root requests exact-empty gate RED（实际7），ready/nav均true、pageerrors0；所有旧失败保留。
- 生产只在 `scripts/build-site.mjs` 加 `base:'./'`，保留OXC、ES2022、五组加载、启动顺序和全部门限；不禁用preload、不虚造根路径映射。`subpath-green-1` 原配置 **1/1/native0**，root requests0、真实ready/nav通过，pageerrors0、写/代理0；4个行情外域读取均安全阻断并保留console类别，不能声称此测试console完全无错误或真实行情已验证。
- 两次当前构建 `subpath-build-{1,2}` 原生0，全部runtime/test/script输入清单同，生成site全文件清单同；all由95,208变为**95,223 B（+15）**、cold由50,754变为**50,763 B（+9）**。这是子路径正确性修复，不虚称减包或延迟提升；总包FAIL仍保留。

## F. 实际Paddle固定长图：桌面基线已测，永久路径待全套

- 新安全图 `test/fixtures/ocr/synthetic-alipay-1440x9317.png` 为1440×9317、15行、785,150 B，SHA `487ec86fc114732a3350e02b53c99aa7dfbd7f7e85d9299bda3144d986a0b314`；配套expected JSON SHA `f5fd86504bab0972d97542d924d3e5da364b9137c544b28781b1452d4c54aaea`。只含公开基金身份和事先人工构造的金额，无个人截图；确定性栅格化三次同字节，先固定标注再识别，没有从OCR结果倒改真值。首行跨tile边界，包含名称换行、真0、null及A/C缺失歧义。
- 原实验 `Temp/M5-actual-corpus-20261026-child/REPORT.md`（SHA `119697326ec5dc07e790071673e4dba0d3542123b6cbef40a145b415a26d9fd5`）实际原生 **3/3、0retry、每例原30s**。07:58:00.765Z→07:58:33.379Z，绑定`offline-intent-build-1`真实父级构建收据、28个相关source/builder及23实际OCR资产。真实SDK/模型/预处理/预测未替换，每次8片、106有效块，WebGPU且无fallback。
- 三轮选图到完整预览 **10,408/7,715/8,257ms，median8,257、worst10,408**；每轮15候选、13可信自动匹配、错误自动身份0、A/C错配0、60字段差异0。摘要14个identity matched不等于自动可信14：一条保持需要核对，缺A/C行明确skip。真实份额和成本未填、显式逐行许可和总ack未勾、未点击确认，canonical合成持仓原文/SHA不变。
- 每轮31个同源静态只读请求、36,313,666 B响应体，外域/代理/写请求0，页面及console错误0；这是WebGPU加载子集，不是全资产大小、内存峰值或互联网传输性能。三个fresh context共享Chrome/OS/GPU，无同图旧版before/after，不宣称回归改善或手机通过。
- 已将同字节PNG/expected、定义、`e2e/helpers/ocr-corpus-binding.mjs`及 `e2e/v16-ocr-real-corpus.spec.js` 放入永久路径；原实验spec/helper/runner和收据完整冻结。新spec不依赖Temp、特定历史receipt或Windows字体，使用标准testInfo附件；helper验证当前source/site、固定版本及23资产，并明确当前builder哈希**不是独立build-input receipt**。路径整理后只做3 syntax和3项collection，尚未运行永久路径浏览器/CI，不能直接冒认原实验3/3。详见同目录`FORMAL_CI_PREPARATION.md`。
- 作者后续只读复核 `READONLY_REVIEW.md` 未发现新增P0/P1，但保留两项P2证据边界：JSON内`PASS`是attach/fixture teardown之前的断言检查点，必须结合最终原生Playwright结果；当前CI只在失败时上传诊断，绿色list reporter不会保留详细OCR收据，后续精确提交CI仍须处理证据留存。该复核没有运行新浏览器，也不是另一作者的独立实现审查。
- 后续统一 `candidate-e2e-1` 已实际执行永久路径3例、真实init/predict取消2例及其余回归，**70/70/native0/0retry**，09:26:58.281Z→09:29:28.350Z。三轮仍15行/13自动/0错身份/0A-C/0数字差异，预览6,294/6,422/6,347ms（median6,347）；取消init/predict关闭上界94.3/1,120.6ms、实际finally2.0/5.4ms，两次同图retry均15行且持仓未变。这些是Windows桌面WebGPU本次观测，不将较快值归因于preload修复或视为配对性能通过。

### CI成功收据留存：本地修正，真实上传未执行

- `.github/workflows/ci.yml` 新增独立`Preserve successful synthetic E2E receipts`，在实际E2E成功后用已存在的同一pinned upload-artifact提交归档明确命名的合成JSON（初5种M5收据，后加第6种native创建防重收据）。仅指定JSON、include-hidden-files=true、14天、无文件即error；不上传通用图片/trace/用户目录。原failure-only全诊断步骤、不可变生产candidate排除`.playwright-results`及最终预算失败步骤原样保留。
- `test/e2e-receipt-retention-v16.test.js` 加3项：成功归档接线/精确JSON allowlist/旧失败与预算独立性，与原5个deploy tests合跑。`receipt-retention-red-1`缺步骤时实际6pass/2fail、native1；实施后`green-1`仍实际失败，因为新测试未归一Windows CRLF；仅新harness显式CRLF→LF、原断言不变，`green-2` **8/8/native0/stderr0**。失败命令原名即使含green也不改判。
- 这是未来workflow行为的本地源码/契约修正，不是GitHub上传已成功；若后续budget失败，E2E收据仍只是可审阅合成证据，不能把整个candidate job叫绿色/可部署。JSON内PASS仍是pre-teardown检查点，最终原生框架结果才是该次测试成败依据。

## 当前整体验证与未退出项目

父级原生 stdout/stderr/receipt 见 `Temp/m5-qa-20261026-parent/`。记录不覆盖其后的源码改动，不把 Windows skip 计通过。

| 检查点 | 实际结果与限制 |
| --- | --- |
| `integrated-test-1` | 1890 total /1887 pass /0 fail /3 既有 Windows skip，native0；移动工作树检查点。 |
| `integrated-check-1` | 255 JavaScript 文件，native0。 |
| `page-guard-build-1` | native0，all 94,536 B，cold 50,665 B；总包不通过。 |
| `read-convergence-baseline-1` | 后续云提示修复及撤销无收益候选后 native0，all **94,564/92,160 B FAIL**，cold **50,690/52,241 B PASS**；不代表预处理 Worker 已集成。 |
| `integrated-e2e-1` | **56/56，native0，0 retry**；12764，2026-10-26T07:08:02.799Z→07:09:48.198Z，351B 颜色环境告警。运行的是 `read-convergence-baseline-1` 实际 site；site 原有文件 SHA 前后不变，新增的仅 `.playwright-results/` 输出。源树唯一变化为尚未被该 site 引用/集成的 `preprocess-worker.js`；不声称全源冻结、当前 Worker 或最新 CI 通过。 |
| `preprocess-adapter-build-1` | 已生产接入 light Worker 的构建 native0；全部 runtime/test/script 清单前后一致；非OCR app chunks仍 94,564/50,690 B（all/cold）。|
| `preprocess-adapter-browser-2` | 新 4/4 真实 Chrome 预处理/adapter/页面取消定向；12768，2026-10-26T07:18:01.160Z→07:18:05.927Z。源与实际 site 全清单前后一致；352B 颜色环境告警。不是更新中 PWA 补丁或最终完整 E2E 结果。 |
| `pwa-second-observation-test-1` / `check-1` | 后续PWA补丁检查点：1948 total /1945 pass /0fail /3既有Windows skip；262 syntax/native0。runtime/test/script全清单前后同；尚不含之后create-intent和manifest测试，非最终冻结。 |
| `pwa-second-observation-build-1` | native0，all94,637/92,160 FAIL，cold50,756/52,241 PASS；原生PWA绿色组合绑定此site，全源/产物清单窗口内前后同。 |
| `offline-intent-build-1` | native0，17chunks，**all95,208/92,160 FAIL（超3,048）；cold50,754/52,241 PASS**。包含当前persistent intent候选与静态离线/manifest；构建窗口完整runtime/test/script清单同。intent定向/独立安全审查和最终全套另算。 |
| `offline-shell-green-2` | 新3/3实际桌面离线交互样本，产物全清单前后同；不替代installed/physical gates。 |
| `candidate-test-1` / `candidate-check-1` | 当前源：**2041 total /2038 pass /0fail /3既有Windows skip**、272 syntax，均native0；输入和site全清单前后同。 |
| `subpath-build-{1,2}` | 两次原生0、stdout和site全清单逐字节一致；17chunks，**all95,223/92,160 FAIL（超3,063）**，**cold50,763/52,241 PASS**。 |
| `candidate-{chunks,graph,bindings,assets,audit}-1` | 五项原生0：17实际chunks字节、literal import closure/静态绑定、23实际OCR资产（88,197,828 B）、npm audit0漏洞。图审查不执行模块、不证明完整启动顺序；实际浏览器另计。 |
| `candidate-budget-1` | 独立CLI原生1，all95,223>92,160；没有把构建成功/其他门禁通过改判总包。 |
| `candidate-e2e-1` | 当前检查点 **70/70/native0/0retry**，端口12775、原30s/expect8s；含永久actual Paddle、取消、离线和子路径回归。stdout27,078B SHA `f52f76b3291f23f42cc82b091144630558d5f81ae3199580da2db0e7fecf3952`，stderr351B颜色环境告警；完整源/产物清单窗口内前后同。 |

上述12份原生收据一致性由父级 `CANDIDATE_SUMMARY.json` 汇总（SHA `674a0633b9405ef01f530f16604974d7d933f6f0304dee55d2697d651a99b629`）：runtime/test/script/root输入清单摘要 `52e99b6d155ade7867403fd4cc788107d86e626a58576708cec8f758f0be11d0`，site全文件清单摘要 `a2689d62ab3b541b4c94bfffee8e4916ba0615016e9728bd562bb44754a84621`。该摘要不覆盖docs/Temp/环境，也不是Git提交/CI签名；后续fixture README文档更新和新M4浏览器用例不在此窗口内，不能追溯声称最终全树冻结。

必须继续完成：WASM及资源峰值；动态加载阶段取消、立即重试资源重叠、超时、切后台、Android/iOS 浏览器兼容；专用maskable图、真实安装身份与已安装 v15.0.2→v16 更新/离线/持仓 hash；总包硬门禁、最终冻结全套及精确 CI。PWA有限竞态补丁/本地离线及桌面WebGPU精度、取消证据不豁免上述范围。三类物理设备各三次见 [DEVICE_ACCEPTANCE.md](DEVICE_ACCEPTANCE.md)，当前 `NOT_RUN`，不得用桌面/模拟器冒充。

未升版、未合并 main、未打 tag、未发布。本文件记录的是实现和未闭合范围，而非 RC 或 v16 完成声明。

## 最终本地收口（不是M5退出）

在追加成功收据CI配置、对应3项单测和两个native create-intent跨reload用例后，统一`final-local-*`窗口实际 **2044 total/2041 pass/3既有Windows skip、274 syntax、72/72 E2E**；两次build完整site字节同，chunks/图/绑定/23OCR资产/audit均native0。独立预算仍native1：**all95,223/92,160 FAIL**，cold50,763/52,241 PASS。

原30s/expect8s/0retry不变，最后E2E09:45:46.504Z→09:48:17.171Z；清单现显式覆盖`.github`，不能与早期不含该目录的52e99...摘要直接比值。最终源清单789afd...、site a2689...前后及11份收据间相同；汇总SHA `31a24753ee855a0eb2ead5c588e67554e34e1c1396f71e5442a9659829ed3582`。6种14份合成JSON实际落盘；新增CI成功上传配置仅静态/本地验证，不冒充远端上传成功。

最新长图三次6,504/6,397/6,385ms、每次15行/13自动/0错身份/A-C/数值差异；init/predict close上界100.8/1,151.2ms，离线壳246.8/264.6/251.9ms。保留原桌面、缓存状态、未配对性能、立即重试/物理内存及真实设备边界。完整来源、失败历史和下一门禁见[最终本地检查点](LOCAL_QA_20261026.md)。
