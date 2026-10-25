# M3：OXC 产物打印器 / ASCII 有限探针（未采用）

在完整回归结束后，用既存 Temp Terser 5.51.2 对当前 OXC chunk 做固定三轮离线打印对照。没有安装依赖，没有修改构建配方、site、版本或预算。此实验**不是 Vite 构建，也不是可发布候选**。

输入 16 份 JS 逐项匹配原 manifest 的长度、SHA、gzip。固定 `compress:false,mangle:false,ecma:2022,module:true,format.comments:false`；先声明三轮顺序 UTF8→ASCII / ASCII→UTF8 / UTF8→ASCII，唯一变项是 `format.ascii_only`。三个变体的范围分别为原 OXC、不转 ASCII 的 Terser 重打印、同打印器转 ASCII；不能把①→③全部归因为编码。

| 配方 | all gzip B | cold gzip B | raw B | 相对原 OXC |
| --- | ---: | ---: | ---: | --- |
| 原 OXC 字节 | 80494 | 42985 | 235647 | 基线 |
| Terser UTF8 重打印 | 80465 | 42980 | 235622 | all −29 B |
| 同打印器 ASCII | 80224 | 42887 | 244683 | all −270 B；raw +9036 B |

每个打印器配方三次 fingerprint 相同。ASCII 相对 UTF8 打印器额外减少 241 B all / 93 B cold；最终相对 OXC 仅约 0.34% all 收益，即使只按探针数字仍至少差 2997 B，不能填平原缺口。因此未采用，不继续扫描参数或对低收益候选启动完整工具链迁移。

每份最终代码解析及本轮新增的真实字面闭包/原生静态绑定通过：16 chunks、18 条静态边、10 条动态边、6 cold。忽略位置、raw spelling、comments 后的 AST hash，两个重打印配方都各有同样 5 份 chunk 与原 OXC 不同（见 `format-report.json` 的 astDifferences）。**没有把这些差异当作语义等价证明，也没有随意删除更多 AST 字段让 hash 通过。** 转义正则还可能改变可观察的 RegExp.source；未完成反射/namespace/身份及完整运行资格。

原 chunk 标识符仅供内存对照和链接使用，不代表新内容的正确 content hash。若未来采用，必须在真实构建的 hash 生成前集成并重建 manifest/SW，不能覆盖已命名的 site 后冒充验证完成。本次未保存完整候选 JS 字节，只归档协议、测量与逐文件 hash、确切脚本和既存工具锁文件；没有候选 E2E、相对时延或设备/生产证据。

另一个只读排除：Vite 8.2.2 的客户端构建本来就设 `preserveEntrySignatures:false`，项目没有覆盖，因此显式设置 false 不是新优化。没有为此重复构建。10 个小 façade/stub 本体合计 1340 gzip B 不是可兑现收益或严格上界，不能据此保证修改分块安全或解决 3267 B。

协议及报告中的 before/after 数组和 manifest 原件实核证明探针输入未变；不是全仓无改动声明。实际保留产品仍 all 80494 / cold 42985，原预算仍 FAIL。**M3 IN PROGRESS / 15.0.2，未进入 M4，未发布。**
