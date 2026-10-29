# Root安全审计闭合与当前减包切面只读复核

2026-10-22；FundVal15.0.2，HEAD170fd3e、既有dirty工作树保留。上一目标回合完成了安全补丁、完整QA和归档，属于实际进展；本轮不是重述旧状态。

## 新的根目录安全证据

先写独立PROTOCOL，限定此次仅一次完整官方`npm audit --json --registry=https://registry.npmjs.org --fetch-timeout=20000 --fetch-retries=0`，不安装、不换registry、不重试挑0，parent hard timeout45s。2026-10-22 03:20:06.210→03:20:07.814 UTC，**唯一调用nativeexit0，vulnerabilities{}、全部severity及total0，包含dev71，原六GHSA absent**。原始stdout/stderr完整、stderr空；独立审查未发现本次新收据cookie/auth输出，可原字节归档。此前root503/timeout留在[上一窗口](../vite824-security-20261022/README.md)，没有删除或改写为成功。

请求前后逐文件复核270复制范围输入（214510943B，SHA`a93ec47713269596123a672c43af9e8740b47bcf8ec19c7f700249cb0bdb3a16`）和127输出（92537133B，SHA`5b946d23a08cd42743e5151b3ba5bb62ec52b7b6016dcd83eafaac42817124a9`），与上一B冻结/root第3轮全部行相同。该270范围仍包含24个历史dot目录文件，不是230所选输入，也不是全部必需构建输入。

另核68份安装manifest/hidden lock/native/launcher库存42709269B，SHA`2da11b473eaff8bcaa1fef492e4b595629145b97f8c7f2ea18f4e7fb5b074e1c`与前轮独立审查相同，20份历史收据SHA全部不变。Vite8.2.4本地补丁资格的最后root audit缺口现可闭合；这只是时间特定的已知依赖告警结果，不是绝对安全/线上不可利用或发布证明。

上一轮1224/1221PASS/3既有skip、syntax212、Chrome33/33和九轮全产物同一仍是同输入/输出身份的历史行为证据，**本轮没有重跑这些测试/build/E2E**。`final-status.json`是新闭合结论；上一`qa-summary.json`的rootQualificationComplete=false为历史真实状态，不覆写。当前新预算CLI仍nativeexit1：all84187>77227.7，cold44699<=52241，至少差6960整数B。

## 三路新的有界只读审查

- 实际跨组：实读16份真实chunk，1137函数节点去位置精确AST/保留属性名的粗identifier形状定位，跨chunk≥80raw B仅三份100B clock，已由第40节排除；418个≥200raw block跨组匹配0，8项≥80raw完整纯常量跨组0。两协调器源码不是两份实际引擎，公开额外路径已tree-shake。没有新可兑现大重复。此为有限定位，不是语义等价或全程序不可能证明；独立报告原始临时AST程序/JSON没有单独保存，只有完整方法和结果报告，不冒称可重跑完整扫描原件。
- 新诊断：三槽(value,report-rank)共享cell是具体结构机会，但直接重复只有约20行，仍须保留严格own-data/null/深复制冻结、独立生命周期/报告rank、同步onError重入、started-only null/晚drain等契约；没有约1KBgzip可信材料性池，未生成变体。历史诊断功能成本3693B不是可回收重复。
- storage/Gist：单份normalizer多次调用不等于多份算法；migration与旧标签页编辑在getter、null/0、notes/tombstone及异常轨迹不同；Gist第二遍backup枚举跨过校验边界，不能前移；部分公开旧API不在产物。另一个可疑native Map bookkeeping仅888raw live函数的子集，不能冒称材料性gzip收益。报告列出已有测试和getter/sentinel/时序覆盖缺口，未实施。

三路均未改产品、配方、依赖、测试、版本、五组或预算，未build/test/install/压缩/时延。没有新的减包候选被采纳，不把粗AST/raw池/整组体积换算为gzip收益。这不是证明其他大闭合重构不存在；完整限定与位置见归档各报告。审查中沿用第45节root UNKNOWN的文字是其先读的旧窗口状态，不覆盖本次独立audit0。

## 门禁与后续

Vite8.2.4本地安全资格已闭合，但**M3仍IN_PROGRESS，all预算FAIL，当前源码尚无新相对时延/精确CI**。原ES2022/五组/启动/隔离/校验/兼容和77,227.7预算不放宽；旧800配对不继承。后续新时延测量须同依赖、安全对齐参考、固定协议和完整保留，不能覆盖总包FAIL。无真实源/真机/OCR引擎/Gist写入/生产或发布新资格，未提交业务/推送/合并/部署/升版。

`original-evidence.tar.gz`保留本次协议、audit原始收据、前后身份、68安装库存、原预算失败和四个独立审查队列原件；新Temp解压逐项bytes/SHA复核见`archive-audit.json`。不重复保存上轮源码与九轮payload，均有原SHA/引用；无须重跑旧800或全套测试来生成本报告。
