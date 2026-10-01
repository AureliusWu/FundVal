# M2 数据可信核心：实现与验证

> 日期：2026-10-01（Asia/Shanghai）
> 状态：M2 EXIT / PROTECTED MAIN CANDIDATE VERIFIED；未生产发布。
> 起点：M0 主线 `4c04e7fec9635d099191c0899dc57a25dd343fab`；独立先红提交 `72a25a2`。
> 分支：`codex/v16.0.0-data-contracts`。版本保持 15.0.2，v16 版本冻结在 M6。

## 1. 实际完成范围

- `js/runtime/valuation-period.js`：只消费绑定的 NAV/日期，输出区间类型、今日资格、区间收益、标签和比较键。正式净值即使目标日期为今天也不是“今日估算”；旧数据明确标旧，缺值维持 null，真实相同 NAV 的收益为 0。
- `js/runtime/market-clock.js`、`data/market-calendars.json`：统一中国日边界和交易所当地时区；CN/US/JP 的 2026 官方日历含版本、有效期与提前收市。已知市场缺失或过期日历不宣称今日/开市；HK/KR/gold/QDII 暂为 unverified。周末基期、节假日与多日缺口不包装成单日涨幅。
- `js/runtime/quote-contract.js`、`quote-normalizer.js`：严格数字与真实日期解析；canonical null 不被旧别名补数；未知 kind/tier/status 及显式 unavailable 不会被后续时间分支复活。unavailable 的 value/change/base 为 null，消费者也拒绝未知状态生成金额。
- `js/runtime/cache-envelope.js`：缓存保留原来源、获取/写入/到期时间，读取不续期；旧官方 NAV 只按原获取时间适配。损坏、未来、时间倒置、未知来源与枚举拒绝；fresh Quote 缓存同样检查原来源与等级，不能被新外层 TTL 洗白。
- `js/runtime/worker-contract.js`：严格兼容无 schema_version 的 v1、验证数值版本 2 的协议；整包校验请求集合、重复、日期、来源、能力与状态。transport 成功不会抹掉上游 stale/partial/degraded。HTTP 协议版本和行级 estimate-wire 版本分开。
- `js/runtime/holding-set-contract.js`、`js/fund-holdings.js`：整组重仓校验重复 market+code、行数、权重/总权重、名称代码及报告期；不删除坏行再伪装为完整披露。v1 缺市场保持缺失，不把海外代码猜作大陆股票。
- `js/holdings-estimate.js`：严格当日行情与报告期；低覆盖、未知贡献不能补 0；模型基期不能借 stale/cache 数据或裸别名升级；模型不覆盖不兼容日期的正式 NAV。
- `js/runtime/holding-quote-amounts.js`：市值、累计收益及区间收益始终投影当前仓储份额/成本，缓存或慢请求不拥有用户仓位。
- `js/runtime/quote-presentation.js`、`quote-diagnostics.js`、`js/app.js`：标签、区间收益、不同区间分组排序、缓存/原来源诊断接入；渲染时重新判定缓存到期，不因驻留页面而保持假 fresh。
- `js/runtime/notification-policy.js`：只有可信当日且绑定单日区间的非缓存数据才可通知；旧、正式 NAV、模型、缓存、过期日历不冒充今日推送。
- `js/integrity.js`：重复基金缓存整组拒绝，不任意选首条；不更改持仓。

## 2. 日历资料与覆盖边界

