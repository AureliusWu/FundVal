# 全部非OCR JavaScript总量政策变更（2026-10-28）

状态：`USER_APPROVED / TOTAL_LIMIT_NOT_ENFORCED`。这不是安装包大小政策，也不是发布完成证明。

## 用户要求

在说明当前全部非OCR app chunks的gzip合计为95,223 B、原总限为92,160 B，并提供保持90 KiB或调整96 KiB的选择后，用户明确答复：**“这是安装包大小还是什么 不设上限”**。

已向用户说明：该指标是Web/PWA非OCR JavaScript文件的gzip压缩体积，不是Android APK、桌面安装包或PWA占用空间；它不含按需OCR SDK/模型/WASM资产。按这一问题的范围，取消的是**全部非OCR JavaScript合计的硬上限**，不是取消所有性能和安全验收。

## 当前规则

- 保留全部非OCR app chunks实际raw/gzip字节、文件清单、SHA及加载分组，继续测量和报告，不为通过而转移到度量图外。
- 总量policy显式为`v16-total-unbounded-by-user-20261028`，`allLimitEnabled=false`、`allVerdict=NOT_ENFORCED`；活动总限和allPass用null表示不执行，不伪造PASS、无限大数值或假装旧限已满足。
- 保留v15.0.2基线70,207 B、原77,227.7 B及前一批准的92,160 B总限作为历史字段。10月26日95,223>92,160的原生FAIL和报告保留，不重写为旧政策PASS。
- 合法实测仍要求有限正安全整数、all≥cold；坏输入、缺文件、gzip/hash不符、分组/图/绑定/来源问题继续失败。取消无用的all×10预算算术不意味着允许不安全整数。
- 冷启动gzip上限仍为**52,241 B**；超冷包必须使本地CLI、CI和candidate准入硬失败。不能通过metadata覆盖该政策。
- OXC/ES2022、原五组加载、OCR按需/不进入CORE、原相对冷暖启动与保存时延、刷新请求数、完整性和数据/兼容门禁保持。
- 候选archive防滥用大小界限是验证不可信发布输入的安全边界，不属于网页总包性能政策，不随此要求删除。

## 结果如何解释

当前同字节95,223 B可以在新政策下被记录为“总量NOT_ENFORCED”，并由冷包及其他独立检查决定相应准入。整体budget命令PASS只表示合法度量及保留的冷包门禁通过，**不表示总量变小、实测性能更快、所有测试/CI/设备/生产均通过或已发布**。

发布反馈必须分别写清总量不设硬限、cold实测、配对性能、数据、CI/生产和物理矩阵豁免情况。原90 KiB批准见[BUNDLE_BUDGET_POLICY_20261023.md](BUNDLE_BUDGET_POLICY_20261023.md)；本文件只替代该总量阈值，不修改其历史事实。
