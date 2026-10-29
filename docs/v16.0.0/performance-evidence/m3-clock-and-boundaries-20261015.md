# M3：一次校时失败、固定五次主源检查与较大职责审查

状态：`M3_IN_PROGRESS_NOT_RELEASED`。本轮基于 `f926ee5c11d13c68802dfda3fd4ec3cfd5e50a96`，仅新增/更新证据文档；没有修改业务代码、配置、依赖、版本、预算、系统时间服务设置或第三方服务。所有时间均注明本机观察限制。

## 一次获授权的系统校时尝试

只读 `w32tm /query /status` 显示：Leap Indicator 3（未同步）、Stratum 0、最近成功同步未指定、源为 Local CMOS Clock。W32Time 服务为 Running / Manual。这不是已与外部时钟成功同步的状态。

独立只读命令 `w32tm /stripchart /computer:time.windows.com /dataonly /samples:3`，服务器 `52.231.114.183:123`，本机北京时间 2026-10-15：

| 本机采样时间 | NTP 相对本机偏移 |
| --- | ---: |
| 16:30:29 | +3.7485092 s |
| 16:30:31 | +3.7455816 s |
| 16:30:33 | +3.7487945 s |

该批普通 UDP NTP 观察支持本机约慢 3.75 秒；它不是认证 NTS 或绝对时间证明，也不能倒推此前未保存 payload 的所有失败原因。

用户明确授权“允许仅同步一次”。实际只执行 **1 次** `w32tm /resync`，结果 **Access Denied，0x80070005，exit -2147024891**。未完成系统校时，没有再次尝试、修改 peers/注册表/服务配置或发起 UAC 提权。完整项目文件访问能力不等于 Windows 修改系统时钟的管理员权限。

随后仅作只读状态/偏移复核，仍未同步：16:31:43 为 +3.7511626 s，16:31:45 为 +3.7512812 s；第三个样本 16:31:47 为 **0x800705B4 超时**，失败保留，没有补采替换。上述控制台结果为本轮实际观察的摘录，不声称另存了完整原始 w32tm 日志。

需要外部处理：用户在**管理员 PowerShell**执行 `w32tm /resync`，或由 Windows 时间设置完成同步；再只读确认同步源/状态与独立偏移。当前授权的一次代理尝试已经使用，后续 AI 不得据此自动重复校时。不要用改项目 `now`、放宽未来时间校验、改预算来绕过。

## 校时失败后的固定五次真实客户端检查

精确记录：[JSON](m3-clock-client-five-20261015.json)；采样前创建的精确脚本：[mjs.txt](m3-clock-client-five-20261015.mjs.txt)。两份均已与 Temp 原件做 byte-for-byte 比较一致，不是重写后的汇总替代品。

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| JSON | 6274 | `009d9377473a32ed35b4e3d2ad7eb9aeed7c88580bfcc8c67396ccc55ed8b443` |
| 脚本 | 5100 | `5fc037c9f32f462a039ba56db90e3ba6866055bfa3939eb91869eea7e4f7bf96` |

协议：真实 `fetchEstimateRows(['005844','012920'], { force:true })`；缺省时钟/10s 超时。root 实际使用 `node --use-env-proxy <Temp>/client-five.mjs` 启动；JSON 的 `envProxy:true` 与校时背景是脚本声明，不是脚本自行探测 Windows 权限或代理环境的结果。事前固定 5 次，无自适应重试，不替换先前失败。native `response.json` 仅旁观公开顶层 metadata 并返回原 payload，有轻微观测开销；没有改 Date、响应、来源或校验。记录列出的 5 个源码 hash 前后相同并匹配 f926；不是整个依赖图的完整性证明。

报告窗口的本机 UTC 为 08:33:55.178Z～08:33:59.806Z；样本 1 从 08:33:55.197Z 开始。5 次均 HTTP 200，缺 `schema_version` 按解析器为 v1，`source=eastmoney_official_nav` / `status=degraded`，各 2 个条目。其共同 `fetched_at=2026-10-15T08:34:02.956Z`。