CN 使用[上交所 2026 全年休市安排](https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml)与[中秋/国庆安排](https://www.sse.com.cn/disclosure/announcement/general/c/c_20260915_10832273.shtml)；US 使用 [NYSE 交易日历](https://www.nyse.com/trade/hours-calendars)；JP 使用 [JPX 交易日历](https://www.jpx.co.jp/english/corporate/about-jpx/calendar/)。独立复核未发现与官方表的差异。

没有用港股通日历代替香港现货。2027 到期后保守返回 unverified，下一次日历更新应先核对对应交易所。无/unknown 市场只保留保守 weekday 区间判断，不宣称已验证某个交易所日历。

## 3. 必要的冷启动边界调整

M2 新增合同会扩大冷图。为保持既有 52,241 B 硬预算，机械抽出 `fund-model-enrichment.js`、手动云档案 `js/storage/cloud-archive-ui.js` 和 `quote-diagnostics.js` 并按需加载；重仓集合校验抽成小模块，避免模型导入完整 Worker wire parser。

这是保持原行为的最小载入边界调整，不代表 M3 Refresh Plan 或 M4 同步状态机已完成。云档案工厂通过回调读取当前仓储/设置，保留原确认、事务、备份、读回哈希及待同步行为；导入失败可重试。抽取后的上下文与成功/失败路径另有纯内存行为测试，无真实 Gist 写入。

## 4. 最终本地门禁

| 检查 | 2026-10-01 实际结果 |
| --- | --- |
| `npm test` | 548 项：547 pass、0 fail、1 skip |
| skip 原因 | Windows 账户不能创建测试符号链接（EPERM/EACCES）；Linux candidate 必须验证为 0 skip，不能把本地 skip 算通过 |
| `npm run check` | 155 个 JS 源码/测试文件语法通过 |
| `npm run build` | 通过；冷启动 gzip 51,650 / 52,241 B |
| 非 OCR 全 chunks gzip | 86,310 B；**大于 77,227 B 最终目标，M3 必须处理，性能全门禁尚未通过** |
| `npm run test:e2e`，端口 12437 | 13/13，通过，17.1 秒；使用合成持仓、固定行情和 mock，不代表真机或真实云同步 |
| `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 0 vulnerabilities |
| `node scripts/dependency-install-policy.mjs` | 5 个锁定安装脚本已审查；没有升级依赖 |
| app chunks 校验 | 35 个 chunks，226,084 B 原始体积，通过 |
| OCR 资源校验 | 23 个资产，88,196,906 B，通过；引擎/模型未更换 |
| 两次连续构建目录指纹 | 均为 `4a5a40ea586509d917ddb7a7cfc6cc656b1f5508abf01b26472ded3d681f1d13` |
| `git diff --check` | 无 whitespace error；Windows LF/CRLF 提示不等于内容漂移 |

E2E 包含正式 NAV 区间标签、缓存重开、份额 100→200 后网络 503 仍按最新份额显示 4.44 区间收益、XSS 全组拒绝、Schema 3 增删/重开、旧编辑器不覆盖新持仓、opaque-origin Bridge、云读回不一致 fail closed、OCR 页和 PWA 离线基本链路。

本次最后三轮桌面移动 viewport 合成场景：cold 215.1/201.4/191.6 ms，warm 150.8/132.9/122.0 ms，save UI 56.94/59.36/62.52 ms。只是本地交互预算检查，样本不足以声明 p95、稳定前后性能改善或物理设备通过。

独立只读 QA 两批针对性测试共 204/204；最后合同复现 68/68，通过未知状态、unavailable 残值、缓存来源等边界复核。未发现新的可复现 M2 P0/P1；这是所测范围结论，不是全项目零 Bug 保证。

## 5. 兼容与真实数据证据等级

- Schema 3、tombstone、device shard、legacy 文件保留、Web Lock 与事务基线未改；启动仍先迁移/完整性检查后加载 app。
- Bridge 仍精确 `sandbox="allow-scripts"`，未扩大操作、允许源或参数边界。OCR 不进入 cold graph 或 SW CORE。
- 所有测试财务数据为合成。没有提交用户截图、OCR 原文、真实持仓或 Token。
- 只读 Worker v1 抽查：005844 为 9/29 的 3.2259→9/30 的 3.1282，-3.03%；012920 为 9/28 的 3.7218→9/29 的 3.7594，+1.01%。请求发生在 10/1，不把请求日补成行情日。重仓 live 请求超时，不宣称当前 live 重仓已验证。
- 外部司南 Worker 仓库未修改；v2 客户端验收使用合成协议 fixture，外部服务尚未协调上线 v2。
- 本地目录指纹不是 GitHub immutable candidate 或生产证据；protected CI、主线 candidate 与独立下载校验待执行。

## 6. 显式未完成

- M3：同代请求去重、稳定资源 TTL、按活动持仓裁剪/证券批量行情、全资源代际提交、每代最多一次聚合缓存实际写入、非 OCR 总包大小门禁。
- M4：`contracts/gist-selection.contract.mjs` 的多档案选择仍 RED；同步状态机/凭证策略/退避/专用合成账户真实双端读回未完成。
- M5：`contracts/ocr-import-safety.contract.mjs` 的布局导入门禁仍 RED；解码前像素预检/内存、取消、移动端与更新 guard 待实施。两个 RED 合同必须在对应里程碑纳入自动测试并关闭后才可发布。
- M6：三类物理 Android/iOS/PWA 各三次、v15→v16 真升级、生产 smoke 与同一候选产物发布未执行。

不得把模拟器、桌面 E2E、本地纯内存适配器或当前 15.0.2 显示当作 v16 已发布/真机已通过。以下主线证据满足 M2 退出要求；总非 OCR 预算尚未通过，M3 不得以此标记性能退出。

## 7. 受保护主线退出证据

- PR [#11](https://github.com/AureliusWu/FundVal/pull/11) head `f93668e7e8b00d6c1d564edc751111e4f1e5d1f3`：required candidate/codeql 与独立 GitHub Advanced Security CodeQL 全绿后受保护 squash merge。
- main：`154139d78b0e226fd99ec9a3009c1e63c06925ca`；真正 push/main [CI 36867144431](https://github.com/AureliusWu/FundVal/actions/runs/36867144431)，attempt 1，candidate job 110385355950、codeql job 110385355760 均成功。
- Linux 548/548、0 fail/skip，syntax 155、E2E 13/13、audit 0。main CodeQL analysis 1874085816 对应该 SHA：103 rules、3 results，error/warning 为空；原 M0 main 为 5 results。既有 3 个 findings 不因 workflow 成功就算已修复。
- immutable artifact 11164058335，`fundval-candidate-154139d78b0e226fd99ec9a3009c1e63c06925ca-1`。真正 main-only CLI 验证 exit 0，133 文件/92,432,941 B 的路径、大小、SHA 逐项一致。
- 内层 `site.tar` 92,538,880 B，SHA256 `b8c9fb8babe79bfc876f59678a7f444943c00ecde69bce7f43f2bd3445352791`。
- site fingerprint `7e39499e560bce2dae5b3e0b3b9db3e8f36604efeaeb595ba31ed2505bad7f3a`；release fingerprint `8b4d3fe965ced8c09ad009b585e345e07d388fe1617232c70bbfe09ce439fa0f`，官方脚本重算与 manifest 一致。
- app 35 chunks/226,084 B、OCR 23 assets/88,196,906 B 校验通过。3 次独立 gzip 重算 cold 51,650 / 52,241 B、all 86,310 B，后者仍红。
- 外 ZIP 92,563,148 B 仅 API/CI 记录，未独立重算外 ZIP digest；不扩大内 tar 验证结论。
- 下载核验目录：`C:\Users\84046\AppData\Local\Temp\fundval-m2-main-154139d-d275701107de4d4da112ba84faa26d5d\verified-site`。
- PR synthetic merge 与 main squash 是不同 commit，OCR manifest 的 `generated_at` 因 SOURCE_DATE_EPOCH/commit 时间不同而不同，跨 commit 全目录指纹不同属于预期；同一 commit 的连续两次构建仍必须指纹相同。
- 生产 workflow 未执行，生产未因合并自动发布。下一实施分支为 `codex/v16.0.0-refresh-plan`。
