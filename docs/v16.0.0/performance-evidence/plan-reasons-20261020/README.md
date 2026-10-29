# M3 计划原因观察链：固定十键、原决策单次计数

日期：2026-10-20（Asia/Shanghai）。保留版本 15.0.2，分支 `codex/v16.0.0-m3-continuation`，HEAD `170fd3eadc6da02750882f8a542904ee2358d0d9`。本轮为未提交工作树证据，不是精确提交 CI、v16 发布或 M3 退出。

## 结果与边界

完成原 M3 诊断中的细分计划原因；不重复运行 planner、不再读缓存/时钟、不改变金融结果或原刷新调度。限定结论为 `CONDITIONALLY TRUSTED`：合成样本下的固定计数观察契约。不是第三方金融数据、准确执行 gate 历史、物理设备或生产可信性结论。

- 全量最终：1159 项，1156 PASS、0 FAIL、3 既有 Windows 条件 skip，8044.4173 ms。
- 最终语法检查：211 份 JS。
- 原生 Chrome E2E：32/32 PASS，1.1m；真实构建 App、opaque Bridge、合成网络，并非真实金融源或真机。
- 官方 npm registry 审计：0 vulnerabilities。
- E2E 后固定 epoch `1792046773` 三次原配方构建：全部 127 文件逐字一致；229 份选定输入构建前后相同。
- cold **44,514 / 52,241 B PASS**；all **83,647 / 77,227.7 B FAIL**，至少还需减少 **6,420 整数 B**。
- 本轮未改压缩器/构建配方/五分组/ES2022/依赖/预算/版本；未推送、合并、部署，未进入 M4/M5/M6。

## 实现索引

1. `js/runtime/refresh-plan.js` 的私有 `createRuntimeRefreshPlan(input, observePlanReasons)` 增加可选第二参数。第一参数原七项读取顺序不变；公共 planner、security planner 与 cache core 未改。固定累计器只在 observer 为函数时分配，原分支/同一次 core 返回值计数，成功冻结 plan 后回调一次。默认私有 plan 仍只有 generation/activeCodes/resources，资源仍没有 reason 字段。异常、拒绝 Promise、抛错 then getter 均隔离。
2. `js/runtime/refresh-execution.js` 传闭合局部 collector，只赋值 `diagnosticPlanReasons`。原 started/resources_settled/final 时点增加固定 `planReasons`；不直接从 planner 调外部 observer，scope/provider 稀疏计数 API 不变。
3. `js/runtime/refresh-generation.js` 对新 DTO 作固定十键、自有 data descriptor、非负安全整数复制与冻结。未知字段不保留，缺失/无效为 null，真实 0 保留；只有收到有效 DTO 才增加 record.planReasons，旧报告/空记录形状不变。三个槽位、阶段高水位、晚取消和同步 onError 重入机制不变，不新增持久化。
4. `js/runtime/diagnostics-ui.js` 增加“计划原因”行。十标签、顺序固定，不省略 0；缺失为“未观测”。明确“仅表示计划时决策；实际执行 gate 细因未记录”，既有数据源健康是当前快照，不能反推本代历史。
5. `test/runtime-plan-characterization-v16.test.js` 仅允许精确文件/函数/局部初始化/条件/箭头赋值形状的第二参数；不允许逐资源 reason 读取、对象逃逸或原 namespace/reexport/alias/spread 负控。独立审查发现解构绑定 `.id.name` 漏控，另加三处 Identifier 检查和六项对象/数组解构负控；只修测试护栏，当前生产代码没有该逃逸写法。

## 十原因口径

| 字段 | 判定来源 |
| --- | --- |
| fresh_cache | 原 core fresh，保留 Math.min 的原到期时间 |
| cache_miss | planner 实际输入中该 key 缺失 |
| cache_metadata_invalid | 原元数据结构/时间/validated 校验失败 |
| cache_quality_unusable | 原 sourceTier/status/cacheState 质量校验失败 |
| cache_expired | 质量仍 fresh，但显式 now/标准 TTL 已到期 |
| force_live | 非稳定资源显式 forceLive |
| force_stable | diagnostic 触发且明确稳定 key |
| market_ineligible | 市场不适用，优先于强制刷新 |
| phase_pending | 活动持仓的两个 phase-B 占位资源 |
| no_active_holdings | 无活动持仓的两个 phase-B skip |

