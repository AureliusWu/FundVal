# M3 配对性能证据

报告只含合成持仓、耗时、分类后的请求和测试环境/源码/产物指纹。不得加入 Token、真实持仓、原始 URL/query、图片或 OCR 文本。大 JSON 是原始样本，不是生成的生产资源，不进入 site/SW。

## 采样约定

- 固定旧版 SHA：`40e68edab9cb3fba0b17338dc3672a82d13ad17e`，不是可变分支名。
- 历史报告仍绑定原40e。2026-10-11新测量预声明：使用仅含source-map-js安全补丁的本地不可变旧业务参考 `c2980265d3c89f960517ced1527ba9cb85bf7c2b`，证明见 `m3-security-aligned-reference-20261011.json`。不降低依赖校验或预算、不改写历史报告；新文件 `m3-pair-security-v15-200-20261011.json`，200 retained + 4 warm-up、bootstrap5000、seed160003，其他协议与硬阈值不变。
- 同机同浏览器、390×844、HTTP 缓存关闭/no-store，SW 不控制页面，固定合成时钟。
- 每个 side 使用独立空 context；warm 为同 context reload；save 为真实 UI 保存合成份额。
- 先声明样本数与 warm-up；交错 AB/BA，保留全部原始观察，不挑最快、不剔除 outlier、不自动重跑失败 pair。
- p95 为 nearest-rank；不把最大值当 p95。分层 bootstrap 保留整组配对相关性，固定 seed。
- 网络字段仅本地 HTTP/拦截 fixture；不冒充生产服务端、公网或手机性能。
- 前后源码与产物指纹不变、无意外 pageerror、请求记录完整、资源清理可证后才讨论统计结果。
- 工具的 PASS 还要求 95% 上界满足相对目标和稳定 p95；样本不足/区间宽记 INCONCLUSIVE。保存 p95 是额外工具诊断，不是原升级方案中新增的硬预算。

PowerShell 运行需显式传递 Node exit code（2=INCONCLUSIVE，非 0 不代表必然业务失败）：

```powershell
node scripts/measure-performance-pair.mjs --pairs 200 --warmup-pairs 4 --bootstrap 5000 --seed 160003 --output docs/v16.0.0/performance-evidence/m3-pair-200.json
exit $LASTEXITCODE
```

已有报告禁止覆盖；脚本使用独占创建。采样期间不编辑源码/构建、不并发跑 test/E2E/虚拟 bundle；不使用或终止其他项目的 4173 服务。

下表 SHA256 对应生成报告的 LF 文本，也是 Git blob 的文本形式。若 Windows checkout 将文本变为 CRLF，校验时先还原 LF；不能把换行形式误报为采样数据被修改。

## 报告索引

