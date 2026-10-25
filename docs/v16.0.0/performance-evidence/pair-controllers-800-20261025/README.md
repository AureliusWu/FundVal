# Controller与补名收敛后的固定800配对性能

状态：2026-10-25 / **LOCAL_PAIRED_PERFORMANCE_PASS / M3_IN_PROGRESS / NOT_RELEASED**。这是最终281源dirty候选的一次本地合成桌面测量，不是不可变提交CI、M3 EXIT或v16发布。版本仍15.0.2，HEAD `170fd3eadc6da02750882f8a542904ee2358d0d9`。原[PROTOCOL.md](PROTOCOL.md)保留预声明原字节，不事后改写其NOT_RUN时点。

## 原生执行与身份

- 唯一测量窗口：`2026-10-25T06:27:33.374Z` → `07:03:05.051Z`；native0，signal/error null，stderr0，最终PASS；postflightError null。
- 完整804组：4个预定warmup全部保留，800 retained，AB400/BA400；0 failed/incomplete/replacement，无重试、剔除离群或补样。bootstrap5000/seed160003/timeout30000及原阈值不变。
- 原始报告88,027,817B，SHA256 `c0586a69852c8415090f46384ca1e1483ad41371adae4af3306bff85fdf1b4e7`。它在包内仅存一次：`parent/PAIR.json`；不另外提交88MB根目录副本。
- 参考精确为安全对齐的v15 `057042963a33579c624a41404a6d533dfda29768`，parent `c2980265d3c89f960517ced1527ba9cb85bf7c2b`，tree `40098290fb64d31e0c8fcc12e552b3a913b5c715`，epoch1791676800。严格normalizedLock SHA `db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc`，仅省略root.engines。**参考不是提取前的§58候选，不能把本次时延差因果归给controller提取或某一项修复。**
- 原sampler/collector完全不改；hash、完整参数、实际环境、源码/产物/安装及Git前后状态见`parent/FROZEN.json`、`LAUNCH.json`和原生收据。

最终完整源281行SHA `8b93b2e2476757a381e3788f3f82428b54cfa26fae7fe6f3339a0896f8a71653`；完整site129行SHA `94bd2839eb13c06ae0000c98264587936d494eea3e3562786864f812bf5bf5ce`。sampler当前整树path-NUL fingerprint `bc9173dc63b1b2f8f3f1ca0e810799b1483559b8a8796fd6367c4759929c74a7`（129文件/92,564,199B），参考 `a18ee3fc44654061712e4714f257efbb8767571d07b868d579a56b5d5660f812`（110文件/92,344,588B）；两种hash算法不可混用。全部前后保持一致。

## 结果（全部800 retained，单位ms）

| 指标 | v15 median / p95 / max | 当前 median / p95 / max | median / p95变化 | 判定 |
| --- | --- | --- | --- | --- |
| 冷启动ready | 128.20 / 161.60 / 237.70 | 119.80 / 154.90 / 327.80 | −6.552% / −4.146% | PASS |
| 暖启动ready | 67.75 / 92.20 / 143.60 | 60.20 / 80.20 / 129.50 | −11.144% / −13.015% | PASS |
| 实际UI保存 | 79.10315 / 85.4128 / 180.9507 | 66.06475 / 72.4896 / 96.6810 | −16.483% / −15.130% | PASS |

当前冷启动最大值**327.8ms劣于参考237.7ms**，原样保留且仍低于3000ms。不能声称每个样本都快；中位数/p95通过也不是生产体验保证。p95为nearest rank；偶数中位数为中间两项平均，不用最大值代替p95。

| 指标 | median ratio 95%区间 | p95 ratio 95%区间 | p95区间相对宽度（参考/当前） | bootstrap通过比例 |
| --- | --- | --- | --- | --- |
| 冷启动 | 0.92818–0.94163 | 0.92681–0.98858 | 5.446% / 4.325% | 1 |
| 暖启动 | 0.87656–0.89911 | 0.85423–0.93222 | 3.905% / 7.606% | 1 |
| 保存 | 0.83043–0.84069 | 0.83647–0.86150 | 2.596% / 1.814% | 1 |

原median≤1.15、p95≤1.20、95%上界达限、双侧p95区间宽≤0.20、通过比例≥0.95及当前关键单样本<3000ms均符合；未改变sampler对保存的额外p95检查。比例1是bootstrap重采样中达标的比例，不是总体通过概率。

本轮包预算与时延独立：QA V3实际all86,850/92,160B、cold47,014/52,241B。只有全部非OCR总包上限获用户批准修改为90KiB；冷启动、数据、兼容、时延及后续门禁没有放宽。

## 两层复核及观测边界

1. 预冻结`independent-audit.mjs`单次实际native0/stderr0，**12,883检查/0失败**；独立执行未改的原`summarizePairs`和`rendererDelta`，整个summary对象和每个renderer对象一致。此处复用原helper，**不是第二套独立实现bootstrap算法**；精确调用见包内源码。
2. 另一个只读终审实际native0/stderr0，**7,253检查/0失败**；直接`rawPairs.slice(4)`，独立排序/median/nearest-rank p95/maximum/ratio与原报告完全同；检查全部4,824 renderer对象和19,296直接duration counter差值。它核对报告所列区间算术/上界，但没有独立实现或重跑bootstrap。报告、实际脚本、RESULT、原生输出与收据都在`terminal-review/`。

