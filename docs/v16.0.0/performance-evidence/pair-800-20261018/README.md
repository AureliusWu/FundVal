# M3 当前源码800组配对：时延PASS，整体仍未退出

## 结论与身份

按[事前800组协议](../m3-pair-security-v15-800-20261018-protocol.md)一次完成，原执行session34262最终native exit0；804组原始pair全部保留，4组预热不入推断，retained800、AB/BA各400、失败0、无剔除或补跑。参考为安全依赖对齐的v15业务 `c2980265d3c89f960517ced1527ba9cb85bf7c2b`，当前业务源为 `170fd3eadc6da02750882f8a542904ee2358d0d9`。工作树有M3证据文档修改，不伪称全树clean或所有字节就是HEAD。

采样窗口 **2026-10-18 06:23:05.871→06:57:58.157 UTC**，约34分52秒。Node24.14.0、Windows、Ryzen5 3600/12逻辑CPU、16GB、本机Chrome **155.0.8059.80**、390×844；两侧用同一个browser实例，不是单OS进程。

**本轮桌面合成相对时延PASS。all包预算仍FAIL，M3仍IN PROGRESS，15.0.2，未进入M4/M5/M6或发布。** 此处不是换压缩器后的结果：Terser/esbuild/SWC均未采用，本轮没有改任何业务、构建配置、依赖、预算或版本。

## 全量800组结果（ms）

| 指标 | 参考median / p95 | 当前median / p95 | median / p95变化 | 原门禁 |
| --- | ---: | ---: | ---: | --- |
| 冷启动 | 126.35 / 154.50 | 117.10 / 143.50 | −7.321% / −7.120% | PASS |
| 暖启动 | 65.70 / 90.90 | 57.35 / 77.70 | −12.709% / −14.521% | PASS |
| 保存UI | 75.3595 / 85.8120 | 62.8659 / 71.9219 | −16.579% / −16.187% | PASS |

两次独立重算均用原 `summarizePairs`、全部800 retained、bootstrap5000/seed160003，与raw报告summary严格deepEqual；另一只读复核检查身份/产物/观测。保留原中位数ratio≤1.15、p95 ratio≤1.20、current任一样本<3000ms、双侧p95区间宽度≤20%及pass fraction≥0.95，无阈值修改。

| 指标 | median ratio 95% CI | p95 ratio 95% CI | p95区间宽度：参考 / 当前 |
| --- | --- | --- | ---: |
| cold | [0.916765,0.936356] | [0.897106,0.956868] | 4.919% / 4.390% |
| warm | [0.859729,0.881408] | [0.807814,0.931395] | 10.341% / 7.722% |
| save | [0.815989,0.851214] | [0.829908,0.850594] | 2.185% / 1.081% |

current最大值229.80/140.60/85.7481ms；三项bootstrap pass fraction均1，**不是总体通过概率100%**。旧200报告仍INCONCLUSIVE，不覆盖或混样。本轮业务源、采样日期和Chrome版本均与旧200不同，不能把置信宽度改善全部归因于增加N，也不能把速度变化归因于某个单独源码修改。

## 分解与诚实的观测边界

以下中位数来自800 retained；不能把各列中位数相加当精确总时延分解。TTFB含本地HTTP等待而非独立服务端CPU，post-HTTP项是ready减responseEnd的残差，含JS/调度/DOM等。

| 观测 | 参考 | 当前 | 解释 |
| --- | ---: | ---: | --- |
| cold导航TTFB ms | 1.60 | 1.60 | loopback，不代表公网API |
| warm导航TTFB ms | 1.40 | 1.30 | 同context no-store reload |
| cold response下载 ms | 0.40 | 0.40 | 非生产带宽测量 |
| warm response下载 ms | 0.30 | 0.30 | 非HTTP热缓存 |
| cold post-HTTP残差 ms | 119.95 | 111.10 | 不是纯主线程CPU |
| warm post-HTTP残差 ms | 60.90 | 52.20 | 同上 |
| cold部分Script counter ms | 7.346 | 7.634 | 描述性增加，不是全部CPU都下降 |
| warm部分Script counter ms | 1.8315 | 2.0230 | 描述性增加约10.46%，保留WARN观察 |

导航renderer各侧1608份均PARTIAL，保存各侧804份MEASURED；总4824份renderer/19296个counter从原before/after快照重算一致，epoch相同、无null/负值/invalid reason。它们是受检renderer的timeTicks活动差值，导航只覆盖post-commit至采集，包含采集/harness开销；不是完整bootstrap或隔离OS CPU。窗口内cold/warm longTasks记录均0，不能据此排除未覆盖时段或其他renderer的任务。LCP等未用于本次硬门禁，不伪造完整Web Vitals。

全部804组的观测：pageerror0、网络instrumentation failure0、两侧各2412次drain全部SETTLED、SW事件/控制器/注册数量0（注册尝试被工具拦截，不是没有尝试）。**console error非零**：参考7236/current10452（若只数800 retained为7200/10400），与每次9/13个hermetic block数量一致；未保存每条console文本，不能证明逐条因果或声称console零。全部request原始分类/时长/字节仍在raw报告。