| 文件 | 结论和范围 |
| --- | --- |
| `pair-controllers-800-20261025/README.md` | 最终281源/129site的新唯一800+4、native0/PASS及前后指纹同；原helper整对象12883检查与另独立基础统计7253检查均通过，不冒称第二套bootstrap。cold/warm/save median119.8/60.2/66.06475ms，冷max327.8劣于参考保留；console17688、导航PARTIAL和合成桌面局限明确。509成员tar完整raw仅一次；精确提交CI未完成，非M3 EXIT/生产 |
| `controller-extraction-20261025/README.md` | 最终281源的两controller提取、真实互锁和补名事务cache/旧代状态竞态修复；原先红、V1浏览器34/35及V2结构断言2fail均保留。V3为1409PASS/3skip、syntax223、Chrome35/35、两次完整129构建同、all86,850/cold47,014、audit0。只是本地QA/代码范围；新800+4结果另见pair-controllers，精确CI尚待完成，非M3 EXIT/发布 |
| `pair-controllers-800-20261025/PROTOCOL.md` | 两controller与补名修复后的独立预声明：同0570429安全对齐参考、严格同锁、原工具800+4/ABBA/5000/160003/30s、门禁不变。运行前最终QA/source/site/工具/协议冻结，完整原始报告仅在新独立Temp及后续归档保存；协议本身不是已运行或PASS |
| `pair-correctness-800-20261023/README.md` | controller提取前274源的新正确性候选，唯一800+4/native0、完整独立重算；all85,969/cold46,149、本地时延PASS。归档含全部88MB raw，不能继承给后续281源的runtime改动，也不代表M3退出或生产 |
| `budget-policy-20261023/README.md` | 用户仅批准全部非OCR总包90KiB，cold52,241及其他门禁不变；旧CLI对同site仍FAIL。旧夹具失败和新1320PASS/3skip、35/35、四次127构建相同、audit0原件归档；不追溯改判旧候选，不等于压缩收益或发布 |
| `private-vertical-20261023/README.md` | 当前正确性基线的完整私有路由原型：A249不变/B257精确改2旧+8新；generic Quote/cache严格规则仍K，不伪称全退役。A完整127精确当前；B完整136/17chunks，all87,338（+1,369）/cold46,005（−144），原预算真实native1/未采用。无候选完整QA/三轮确定性/配对时延或生产资格；原始源码、收据、实际app块和完整site库存保留，root273/site127/安装68/Git未变，15.0.2/M3 IN_PROGRESS |
| `closure-overlay-20261023/README.md` | 当前273输入上的独立同版parser overlay：共同packaging重定位+B1唯一2022 case，B0/B1各13类/16模式及完整族javap仅有限前提PASS；原DRIVER/8夹具/4support共13文件字节与固定options不变。唯一F01 original0→Java2，原标签SETUP_OR_DRIVER_FAILURE保留、真实阶段OPTIMIZER_INTERNAL_EXCEPTION（RemoveUnusedCode内部NPE），无转换代码/余7组/产品build/gzip/采用。旧§53桥接失败及本轮fetch/空格断言准备失败全保留；执行前后273源/127site/68安装/Git同，all85,969/cold46,149、预算FAIL/差8,742 B，旧QA/800不继承，15.0.2/M3 IN_PROGRESS/未发布；未来正常renderChunk为Closure→OXC→hash，TLA正文约束不等于最终SHA不变 |
| `closure-fixed-probe-20261022/README.md` | 当前273输入上单次固定Java API SIMPLE前置实验：工具JDK/JAR实下载SHA/版本通过，原下载超时和受控206续传保留；F01原版sanity0，Java2解析桥接异常ECMASCRIPT_2022，controller2/SETUP_OR_DRIVER_FAILURE，F01转换及其余7组NOT_RUN。无改参重跑/产品转换/压缩收益/采用；106成员归档全新解压同、14项归档审计0（非策略PASS），只读诊断确认上游input桥接漏项、不推断output目标失败；root产物仍85,969/46,149，预算FAIL/M3 IN_PROGRESS/15.0.2/未发布 |
| `accuracy-lifecycle-fix-20261022/README.md` | 独立accuracy异步enriched生命周期修复：真实accepted-US-session RED04→同字节隔离GREEN01，新增12单测；最终1313 PASS/3原Windows skip、语法215、Chrome35/35，三轮完整127行SHA同。预测目标Sep28而非中国Sep29今日涨跌，暖ledger结果幂等（非零写入证明），合成后续NAV1.224结算预测1/实际约2/误差约−1个百分点。all85,969/cold46,149，较第51节+13/+20 B、预算native1/仍差8,742整数B；273完整输入与旧272前置A/B/Closure身份区分，旧失败全保留，无压缩执行/采用、Java下载或新时延/CI/生产资格，15.0.2/M3 IN_PROGRESS |
| `model-provenance-fix-20261022/README.md` | 独立双模型来源P1本地修复：真实OLD13有7 RED/6控制，同字节最终13 GREEN；正式新80测试、最终1301 PASS/3 skip、Chrome34/34及三轮完整127构建相同。all85,956/cold46,129，正确性成本+1,769/+1,430 B、预算native1/仍差8,729 B；791成员全解压同、主30项native0。旧失败保留，accuracy完整生命周期未闭合；无新时延/CI/真机/生产或压缩采用，15.0.2/M3 IN_PROGRESS |
| `pipeline-boundaries-20261022/README.md` | 完整管线原型仅wire64公开边界一致；另234/34是独立OLD控制，不是完整候选，保留首次冻结器与两个forecast native1。发现可达双模型候选来源P1、未证明主金额错；916成员全量归档/新解压同、主23项native0，root产品不变/仍超6960B，无新build/时延/CI/采用或发布 |
| `worker-seam-20261022/README.md` | 原输入三文件Worker同文件解析边界：generic64/fixed52完整独立旧对照相同，2×97定向测试，原配方六轮全127成员确定；候选all84,257/cold44,702反增70/3 B，不采用。两侧graph native0、budget真实native1，root仍84,187/44,699、差6,960 B；非完整QA/新时延/CI/生产或M3 EXIT。完整行为raw、source/原件/方法及有限归档见目录 |
| `m3-pair-60.json` | 第一轮 60 retained +4 warm-up；统计 INCONCLUSIVE，harness pageerror 和请求记录问题使完整性证据不足；原样保存，SHA256 `88b927752e589553cea18dba88e3d2233c780f208beeb1ea77a1de6902a4611d` |
| `m3-pair-200.json` | 修正 harness 后预设 200 retained +4 warm-up；health/instrumentation/integrity/cleanup PASS，统计 INCONCLUSIVE（旧版 p95 区间宽、保存额外 p95 观察不稳定）；SHA256 `b7abe1b6f9409a8ebf5543b0b380acbb252bc2db60676db5ead7d75491813ad9` |
| `m3-counter-probe.json` | 新同文档 counter 协议的 3 次 current-only 桌面实际采集兼容性预检；COMPATIBILITY_PASS，不是 v15 相对性能/p95；SHA256 `94f658237181e97021f64881bd550522e7f05796842aa324fe05bb975448e707` |
| `m3-pair-v2-200-protocol.md` | d9fdabc 在采样前已提交并推送的预声明；固定 200+4、bootstrap 5000、seed 160003、同文档协议及限制，不是结果证明 |
| `m3-pair-v2-200.json` | 同文档 v2 协议，200 retained +4 warm-up，AB/BA 各 100；relative tool PASS / exit 0，health/instrumentation/integrity/cleanup PASS；cold/warm renderer 仍 PARTIAL，保存 MEASURED；实际 HEAD d9fdabc，LF 22,398,799 B / SHA256 `323ff4087da0a1a836fe8147ef305cd8f315e3e0d10e706cbc4d25abfba74236`；独立 all-gzip FAIL，非 M3 EXIT |
| `m3-bundle-gate.json` | 第 11 节历史本地 app chunks 实算：cold 43,845 PASS、all 82,481 FAIL；预算 CLI exit 1，不是本轮新源码、CI/生产产物证明 |
| `m3-continuation-ci.json` | 归并后新分支 afd472c 的实际 CI 37095774528：Linux 823/823、E2E 23/23、构建/资源核验通过；唯一失败为 all-gzip 82,481 超预算。CodeQL workflow success / analysis 3，未观察到独立 CodeQL check，不是零告警或正式发布 |
| `m3-safe-compaction-20261003.json` | 父检查点 93b6182 上的待提交源码去重：3 次虚拟重复 + 实际确定性构建，all 82,286（−195 B）/ cold 43,702；840 tests（3 Windows skip）及 E2E 23/23；总体预算仍 FAIL，变化后的 paired latency NOT_RUN，现场 Worker 时钟超前使 5 次数据抽查 NOT_VERIFIED；非 CI/生产证据 |
| `m3-private-compaction-20261003.json` | 父检查点 f625062 上的私有参数 / latestSource 去重：3 次两侧虚拟重复、实际确定性构建，all 82,202（−84 B）/ cold 43,699；850 tests（3 Windows skip）/ E2E 23/23；元数据 setter 候选被真实 RED 测试否决并保留旧 literal。全包仍 FAIL / paired NOT_RUN；新 5 次完整主源拒绝，005844 NAV 四字段仅诊断精确匹配；非 CI/生产证据 |
| `m3-runtime-surface-20261003.json` | 父检查点 54fc3a0 上的 4 窄 facade / 私有死排序分支裁剪：3 次各变体、实际确定性构建，all 81,735（−467 B）/ cold 43,486；862 tests（3 Windows skip）/ E2E 23/23；12 项新测试与 4,920 对排序对照。图有意新增零实现 facade，原业务/启动模块集合保持，预算仍 FAIL；paired / 新公开数据抽查 NOT_RUN，非 CI/生产证据 |
| `m3-private-runtime-20261011.json` | 父 c303 上保留公开 API / 完整声明验证的固定内部刷新入口：两侧各 3 次、两轮实际 build，all 81,195（−540 B）/ cold 42,944；892 tests（3 Windows skip）/ E2E 23/23，新 30 项 runtime/AST/factory 契约；预算仍 FAIL，官方依赖审计新检出 1 high。另记录父 c303 实际下载候选 125 文件字节核验、main-only 准入拒绝及 CRLF 指纹边界；不是新 SHA CI/生产/paired PASS |
| `m3-source-map-security-20261011.json` | 独立安全 PR：锁文件唯一 source-map-js 1.2.1→1.2.2，5 install-script policy 不变，冻结安装/全 audit 0、892 tests（3 Windows skip）、E2E 23/23；同 411 epoch 的两次关键指纹与补丁前一致。all 81,195 仍 FAIL；记录 411 CI 因新公告 audit 失败且后续步骤 skipped，不继承为 patch CI/生产证明 |
| `m3-security-integration-20261011.json` | PR #17 已仅合入 WIP continuation：f626 与 merge 501 tree 精确相同；两 SHA 实际 CI Linux892/892、audit0、syntax192、E2E23/23、build/资源核验/封包上传成功，唯一失败仍 all81,195预算。CodeQL扫描各3结果；merge两轮本地新epoch指纹实核，不冒充远端/生产，main未动、M3未退出 |
| `m3-cache-identity-20261011.json` | 父 414 上修复 P1 聚合缓存串基金：旧 unit 6 PASS/17 RED、旧页面 1 PASS/3 RED，新增 HTTP 28 表征与 cache 23 / UI 4 回归；全量 943 tests（940 PASS / 3 Windows skip）、syntax195、audit0、E2E27/27。两次实际 build all81,263 / cold43,015，正确性成本 +68/+71 B，预算仍 FAIL / 当前 paired NOT_RUN；记录被真实负控否决的减包候选和精确父 414 CI，不继承至新源码，不是发布 |
| `m3-cache-identity-ci-20261011.json` | 修复已推送 fa49224；新 SHA CI38110531850 实核 Linux943/943 / 0 skip、syntax195、audit0、E2E27/27（46.2s）、build/app/OCR/seal/upload成功，唯一失败仍all81,263预算。精确CodeQL3结果；该提交新epoch两轮本地指纹实核，远端包未下载，不是main/生产/后续文档SHA或paired证明 |
| `m3-private-hash-build-read-20261011.json` | 父2f上裁剪闭合私有hash、emitted Worker单次read；新增23测试，旧read13PASS/1RED→14GREEN。全量966 tests（963PASS/3skip）、syntax197、audit0、E2E27/27；共3次实际build，E2E后连续2次，all81,158/cold42,907（−105/−108 B），预算仍FAIL。父精确CI/3安全告警、5直接transport失败完整保留；不是paired/真机/发布证明 |
| `m3-security-aligned-reference-20261011.json` | 新本地不可变参考c298026，唯一父原40e；164 tree entries仅lock变，109锁条目仅source-map-js3字段安全补丁，原业务不变；严格normalizedLock与当前相同，真实index/工作树/普通分支不变。未测量，旧PASS不继承，77,227.7预算原锚不变，local-only不push |
| `m3-pair-security-v15-200-20261011.json` | 新安全对齐参考c298026 vs 06aa，200 retained +4 warm-up，AB/BA各100，0 failed。cold/save PASS，warm p95区间宽24.457%>20%稳定性限制，总体INCONCLUSIVE；完整性/健康/仪器/清理PASS。LF22,410,202 B / SHA256 `5e4199a9268ecb8761dc3f91725daba3f1b63adedd7b86ef2a9b820f940b3ddd`；保留全部样本，不重跑挑PASS，不是M3 EXIT/真机/生产 |
| `m3-private-hash-pair-ci-20261011.json` | 精确06aa CI38112117242：Linux966/966、syntax197、audit0、E2E27/27，构建/封包成功，唯一失败all81,158预算；CodeQL2结果，#3仅continuation fixed、main仍open，#5/#7仍在。提交后两build确定性及新pair独立重算/观测边界汇总；不是后续文档SHA、远端包独立下载或正式发布证明 |
| `m3-public-source-readonly-20261013.json` | 真实HTTP客户端/env-proxy/缺省时钟：未强刷及app默认force:true各固定5次均5/5接受，首个9.89s/9.07s慢样本保留；005844 Oct12→13、012920 Oct9→12均正式NAV降级，非实时估算。另列显式请求开始now诊断1拒绝/4接受，不替换失败、不误报app Bug；无云写入/生产渲染或独立上游核对 |
| `m3-rejected-structural-probes-20261013.json` | 17bb 内容上的12个各自在脚本中预设的虚拟变体（含负控/组合）各三轮，以及两轮真实导出库存；最佳组合仅−14 B，不实施任何候选。归档精确脚本、变体与原结果；新本地963 PASS/3 skip、syntax197、E2E27/27、app/OCR核验通过，all81,158仍FAIL，旧pair INCONCLUSIVE保留。无业务/配置/依赖/预算/版本/main/生产修改；不是新文档SHA的CI或发布证明 |
| `m3-larger-boundary-probes-20261015.json` | 17bb 内容上7个独立脚本族的22个预设变体各3轮，均未实施；私有HTTP投影−120 B但原28/28、候选27/28表征证明改变safe rescue而否决，其余最大仅−34 B。新全量963 PASS/3 skip、syntax197、E2E27/27、三build/资源核验通过；all81,158仍FAIL，旧pair未重跑。19份精确LF原脚本/报告/TAP压缩归档，非CI/生产或M3 EXIT |
| `m3-e750-ci-20261015.json` | 精确父e750 CI38694431660：Linux966/966、syntax197、audit0、E2E27/27，唯一失败all81158预算；CodeQL仍2个既存medium（#5/#7）。artifact仅元数据/未下载；不继承到新实现SHA |
| `m3-runtime-projections-20261015.json` | 正式通知布尔入口、共享完整validator的私有计划、独立SW消息认证。新全量1012/1009 PASS/3skip、syntax202、audit0、E2E28/28；三实际build all80394/cold42907，−764 B但原预算仍FAIL/差3167 B。五真实源0接受，空every不算等价PASS；旧pair未重跑、无新CI/真机/生产验收。71份完整原件见同名前缀md及gzip/base64归档 |
| `m3-public-metadata-skew-20261015.json` | 后续单独固定3次真实HTTP GET旁观：3次200/v1、fetched_at比本机未来3545/3400/3262ms，均metadata拒绝。本批可定位未来fetched_at分支，不倒推此前无payload错误、不判定哪端钟错、不替换五失败/放宽校验/调整时钟；精确脚本另存mjs.txt，不在71份旧包中 |
| `m3-1a02-ci-20261015.json` | 精确1a02/run38698735715：Linux1012/1012（0 skip）、syntax202/audit0/E2E28均通过，唯一失败原all80394预算。新CodeQL103rules/1result为#5，#7 continuation fixed；不外推main/生产。127文件artifact仅元数据，未下载；seal为site inventory指纹，不是critical，不继承后续文档SHA |
| `m3-page-update-guards-20261015.json` | 父fb559上真实app/native SW两次旧源1FAIL/1PASS发现peer自动重载；18项最终GREEN、全量1027PASS/3skip、syntax204、E2E30/30。原配方三build all80477/cold42992，正确性成本+83/+85 B，原all预算仍FAIL/差3250 B。只限同版本本地合成流程；非版本迁移/真机/CI/生产，完整原件在本机Temp，不称完整归档 |
| `m3-page-update-portable-harness-20261015.json` | b9da真实Linux CI为路径负控E2E失败（28/2），非只有budget红；跨平台测试helper修正、win32/POSIX58/58纯path矩阵，新本地1027PASS/3skip、E2E30/30、三build/产品指纹不变。保留旧失败，不继承为新SHA CI或Linux浏览器通过；原all仍超3250 B |
| `m3-clock-and-boundaries-20261015.md` | f926上独立NTP支持本机慢约3.75s；获授权仅一次resync被0x80070005拒绝，未重试/改配置。随后固定5次真实客户端均metadata未来拒绝，不是可信数据PASS；三个新较大职责审查未找到合格删码切面，仅归档人工报告。现有产物原CLI仍80477/77227.7 FAIL，无新build/pair/发布；同时记录f926精确CI唯一budget红，不继承后续文档SHA |
| `m3-clock-client-five-20261015.json` / `.mjs.txt` | 校时被拒后的固定5次原记录与精确脚本，byte-for-byte实核；fetched_at未来3689/3513/3387/3270/3151ms，0接受。无自适应重试/改时钟/改校验，不替换历史失败，不是独立净值对账 |
| `m3-render-boundary-review-20261015.md` / `m3-startup-boundary-review-20261015.md` / `m3-estimate-dto-review-20261015.md` | 三个完整有界人工审查报告：实际渲染、跨锁恢复与缓存/DTO可达性；无新候选测量。附属Temp AST脚本/JSON没有全量归档，不代表更广架构不可能优化 |
| `catalog-maintenance-20261015/README.md` | 目录维护器输入预算、stream/UTF8、单调deadline、wx+descriptor+rename；10/15窗口旧23项8/15 RED、两个单项RED与29定向/1057全量保留。10/18新空片资源负控RED→固定16MiB正文缓冲，31定向/1059全量（1056PASS/3skip）、syntax205/E2E30与三build通过，产品不变/all80477仍超3250B；当前模块一次真实GET仅写Temp生成28104行、本地27487目录未改。不预称#5关闭或上游/金融数据/发布通过 |

