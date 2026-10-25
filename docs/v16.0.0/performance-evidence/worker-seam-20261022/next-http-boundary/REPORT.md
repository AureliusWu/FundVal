# 单一完整 HTTP 估值纵切面：字段、存在性、错误与退休规格

2026-10-22；源目录 `D:/AI项目/FundVal`。这是一个有限的**只读实现规格**，不是候选实现或新的测试结果。未改 root、候选、旧证据；未执行测试/build/install/browser/网络/Storage。报告与机器字段账本仅写入这个新系统 Temp 目录。

字段完整清单：[FIELD_LEDGER.json](FIELD_LEDGER.json)。命名 writer 字段逐项枚举；任意扩展字段以明确 wildcard 规则覆盖，不能用一张固定字段白名单假装任意公共输入只有这些字段。

使用 data-reliability-audit 的来源、日期、缺失值、降级与追溯规则组织规格；本轮明确禁止实时取样/对账，因此没有新的线上可信度结论。

## 1. 结论与完整切口

下一条有意义的路线不是“再加一个DTO”：它是一个完整私有获取/缓存/投影管线，必须一起覆盖：

    HTTP envelope + wire行校验
      -> 第二次行校验/真类safe rescue -> source Quote构建
      -> resource兼容行的严格读写/使用时校验
      -> primary/official/本地模型及旧aggregate导入
      -> selected Quote -> 当前持仓金额/主次说明/accuracy
      -> resource旧rows + aggregate旧data[]两种兼容输出

必须保留原 public source/API，且 build-site 仍把原 js 源复制到 site。**没有要求每个公共入口必须留在默认bundle**；可以通过窄静态private facade把公共legacy输出构造排除出默认图。反过来，若新入口仍调用旧generic constructor/legacy adapter，不能说已经退休那段默认活实现。

本规格识别了完整退休条件及不可删除算法，但**没有证明任何净gzip量，更不承诺6960B**。原始字段数、源代码raw、整chunk容量或历史standalone gzip都不能相加换算收益。本次也不重新判定M3退出。

## 2. 当前实际所有权，不允许颠倒

| 边界 | 当前所有权 | 拟私有管线必须保留 |
| --- | --- | --- |
| Worker wire | schema/accounting/alias/date/status/model证据完整校验，抛稳定契约错误 | 相同规则/读序/错误阶段；不是信任远端已是canonical |
| Public normalize | 再次校验wire形态；生成legacy展示行与不可变source_quote | 第二时钟、真类ROW_INVALID-only safe rescue、公开任意对象行为 |
| Resource ingress | acquisition允许字段剪裁；持久化strict模式要求白名单；类型/alias/provenance不同于wire | 先检查冲突再剪裁，不能让Quote静默掩盖坏alias |
| source_quote | immutable原primary来源证据，包括当时的基期/来源/诊断 | 不随选中官方/模型而替换，不等于最新winning quote |
| latest_nav_move | 另一个正式净值对与元数据/来源缓存证据 | 保留给基准选择、次要说明、accuracy结算与详情 |
| quote | 候选质量排序后的选中Quote | 主显示、period/P&L/通知、accuracy预测均用它的绑定区间 |
| 当前持仓 | 当前repository的shares/cost | 缓存或请求快照不能拥有当前份额/成本 |
| Aggregate rows | 除三字段外保留未知enumerable string字段，并以可信投影覆盖同名值 | 不是resource白名单；foreign quote须先整行隔离 |

参考：[worker-contract:64](D:/AI项目/FundVal/js/runtime/worker-contract.js:64)、[HTTP normalize:13](D:/AI项目/FundVal/js/eastmoney-estimate.js:13)、[resource:39](D:/AI项目/FundVal/js/runtime/refresh-resource-cache.js:39)、[App:656](D:/AI项目/FundVal/js/app.js:656)、[identity guard:1014](D:/AI项目/FundVal/js/app.js:1014)。

## 3. Envelope/HTTP获取的字段与错误阶段

### 3.1 获取语义

`fetchEstimateRows`（[eastmoney:67](D:/AI项目/FundVal/js/eastmoney-estimate.js:67)）先把输入codes map(String)、正则过滤、Set去重，按请求首次出现顺序建 `Map(code -> null)`。空输入在取消检查之前返回。HTTP使用no-store和包装signal；force为truthy才以真实Date.now写 `_`，不是options.now。HTTP错误、response.json错误、fetch错误进入原request-signal.normalizeError，finally始终cleanup。若外部abort已发生，其错误优先；否则timeout优先；否则返回原错误身份。不要顺手改变原忽略abort的fetch晚成功行为。

完整envelope先校验成功，才逐行调用public normalize；缺席行保持Map中的null，不伪造unavailable行或补0。envelope items顺序与请求Map顺序是两回事；Map.set既有code不重排。刷新计划另有每批<=50/规范codes规则，不得把private计划限制直接加到旧公开fetch API。

### 3.2 Envelope字段

输入集合：`items, schema_version, status, generated_at, service_version, capabilities, fetched_at, requested, returned, unavailable, unavailable_codes, unavailable_items, accounting, source, report_date`；holdings端还有`code`。`accounting`四项为`primary/model/official/unavailable`，按规范化kind计数，不是UI选中结果数。

