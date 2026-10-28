# v16 数据可靠性只读验收（2026-10-28）

> 本文保留修复前的只读审计与原生 RED，不代表后续源码未修复。HTTP-only 固定 2 秒元信息偏差兼容已另行实施，严格源日期/金融语义不变；最终 stage2 的 194/194、独立 201/201 与新实源结果见 [10-28 本地检查点](LOCAL_QA_20261028.md) §2。原样本/旧拒绝没有覆盖改判；完整数据/生产门禁仍未通过。

## 结论与发现

- 数据可信度：`CONDITIONALLY_TRUSTED`，仅限本轮四只公开代表代码返回的、明确标注日期的正式净值降级内容。
- `UPGRADE_PLAN.md` §10.2 完整门禁：`NOT_PASSED`。初始接收时 5/5 主源响应被当前客户端契约拒绝；生产盘中估值和海外模型未取得有效样本；本任务未运行浏览器，不能声称页面显示已实测通过。
- P0：本轮没有发现净值错值、缺失值补 0、旧日期冒充今天或正式净值冒充盘中估值的证据。此结论不覆盖未观测的代码、时段或模型路径。
- P1-01（实测）：服务端抓取时间略领先客户端时钟，整个 HTTP 200 批次被零容忍的未来元数据校验拒绝。
- P1-02（验收证据缺口）：本轮 20 条响应行均为正式净值 fallback，没有生产盘中估值或模型成功行，不能关闭其生产可靠性门禁。

未修改业务源码、旧测试或市场时间字段。未操作真实 Token、Gist、账户、个人持仓、本地浏览器存储；未 build、未浏览器验收、未 commit/push/deploy。已有脏工作区保留。本文是当前工作树只读审计，不是发布声明。

## P1-01：小幅跨机时钟偏差导致正常内容整批不可用

- 受影响字段：Worker 顶层 `fetched_at`。
- 生产路径：`js/config.js:16` 固定主源 → `fetchEstimateRows()` → `parseWorkerEnvelope()`；`js/runtime/worker-contract.js:179`–180 对任意 `fetched_at > nowMs` 直接抛出 `WORKER_METADATA_INVALID`。
- 当前页面处理：`js/app.js` 的 `fetchRefreshEstimateRows()` 捕获错误后记录源失败并返回空 Map。页面后续可能尝试其他来源，但本轮没有运行浏览器，所以最终页面是否不可用为 `NOT_CONFIRMED`。
- 精确证据：服务返回 `fetched_at=2026-10-28T07:26:02.442Z`（北京时间 15:26:02.442）；五次客户端接收结束时间分别为 07:26:01.279、01.431、01.588、01.715、01.874Z，领先量分别为 1163、1011、854、727、568 ms。HTTP 均为 200，但原始时刻契约均拒绝。原始响应与 HTTP `Date` 标头均已保存。
- 根因：抓取元数据使用服务器时钟，验证使用客户端时钟；当前元数据验证没有允许跨机器小幅时钟偏差。不能据此断定哪台机器的绝对时钟准确。
- 对照：同一份原始 JSON 不修改任何字段，以稍后真实客户端时间离线回放，5/5 成功；故本轮拒绝并非净值、日期或别名冲突。回放成功不能覆盖初始失败，不能写成 5/5 在线成功。
- 补充四次只读时钟观察（07:33Z）：新 fixed-URL Worker 响应的 `fetched_at=07:33:23.736Z`、HTTP `Date=07:33:23Z`，本机接收为 `07:33:22.573Z`；两个生产 force 样式的 `_` 查询同样返回该新响应、`Age=0`，本机接收分别为 `22.771Z` 与 `22.950Z`。三次 fetchedAt 领先 1163、965、786 ms，当前契约仍 3/3 拒绝。fetchedAt 与各 HTTP Date 差 +736、+736、-264 ms，符合 HTTP Date 仅有秒精度的范围。
- 独立东方财富 API 的补充 HTTP `Date=07:33:24Z`，本机接收 `07:33:23.067Z`，同样领先 933 ms。本次 Worker body 的 SHA-256 与最初五次不同，但三次新观察相同，故不是原来单个旧响应一直携带未来时间。每次墙钟/单调钟耗时差 <1 ms，未见请求期间系统时钟跳变。
- 推断与限制：两服务 HTTP 时钟都相对本机接收时间略前，支持本机相对服务时钟慢约一秒的解释；仅凭 HTTP Date 不能证明绝对真 UTC 或归责某一端。未做 NTP/Windows 时间同步或任何时钟校正。初始与补充样本分别冻结，绝不通过改 `now` 伪称原始在线成功。
- 用户影响：返回内容本身正确，但整个结构化主源可能被拒绝，增加 fallback、旧缓存或不可用风险；不是实测错值。
- 建议最小修复（未实施）：为获取/生成元数据定义明确且有上限的正向时钟偏差策略，并保留原始服务器时间和本地接收时间；继续严格拒绝越界未来时间、错误时区/日期、未来目标行情。不得把服务器抓取时间替换成源行情时间，也不得仅为通过验收删除时间校验。
- 回归风险：放宽范围过大可能接受未来/重放的元数据；还需检查 `refresh-resource-cache.js` 的 `fetched > now` 与缓存 `fetchedAt <= cachedAt` 规则，避免仅 HTTP 入口修复、缓存入口仍拒绝。
- 精确验收方法：用已保存响应分别在原始 `endedAt` 和稍后真实时刻解析，保留 RED；修复后增加 ±小偏差、越界偏差、源行情未来、未来目标日和缓存创建时间顺序断言；再做生产只读采样确认。绝不更改抓到的源日期以获得 GREEN。