后续修复 harness 不会改变第一轮结论。新报告按实际结果追加；总包 gzip 独立硬门禁不能被桌面工具 PASS 覆盖。

200 组报告的 warm renderer counter 跨导航重置，差值保持 null，因此不能确认该阶段 CDP 主线程分解。console errors 为主动阻止外部请求的已记录观察，非“无 console error”验收。详见上级 `M3_STATUS.md` 第 9 节。

当前采样器协议为 `paired-readiness-v2-same-document-counters`，以 commit 后同文档 baseline 避免跨导航相减。额外 RPC 有观察开销，cold/warm attribution 仅 PARTIAL 到 collection，不是完整启动或隔离 OS CPU。future relative samples 必须两侧同新协议、另存新文件，不与旧 60/200 混样。既有文件仍可重现其历史结论；上面的示例输出路径已经存在，不能直接重跑覆盖，应先选定新的证据文件名。

v2 的独立结果不追认历史报告为 PASS，也不能证明新 RPC 或某项业务改动是时延变化原因。两侧每阶段 204 组四个 counter 均有限、同 epoch、无 invalid reason；cold/warm 全为 PARTIAL，save 全为 MEASURED。计数范围包含 warm-up，不参与时延推断的 4 组没有丢弃。Task/Script/Layout/RecalcStyle 不是可相加的互斥 CPU 项。reference/current 各有 1,836/2,652 个已记录的外部阻断 console error，不是 console 零；每侧 612 drains 全 SETTLED，SW event/controller/registration 为 0。详细数值、95% CI 和当前独立阻断见 `../M3_STATUS.md` 第 17 节。