返回固定own-key顺序：`wireVersion,status,source,fetchedAt,generatedAt,serviceVersion,capabilities,reportDate,items`。

- wireVersion：无own schema为v1，有则只接受数值2，不接受'2'/null/未知schema。
- status：v1的默认/holdings空语义与v2显式top status不同；partial/degraded要求行理由，v1有显式LEGACY_SUCCESS_ROW适配，不能套用v2。
- source/reportDate：尾部再以contractText截断/安全过滤；不是早期缓存好的字段。
- fetchedAt/generatedAt/serviceVersion：对应原payload尾读的truthy值或空串；validation读与最终输出读不是同一次。service_version通过trim判合法不代表返回值已trim。
- capabilities：v2尾部重新展开数组，v1为新空数组。
- items：完整校验后的规范行，返回顺序维持原items再unavailable_items。

### 3.3 必保错误/读阶段

按原[worker-contract:163](D:/AI项目/FundVal/js/runtime/worker-contract.js:163)：options destructuring → payload record/endpoint → 两次items读取、Array.isArray/length → schema → envelope clock → status → v2 metadata → fetched_at两次timestamp读取 → requested身份 → endpoint items/accounting → late-tail。

所以“metadata先于rows”**不等于先于items起始检查**。同文件header/items/tail seam的既有64/52有限资格只保护这一步，不授予后续canonical decoder资格。

estimates的endpoint阶段仍必须：unavailable数组/重复与请求身份 → 完整缺席记账 → partial理由/legacy-success额外row校验 → 全部row规范化 → top unavailable不能带可用kind → 可选accounting计数 → 尾字段。不能在metadata/core抽取时提前读取source/report，也不能把完整envelope的坏wire交给safe rescue逐行“修好”。

## 4. Wire行：所有命名输出、aliases与缺失值

`...row`只在所有检查之后展开，再按FIELD_LEDGER的23个命名overlay覆盖。未知嵌套值浅保留，own可枚举symbol也保留；非enumerable不展开。覆盖已有key不移动其原插入位置，因此没有一张对所有输入通用的固定ROW_KEYS；现有characterization的42-key是具体fixture期望，不是所有输入模板。

| 输出字段 | 来源/存在性与数值语义 |
| --- | --- |
| code | `text(code ?? bzdm,6)`，六位；不是public第一读code的同一语义 |
| name | `text(name ?? jjjc,160) || code` |
| source | 安全文本120，usable必须非空；输出source或unavailable |
| kind | canonical kind/est_kind别名/v1默认；不可用时为unavailable |
| status / source_status | 前者ok或unavailable；后者原合法上游质量字符串，不能混合 |
| base_nav / last_nav | canonical base_nav与last_nav/dwjz精确alias一致；不可用输出null |
| value_nav / est_nav | official的aliases为est_nav/gsz；非official另含estimate_nav；不可用null |
| value_change | official可用change，其他null；非official的change另存在estimate_change |
| estimate_nav / estimate_change | 仅非official且可用时有数值；official有意null |
| est_change | 可用change，包括合法0/-0，否则null |
| base_nav_date | own canonical优先；没有时canonical kind不退回legacy日期；不可用null |
| value_date | own value_date优先，否则canonical official nav_date或source日；不可用null |
| source_time / est_time | own source_time否则estimate_time/est_time/gxrq；校验语法/时区/未来；不可用null |
| nav_date | wire的official用targetDate，否则baseDate；**不是所有不可用行都强制null** |
| est_kind | 初始official/qdii/holdings/intraday别名；不因status变unavailable就抹掉初始kind分支 |
| coverage | coverage/model_coverage；percent grammar；missing null；模型有各自范围规则 |
| quote_count | quote_count/model_quote_count；非模型并非一律整数，holdings模型才要求5..10整数 |
| report_date | own report_date否则model_report_date；同时存在会查alias；safe text10或null；非模型不是统一日期强校验 |

数值规则由`chooseNumber`保留：接受指定十进制number/string（percent只用于change/coverage），拒绝boolean、非法数值、canonical非null坏值；own canonical null不会被nonnullalias填上，冲突即throw。official特定字段ignoreNullAliases使有意null alias不冲掉可信canonical。每组aliases细节在FIELD_LEDGER，不可统一为 `a ?? b` 或一种coercion。当前wire与resource的numeric domain/error behavior不同。

日期/证据必须同时保留：source_time_precision语法/精度一致性；三个时间alias一致（v1 holdings-model est_time可刻意降到date）；base/target/China日与source时钟；holdings disclosure/coverage/quoteCount；QDII显式target/model-version/sample-count/uncertainty的mae/error_p80/direction_accuracy。QDII future target能通过wire但会被后续Quote标stale/resource拒绝，这两个阶段不可合并为同一接受规则。

## 5. 第二次normalize与source Quote：不能只存最终净值

### 5.1 第二校验与真类safe rescue

[eastmoney:13-65](D:/AI项目/FundVal/js/eastmoney-estimate.js:13)先以 `String(row?.code || row?.bzdm || '')`取公开code，坏code直接null。随后调用wire normalizer，**只在这个try里**捕获真正 `instanceof WorkerContractError && code===WORKER_ROW_INVALID`。同名/code普通Error不捕获；schema/status/alias错误不捕获；presentation/diagnostics/类型的后续getter即使抛同类ROW_INVALID仍原对象传播。