现有负控索引（本轮未改）：

- `test/worker-contract-v16.test.js:130`–138：v2 生成元数据缺时区、无效日期、次日未来等。
- `test/estimate-http-characterization-v16.test.js:404`–421：行级 fetched_at 优先级、未来 generated_at、无效 fetched_at 日期。
- `test/refresh-resource-cache-v16.test.js:130`–140：缓存 `fetchedAt: NOW + 1` 拒绝。
- `test/cache-envelope-v16.test.js:81`–96：缓存 fetchedAt/cachedAt 时间顺序及未来写入拒绝。
- `js/runtime/worker-contract.js:112` 的行情 `sourceMs > nowMs`、基期/目标日期规则属于**市场语义**，不能随 transport metadata 策略一并放宽。

## P1-02：当前估值/模型能力尚未获得生产成功证据

五次 Worker 顶层均 `status=degraded`、`source=eastmoney_official_nav`、`accounting={primary:0, model:0, official:4, unavailable:0}`。所有行 `primary_reason=upstream_empty`，`est_realtime=false`、`source_time_precision=date`，估值/模型字段为 null。模型未采用的原始原因如下：

| 代码 | 代表类别 | `model_reason` | 本轮生产能力结论 |
| --- | --- | --- | --- |
| 005844 | 境内主动 | `http_5xx` | 盘中/重仓模型 `NOT_CONFIRMED`；正式净值已核对 |
| 010736 | 境内指数增强 | `non_mainland_holdings_forbidden` | 盘中/重仓模型 `NOT_CONFIRMED`；正式净值已核对 |
| 012920 | QDII / 海外 | `overseas_model_forbidden` | 海外模型 `NOT_CONFIRMED`；正式净值已核对 |
| 539002 | QDII 代表代码 | `model_budget_exhausted` | 模型 `NOT_CONFIRMED`；正式净值已核对；Worker 名称仅返回代码 |

这是功能降级与验收覆盖缺口，不代表未公布今日正式净值就是错误。采样时为北京时间 2026-10-28 15:25–15:26，不能要求尚未公布的当日正式净值，更不能制造 2026-10-28 数值或把 null 改成 0。

建议保留诚实的正式净值 fallback；后续在相关市场可观测时段采样生产估值/模型，核对覆盖、基期/目标、模型版本和不确定性，并完成真实部署页面字段对照。未观测前不得用合成模型通过代替生产模型通过。

## 采样与独立对照