实际体积门禁可独立运行（PowerShell 同样保留 exit code）：

```powershell
node scripts/release-fingerprint.mjs --assert-app-bundle-budget site
exit $LASTEXITCODE
```

它枚举完整 chunk 文件集并实算每份 gzip，不信任 manifest 自报压缩长度。报告 `importClosureVerified:false`：真实静态依赖图/冷启动隔离仍由 build-site 的 Rolldown 输出图校验负责。超预算的 WIP review artifact 可以封包保存，但 CI 必须红、standalone candidate/deploy 准入必须拒绝。

最新06aa配对与精确CI见上级 `M3_STATUS.md` 第27节。第26节/reference JSON中的未测量状态是创建参考时的历史事实；本轮实测结果为INCONCLUSIVE，不继承历史v2 PASS。console计数与阻断计数相等但未保留逐条关联，不能断言全部错误根因；统计及source/artifact完整性结论不扩展为console-zero、生产或物理设备通过。

最新结构减包排除和本地复核见上级 `M3_STATUS.md` 第28节及 [精确探针归档](rejected-probes-20261013/README.md)。所有候选均未实施，旧配对未重跑。归档中的 `.mjs.txt` 不属于业务源码或 package scripts，不应直接执行或覆盖历史报告；库存投影与原报告、graph SHA与产物指纹的边界详见归档说明。

