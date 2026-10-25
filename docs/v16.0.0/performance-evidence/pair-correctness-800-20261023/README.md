# 当前正确性修复后M3：独立800组配对结果

2026-10-23。**LOCAL_PAIRED_LATENCY_PASS / M3 IN_PROGRESS / NOT_RELEASED**。本轮针对§51/52正确性修复后的实际产品，不继承§48旧800。用户批准的90KiB只改变独立总包政策，未改变本轮时延、cold52,241B、数据或兼容门禁。

## 预声明、身份与一次执行

[PROTOCOL.md](PROTOCOL.md)保持执行前PREDECLARED/NOT_RUN原件不改写；结果写在本页。独立配方与启动前复核后，原sampler唯一运行2026-10-23T06:43:09.455Z→07:20:41.812Z，**native0/PASS**，stdout5,871B、stderr0B，外层postflightError:null。固定800 retained+4warmups、AB/BA400各组、bootstrap5000/seed160003/timeout30000，0failed/incomplete/replacement；只有原4预热不参与推断，原始804组全部保留，无中途统计/剔样/重试。

原sampler `2ca75452...`、collector `8a98f579...`字节不改，原strict锁校验无例外。既有不可变参考057042963a33579c624a41404a6d533dfda29768（parentc298/tree40098290/epoch1791676800），只此前安全依赖对齐、v15业务不动，不新建ref。当前/参考normalizedLock精确`db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc`，8声明安装版本同；原40e/70,207B预算锚不改。

Windows10.0.26200/x64、Ryzen5 3600/12logical/约16GiB、Node24.14.0/npm11.9.0、Chrome155.0.8059.86、390×844。同一browser实例、fresh contexts、HTTP-cache disabled/no-store暖reload、SW denied/bypassed、原合成Worker/空重仓fixture、UI保存100份/成本1.2。所有真实provider/Gist隔离，无真实用户数据。起止可用内存约1.79/2.33GB，系统其他进程未停止；非全机idle或生产网络证据。

## 原门禁结果

单位ms；p95仍nearest rank，所有800 retained参与。

| 指标 | v15 median / p95 / max | 当前 median / p95 / max | median / p95变化 | 结论 |
| --- | ---: | ---: | ---: | --- |
| cold readiness | 141.70 / 187.00 / 461.40 | 130.40 / 177.80 / 278.00 | −7.975% / −4.920% | PASS |
| warm no-store reload | 75.55 / 117.40 / 269.30 | 66.30 / 104.90 / 237.20 | −12.244% / −10.647% | PASS |
| 实际UI保存 | 79.46955 / 90.81360 / 122.85390 | 65.65980 / 75.10660 / 317.89520 | −17.377% / −17.296% | PASS |

保存最慢样本**317.8952ms高于参考122.8539ms**，完整保留，没有宣称每个样本都改善；仍低于原3000ms绝对阻断。三指标95% median/p95 ratio上界分别0.932094/0.995565、0.892857/0.955768、0.834978/0.849655，满足原1.15/1.20。双侧p95区间相对宽度cold7.219%/7.705%、warm13.032%/10.963%、save2.729%/3.159%，均≤20%。原plan的save-median和原工具更保守的save-p95均通过；bootstrap pass fraction各1不是总体100%通过概率。没有放宽阈值或以generic minimum60代替协议800完整组。

## 两路独立复核与有限观测

父级执行启动前预写的independent-audit（SHA `060798af7929e03fa754baab11e6dfe63ca1d0cd3f7aadf4d575c91f1fa8246c`）实际native0：**12,883检查/0失败**，整个原summarizePairs对象精确一致。另一只读审阅者直接读取88MB raw后以slice(4)重新整对象bootstrap及全部4,824条rendererDelta，native0/一致；未重启任何浏览器采样。其FINAL_REVIEW原件在归档parent/。

全部1,608 side的pageErrors0、instrumentation0、三阶段SW/controller/registrations/script requests0，4,824个原顺序drain均SETTLED，Gist写尝试0；health/instrumentation/integrity/四项owned cleanup均PASS。独立事后OS观察采样PID1928已无、原5008/5011无监听，只证明该时点。没有停止无关进程/触碰4173。

**console errors17,687与blocked requests17,687都保留**，同数不等于逐条因果证据，不宣称console-zero。共80,398requests：59,495loopback、3,216synthetic intercepted、17,687blocked。导航renderer cold/warm各1,608为PARTIAL post-commit归因，save1,608为其窗口MEASURED；missing reasons{}不等于完整启动/OS CPU。原7个cold longtask合计375ms、warm0只描述该观测范围，不将duration类别相加当CPU。暖是no-store reload，不是暖HTTP缓存；UI保存含自动化调度；没有把所有改善归因于单一修复。

## 源码、产物和实际原件

结束及独立终审重新物理枚举：完整选定274输入行SHA `89bdfff42618da6b1743a61e96bf4177ba34329ea716acb73c49e3ee920cc80f`、site127行SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`、68指定安装、HEAD170fd3e/branch/index/同阶段tracked diff和工具/协议全部不变。业务/runtime/build/依赖/版本未为本轮测量改动。

sampler整树算法（不是sorted-JSON行SHA）：当前127/92,557,057B/SHA `2037640ce945a052ba299a2bce19afdafd61b9ef1a77e7d687c75af983ea2e6e`，参考110/92,344,588B/SHA `a18ee3fc44654061712e4714f257efbb8767571d07b868d579a56b5d5660f812`，各before/after完整同。受控reference snapshot已由原安全清理删除；仅保存完整库存/来源，不声称事后重读已删payload或收录原sampler故意不持久化的内部reference-build日志。

真实raw：**88,033,360B/SHA256 `7a72633783011c112ee8661ab079a93f1c61c9db8a5e9554c7b5bd65f9c7dd42`**，完整收录[original-evidence.tar.gz](original-evidence.tar.gz)的`raw/PAIR.json`，不是只有summary。目录外同名原JSON留在本机，不需把88MB明文重复提交到Git；交付以此经核验归档原件为准。

[archive-plan.json](archive-plan.json)逐成员列库存，[archive-audit.json](archive-audit.json)记录新目录解压核对：**432成员/106,616,981B**，压缩**14,555,822B/SHA256 `c4fc4fdee76c9f32708fc69f9cde7487618daf64d67d7ba25020ce16bf53751e`**。raw完整round-trip字节/SHA相同；全部workspace协议/原生外层收据/预审/独立检查/终审、最终250非历史源payload、选定非OCR当前site payload、完整274/127/110/68库存均包含。24历史Android、生成OCR、安装和已清理参考大payload仅库存，不冒称收录；父级第一次独立审计stdout仅工具会话输出，machine checks JSON实际保存，不伪称另有原始stdout文件。归档审计/本页为后续包外addendum。

## 下一步与不变限制

当前all85,969≤92,160、cold46,149≤52,241，包政策及本地QA见[§57证据](../budget-policy-20261023/README.md)，旧77,227.7失败/旧200INCONCLUSIVE/拒绝原型与compiler失败不覆写。本轮只补齐新正确性产品的本地时延门禁，**精确提交CI/独立阶段完整性review尚未完成**，不自动M3 EXIT。M4/Gist、M5/OCR/PWA/移动与M6真机/生产仍需完整执行；没有真实金融源、云写、OCR识别、物理设备或部署证明。

15.0.2 / M3 IN_PROGRESS / NOT_RELEASED；本轮没有业务提交/推送/合并/升版/部署，不因为此PASS直接进入M4或发布。