safe rescue替换成一个较小wire对象，不再展开旧row：code/name/source/kind/status/source_status/base_nav/value_nav/est_nav/est_change/source_time/value_date/coverage/quote_count/diagnostics/message/fallback_reason。随后public overlays会加回指定展示字段。它**不是**正常wire完整字段都变null：例如rescue没有value_change/estimate_nav/estimate_change自有字段，后续不会无端补出来。无效raw envelope在此之前已经整体失败，不能被rescue。

Date subclass的有效序列是envelope第一次getTime → public wire第二次getTime（可因时钟回拨ROW_INVALID而rescue） → Quote第三次getTime。不要缓存第一次clock决定，也不要拿第一次valid结论授权第二阶段。原machine baseline与资格已保存此输出；本轮不重跑。

### 5.2 Public overlay逐字段

FIELD_LEDGER逐项记录全部23个overlay加source_quote：

- code保留公开入口第一读，不用后来的wire/spread code；name二次safeText160；type重新读raw type/FType，safeText80。
- last_nav/est_nav/est_change：`wire... ?? NaN`，不是0/null。coverage/quote_count同样missing→NaN。
- nav_date：`wire.base_nav_date || ''`，**official在public阶段也改成base日期**，不能复制wire official nav_date(target)。
- est_time/source_time：wire source_time或空串；source_time_precision按HH:MM regex重新写minute/date，v2原datetime并不原样保留。
- value_date/base_nav_date/report_date：各自wire值或空串，不替换成同一个date。
- est_label/est_note/message/fallback_reason：各自原truthy优先级、不同长度和固定缺省文案；est_note仍非source Quote一个reason可替代。
- est_kind：wire值或estimate；est_realtime需要raw===true、wire intraday及特定source_status；is_fallback也要求===true。
- diagnostics：重新读原row并enumerable spread clone，不是直接沿用wire引用；即使safe rescue wire.diagnostics是{}，仍会重新使用raw diagnostics。
- source_quote：从包含所有opaque扩展的normalized副本、但status替换为wire.source_status，再构造不可变Quote。只有原row status为ok且Quote unavailable时才把public status改error并补空message；原unavailable与rescue error是不同形态。

常规own-key位置沿原spread保留、补新key按overlay顺序；source_quote若输入早已有ownkey就覆盖但不挪位置。public行可变，Quote/reasonCodes冻结；未知嵌套metadata引用与diagnostics clone的引用差异也属已有公开契约。[characterization:99](D:/AI项目/FundVal/test/estimate-http-characterization-v16.test.js:99)、[545](D:/AI项目/FundVal/test/estimate-http-characterization-v16.test.js:545)、[564](D:/AI项目/FundVal/test/estimate-http-characterization-v16.test.js:564)。

### 5.3 不能提前resource白名单化：真实先消费、后剪裁

wire/public保留的opaque不全是“对金融无影响”。在resource ROW_FIELDS前，Quote构造会读取：

- fundCode/fundName先于code/name；外来fundCode可使source_quote身份与row.code不同并被resource拒绝。
- row.market、sourceTier、originalSource/originalSourceTier、cacheState/cachedAt/expiresAt，影响分类/来源/缓存拒绝。
- stale、est_model、est_holdings_model、est_model_stale影响kind/freshness，即使这些字段后来被resource剪掉。
- confidence/est_confidence、officialNavDate、fetched_at/fetchedAt、model_version/estimate_model_version/est_model_version影响Quote证据。

**精读纠正**：identity()不读row.assetKind；它取options.assetKind或classifyAssetKind。row.assetKind可作为opaque存活，但不能把它列成这条HTTP Quote路径的直接控制项。

因此新decoder不能先丢ROW_FIELDS外的所有输入再生成Quote，否则可能把原来应该因身份/缓存/stale/model冲突而失败的行救活。也不能把所有35个resource字段从最终Quote反推：raw fetched_at、多个model-version别名、report_date、quote_count、notes、precision及null aliases并非Quote26字段可逆映射。

### 5.4 Quote26字段

精确顺序与逐项来源在FIELD_LEDGER：fundCode/fundName/market/assetKind/valueKind/value/changePct/baseNav/baseNavDate/targetDate/sourceId/sourceTier/originalSource/originalSourceTier/cacheState/cachedAt/expiresAt/observedAt/fetchedAt/officialNavDate/status/ageMs/coverage/confidence/modelVersion/reasonCodes。

必须保留：own-first字段语义，显式null不被旧alias救活；confidence字符串/数值规范化；worker诊断有限枚举/unknown→unclassified；源新鲜度、周末carryover、市场时钟、cache metadata/provenance；值缺失与未来date/时钟等不同reason；Quote status unavailable只null化value/changePct/baseNav，日期字段并非全部擦除。fetchedAt优先顺序实际为row.fetched_at → row.fetchedAt → options.fetchedAt，即使调用者看似传了envelope.fetchedAt。[quote-normalizer:160](D:/AI项目/FundVal/js/runtime/quote-normalizer.js:160)、[quote-contract:127](D:/AI项目/FundVal/js/runtime/quote-contract.js:127)。