每资源恰计一种原因，十数之和等于计划资源数量，不等于实际请求数或 cacheHits。无 key/code/name/金额/URL/Token/原文/Quote，固定大小、不保留输入引用。`readRefreshResources` 已丢弃的坏条目，在 planner 里是 miss；不能补称 invalid。cacheState stale 先命中质量校验，不能统一说 expired。排队后到期仍保留原 fresh_cache 计划事实，真实 loader/dispatch 另计。phase_pending 不是已派发或成功。

`claimSourceAttempt().allowed === false` 也可能是 unavailable 或半开探针已占用，并非都叫 cooldown。本轮没有新增执行 gate DTO，不伪造 source_cooldown。最终 Quote 来源仍看逐基金详情的数据说明，本摘要不复制报价/收益。

## RED / GREEN 与限定覆盖

- `main/dto-red.json`：36 项中31 PASS /5 FAIL，分别为3项 Store、一项 UI、一项 executor 新契约缺失；不是五个旧报价错误。实现后 Store/UI 28/28，随后六文件100/100（后来的补充覆盖尚未包含在这个早期窗口）。
- `planner/red-v2.*`：22 项13 PASS /9 FAIL；八项缺回调，一项 AST 正例尚未允许新闭合参数。其余包括非函数 observer 的用例已过；不能说九项均为原业务故障。实施后22/22，扩公共套件48/48，再加真实消费两例50/50。
- `planner/binding-red.*`：19项13 PASS /6 FAIL；解构逃逸负控实际被误接受。补绑定类型断言后19/19。
- `e2e-red/`：旧 site 单项1 FAIL，缺“计划原因”行；最终完整32/32包含该项 GREEN。冷十项依次 `[0,3,0,0,0,3,0,0,2,0]`，暖 `[3,0,0,0,0,3,0,0,2,0]`。手动刷新仍 force_live=3，不把暖组合全部叫 cache。
- 新 `test/refresh-plan-reasons-v16.test.js` 11项覆盖十原因、51基金拆批、删除/空/QDII、TTL/质量优先级、changing getter trace/sentinel、禁止 Date.now、冻结/脱敏及 observer 错误隔离。最后两例为 GREEN-only 补覆盖，不冒称原 RED：真实 scope 消费跨过 exact expiry 后 dispatch1/cacheHits0 而原 fresh_cache 不改；真实 coordinator claim 分别拒绝 cooldown/unavailable/occupied half-open，requests0、health不变、无伪造原因。
- Store 新三例覆盖固定白名单/复制/冻结、null/0/恶意 getter/proxy/继承/撤销 proxy、取消迟到/回退阶段/最多三槽。UI例同时验证剪贴板与无 Storage 写入。
- `test/refresh-observation-v16.test.js` 的开关等价仅为空组合市场栏；另在 `test/refresh-execution-v16.test.js` 补境内和QDII各一例真实活动基金成功 cold/warm：provider 次数、UI primary/enriched、claims、health、诊断、结果与缓存序列化逐字相等。它们是合成有限样本，不证明所有基金/金融输入的全域等价，也不是原故障 RED。
- E2E 诊断读取仍不新增六类网络请求/缓存写入、不续 TTL、不加载 OCR/Gist，十标签可见、0不缺省、摘要不含合成持仓身份/金额/Quote 原文。
- 本轮第一份全量 `main/unit-final.json` 为1151/1148/3skip；AST六负控与活动基金两例补齐后再跑 `main/unit-complete.json` 得1159/1156/3skip。最终 check 亦重跑，不能把早期窗口称作最终覆盖。

## 产物与性能范围

