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