## 6. Resource旧rows：严格兼容codec，不是wire的第二份同类校验

### 6.1 精确输出

旧resource row按FIELD_LEDGER中35个ROW_FIELDS的固定顺序只选**own存在**字段，最后追加source_quote。缺字段不能无端变null/空串；own undefined在内存仍可存在，JSON后才丢；nonenumerable的合法own字段会被select变成enumerable输出；symbols不被select保留。strict模式用Object.keys拒额外可枚举string字段，不能顺手扩大成拒所有symbol/nonenumerable（原代码没这样做）。

不同于wire的严格type/别名规则：[resource:39-93](D:/AI项目/FundVal/js/runtime/refresh-resource-cache.js:39)。

- row.status必须ok、code在请求codes且等于source_quote.fundCode；source_quote status/kind/tier/market/assetKind枚举、非cache、正value、source capability、date/fetched/observed/model/status等都受检查。
- 数值aliases组value(est_nav/value_nav/estimate_nav)、base(last_nav/base_nav)、change(est_change/value_change/estimate_change)：nonnull必须number，NaN占位可接受，finite必须与Quote差<=1e-7；不接受wire那样的数字字符串。Infinity在这些alias上拒绝。
- null/undefined/NaN alias占位不能回填成Quote值；例如nonofficial value_change原本null，不能因Quote.changePct=1就写成1。
- date aliases value_date/base_nav_date/nav_date、source/kind/est_kind、est_realtime分别一致性检查；canonicalQuote不能掩盖冲突。
- clean的通用标量规则并不是“每个名字都有严格类型”：null/undefined、boolean、number允许（除前面特殊检查），其他值须safeString<=300；余下非finite number转null。不要借重构加强所有row name/type/metadata的旧接受域。
- row.coverage/quote_count/report_date/version/fetched_at等不全是Quote别名：例如非模型row.coverage可finite但超界，Quote.coverage为null；report_date可安全非日期；raw fetched_at可安全但非合法timestamp而Quote已选择fallback时钟。这些内存/持久化兼容值不能都由Quote反推。
- strict白名单之前调用normalizeExistingQuoteFreshness；canonical source_quote经createQuoteEnvelope重建。已validated品牌不能跳过使用时新鲜度/时间检查。

HTTP专有diagnostics/message/transport_status/adapterReasonCodes/estimate_time/confidence/sample_count/uncertainty/meta/大部分opaque在这里被剪掉，但Quote内保留归一化后的confidence/modelVersion/reasonCodes等。这纠正“所有HTTP opaque直接进入fresh App”的错误推断。

### 6.2 当前实际获取/缓存调用顺序

[refresh-execution:142](D:/AI项目/FundVal/js/runtime/refresh-execution.js:142)先从HTTP Map筛status ok、source_quote非stale/unavailable的行，取目标date，再makeRefreshResourceEntry。acquireEntry再次valid、标acquired、stageCache私有copy再valid，都是不同边界，不是多份源码算法。

resource entry的payload含source/codes/rows与可选common字段；默认acquisition输入只有codes/rows/source，select后为source,codes,rows。envelope固定schemaVersion1、payload、originalSource/tier、sourceTier cache、sourceDate、fetchedAt、cachedAt、ttlMs、expiresAt、cacheState。read不续时钟，按now重新给fresh/stale/expired；validate要求policy source/tier/TTL/sourceDate精确一致。

fresh获取的row直接给UI；旧entry回用时clone row、est_realtime=false、source_quote经normalizeCachedQuote标local-cache并附originalSource/tier、原fetchedAt/cachedAt/expiresAt。不能把旧row当新的primary实时行情。

[scope:12](D:/AI项目/FundVal/js/runtime/generation-resource-scope.js:12)的privateCopy使用JSON.stringify/parse后deep freeze：NaN/Infinity→null、-0→0、own undefined/functions/symbols按JSON规则丢弃，随后才校验。stage/cache-hit/use-time/final-serialize的边界、代际取消、只同步验证、一次flush与失败不重写都必须保留。[scope:110](D:/AI项目/FundVal/js/runtime/generation-resource-scope.js:110)、[flush:121](D:/AI项目/FundVal/js/runtime/generation-resource-scope.js:121)。

## 7. App投影、旧aggregate导入与双身份

[App:656-714](D:/AI项目/FundVal/js/app.js:656)的实际顺序：spread原row → fetchedName与当前holding name/shares/cost → apply海外模型 → 必要legacy est_nav补值 → updatedAt → market/asset分类 → candidates → selected quote → primary/display/金额/freshness。

主展示字段全部列于FIELD_LEDGER。它们可能不是当前DOM的直接reader，但仍属于黑名单式aggregate输出与未知同名值覆盖契约：primary_change/primary_nav/display不能仅因“搜索没reader”而删；否则opaque同名值不再被可信Quote覆盖。fresh build的display有label，旧cache hydrate重建display没有label，不能强行统一形状。