| 指标 | 前轮已核验诊断产物 | 本轮实际产物 | 变化 |
| --- | ---: | ---: | ---: |
| all gzip | 83084 | 83647 | +563 |
| cold gzip | 44386 | 44514 | +128 |
| 16 chunks raw | 242222 | 243660 | +1438 |
| whole site bytes | 92528422 | 92532345 | +3923 |

前轮是历史实核窗口，不是新配对时延 baseline。本轮增加功能成本，不是减包。没有重跑800/1000配对或挑选 PASS；第37节旧4bda产物的时延资格不能授予本轮。

- 三轮 whole 127 files /92532345 B，排序 JSON 库存 SHA `86d3e5fee78f74824a2a76e5a2e6c37b3ea99f1fe31bcf3333e527d9e11854a8`。
- critical 指纹 `581f8068961daccbe5afbb60368c87412075e00692e2969ec1176eba333c85e2`。
- 229 选定输入库存 SHA `9db247a2fae5a594214b836bbe9e25f412ceb43c848a0e0ce1e76072463adaa7`，前后同；不含文档、node_modules、未跟踪 evidence。
- 实际图16 chunks/18静态边/10字面动态边/6cold与 native binding PASS；不 evaluate，不证明 TDZ/运行时动态 namespace/完整启动次序。
- OCR 23 assets /88196906 B 字节核验，不运行引擎；未测物理Android/iOS/PWA更新、真实Gist写入、实时金融核对或新CI。
- `main/budget-final.json` 原预算命令 native exit **1**；外层 expected=1 的记录工具 exit0只说明成功捕获预期失败，绝非预算 PASS。

新增 Store 严格 adapter/私有 adapter 的减包方向止于只读前提审查，**没有**启动 variant/三轮参数试验：可删通用 helper 源739B，大部分字段复制/固定键/规范顺序/深冻及生命周期还需保留，不能把前轮整个 Store 冷包+1401B当可删空间。无可信材料性假设，故不写候选、不测 gzip、不宣称实测收益。既有压缩候选未重启，预算与授权边界不变。

## 原件与可复核性

机器摘要：[qa-summary.json](qa-summary.json)。完整原件：[original-evidence.tar.gz](original-evidence.tar.gz)，758898 B，SHA256 `f33eeea98caf6f9a9795197861de7fa901ee5c552164453b15dd4c85badfccb1`。105文件 /2208839解压字节，新Temp解压逐路径/长度/SHA核验全同；[archive-audit.json](archive-audit.json)含全部清单，[归档工具](archive-tool.mjs.txt)保留精确生成方式。

前缀 main 包含4份改前源码、11份最终源码/测试副本、原始完整命令/stdout/stderr/exit、当前 diff/Git状态、三轮 build/229输入/127site库存、全部16份非OCR JS和manifest、E2E附件。planner 保留不同阶段源/测试/RED/GREEN/运行器；旧阶段副本不是最终产品。readonly-review 是80/80早期独立定向日志，不含后续AST修复/活动基金新增，不能代替最终1159。

保留工具失败而不当产品故障：初次 E2E 参数转义“No tests found”在 e2e-invocation-error，第二次才是真RED；首个 planner PowerShell路径解码问题仅工具历史有完整 shell 错误（Node输出实际捕获），继承cwd仍正确，后用ASCII cwd断言原样重跑RED。一个AST负例曾误生成合法的声明顺序，修正夹具后才进入最终GREEN；原错误夹具在归档。root初次Temp命名使用不可用的crypto变量，创建前即失败，无源码/构建作用，仅工具历史，不冒称有独立日志。

**该窗口M3仍 IN PROGRESS / NOT RELEASED。** 原总包预算与当前源码相对时延资格未关闭。准确执行gate细因在该窗口未记录，但原方案没有把全量细因历史单列为M3硬门禁；后续真机/生产属于各自阶段，不能提前扩大M3退出范围。功能测试与确定性构建不能取代原定门禁；最新执行事实与审计状态见第44节。