10月15日新增22候选及HTTP反例见第29节与 [19份精确原件压缩归档说明](rejected-probes-20261015.md)。较大HTTP/模型/时间解析/UI职责和静态排布都未取得合格收益；不改变原预算或旧pair结论。压缩归档只保存文档证据，不属于发布资源或产品减包手段。

10月15日正式闭合运行投影与SW加固见第30节及[71份完整原件说明](m3-runtime-projections-20261015.md)。新all80394是三次组合构建的实值，不是两候选收益相加；whole-site明文实际增长6824 B。原件中五次0接受的allRowsPredicatesEqual:true与无条件条件可信标签已明确否决，不作为真实源/通知等价验收。

10月18日105基金真实Bridge队列溢出与独立官方2-slot修复见第35节及[原始RED/GREEN、Chrome与三次构建证据](nav-scheduler-20261018/README.md)。新all80494（+17B）/cold42985，仍差3267B；是刷新可靠性修复，不是减包收益。最终1064/1061PASS/3skip、E2E31/31；原pair仍INCONCLUSIVE，不进入M4或发布。

10月18日压缩器独立比较与新800配对分别见第36/37节；后者当前源时延PASS，旧200不改判，all包门禁仍FAIL。10月20日第38节补[独立实际字面闭包/原生静态绑定门禁](esm-link-20261020/README.md)：完整1101/1098PASS/3skip、syntax207、E2E31/31、两次确定性build/audit0，产品库存不变；预算工具仍诚实返回importClosureVerified:false，不能混用新命令的有限证明范围。第39节[UTF8/ASCII打印预筛](format-only-20261020/README.md)最终仅−270B且有未闭合AST差异，未采用，不是实际Vite候选。当前M3仍IN PROGRESS /15.0.2，未提交推送、部署或发布本轮工具工作。