`holdingQuoteAmounts` ([line7](D:/AI项目/FundVal/js/runtime/holding-quote-amounts.js:7))永远用当前holding `shares ??0` / `cost ??null`，输出shares/cost/period/today_profit/curr_value/total_profit/total_profit_rate。resolveQuoteBaseNav只认selected Quote自己正baseNav与baseDate<targetDate，不借legacy last_nav或别的模型baseline。[calculator:28](D:/AI项目/FundVal/js/calculator.js:28)。period完整10字段与freshness11字段在机器账本；stale绑定完整Quote可保留旧区间收益但不冒充今日，不是一律把所有旧金额清零。

`tryShowCache` ([App:1009](D:/AI项目/FundVal/js/app.js:1009))先loadCache检查非空data、六位/无重复code与holdingsHash；再逐行：

1. 现有quote或source_quote任一存在但fundCode严格不等row.code，整行金融snapshot丢弃，仅保code/name；missing/null/numeric/padded identity也不重绑救数值。
2. matching selected quote优先；无selected才用真实legacy candidate adapters（含source_quote或raw legacy without either）。
3. selected source再normalizeCachedQuote，fresh还要求当前online；原acquisition clocks保留；current holding重投影。
4. spread旧row后再覆盖可信主值/display/金额；坏身份先已整行隔离，不能保留旧notes/model/secondary；hydrate只读不写任何Storage/repository。

selected quote与source_quote不能合并：原source_quote供model的正式baseline provenance，selected quote供主展示/金额/accuracy，latest_nav_move是另一组证据。缓存命中也不是把原source_quote的所有角色都改成selected cache Quote。候选顺序source → latest official → holdings → overseas，精确去重key与quality排序须留。`preferredDailyMove`在当前App只见definition、没有活调用；不可把其文本大小当新的可回收默认活池。

## 8. 次要official/model/accuracy证据与顺序碰撞

### 8.1 官方证据

官方move全部字段与meta六字段见FIELD_LEDGER；来自[App:617](D:/AI项目/FundVal/js/app.js:617)，并在executor navMove附live/cache来源/原时钟。详情还使用scale/manager/managerWorkTime/managerId/sourceRate/currentRate，不是只保一个NAV和change。

[latestOfficialNavBase:137](D:/AI项目/FundVal/js/holdings-estimate.js:137)在usable latest_nav_move.nav/date与source_quote的official value/date或非official baseNav/baseNavDate中择较新日期。**只要存在任一provenance对象，就禁止legacy est_nav/last_nav救活baseline，即使该provenance stale/无效**。它不读最终selected quote，也不自行校验fundCode，因此上游身份隔离不可删。

### 8.2 重仓/海外模型

重仓原始输入ratio/change/quoteTime仅采当日非未来有效报价，coverage求有效ratio总和，贡献是Σratio*change/100，不除coverage归一化；披露集合、覆盖/数量、same-session双算/缺交易日阻断与未知误差说明必须留。[holdings-estimate:76](D:/AI项目/FundVal/js/holdings-estimate.js:76)、[156](D:/AI项目/FundVal/js/holdings-estimate.js:156)。完整result8字段、安装17字段在FIELD_LEDGER。

compose每次从immutable primary snapshot重建，先装officialMove再安装holdings，不能对上次已模型化行增量叠加。[compose:192](D:/AI项目/FundVal/js/holdings-estimate.js:192)。海外随后在buildFundData安装，使用模型配置、quotes.changePct与sourceTime||time、正式baseline及独立period规则；其加权/usableWeight后scale/bias、时区、未来/过旧、季度/valid_until等算法不是重仓算法的别名。[fund-model:12](D:/AI项目/FundVal/js/runtime/fund-model-enrichment.js:12)、[overseas:159](D:/AI项目/FundVal/js/overseas-model.js:159)。完整安装19字段在FIELD_LEDGER。

**必须新增表征的静态兼容阻断**：重仓安装之后，buildFundData还能运行海外模型；两个model flag可能同时true，共享est_nav/change/time/note被后者覆盖，而候选器仍按两flag构建两种candidate，各用自己的est_holdings_*/est_model_*基期。一个“干净独立模型slot”如果保留各模型原算值、假定互斥，就可能改变现有有效候选/secondary说明。新结构必须先复现现有顺序的effective候选输入，不能悄悄修正；本轮未运行新case，也不据静态现象宣布线上P1。

### 8.3 主次说明与accuracy

展开UI在selected official时仍可显示下一净值模型，在selected model时仍显示最近正式NAV。仍读nav_date/primary_base_nav/est_note/primary_note/today_is_latest_nav/est_model/est_change/est_nav/latest_nav_move.change/date/prevDate。[App:1401](D:/AI项目/FundVal/js/app.js:1401)、[1431](D:/AI项目/FundVal/js/app.js:1431)。不能只保winner后丢secondary。

[accuracy:57](D:/AI项目/FundVal/js/accuracy.js:57)先用latest_nav_move结算，再仅当selected quote为model_estimate/model、est_model真且非stale、绑定base/target、finite changePct及北京时间>=14:30记录。预测取quote.changePct，不是raw est_change；model_version/label/confidence仍来自model副字段，truthy默认'unknown'也须保留（例如0 confidence的旧行为）。预测9字段、结算4字段、stats6字段在FIELD_LEDGER；去重code+prediction_date+model_version、每code100条、旧target=next需baseDate匹配prevDate、未知accuracy row字段spread保留，算法都留。

