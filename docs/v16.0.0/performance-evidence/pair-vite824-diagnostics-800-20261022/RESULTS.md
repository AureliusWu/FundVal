# 当前诊断源码 / Vite 8.2.4：独立800配对结果

2026-10-22。原采样器native exit **0 / PASS**；独立v2核验9,663项检查、0失败。这里只闭合该精确本地候选相对同依赖v15业务参考的时延项。**M3仍IN PROGRESS，应用仍15.0.2：all 84,187 B > 原77,227.7 B，至少还差6,960整数B，不能进入M4或发布。** 未更换压缩器、放宽预算、修改ES2022/五组配方或删除兼容/校验。

## 固定设计与身份

- 唯一原始数据：[m3-pair-vite824-diagnostics-800-20261022.json](../m3-pair-vite824-diagnostics-800-20261022.json)，**88,032,041 B**，SHA256 `46aeb7a3ad8908bf256ffe4b17e706e59fddd282e5bdcbed994780222a9bf49f`。完整804对，4个预定warm-up、800个retained；retained AB/BA各400，warm-up各2，失败/不完整均0。没有重试、替换、outlier剔除、合并旧样本或更改N。
- 原运行窗口：`2026-10-22T03:41:39.305Z`→`04:16:50.991Z`。固定bootstrap5000/seed160003/timeout30000ms；原sampler SHA256 `2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7`，collector `8a98f57980cfcde94e4035987c974b149c80bc27b51a1ca2309d3aed9d85bdd0`，均未修改。
- 测前[协议](PROTOCOL.md)、[参考身份](reference.json)、[前检](preflight.json)和独立前检均先于浏览器测量。参考057042963a33579c624a41404a6d533dfda29768仅本地，父c298026；只在两个package文件中改五个Vite 8.2.4标量，其他162/164 tree entries不动。它不是产品提交、发布或新预算基点；原40e/70,207 B预算锚不重算。保留parent epoch1791676800是可复现测试元数据，不是发布日期。
- 两侧strict normalized lock SHA256 `db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc`；原算法仅忽略root.engines，未增加例外。Node24.14.0/npm11.9.0/Chrome155.0.8059.86，win32 x64，390×844，同机同浏览器，原合成时钟/基金fixture。
- 当前HEAD170fd3eadc6da02750882f8a542904ee2358d0d9 + dirty候选，不把HEAD单独当不可变源码身份。测量前后tracked diff SHA256 `c90f6da518b7c5e26dc9dbe725510a6bb58372445c82d1232a62a55e0721fa82`、build-relevant untracked SHA256 `f3a07215ad454621efd1be647bc1954dca2dc8cb5eb165311bfe815199f81da3`严格同；在编辑本报告前保存了118,929 B原始binary patch。branch和暂存内容未变。
- 完整重新枚举原snapshot范围270文件（不是只读既有列表），前后没有额外/缺失/变化，214,510,943 B / SHA256 `a93ec47713269596123a672c43af9e8740b47bcf8ec19c7f700249cb0bdb3a16`。其中24个.codex-tmp历史Android输出占202,403,286 B，不是构建必要输入；非历史部分246文件/12,107,657 B。68安装manifest/hidden-lock/native等文件42,709,269 B / SHA256 `2da11b473eaff8bcaa1fef492e4b595629145b97f8c7f2ea18f4e7fb5b074e1c`不变。

## 统计结果

单位ms，所有800个retained对参与原统计，不取最快值。p95为nearest-rank。

| 指标 | reference median / p95 / max | current median / p95 / max | median / p95变化 | 原门禁结论 |
| --- | --- | --- | --- | --- |
| cold readiness | 129.35 / 167.80 / 262.50 | 119.85 / 156.80 / 420.60 | −7.344% / −6.555% | PASS |
| warm readiness | 67.15 / 96.50 / 146.30 | 60.00 / 86.10 / 196.90 | −10.648% / −10.777% | PASS |
| save UI | 75.30155 / 86.98140 / 132.60490 | 64.54230 / 72.94400 / 91.03660 | −14.288% / −16.138% | PASS |