## 身份、产物与清理复核

- source Before/After逐字段一致：HEAD170fd、tracked diff SHA `bd23762e7ded67453853e34acd7eec5845c156521036d2653c63be07998c1adf`、相关untracked空hash。结束后、更新本说明前再取live diff亦匹配；该实际diff存为[pre-sampling-tracked.diff.txt](pre-sampling-tracked.diff.txt)。此后新增结果文档不在采样窗口内，不把未来文档改动反写进raw。
- 依赖normalizedLock SHA `0b9db07c13394523bbee5d7b21d51cadb00f39b160794ebbda53ea8766b4aebf`相同，只按原规则忽略root.engines；全部8个已安装直接依赖与pin相同。两侧raw lock hash不同如实保留，不把归一化相等称逐字相同。
- 四份file inventory的排序/唯一性/数量/字节合计/aggregate均独立自洽，两侧完整before/after数组相同。当前实际127文件/92507677B逐项重读匹配，sampler库存hash **739c0fdcea30badfa0928a59bfe9ee2020d1687aaf132682c12ab627a7a0ffc4**；它不是排序JSON库存hash **7d4d8c1e0828f09164bf10b8ef64e8be6f06ccb8cdca61ed7dc2f031c0e68e37**，也不是critical **4bda36bc3ed361fcbf69d44d96f30af47fc1fff3b75eefd8728a341a45680948**。
- reference记录110文件/92344588B，sampler库存hash a18ee3fc44654061712e4714f257efbb8767571d07b868d579a56b5d5660f812。快照已经按原工具清理，事后只能核报告内inventory内部及前后稳定，**不能声称独立重读reference实体文件**。三个transport/test文件改动由原工具记录；不是重新确认所有已删除参考源码字节。
- 工具cleanup四项PASS；现场原2114/2121无监听，原采样器/相关server进程不再存在，只清理自有资源。没有启动第二份采样，也未操作其他项目4173。
- 本次不重建current site；它与上轮原OXC实际构建的指纹一致。结束后预算CLI实际exit1：cold42985/52241 PASS，all80494/77227.7 FAIL，至少差3267整数B；性能PASS不能覆盖该门禁。

## 归档、复现与下一步

- [原始完整JSON](../m3-pair-security-v15-800-20261018.json)：**88,029,371 B**，SHA256 **65bfd348cb04b46826b811a521e5acea03086fa2c43b924efdced83459b00d8c**。保留全部804组，不另做删减版冒充raw。
- [summary.json](summary.json)：完整统计/身份/质量计数、当前现场重读、预算及限定，不是另一份新采样。
- [run.log.txt](run.log.txt)：同一session完整CLI日志；81条里程碑严格为6,16,…,796,800，只出现一次reference build及一次PAIR PASS。日志不能证明任何未观测外部进程从未存在，但与原session及raw连续索引共同支持本轮一次执行。
- [verify-report-v2.mjs.txt](verify-report-v2.mjs.txt)：root完整重算/观测/现场库存校验工具副本，实际exit0；原采样器未改。初版临时工具误把Windows绝对路径当ESM specifier，加载阶段失败；[初版](verify-report.mjs.txt)保留，v2仅修为file URL，没有重跑采样。工具硬编码本机路径与Temp日志位置，异机复现需明确调整并报告，不能宣称未改工具复现。
- [archive-audit.json](archive-audit.json)：diff、完整日志和两版工具的原始与LF规范化SHA；raw与原采样器hash独立复核，原200文件仍为5e4199a9268ecb8761dc3f91725daba3f1b63adedd7b86ef2a9b820f940b3ddd。

## 采样结束后的完整原配方回归

按照项目规则，在上述测量及身份检查**结束后**另跑全量门禁，见[post-pair-regression.json](post-pair-regression.json)：unit1064/1061PASS/0FAIL/3Windows条件skip（7734.1823ms）、syntax205、Chrome E2E31/31（1.0m）、官方npm audit0。固定SOURCE_DATE_EPOCH1792046773，E2E前1次及结束后连续2次build均exit0；两个最终critical指纹4bda36bc、whole sampler739c0fdc/JSON7d4d8c1e均一致，app16/OCR23实核通过但未运行OCR。最终budget依旧exit1/all FAIL。自有12437测试服务已退出。

这批构建/测试不是在800采样期间并行执行，没有回写或替换raw报告。完整原始回归日志仍在Temp，机器收据只归档其hash及命令，不声称日志本体全入库；日志hash收集的一次内联语法错误没有读取或改动数据，已用独立ledger更正，不是产品测试失败或重跑采样。

本轮遵循性能回归检查：保留全部样本、置信边界及不同性能层，不只报告更快的点估计。没有业务修改、新的正式CI、真实主源摄取、Gist读写、OCR识别/真机或生产smoke；不把本机合成结果外推为这些通过。后续仍优先解决all包体积缺口，不重复800或追加1000挑结果。版本保持15.0.2，未merge main、未部署/发布。