## 9. 持久化：两条writer不仅时钟不同

| 项目 | 刷新writer | 编辑/外部repository安装writer |
| --- | --- | --- |
| 入口 | serializeRefreshAggregate，executor一次flush | App.saveCache，经reconcile |
| 顶层unknown | 重建data/refreshResources，仅copy五个旧own keys；其他顶层unknown丢弃 | spread previous，保留全部顶层unknown和原key位置 |
| 每行unknown | 仅排_cached/message/quoteCandidates，其余Object.entries→JSON | 同三键黑名单，其他同样保留 |
| 资源 | active有效旧资源保留；new stage严格验证/更新 | 保留previous.refreshResources，不新采集 |
| 时钟 | 只有新nav/holdings/estimates acquisition才推进fetchedAt/expiresAt/source；time仅old own存在时推进 | 不续任何采集时钟/来源；只改data与holdingsHash |
| 条件/失败 | invalid clock/重复active row抛TypeError；scope捕获、最多一次写尝试，不重试 | previous须有data数组；JSON/read/write异常被原catch吞掉；空active按现有reconcile可删除cache |

[refresh serializer:233](D:/AI项目/FundVal/js/runtime/refresh-resource-cache.js:233)、[edit writer:596](D:/AI项目/FundVal/js/app.js:596)、[reconcile:251](D:/AI项目/FundVal/js/app.js:251)。

refresh新资源须fresh，且相对former的fetchedAt/cachedAt均严格推进，不能只改cachedAt复活旧acquisition；没有former也要过旧aggregate fetchedAt约束。indices/gold/meta可写资源但不续基金投影TTL。返回顶层先data/refreshResources，再按fetchedAt/expiresAt/source/time/holdingsHash顺序copy存在的keys；覆盖原key不移动位置。

行unknown并不授权未知金融同名值获胜：应先当前可信投影覆盖，再按旧Object.entries顺序输出；foreign identity则先整行清掉。symbols被Object.entries丢，undefined/functions在JSON时省略，NaN/Infinity→null，-0→0；public arbitrary objects的getter/toJSON/循环错误仍走原公开source契约，不能直接替换成一个不同JSON encoder。不要将resource ROW_FIELDS白名单误套aggregate。

## 10. 一个私有结构与明确替换接口

这是一份行为规格而非写好的实现。建议的单一私有状态至少分为：

- `AcquisitionEvidence`：row identity/availability、immutable source Quote、上游/transport状态、生成Quote所需有序输入证据、resource35字段的own-presence/value状态。未过第二校验之前，不得丢会被重读/影响Quote的输入。
- `FundEvidence`：source evidence、officialMove+meta+provenance、两个模型安装后的**旧顺序effective状态**、legacy aggregate扩展、selected Quote；份额/成本/period是当前投影，不是源获取事实。
- `CompatibilityRows`：resource35+source_quote与aggregate黑名单输出是两个不同codec。presence与有序extension entries必须可区分absent/undefined/null；何时能丢这种区分由原JSON边界决定，不由DTO偏好决定。

完整私有接口需要闭合：

1. **专用HTTP acquisition**：保原transport/Map/accounting/error流程；按原clock/阶段产生evidence。公共fetch/normalize留原API/source，默认路径可另用private入口。
2. **source/wire core + compatibility finish**：严格验证逻辑共享而非复制；旧wire finisher仍在所有原read之后展开/覆盖，公开调用的任意对象读轨迹保留。私有路径只有在能证明第二校验所需完整中间语义已保留时才不构造legacy wire/presentation行。
3. **resource ingress/evidence reader + legacy row encoder**：持久化旧rows先执行同样冲突/type/provenance/freshness校验再转evidence；实际消费/staging/final serialize仍校验；encoder只在需要旧rows输出时装配35字段，不能以Quote推测原缺字段。
4. **legacy aggregate importer + model composer + view projector**：raw legacy和identity隔离都进同一受控导入边界；模型保旧顺序/异步收敛；UI/accuracy改读typed状态但产生原可见/持久化结果。
5. **共享row egress，两个outer writer policy**：可共用三键黑名单/ordered row编码，不合并topunknown/clock/active-resource/error策略。
6. **窄静态private facade**：App/executor只拿所需private函数；不逃逸旧business namespace、不反向barrel导入旧generic；不新建第六加载组、不把business提前到integrity前、不改ES2022/预算。

只迁移1或仅加facade并不完成闭合；完整转接后必须检查实际产物可达图，不能用源码“没再调用某名字”作删包证明。

## 11. 逐段退休表：构造可退，算法/codec仍在