| 指标 | median ratio 95% CI | p95 ratio 95% CI | reference / current p95相对区间宽度 |
| --- | --- | --- | --- |
| cold | [0.913872, 0.937282] | [0.896492, 0.968731] | 6.555% / 6.760% |
| warm | [0.881129, 0.902985] | [0.861336, 0.953927] | 6.425% / 8.362% |
| save | [0.844323, 0.867620] | [0.826157, 0.845910] | 2.111% / 1.040% |

原界限完全不变：median ratio≤1.15、p95 ratio≤1.20，其95%上界须满足限制，current任一关键样本不得≥3000ms；两侧p95区间相对宽度≤0.20，bootstrap pass fraction≥0.95。三项pass fraction均1，**不是总体“100%通过概率”**。冷/暖current最大值比reference大，原始慢样本仍全部保留；p95与最大值不得混用。

独立核验直接调用未改原`summarizePairs`，5000/160003，对完整后800对重算的整个summary与raw deepStrictEqual；另以原`rendererDelta`精确重算4,824条阶段归因。主核验再检查该完整独立结果、逐对观测和整个输入/输出集合，没有重测浏览器。

## 可观测事实与限制

- 每侧804观测，pageErrors0、network instrumentation failures0；每侧2,412个drain全部SETTLED。四个原清理记录（一个browser、两个独占server、一个验证过的临时snapshot）均PASS。另一次结束后的只读OS查询未见旧11792/19900 PID和13546/9692监听；只证明查询时状态，不冒称永久端口所有权。
- **consoleErrors共17,687**：reference7,235/current10,452；策略阻断的request_failed也分别7,235/10,452。记录只保存分类与计数，没有console文本或逐条关联，数目相同不能证明每条console错误的根因。不能称console-clean。
- 请求总数reference42,611/current37,788；MEASURED35,376/27,336，HERMETIC_POLICY_BLOCK7,235/10,452。冷/暖localStatic每侧每次19→14个是实际图请求观察，不等于生产网络变快的因果证明；当前相对参考含多项累计源码变化，不能把时间变化单独归功于诊断或Vite补丁。前三个归因边界是本地载荷/请求图、客户端编排和fixture阻断；真实服务端等待未在本实验测量。
- SW event/controller/registered worker/script请求均0；三边界registrationAttempts观测累计4,824，含同一warm文档重复观测，不是唯一尝试，更不是成功注册。原harness阻断/旁路SW，本实验不验收PWA离线/更新。
- 导航renderer3,216条PARTIAL，save1,608条MEASURED；invalidReasons{}。它们只覆盖同document post-commit/interaction counter范围，不是完整startup或独立OS CPU；Task/Script/Layout/RecalcStyle不应相加。
- warm为同context的**no-store reload**，不是暖HTTP缓存；cold为新context。save是UI实际保存合成100份/cost1.2，不是用户资产或Gist写入；Gist write attempts0。
- 所有真实provider/Gist请求按原harness阻断，只有原fixture；没有生产网络/真实金融对账、手机真机、OCR引擎、云写入、精确新SHA CI或发布证据。上一阶段完整tests/check/E2E仍是身份已核历史材料，**本次没有重新执行**，不能重复算新PASS。

## 两种构建完整性证据

current原采样前后和结束后实际site均127文件/92,537,133 B，sampler清单算法SHA256 `4e8dddb5ce4f81992f384afd0ee552431787c6b30600a643bcb97f6a0837e4e4`。此前sorted-JSON算法SHA256 `5b946d23a08cd42743e5151b3ba5bb62ec52b7b6016dcd83eafaac42817124a9`与其不是同一个算法；critical仍`3103251a7107ebb76d61c0a7131430ccf221e204e6aac931a319649c7608bf55`。

原reference前后均**110文件/92,344,588 B**，sampler清单算法SHA256 `a18ee3fc44654061712e4714f257efbb8767571d07b868d579a56b5d5660f812`。原采样器没有独立持久化参考build stdout/stderr；原snapshot已按原协议删除，不能声称重新读到了它。

为补强构建出处，采样结束后先写独立新协议，调用原`createSourceSnapshot(0570429)`及一次原`configureSnapshotTransport`，新快照`C:/Users/84046/AppData/Local/Temp/fundval-baseline-4ehUoD`保留。沿用原node直接build命令、根固定依赖junction、epoch1791676800，连续**三次实际reference构建native0**；每次stdout/stderr/native receipt单独保留、每次全110成员逐项精确等于raw before及after。主核验再次逐项验证三份收据/清单与最后实际snapshot/site。没有更换recipe、重测时延、安装依赖或触碰root/site。这是**新重建**可复现性证据，不是原build日志的补写或原snapshot重读。