实际环境Windows x64、Node24.14.0、桌面Chrome155.0.8059.86、390×844、一个浏览器；固定合成时钟/持仓/provider fixture。cold为独立context，warm为同context的no-store reload，不是暖HTTP缓存。保存是实际UI100份/成本1.2的合成操作。

- 1608 sides，4824 drains全部SETTLED，pageerror0、network instrumentation failures0；SW event/script/controller/registration0，Gist写请求0。
- 80,400请求：59,496 loopback静态、3216 synthetic intercept、17,688 blocked external/proxy；没有真实provider延迟。
- console errors **17,688**保留，与blocked总数相同不证明逐条因果，更不是console-zero验收。
- cold/warm各1608 renderer为PARTIAL、save1608为MEASURED；navigation仅post-commit到collection窗口，不是完整startup/隔离OS CPU。重叠CDP counter不能简单相加；harness/自动化调度开销仍在。
- 记录cold long task共3项/161ms，warm0；不是独立OS CPU分解。
- 原4项owned cleanup均PASS。终审在`07:06:25.4059025Z`实际点观测sampler PID30520 absent、raw所记owned端口9232/9235无监听；原命令/收据在`terminal-review/owned-os.*`。仅证明该时点owned资源，不保证所有后台负载。
- 原工具已清理受管reference快照；只保留其完整库存/hash，不声称重读已删除payload或保存工具从未持久化的内部reference build日志。

## 归档交付

| 项目 | 实际身份 |
| --- | --- |
| `original-evidence.tar.gz` | 14,955,988B |
| 压缩包SHA256 | `38bfa2efa4ac7bde5cc82654dfe4ac13a270d0e6b82024bec99eee0aba1c72d7` |
| 成员 / 解压字节 | 509 / 108,670,719B |
| sorted-JSON行SHA | `431b27656d0069c5029a1248d6fcee3d0920ce285c42fe18eda3adfbeebe1c12` |
| 创建/新解压/外层归档执行 | 均native0、stderr0；全部成员路径/bytes/SHA相同，raw完整round-trip且仅一份 |

`archive-plan.json`列每一成员和完整源/site/reference/安装库存；`archive-audit.json`记实际结果；`archive-tool.mjs.txt`为实际工具源码；`archive-native/`是before/after Git及tar原生回执。plan/audit/README和归档后外层回执为包外addendum，不倒称原包成员。归档过程中281源、129site、选定68安装、PROTOCOL、HEAD/branch/index/同阶段tracked diff和3个原工作区均不变。

| 包内前缀 | 内容 |
| --- | --- |
| `parent/` | 全部原测量raw、启动/前后冻结、PID/native日志/退出、原helper复算及收据；raw只在此一次 |
| `preflight-review/` | 原预审draft/final检查、脚本、原生收据及诊断addendum；保留早期查询/转义问题，诊断问题不混称测量失败 |
| `terminal-review/` | 完整只读终审10文件，包括独立基础统计与owned OS点检查 |
| `final-source/` | 最终257非历史源payload；24份`.codex-tmp/`历史Android仅完整库存 |
| `selected-current-site/` | 105非`assets/ocr/`构建文件；24个生成OCR目录文件仅完整库存 |
| `frozen-inputs/`、`protocol/`、`tools/` | 完整QA_SOURCE_V3、原预声明、原common helper；原sampler/collector在最终source中 |
| `linked-controller-QA/` | 控制器QA归档README/audit；原10MB包只绑定，不重复收录 |

对应完整本地QA/真实失败在[控制器归档](../controller-extraction-20261025/README.md)：压缩10,284,125B，SHA `63ef139c550aa71f2d9e755ba77deb01e0b9351bfe6463a8d6add70e7caaa971`；该包已含实际QA V1/V2/V3原件，1412total/1409PASS/3既有Windows skip、syntax223、Chrome35/35、两次129构建同及audit0。新性能包引用精确hash，不通过重复打包改变这份旧证据。

未打包node_modules、重型OCR生成payload和已清理reference payload，但完整库存保留。选定499份文本做高置信Token/private-key形状筛查，仅允许完全相同文件和字符串hash的两处既有合成脱敏测试；未知文本命中0。它不是完整秘密/二进制安全认证，也没有新读取用户Storage或截图。

## 下一步与禁止扩大结论

这是依据performance-regression-check区分样本、门禁与局限的本地结果；没有隔离“提取前/后”因果实验，不能编造收益原因或据此做无依据微优化。工程上接下来应：绑定精确不可变业务提交及完整CI；下载核对该候选产物；再顺序完成M4同步、M5 OCR/PWA/移动端、M6真机/生产/回滚。

本轮没有提交、推送、合并、升版或部署；没有真实金融源对账、真实Gist双端、OCR长图识别、物理设备或PWA版本迁移/生产验收。总包PASS与本地时延PASS不能替代上述门禁，**M3仍IN_PROGRESS / 15.0.2 / NOT_RELEASED**。
