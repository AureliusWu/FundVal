# M3 9.1剩余职责拆分

状态：2026-10-25 / IMPLEMENTED_LOCAL_QA_AND_PAIRED_PERFORMANCE_PASS / M3_IN_PROGRESS / NOT_RELEASED。这是原UPGRADE_PLAN 9.1/M3的剩余实施，不是修改计划范围或开始M4/M5最终功能。最终候选的新800+4已独立通过（M3_STATUS §61），精确提交CI和候选核验仍待完成；不是继承迁移前§58结果。

## 为什么必须继续

§57新包政策和§58新800+4本地时延虽通过，但完整阶段审阅确认：`sync-status.js`和`pwa-update-controller.js`还不存在，App仍拥有相应状态/计时器、云同步UI编排和整段SW guard/channel/listener。M4/M5负责这些领域的后续最终功能，不构成M3拆分本身的自动豁免。不能只根据退出摘要的性能PASS把整个工作包勾选。

独立审阅原件：`M3_EXIT_REVIEW.md`，15,242B/SHA256 `8d2b426b9de042aba23c5c87b6960e125eee40535af9fc400e011aeb86effa09`。其范围逐条覆盖真实Refresh Plan、TTL、批量、唯一flush、代际gate、计数、9.1/9.2；未发现新的刷新主链缺陷，确认上述职责边界和精确提交CI仍缺。它没有运行新测试或替代原始时延重算。

## 固定迁移前基线

- 15.0.2 / HEAD170fd3e dirty candidate，不是不可变业务提交。
- 完整选定274源行SHA89bdfff42618da6b1743a61e96bf4177ba34329ea716acb73c49e3ee920cc80f；原App97,389B/SHA17826050a92d14d4ff7327c275e6c04a60632b6e01d9d046f05c4554e9f84359。
- site127行SHA0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31；16chunks/raw252331/all85969/cold46149。
- §57完整1320PASS/3Windows skip、syntax216、Chrome35/35、四次全产物同；§58唯一800+4/native0/双路整对象重算。这些只属于迁移前基线，**不能继承为新runtime提取后的QA/时延通过**。

## 实施边界

1. `runtime/sync-status.js`真实拥有既有busy/pending/timer与同步UI编排；按原顺序调用App注入的仓储/adapter/render边界。云客户端继续动态加载。App保留必要的私有完整持仓fingerprint/meta写入适配，不把原Schema3规则复制进新模块。
2. `runtime/pwa-update-controller.js`真实拥有既有SW状态、banner、prepare/blocked跨页握手、身份校验、drain前后dirty检查、activation/controllerchange及重载控制。构造无listener副作用；在原注册位置start。App注入编辑/同步/保存状态及refresh控制，动态读取busy/applying，不能用快照或第二份flag。
3. 父级统一App与原五组build membership接线，并只把两新同源依赖加入源码SW CORE，生产标记段仍由原builder按实际chunks生成；不改缓存版本/生命周期。两实施者只改自己模块/测试并提供接线建议。保留`update-compat.js`原字节/入口顺序；新ESM不新增global受保护函数暴露。
4. 不新增M4档案选择/退避/token政策或M5 manifest/OCR/移动功能；不真实读写Gist，不改金融/null/日期/evidence/Schema3/device/tombstone/legacy，不升版/依赖/发布。

## 证明顺序

迁移前先保存旧App字节/hash，锁定旧行为oracle/characterization和原生先红证据。移动后用真实新factory/模块及必要App接线验证；保留原有状态、异常、微任务、重入、dirty、同步中更新禁止、跨页身份和peer不强制reload断言。允许把源码断言定位到新职责文件，不允许删除安全断言、把新wrapper互比当旧行为对照或添加生产测试后门。

完成App集成后重新完整test/check/build/Chrome E2E、确定性全产物/实际gzip/图与资源核验；审阅所有M3要求。任何新runtime字节都需另立最终候选性能证据，不复用§58旧样本，不扫N/seed或放宽门禁。总包92160/cold52241、ES2022/OXC/五加载组/完整性顺序不变。

## 实际完成与最终候选（2026-10-25）

- `js/runtime/sync-status.js`实际接管既有4类busy/pending/timer状态和10个编排方法；App薄委托保留动态客户端、完整持仓fingerprint及meta写入。41项表征测试用迁移前App方法体作为旧行为oracle，不是两个新wrapper互比。
- `js/runtime/pwa-update-controller.js`实际接管6类SW状态、banner、prepare/blocked握手、身份认证、drain及激活/重载流程；构造无listener副作用，原位置start。旧18个安全测试主体保留，另有旧/新factory场景对照；`update-compat.js`和独立入口顺序不变。
- 新App接线、build membership、源码SW CORE和4个真实双controller生命周期用例验证动态互读，确保同步中不更新、更新drain中不开始同步、dirty改变可恢复、精确ACK仅重载一次。仍为原五组/ES2022/OXC，不新增云写入或M4/M5功能。