| 次数 | fetched_at 减捕获时钟 (ms) | HTTP Date 减捕获时钟 (ms) | 完整客户端耗时 (ms) | 客户端结果 |
| --- | ---: | ---: | ---: | --- |
| 1 | 3689 | 2733 | 4070.7715 | WORKER_METADATA_INVALID |
| 2 | 3513 | 3557 | 174.6183 | WORKER_METADATA_INVALID |
| 3 | 3387 | 3431 | 126.0500 | WORKER_METADATA_INVALID |
| 4 | 3270 | 3314 | 117.5413 | WORKER_METADATA_INVALID |
| 5 | 3151 | 3195 | 118.8059 | WORKER_METADATA_INVALID |

本批 v1 控制流可定位到 `js/runtime/worker-contract.js:179-180` 的未来 fetched_at 拒绝。独立 NTP 支持未同步本机时钟是当前拒绝的重要贡献因素，但不能排除 Worker 自身偏移或宣称所有历史错误同因。**0 次接受、0 行通过完整客户端；不是可信数据验收 PASS**。未执行独立净值对账、生产 UI、真实账户/Gist 或物理设备验收；不把 HTTP 200 / 空结果集 every 当成功，也不把首个较慢请求删去。

## 三个新的有界较大职责审查

完整人工报告均已归档，以下不是全程序不可优化证明。没有生成新源码变体、运行新虚拟/实际构建或声称 gzip 收益。

- [渲染职责](m3-render-boundary-review-20261015.md)：实际 18 个相关函数/5 个 HTML sink；最大的 renderer 是不同功能的并集，不是两份重复实现。精确重复仅小 wrapper；移动 HTML 到 data/index 逃预算不合格。原报告的“前后 clean”只属于代理审查窗口，不适用于 root 后续文档新增。
- [启动恢复职责](m3-startup-boundary-review-20261015.md)：多处 recovery 调用共用一个算法；不能按调用数计算可删实现。实际函数的内存合成探针表明，跨锁复用旧快照会把后来写入的 20 份回退显示为 10 份；不是运行完整 bootstrap。旧 retained-module 证据明确标记 fb559 来源及当前相关文件 LF hash 对齐，不冒充新构建。
- [较大估值 DTO](m3-estimate-dto-review-20261015.md)：独立资源缓存行、旧聚合 hydration、模型备用证据、两处聚合写入和 holdings 公共 parser 令旧构造器保持可达。增加私有 DTO 并不自动消除这些实现；需要更广兼容设计，不宜强行在本 M3 直接重写。新鲜 HTTP 行先经资源白名单，不能误称所有未知字段直接到 app；旧聚合黑名单是另一个边界。

只归档这三份人工报告；Temp 中附属 AST 脚本/JSON/旧 retained report **没有在本次完整打包**，不宣称完整原件归档。后续不得将无合格候选改写为“方案不存在”或按字符数推算 gzip。

## 当前门禁与后续边界

本轮只读重跑原 `node scripts/release-fingerprint.mjs --assert-app-bundle-budget site`，对现有产物实算仍 **exit 1**：all **80,477 / 77,227.7 B FAIL**，cold **42,992 / 52,241 B PASS**，至少还需减少 **3,250 整数字节**。这是现有产物核验，**不是本轮新 build**；CLI `importClosureVerified:false` 不替代构建图检查。

上一实现 SHA f926 的[精确 CI 38705211689](https://github.com/AureliusWu/FundVal/actions/runs/38705211689)已完成：Linux 1030/1030、syntax204、audit0、E2E30/30，构建/资源校验/封包上传通过；唯一失败为第15步原 all-gzip 预算。CodeQL job 成功不等于零告警：1957943374 /103 rules /1 result 为既存 #5，未关闭或 suppress。artifact 11958750388 仅上传/元数据，未独立下载核验。此前 b9da 的 Linux E2E 失败仍保留，不能改写。CI 结论只属于 f926，不自动继承至此后证据文档提交。

本轮没有新 npm test/check/build/E2E，也没有新配对时延采样；不复述旧结果为本轮新通过。旧 200 组配对总体仍 INCONCLUSIVE。版本仍 15.0.2，M3 仍 IN PROGRESS；M4/M5/M6、main、生产、tag/正式 release 均未推进。本证据提交/分支推送不是部署成功。