第40节另补[Uglify与clock/HMS共享的固定有限排除](bounded-minifier-scalars-20261020/README.md)：6+12次实际write:false构建，Uglify仅−139B且lazy增122B，scalar最优仅−33B；无采用。439原件含全部产物/输入/4930对primitive trace，压缩归档后新Temp解压逐文件验证；不声称完整API、重复执行历史测试/时延或全程序无法优化。原产品与3267B缺口未变。

第41节补[私有纯字符串池固定离线预筛](string-pooling-20261020/README.md)：153组/1117处，raw−7579B但实际all gzip+641/cold+352B，三轮固定结果，停止且不采用。129原件含全部候选/轮次字节已新Temp解压实核；保留v1零测量词法失败及获批v2修正，不能当作实际Vite构建或完整运行资格。原all80494/77227.7 FAIL及M3状态不变。

第42节按原M3交付补[刷新计数诊断与有界内存观察链](refresh-observability-20261020/README.md)：1133/1130PASS/3skip、syntax210、Chrome32/32、3确定性build/audit0，56原件完整解压实核。当前all83084/cold44386，功能增加all2590B，原预算仍FAIL/至少差5857B；旧800组时延不继承给新源码，无新CI/设备/生产资格，版本15.0.2/M3 IN PROGRESS。

