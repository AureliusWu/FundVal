# M3 同文档计数器配对测量：预声明

状态：PREDECLARED，测量前保存；不是性能通过证据。

## 目的和独立阻断

旧 60 / 200 报告不能提供可信 warm renderer delta；新采样器已通过 current-only 兼容性预检。本轮只运行一次完整 reference/current 同协议配对，补齐 warm/cold/save 的原始同文档计数器及独立相对时延证据。不是追加旧样本直到绿，不改变旧 INCONCLUSIVE。

业务检查点：`3a19c4056024a7635cb48b4acb4f1353cac1baba`。采样器协议 `paired-readiness-v2-same-document-counters`，脚本 LF SHA256 `2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7`。本预声明及其他证据文档可另提交；raw report 必须记录实际 source identity / build epoch，不把业务检查点冒充运行时 HEAD。

实际 app 16 chunks / 243,481 raw B、cold 43,845 gzip B、all 82,481 gzip B；独立 all budget 77,227.7 B 仍 FAIL。即使本轮相对时延 PASS，也不能使 M3 EXIT、开始 M4/M5/M6、merge、deploy 或 bump。

## 运行参数（测量后不得改变）

```powershell
node scripts/measure-performance-pair.mjs --pairs 200 --warmup-pairs 4 --bootstrap 5000 --seed 160003 --reference 40e68edab9cb3fba0b17338dc3672a82d13ad17e --timeout-ms 30000 --output docs/v16.0.0/performance-evidence/m3-pair-v2-200.json
exit $LASTEXITCODE
```

- 200 retained、4 warm-up；交错 AB/BA，各 100 retained；全部原始样本保留。
- 旧版固定 immutable SHA；两侧同机、同 installed Chrome、390×844、相同合成 fixture 与固定时钟。两侧均使用 v2 协议，不借用旧报告 counter 或 readiness 样本。
- 管理式隔离旧源码/build/server 与自有 current server；不使用其他项目端口 4173。current site 先构建，测量期间不重建/修改，不并发测试、虚拟构建或额外浏览器。不得关闭用户应用来改善结果。
- SW registration blocked / CDP bypass、HTTP cache disabled / no-store。无真实持仓/Gist/图片/OCR；所有第三方与 Gist 请求阻断，阻断 console error 计数保留，不声称 console 零。
- 独占 reservation，不覆写任何既有证据；失败 pair 不重试，不剔除 outlier，不更换种子或参数，不与历史两份报告混样。

## 判定和归因

维持已提交工具的固定统计政策：nearest-rank p95、5,000 次按完整配对/ABBA 分层 bootstrap、seed 160003、95% CI、中位数 ratio ≤1.15、p95 ratio ≤1.20、既定 p95 CI width ≤0.20、绝对交互窗口 3,000 ms。保存 p95 是工具额外观察，非原方案新增的硬预算；报告两者，不改工具结论以追求绿。

原始值/CI 不删改。缺失、重置、跨 epoch、baseline 晚于 ready 的 counters 保持 null 和 bounded reason，不变成 0；按 side/phase 列出 MEASURED / PARTIAL / UNAVAILABLE 数量。cold/warm 是 post-commit 至 collection 的 PARTIAL timeTicks 活动，不是完整启动 CPU / 准确 ready 瞬间 / 隔离 OS CPU。新增 RPC 有观察开销，仅在本轮同协议两侧比较，不将历史差异归因为业务收益。

必须核对 200/200 complete、health、instrumentation、前后 source/full artifact identity、自有浏览器/server/temp cleanup。异常 pageerror、未知关键请求失败、资源不完整或源码/产物变化使证据不足；不得忽略。统计不稳定时明确 INCONCLUSIVE，不能再追加样本直到稳定。运行命令 exit 0/1/2 分别保留 PASS/FAIL/INCONCLUSIVE；不因 exit 2 改称业务失败或采样成功。

## 交付

不可覆写 `m3-pair-v2-200.json` 原始 report；记录 LF hash、实际 source HEAD、开始/结束 UTC、完整性/清理与分解限制，更新索引及 M3_STATUS。没有生产公网、物理手机、旧安装 PWA 或实际 Gist 写入验收。