| 旧默认活构造 | 何时能退出默认图 | 必留的实际工作，不能当收益 |
| --- | --- | --- |
| worker normalize行return中的全legacy alias materialization | private estimates items不再调用公开legacy finisher，holdings专用入口不反向拉generic estimates；public原source仍可用 | wire全部规则、别名冲突、模型证据、accounting；第二校验完整中间语义；公共legacy finisher留在公开路径 |
| public normalizeEstimateRow全row spread/展示alias/source_quote往返 | privateHTTP→evidence→resource完整连通且公共任意对象API独立保留 | safeRescue真类/时钟/error、sanitize、Quote创建、所有先用后剪的raw字段影响、兼容resource encoder |
| resource old row作为私有acquire/stage/UI传输 | 内存全用evidence，旧rows只在持久化I/O codec | strict旧row validator、alias tolerance/placeholder/type、own-presence、source capability、staging副本与使用时校验 |
| generic normalizeEstimateQuote/model wrappers/buildFundQuoteCandidates的混合行输入装配 | private producers/candidates/legacy importer都已迁移，默认没有旧函数backedge | source freshness/Quote创建、raw legacy接受域、官方转换、两模型时期/证据、去重与quality排序；算法不因为改文件就消失 |
| officialFundFallback legacy shell/buildFundData大行中转 | primary/evidence、models、UI、cache/accuracy均接新状态 | fallback/naming、selected identity、主次说明、当前holding投影、可信覆盖opaque同名字段、旧输出codec |
| 模型mutate legacy row再解析回Quote | model composer直接形成同等effective候选/secondary状态 | 最新正式baseline/provenance拒rescue、各自权重/时区/session/披露算法、双flag碰撞、completion-order invariance |
| 两处row blacklist/重复展示alias持久化装配 | 一个row egress可复用且outer clock政策各自保留 | aggregate unknown/ordered JSON、两个topunknown差异、active/duplicate/TTL/error/write次数规则 |

没有一项允许直接删除旧公开source/API。没有一行是净gzip量；新codec、presence状态和兼容导入/算法成本必须计入未来实测净值。若raw legacy importer只是继续调用旧generic adapters，相关constructors仍然活；移lazy不改变all总预算。

## 12. 有限接受矩阵与未闭合项

下列是下一次完整纵切面所需的固定接受规格，不是本轮新测试。现有测试仅作为独立旧语义来源；新实现必须与冻结完整旧公开实现差分，不用两个新wrapper共用新core互证。

| ID | 必须比较的行为 | 现有独立锚/新增缺口 |
| --- | --- | --- |
| A01 | v1/v2完整字段、own keys/order、JSON bytes、冻结/引用、null/NaN/zero | estimate-http-characterization:99,175,198,217 |
| A02 | 真类第二钟ROW_INVALID rescue、三钟、伪装类不rescue、presentation同类sentinel不rescue | 同:243,545,564,597；旧64机器基线 |
| A03 | 初始items先于schema、metadata先于row但非items、late-tail/getters/descriptor/symbol错误阶段 | 旧64/固定52原件；不得误当完整后续decoder资格 |
| A04 | partial/accounting、请求Map顺序、遗漏null、force真实时钟、空输入优先 | 同:373,390,444；worker-contract-v16 |
| A05 | HTTP/JSON/fetch错误身份、外部abort/timeout顺序、cleanup/晚成功 | 同:456,475,504,527；本轮NOT_RUN |
| A06 | QDII future target与source time分离，wire通过但Quote stale；模型/unknown nested证据 | 同:279,302,338 |
| A07 | raw fetched_at压过envelope fetchedAt；safe texts/diagnostics与opaque保持不同处理 | 同:358,404 |
| A08 | 不提前白名单化fundCode/fundName/market/sourceTier/stale/model flags/officialNavDate/cache metadata | **新增完整过resource链表征**，包括原应拒绝而早剪后会救活的反例 |
| R01 | 35字段own presence：absent/own undefined/null、官方null aliases、版本/raw fetched_at不由Quote反推；内存与JSON后差异 | resource-cache:159,207；**新增presence/key-order矩阵** |
| R02 | wire数字string vsresource number-only，NaN占位、1e-7边界、Infinity、conflicting dates/kinds/source | resource-cache:182,191,207 |
| R03 | strict Object.keys额外字段、symbol/nonenumerable规则，不加强旧接受域 | **新增公开resource arbitrary-object与实际JSON输入分开表征** |
| R04 | active/request set/partial行顺序、原source tier/TTL/日期/clock、非fresh旧resource不能重新采集化 | resource-cache:30,128,143,159 |
| R05 | JSON私有copy/deep freeze、消费者过期、同代去重、同步validator、取消、一次write失败不重试 | generation-resource-scope:19,36,58,69,88,137,144,155,168,183 |
| H01 | quote或source_quote任一foreign/missing/null/numeric/padded identity整行隔离；matching selected不能掩盖bad source | cache-fund-identity:188,202,218,223,228 |
| H02 | raw legacy无两种Quote仍接受，不写Storage；当前shares/cost覆盖缓存，zero/missing cost保留 | 同:170,181,192,242,250；holding-quote-amounts:10,24 |
| M01 | immutable primary+official/holdings不同完成顺序收敛；新primary official阻止旧detail双算 | holdings-estimate:89；quote-period:79,96 |
| M02 | stale provenance即使legacy aliases可用也拒baseline rescue；不拿selected替换source_quote | data-semantics:126；v16-integration-edge:38,58,253 |
| M03 | holdings覆盖/数量/披露/当日/未知贡献与海外权重/时区/session/valid_until各自保持 | holdings-estimate:22,39,52,157；quote-period:106,128,137,147；overseas-model tests |
| M04 | 两model flags同时true、后写共享est值但基期分别保留的旧effective候选/说明/排序 | **新增冻结旧完整模型安装序列表征；不能顺手互斥/修正** |
| P01 | 主显示跟selected，secondary官方/模型说明不丢；官方单点无伪P/L；stale可旧区间但非今日 | test/quote-period.test.js:16,33,69；js/runtime/valuation-period.js:11,41,61；未来App展开DOM对照 |
| P02 | render时钟过期、当前持仓变化重投影、没有提前冻结period | v16-integration-edge:142,155；holding-quote-amounts:10,24 |
| S01 | 编辑保topunknown/全部acquisition clock；刷新丢topunknown并仅继承五旧own键；两边row unknown/同名可信override/key-order | **新增两个真实outer writer差分**，不得只测共用row函数 |
| S02 | market/meta-only不续基金TTL，新nav/holdings/estimates续；只改cachedAt不能救旧采集 | resource-cache:218,235,253,264,278,299 |
| S03 | 保存失败/重复active rows/坏clock/JSON错误仍按原层级return/throw，且不第二次写 | resource-cache+scope上述错误例；edit writer新增失败表征 |
| C01 | accuracy用selected model.changePct而非raw est_change，14:30/period/stale/settle/baseDate/unknown ledger | accuracy:22,40,50；**model双flag后的accuracy补例** |
| G01 | 实际默认图旧constructors真正不可达，公开API/source仍可用；原五组/ES2022/启动隔离、所有chunks/native绑定 | 未来完整候选构建/现有graph工具；本轮NOT_RUN |