## 完整保留的核验工具错误

独立v1运行完整结束native3，仅1个错误：强比“本地ref构造时tracked diff”与“稍后第47节合法预声明后采样时tracked diff”。两者属于不同时间边界，不能要求相等；不是sampler或业务源码在测量中变化。v1脚本/结果/日志/exit3均保留。

v2仅删这一无效跨阶段断言并改两个输出名以保留v1；仍严格要求ref构造before==after，raw采样before==after==当时live，原HEAD/branch/index/270输入/68安装/全site和全部统计/请求/清理检查不变。v2 native0/9,663 checks/0失败；无重跑采样、无改raw、无降低任何同阶段完整性要求。说明及精确脚本见归档中的`independent-finished/V2_CORRECTION.txt`。

## 原件、后续行动与准入

本目录`original-evidence.tar.gz`与`archive-audit.json`由独立归档工具生成，新Temp解压后逐文件验证；精确成员/字节/哈希以该机器清单为准。包含测前协议、ref构造脚本/输入、唯一launcher及终态receipt、v1失败/v2全核验、测量窗口patch、完整270/68库存、246份非历史精确源码、参考三次重建收据/全库存，以及两侧非OCR静态文件的精确字节。24个历史Android输出仅保留清单；大型OCR payload不再复制，完整全文件身份见raw与库存。**不把这些未复制项冒称全量payload归档。** raw独立保存在上一级，不在压缩包重复放88MB文本；未覆盖、删除或补写历史结果。

实存归档488成员/23,974,262 B未压缩，压缩包10,239,633 B / SHA256 `133d4326343fc277d8d0a89663b47e77725b40594ebffddd152cd7848c8e2e64`；成员库存SHA256 `8fb8da82baa63ed5c490259ad0a20e7a8f83baee6e7be93cfa82d114cf469693`。两次tar命令均native0；新解压目录`C:/Users/84046/AppData/Local/Temp/fundval-pair824-extract-07zGKl`逐文件等于入包清单。非OCR输出实复制current103/4,335,407 B、重建reference86/4,142,862 B；各自另外24个`assets/ocr/`成员（含manifest/许可等，全88,201,726 B）保留清单而不复制。这里24是整个OCR目录文件数，不能与此前仅23资产的核验口径混用。[机器结果摘要](result-summary.json)可独立查看统计、检查、预算和归档身份。

主postflight的7项检查native0，重新完整枚举而非只读既有270列表；原bundle CLI另一次实际执行**native1**，all84,187/cold44,699，不能因expected-failure包装为0就称预算PASS。归档不部署到site，不是代码当数据绕预算。

归档后的最终独立只读核验也已完成，v2实际native0/6检查全通过，包含全源范围重新遍历、68安装文件、完整site/raw、488个解压成员、原archive SHA及HEAD/branch/staged；`git diff --check`真实native0，既有LF→CRLF提示不是差异错误。另保留一次**最终核验工具自身**的v1遍历失败：缺少大括号导致else绑定到内层排除判断，把被排除目录错误当文件断言；其中无条件`sourceUnchanged:true`字段无效，不作证明。v2仅修工具分支、改为成功后派生该字段并另存报告，没有修改任何样本/业务/产物或预算。两工具、失败/成功报告、修正说明和v2原生进程收据单独保存在[`final-audit/`](final-audit/FINAL_AUDIT_CORRECTION.md)，不覆盖先前488成员原包；最终有效结果为[`final-evidence-audit.v2.json`](final-evidence-audit.v2.json)。这是另一项工具错误，不与前述独立统计v1的跨阶段diff错误混同，也不替代原统计核验。

本次时延门禁通过，原预算门禁仍失败。最值得处理的是可证明完整闭合的材料性重复/私有业务管线；不要重复扫已否决的压缩参数，不要删严格validator、旧缓存/公开API或用额外adapter假称收益。后续任何源码/打包变化都需重新资格检查，不能自动继承本报告。下一阶段M4/M5/M6、升版v16和发布均未获本结果准入；本轮未产品提交、推送、合并或部署。