完整范围复核另外发现实际自动补名竞态：延迟的持仓事务在刷新flush以后清掉新cache，下一次暖刷新重复获取NAV/披露；取消后的旧事务结果还可能覆盖新页面状态。新增测试原5项真实RED后，修复为每代跟踪补名Promise，资源/元数据完成后等待其settle，再经原current gate唯一flush；仓储事务失效规则不改，页面补名reconcile仅使用`persistCache:false`。保存前/后检查signal，旧saved/conflict/failure结果不再安装到新App。第6项实际`runRefresh`接线测试为修复后增加，不冒称6项先红。针对性71/71通过。

限制：既有Web Lock排队本身没有改成可中止；取消后不写入/安装旧结果，但drain可能仍等待外部锁释放。测试明确释放了合成锁，不证明无限锁持有者下的退出时限。

最终冻结`QA_SOURCE_V3.json`完整281源行SHA256 `8b93b2e2476757a381e3788f3f82428b54cfa26fae7fe6f3339a0896f8a71653`；App SHA `d40895881eb10188a8346dfb461918654d25c10cf2e19be9bbcc5516b04d0f3a`，executor SHA `e0dee7d21e503c6142aa0acf1f5f81b9c17fe7c1df2d8d3ed7067b410ecb574f`。QA V3实际结果：

| 门禁 | 实际结果 |
| --- | --- |
| 全量单测 | 1412 total / 1409 PASS / 0 FAIL / 3既有Windows skip；native0 |
| 语法 | 223 JavaScript文件；native0 |
| 桌面Chrome E2E | 35/35；native0；stderr352B颜色环境告警保留 |
| 确定性构建 | 同epoch1792046773的两次完整129行逐项byte/SHA相同；行SHA `94bd2839eb13c06ae0000c98264587936d494eea3e3562786864f812bf5bf5ce` |
| 资源与图 | 16 chunks/raw254560B；23 OCR资产88196906B；literal closure/static bindings通过，不将静态图称为运行时完整证明 |
| 体积 | all86850/92160B；cold47014/52241B，独立CLI native0/PASS；相对§57为+881/+865B |
| 官方registry审计 | npm audit native0 / found 0 vulnerabilities；仅当前本地依赖状态 |

## 真实失败与范围

首次集成全量测试的两条旧源码定位断言失败后，改为检查实际controller并保留App委托断言。QA V1为1403 PASS/3 skip，E2E34/35：105持仓用例在真实请求/渲染完成前用`allTextContents()`瞬时读取到全部`--`。保留trace和截图，仅改该用例为相同105值的可重试`toHaveText`及一次cache写入的完成等待；没有放宽8秒默认超时、改数值/日期/请求断言、增加sleep或retry。V1失败不改判PASS。

QA V2新增补名修复后单测1407 PASS/2 FAIL/3 skip；失败为原结构断言仍要求旧3参数发布和无options的reconcile。仅按真实显式参数迁移两条断言，另保留新的settlement接线检查，形成独立V3。原生失败、旧source inventory、wrapper读取错误字段导致的外层exit1与真实child0均保留，不混淆业务RED和测试工具错误。

证据见[完整归档](performance-evidence/controller-extraction-20261025/README.md)：844成员/21,026,354B，压缩10,284,125B/SHA256 `63ef139c550aa71f2d9e755ba77deb01e0b9351bfe6463a8d6add70e7caaa971`；全新解压逐路径bytes/SHA同，257个非历史源payload、105个非OCR目录构建payload及全部库存保留。24份历史Android和生成OCR/安装大payload仅库存。归档前两次工具失败（目录计数、既有合成Token测试夹具筛查）保留，不记为业务RED；原始PWA worker部分独立native收据从未落盘，未补造。

新的[固定800+4配对协议](performance-evidence/pair-controllers-800-20261025/PROTOCOL.md)独立冻结，未以§58旧样本替代；[实际新结果及原件](performance-evidence/pair-controllers-800-20261025/README.md)为800+4/native0、原helper整对象12883检查和另一独立基础统计7253检查全通过，完整raw及归档保留。参考是v15，不是提取前候选，不能把全部时延差归因于此拆分。这里只证明本地合成QA、有限性能与代码范围；未证明真实金融源/Gist写读、OCR真机、PWA版本迁移、生产部署。版本仍15.0.2，精确不可变提交CI及M4–M6仍须完成，M3尚未EXIT。
