# M3 官方净值调度修复（2026-10-18）

状态：**WIP / M3 IN PROGRESS / 15.0.2，未发布**。源检查点为 `5186c75b8c646e3a8425e00e93f52adb0f4a8f7a`；本说明记录其工作树修复，不把父提交 CI 继承给新提交。

## 发现与实际复现

P1 可用性问题：`js/runtime/refresh-execution.js:getNav` 对整个持仓同时启动正式净值回退/元数据获取；真正的 `QuoteBridgeClient.request` 只有 100 个等待任务容量，且有 60 秒队列期限。上游估值失败、大量基金同时需要正式净值时，后到基金在发出请求前被 busy 拒绝，虽然合成官方源可用，页面仍显示 `--`。

- 最初 105 只 QDII：执行真实 request/pump、仅替换 dispatch 为异步合成响应，旧源只刷新 **101/105**，4 个真实 busy；最大 1 active +100 queued。
- Chrome 原生浏览器独立使用真实构建 app/bootstrap、opaque iframe、父页/realm parser 与路由的合成 JSONP，旧产物只有 **100/105** 个净值，5 个 `--`。它不是上一个 Node 队列模型的结果外推。差一条是两个不同执行环境的观测，不拼成同一计数。
- 修复后上述 Node/Chrome 路径均 **105/105**。Chrome 明确断言净值 `1.2000` 与正式日期 `2026-09-28`，不因请求发生在 9 月 29 日就改成今日。
- 全部输入均为合成；没有真实持仓、Token、Gist 写入、真实金融源采样或物理设备验收。

## 最小修复与数据流

`refresh-execution.js` 新增独立 `runOfficial = limited(2)`；NAV fallback 与 metadata-only 两个入口都通过 `requestOfficial`，取得 slot 后才进入现有 `scope.dispatch` 的 current/cancellation/counter 边界。Bridge 的 serial pump、100 容量、60 秒排队期限、逐源 timeout、sandbox 和 schema 校验均不改。

```text
基金正式净值/元数据需求（按 code 去重）
  → 本代官方源调度（最多 2 个进入 Bridge 的请求）
  → scope.dispatch（当前代 / AbortSignal / provider counter）
  → 原 Bridge queue/pump（串行）
  → 原净值契约和缓存 envelope
  → 原 UI 提交；原最终 drain / 单次缓存 flush
```

该调度器与披露数据 `runStable` **不是同一实例**。不让卡住的披露占满官方净值 slots；不修改 TTL、来源日期、缓存身份、null/0、模型证据或 Schema 3。不增加真实源重试，也不隐式强刷 warm NAV。

它只限制抵达 Bridge 的本代官方任务数，不声称限制整个持仓的总内存或调度器内部待办数量。非协作注入 client 永不返回时，没有新增强制终止能力；真实 Bridge 的已有期限仍负责实际 transport。

## 验证

| 检查 | 结果 |
| --- | --- |
| 最终 5 项新测试对冻结旧 executor | 0 PASS /5 FAIL；绝对 import 重写，其他依赖为未改实际模块 |
| 同 5 项对当前源 | 5/5 PASS |
| executor 整文件 | 40/40 PASS |
| 最终 npm test | 1064 项 /1061 PASS /0 FAIL /3 Windows symlink 条件跳过，6476.4943 ms |
| npm run check | 205 JS 文件通过 |
| Chrome test:e2e | 31/31 PASS，原 reporter 为 1.0m |
| 官方 registry audit | 0 vulnerabilities |
| 原预算 CLI | exit1，all 超标，见下表 |

五项分别覆盖 105 个 NAV fallback、取消排队并排空、105 个 warm NAV 缺元数据、前两项失败释放 slot、披露两 slots 挂起时官方 fallback 先可见。后两项旧源也能完成其基本成功/隔离行为，最终失败点是新增的 **≤2 Bridge 需求**；不能把 5 RED 都描述为旧源丢了全部结果。

取消路径只读真实 client admission/dispatch、计时器、UI/Storage 与 coordinator diagnostics；未对不可见的 scope counters 作过度声明。metadata 路径逐份比较 105 个 warm NAV envelope 保持不变。故障路径后 5/7 成功并只 flush 一次；披露路径先显示 5 个 NAV、写入 0，释放后才最终 flush。

初次全量为 1064/1060 PASS/1 FAIL/3 skip：原 `refresh-regression.test.js` 的源码正则仅认内联 `clients.nav(holding.code)`。替换为更强的静态断言：必须有独立 2-slot helper、两处消费者都调用 helper、全文件只有该 helper 一个 NAV-client 调用点。行为测试不删、不放宽。原失败 stdout 保留于 Temp 并列出 SHA，最终全量为新窗口。