第43节继续补[固定十项计划原因和解构逃逸负控](plan-reasons-20261020/README.md)：最终1159/1156PASS/3skip、syntax211、Chrome32/32、3次确定性build/audit0，105原件解压逐项实核。新all83647/cold44514，相对前轮功能all+563B、原预算仍FAIL/至少差6420B；原决策单次观察不是实际请求/gate历史。无新时延/CI/真机/生产资格，原版本与M3状态不变，未推送发布。

第44节补[实际执行拒绝事实及新安全阻断](execution-skips-20261022/README.md)：1224/1221PASS/3skip、syntax212、Chrome33/33、3次确定性build，93原件解压实核。all84187/cold44699，原预算仍FAIL/至少差6960B；当前官方audit已返回Vite8.2.2的1个high，不能沿用旧0。无force升级/新时延/CI/真机/发布；版本15.0.2/M3 IN PROGRESS，精确gate细因历史不新增为硬退出条件。

第45节补[Vite8.2.4最小安全patch隔离资格及root服务阻断](vite824-security-20261022/README.md)：A/B各完整1224/1221PASS/3skip、syntax212、Chrome33/33及六次全127file字节同，候选audit0后独立screen通过，仅回写两个文件五scalar；root完整回归与三次全产物同一也通过。root audit503→唯一timeout，最新为UNKNOWN，不用隔离0或旧1high覆盖。all84187仍FAIL/至少差6960B，无新相对时延或锁比较例外，应用15.0.2/M3 IN PROGRESS，未推送发布。原件隐私遮盖/完整copy与构建输入范围见新报告，不夸大根目录最终验收完成。