主要未闭合项是A08/R01/R03/M04/S01的完整差分与私有IR可逆性：当前最终Quote不是35字段resource行、旧aggregate、两个模型副状态的可逆摘要。还须证明第二次validation所读的中间wire形态、Presence/读序不变；仅把第一次validation结果封成brand不足。

## 13. 有限迁移顺序与停止条件

1. 以已单独准备/资格验证的endpoint seam作为前置，不重新声称其能减7KB；冻结本账本的单一纵切面输入输出/错误图。
2. 先实现共享wire/source core与public compatibility finisher的受控边界；独立旧原件差分公共输出及private完整中间语义。不能因还没有体积结果就提前采用到root。
3. 迁移resource读写codec与内存evidence，把严格旧rows输入、own-presence/JSON边界和来源时钟保持完整。
4. 迁移legacy aggregate importer、模型effective composer、UI/accuracy及两类outer writer；每步在行为保护下移动，不是一次性重写，且中间状态不被当作最终删包成功。
5. 完整闭合后一次检查默认可达图/原API，再对同一完整候选按原配方原预算测真实净gzip和后续QA/性能/CI；不能相加单阶段小收益或另扫helper/压缩参数。

若新codec只是把旧constructors从一层挪到另一层、需要保留全部旧默认实现，或任何接受项不成立，该完整设计不得声称闭合；保留真实失败与现M3状态。全程序其他重构的可能性并未因此被否定。本报告不要求owner另做许可选择，也不扩展当前任务：只交付这一份有限规格后停止。

## 14. 读取范围、当前hash与信任结论

读了当前worker/HTTP/resource/executor/scope/cache/quote/App/model/accuracy源及上表现有测试源；测试没有执行。当前选定源SHA256：

| 文件 | SHA256 |
| --- | --- |
| js/runtime/worker-contract.js | 54bab1e12f3127b8d28b98185175864ea4dc420b2c862954ab542b3293aa2b44 |
| js/eastmoney-estimate.js | 5ed4a84b2d513c7289afd5facfe961f86ccc9d01653e72915a96c5bb5c5bd1d6 |
| js/runtime/refresh-resource-cache.js | 7f0103a803f83b31df0631cb3a7c53949e7f80259c909becf4eccc6ce0fb6231 |
| js/runtime/refresh-execution.js | 462a76335cb145af061d2f9783f1bfaf0e93a9053ed757bbde2b45a792d76afe |
| js/runtime/quote-normalizer.js | 9454458c08316229f3dfab94c50ae2a3792611a80ec0193cb790a1cde665d76b |
| js/app.js | 9b5394ef5045458a93753b043a6a485272e29a8c477270a54e07f90dc6b6083e |
| js/holdings-estimate.js | 72dadaf00f44e8e388044b7bfada6af4eb2b6f1de75056b16803ee32c7a9dcf2 |
| js/runtime/fund-model-enrichment.js | 94424e9c72658bd84175f4e8743a1b13416a0e7e4207d169bc1a432dc2cc51c4 |
| js/accuracy.js | eed3f70300a5cd43c387052512bcfc5bf99b574c94f56e74cafba2a59c998581 |

没有新P0/P1运行缺陷宣告；上述发现为兼容闭合风险/接受阻断。数据可信度仅可称 **CONDITIONALLY TRUSTED（对已保留旧规则的设计解释）**：实时源、独立NAV对账、完整HTTP运行、设备/生产未验证。此限定不升级为应用整体新可信验收；规格本身也不是完整candidate资格或6960B材料性证据。