## 固定配方体积与确定性

两侧预声明各 **3 次**实际 build，Node24.14.0、固定 epoch1792046773、原 Vite8.2.2/oxc/es2022/五 groups 和 gzip 算法。另有修复后一次初始 build 供浏览器使用；不与最终三次混称。

| 指标 | 旧源三次均值/最坏 | 当前三次均值/最坏 | 差额 | 原门禁 |
| --- | ---: | ---: | ---: | --- |
| app raw | 235665 /235665 B | 235647 /235647 B | −18 B | 非独立准入项 |
| all gzip | 80477 /80477 B | 80494 /80494 B | **+17 B** | 77227.7 B，FAIL |
| cold gzip | 42992 /42992 B | 42985 /42985 B | −7 B | 52241 B，PASS |
| whole site | 92507487 B /127 files | 92507677 B /127 files | +190 B | 非 app gzip 指标 |

这是**刷新可靠性修复，不是减包收益**；当前至少还需减少 **3267 B**。脚本实算全部 chunk bytes/SHA/gzip，build 同时检查原依赖图/阶段隔离；budget report 的 `importClosureVerified:false` 不冒充图证明。

最终三次 critical 指纹均 `4bda36bc3ed361fcbf69d44d96f30af47fc1fff3b75eefd8728a341a45680948`；whole-site 均 `7d4d8c1e0828f09164bf10b8ef64e8be6f06ccb8cdca61ed7dc2f031c0e68e37`。whole 算法是 localeCompare 路径排序的 `[{path,bytes,sha256}]` JSON SHA256；73 个 js 文件前后库存是另一范围，不混作全仓指纹。OCR 23 assets /88196906 B 实算核验，未执行 OCR。

原 E2E 的三组 readiness/save 描述样本保留于 summary。它们只是既有绝对 smoke，不是新 relative/p95 对照；旧 200-pair 总体 **INCONCLUSIVE** 不重跑挑 PASS，不因此退出 M3。

## 减包筛查的边界

并行只读审查本轮 Bridge/transport、UI、模型选源没有找到可删的第二套较大生产实现。进一步固定于 5186 的结构扫描覆盖 62 个非 OCR JS 文件、1234 个函数（833 个 ≥100 raw B），精确 25 组、保守 alpha26 组、0 parse error、分析器 12 项自检。较大组主要是公共 coordinator 与生产闭合版本的刻意镜像，前者不入包；sandbox 跨 realm 函数不计当前 chunk 门禁。新增实际重复只剩 record/clock 小 helper，没有实测 gzip 节省，不据此承诺可解决缺口。该扫描是结构筛查、不是完整语义或全程序不可能性证明；原报告/工具仅 Temp，未冒称已全部归档。

## 原件与局限

`summary.json` 记录源 LF/raw SHA、每轮 app/OCR/critical/whole 指纹、测试计数、原始日志 SHA 与 Temp 位置。本目录保存：最终旧/新 5 项 TAP、40 项 TAP、Chrome RED/GREEN、完整新 E2E、check/audit/budget 输出和测量脚本副本。文本经过 CRLF→LF，PowerShell 显示追加的末尾换行显式保留；不可把归档 raw SHA 当原文件 raw SHA。完整 1064 项两窗口 stdout、全 source/site inventory 与旧 alias 模块/测试副本在 summary 所列 Temp，不声称全部原件已永久保存。

旧 alias 仅把原 executor 的10个相对 import、最终测试的7个相对 import 改为绝对 URL/旧模块入口，业务函数正文不改。第一次构造 alias 的工具在调用不存在的 orchestrator URL 全局时提前失败，未创建文件/运行测试；随后以纯路径解析完成，不把工具错误当业务 RED。

数据可信结论仅为 **CONDITIONALLY TRUSTED（所测合成调度与日期/缓存契约）**。真实主源摄取/独立 NAV 对账、物理设备、真实双端云、生产均未验证；不再次校时。尚无本次提交的精确 CI/CodeQL 证据，父 5186 的 CI 不覆盖新源码；不 merge main / deploy / bump。后续必须继续处理 all-gzip 与时延门禁，再进入 M4。

原始 TAP/Playwright 文本的空白缩进及显示追加末尾换行保留，staged whitespace 检查会对这些 `.txt` 证据告警；不新增 Git 例外，也不声称全体 whitespace PASS。业务、测试与撰写的 MD/JSON 应独立通过检查。