第46节[独立root安全审计闭合与三路有界只读审查](audit-closure-20261022/README.md)：先声明单次probe，实际root完整JSON audit0含dev，前后270输入/127输出/68安装库存及20历史收据全同，经独立hash复核，Vite本地资格已闭合；旧503/timeout与第45节UNKNOWN为历史事实保留。三路未发现新合格材料性候选，无新源码/压缩变体/全量QA；原预算CLI新native1仍84187/77227.7 FAIL，M3未退出，无新时延/CI或发布资格。

第47节[当前诊断+Vite824独立800配对预声明](pair-vite824-diagnostics-800-20261022/README.md)：创建仅本地同依赖v15安全参考05704296，原业务不动/预算锚不改，strict锁同不waive；固定原800/4/5000/seed一次，原sampler不改。预声明本身不是结果，等待唯一新进程/JSON，任何时延结果均不能覆盖all84187预算FAIL或进入M4/发布。

第48节[同一新800配对最终结果](pair-vite824-diagnostics-800-20261022/RESULTS.md)：唯一native0/PASS，完整800+4/ABBA400+400/0failed，独立v2原bootstrap整对象重算及9,663项0失败。cold/warm/save median分别改善7.344%/10.648%/14.288%；raw88,032,041B/SHA46aeb7a3完整保留，v1跨阶段diff错误与native3也保留。结束后完整重枚举270输入/127当前产物/68安装同，先冻结测量patch；新参考三次实际重建全部110成员等于原库存，不冒称已清理旧snapshot重读。console17,687、导航renderer PARTIAL、no-store暖重载与合成桌面限制明确；无新全量QA/精确CI/真机/生产。all84,187/77,227.7仍FAIL/至少差6,960整数B，M3未退出，未推送发布；归档范围和新Temp解压核验见该结果页及机器清单。

第56节[原配方模块归属与三路结构审查](module-attribution-20261023/README.md)：实际16块逐字节复现、59模块预压缩归属；UI/契约/仓储未发现新材料性退休池，不把renderedLength当gzip节省。108原件新解压实核，原预算FAIL保持历史事实，无新优化/性能资格。

第57节[用户批准90KiB总包政策及当前本地验收](budget-policy-20261023/README.md)：仅all上限92,160B，cold52,241及其他门禁不变；当前85,969/46,149新政策CLI0、保留旧CLI1。新增policy RED→GREEN、V1全量负例夹具失败及预声明V2纠正均保留；V2实际1320PASS/3既有skip、syntax216、Chrome35/35、4次完整127构建同、当前audit0。702成员/9,663,880B归档新解压实核；新时延/精确CI/后续阶段仍待完成，15.0.2/M3 IN_PROGRESS，未发布。

第58节[当前正确性产品独立800配对结果](pair-correctness-800-20261023/README.md)：唯一native0/PASS，800+4/ABBA400各/0失败，全量12,883检查与另一路整对象重算同。cold/warm/save median改善7.975%/12.244%/17.377%，保留save最慢317.8952及非零console/nav PARTIAL限制；274/127/68和dirty身份前后同。88,033,360B完整raw收录14,555,822B归档，432成员新解压全同；不是旧800继承、真机/CI/M3总退出或发布，精确CI/完整阶段review仍待完成。