主源来自当前生产配置，不是猜测路径：

`https://sinan-estimate-push.ligugu69.workers.dev/estimates?codes=005844,010736,012920,539002`

独立直连对照为东方财富公开正式净值 JSON API，每只代码单独 GET：

`https://api.fund.eastmoney.com/f10/lsjz?fundCode=<code>&pageIndex=1&pageSize=5&startDate=&endDate=`

请求只解析 JSON 文本，不执行 JSONP、`eval` 或第三方 JS。该对照独立于 Worker 传输，但 Worker 自身也是东方财富数据链路，**不构成不同底层提供商的交叉证明**。未把搜索引擎缓存摘要当成当前净值证据。

| 代码 | 独立基期 / 基值 | 独立目标日 / 净值 | 公布涨跌 | Worker 对照结果 |
| --- | --- | --- | --- | --- |
| 005844 | 2026-10-26 / 2.5016 | 2026-10-27 / 2.3306 | -6.84% | 代码、值、基值、两日、涨跌全部相等 |
| 010736 | 2026-10-26 / 1.0488 | 2026-10-27 / 1.0328 | -1.53% | 同上 |
| 012920 | 2026-10-23 / 3.2783 | 2026-10-26 / 3.2878 | +0.29% | 同上 |
| 539002 | 2026-10-23 / 2.0770 | 2026-10-26 / 2.1110 | +1.64% | 同上；完整名称未独立核验 |

四只目标日均为独立接口返回的最新一日；由目标/基值算得的涨跌四舍五入到两位后均相等。源行情日期原样保留为 10-27 或 10-26，抓取时间保留 10-28，二者没有混用。

五次 HTTP 延迟为 9945、146、156、126、157 ms，中位数 156 ms。后四次 `CF-Cache-Status=HIT`、`Age=0`；五次响应 SHA-256 完全相同。它们是五次 HTTP 观察，**不是五个独立行情快照**，也不足以作可用性 SLA 或性能结论。缓存响应 `Cache-Control: public, max-age=20`。本次请求没有应用强刷的 `_` 参数，不能把结果等同于所有强刷请求行为。

## 字段血缘与展示投影

| 用户字段 | 输入与转换 | 缓存 / 展示约束 | 本轮结果 |
| --- | --- | --- | --- |
| 当前净值 / 涨跌 | Worker `value_nav/value_change` → wire contract → `normalizeEstimateRow().source_quote.value/changePct` | official fallback `sourceTier=secondary`，不提升为 primary/realtime | 四只净值与涨跌相等；`status=official` |
| 基期 / 目标 | `base_nav_date/value_date` → Quote `baseNavDate/targetDate` → `createValuationPeriod()` | `baseDate < targetDate`；正式净值显示“最新正式净值变动”，不叫“今日估算” | 四只 `isTodayEstimate=false`，原始两日期保留 |
| 行情时间 / 抓取时间 | 行级 `source_time` 与顶层 `fetched_at` 分开规范化 | date-only 不虚构分钟；`sourceTimeLabel` 与 `fetchedTimeLabel` 分开渲染 | official 日期保留；fetchedAt 10-28；初始元数据拒绝见 P1-01 |
| 来源 / 降级 | `eastmoney_official_nav` → canonical `eastmoney-official-nav`，fallback/diagnostics → reasonCodes | 正式净值为 secondary，不能覆盖为实时估值 | 来源“最新正式净值”，种类“最新净值涨跌” |
| 缓存 / 旧身份 | `estimates:<排序去重代码>`，`nav:<code>`；TTL 分别 60 秒 / 600 秒 | cache envelope 保留 fetchedAt/cachedAt/expiresAt 与原来源；行内 fundCode 必须匹配；读取不续期 | 过期缓存投影保留代码、原来源、行情/抓取时间，均“旧缓存” |
| 个人盈亏 | `holdingQuoteAmounts()` → `createValuationPeriod()` 与绑定的 baseNav | 真实份额/成本属于仓储，不属于缓存；未知保持 null | 本轮没有读取或计算真实账户盈亏，展示投影 `shares=null` |

主要代码：`js/eastmoney-estimate.js`、`js/runtime/worker-contract.js`、`quote-normalizer.js`、`quote-contract.js`、`quote-presentation.js`、`valuation-period.js`、`cache-envelope.js`、`refresh-resource-policy.js`、`refresh-resource-cache.js`、`refresh-execution.js`、`holding-quote-amounts.js`，以及 `js/app.js` 的候选选择/展示契约。原始工作树源码 SHA-256 见测试 receipt 的 manifest；本报告没有声称绑定新 commit。

## 定向验证及 RED/GREEN

- 新 Temp 探针直接调用当前生产 normalizer/contract/presentation：`23/23 PASS`。覆盖正常当前行、真实 0 涨跌、null/空串/`--`/undefined/NaN、0 净值、缺失/只有日期/过期/未来的源时间、显式失败、别名冲突、外来代码、正式净值日期、QDII 模型证据/缺失证据、缓存过期/不续期、正式 fallback 排序、HTTP 503 与网络异常。
- 现有 12 个定向测试文件：`168/168 PASS`、skip 0、原生命令 exit 0。包含中美市场时钟、周末 carryover 与周一恢复、早收市、纽约/首尔/东京时间换算、海外隔夜基期、跨市场日期、缓存身份与数值语义。它们属于本地合成/回归证据，不是生产实测。
- 初次新增探针 `21/23`：一个把正确抛出的 `WORKER_MODEL_EVIDENCE_INVALID` 错写成期待返回 unavailable，另一个夹具的 `fetchedAt > cachedAt` 被正确识别为缓存元数据无效。只修正 Temp 断言/夹具后 `23/23`；保留初轮 `normalizer-results-initial.json`，不把此探针错误宣称为产品修复。
- 初始在线 Worker 契约 `0/5`（RED）与稍后原样离线回放 `5/5` 分开保存，未覆盖。
- 页面真实 DOM/视觉、实际用户缓存、部署版本一致性、盘中/模型生产成功样本：`NOT_RUN` / `NOT_CONFIRMED`；不能以本地 presentation 对象代替浏览器。

## 可复核证据

所有新增脚本和机器回执位于 `Temp/v16-live-data-20261028-child/`：

- `live-data-probe.mjs`、`worker-1.raw.json` 至 `worker-5.raw.json`、`worker-results.json`：原始公共响应、HTTP/标头、时间、耗时、SHA-256、原时刻契约结果。
- `official-<code>.raw.json`、`official-results.json`：独立正式净值 JSON 文本与请求元数据。
- `reconcile-probe.mjs`、`reconciliation-results.json`：原样离线回放、四只逐字段对照与缓存展示投影。
- `clock-observation.mjs`、`clock-observations.json`、`clock-1.raw.json` 至 `clock-4.raw.json`：三次当前 Worker（含两个 force 样式查询）和一次独立净值 API 只读观察；只记录 HTTP Date/Age 标头、本机 UTC/单调耗时、原始公开响应，未校正系统时间。
- `normalizer-probe.mjs`、`normalizer-results-initial.json`、`normalizer-results.json`：新增合成断言的初轮与最终结果。
- `bounded-tests.mjs`、`bounded-tests.stdout.txt`、`bounded-tests.stderr.txt`、`bounded-tests-receipt.json`：现有定向测试原生回执和源码/测试 SHA-256。
- `evidence-manifest.json`：2026-10-28T07:34:48.229Z 冻结的 28 个审计产物 SHA-256 清单，不包含本清单自身；生产源码另绑定于上述测试 receipt 的 manifest。

可重复运行无网络的 `reconcile-probe.mjs`、`normalizer-probe.mjs` 和 `bounded-tests.mjs`；重跑会更新其生成回执，复核前应先保留本次文件。`live-data-probe.mjs` 会再次发起公开只读 GET，应当作为新采样另存，而非替换本次历史证据。

最终信任边界：正式净值内容与日期/降级表达有条件可信；当前端到端数据可靠性门禁仍未通过，等待 P1-01 处置及未观测生产路径/页面验收。
