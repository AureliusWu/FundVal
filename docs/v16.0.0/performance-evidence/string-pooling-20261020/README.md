# M3：私有字符串池固定离线预筛，未采用（2026-10-20）

唯一候选使实际 all gzip **增加 641 B**，cold 增加 **352 B**，停止且不采用。原产品仍 all **80494 B** / cold **42985 B**，原 all 上限 **77227.7 B** 不变，至少还差 **3267 个整数 B**。这不是 M3 退出、v16 发布或“所有优化均不可能”的证明。

## 固定方案与实测

以现有 170fd 业务的 16 份原 OXC chunk 为输入，只对重复的纯字符串值建立各 chunk 私有、非导出的 const 池。普通 string Literal 与完整的无插值、未 tagged 的静态 TemplateLiteral 按 decoded 值分组；跳过 directive、模块源/导出名、非 computed key、tagged/interpolated template、regex。次数至少 3、每原节点至少 6 UTF8 B、保守 raw 估算正收益；按首次出现及固定合法别名顺序处理，不按 gzip 选择。

事前固定顺序 baseline/pool、pool/baseline、baseline/pool；修正工具后完整执行三轮，未调阈值或继续扫参数。

| 变体 | all gzip B | cold gzip B | raw B |
| --- | ---: | ---: | ---: |
| 原 OXC | 80494 | 42985 | 235647 |
| 私有 const 池 | 81135 | 43337 | 228068 |
| 差值 | **+641** | **+352** | **−7579** |

共 153 组、1117 处替换，三轮每侧文本和指纹完全重复。这里是对一份固定原文本和一份固定候选的六次确定性压缩/核验，**不是六次 Vite 构建、应用执行或用户性能样本**。保留全部 96 份轮次 chunk、6 份 measurement 和 16 份解析前候选文本；raw 减少不能替代实际 gzip 门禁。

## 初版失败与修正时间边界

原 v1 协议先于扫描/转换/测量。初版直接用裸 identifier 替换，在 OXC 的 keyword 相邻模板值语法（如 return 后紧接静态模板、再紧接 in）处丢失 token 分隔，候选 Acorn 重解析失败；此时有效 gzip/link 样本数为 **0**，不是产品语法失败。

经主任务批准，只作一次固定工具正确性 v2 修正：统一 `(alias)`、每处估算计入 2 B 括号、const 声明前后添加换行分隔；不改变范围、次数/长度/收益阈值、别名顺序或唯一池化设计。v2 的 `stateAtCreation` 继承字段只记录**原 v1 的预声明事实**，不表示 v2 文件也早于 v1 扫描。原工具/协议/前置证据和实际失败事实均保留。

v1 没有保存解析失败的候选文本，完整终端 stdout/stderr 也未单独落盘，不追造或冒称原件齐全。v2 在解析前保存完整候选。

## 有限资格与独立复核

- 原实际静态图 16 节点 / 18 边为 DAG，无 direct eval/with。别名避开全 chunk 所有 Identifier/PrivateIdentifier 名称，包括嵌套作用域，避免捕获。
- ES2022 重解析；逐 initializer decoded 值、逐原结构位置 alias、显式导出名称检查；移除新 const 后回填原节点，除位置信息外全部剩余 AST 相同，保留原 regex/template raw/literal raw。
- 六轮均通过实际字面 import/cold 分区/完整可达闭包及 native ESM 静态绑定，不 evaluate。
- 独立只读审查重新读取 96 份 chunk 的长度/SHA/default gzip、轮序/算术/指纹；独立检查 16 对 AST、全部 153 组/1117 处的阈值、排除、别名、原位置回填，未发现不一致。审查未重跑转换、构建、link 或新试验。

旧 content-hash 文件名只作**离线标识**，未计算新的部署 hash，不是可部署的 Vite 候选或已更新 SW 库存。没有完整 API/DOM、CPU/内存、反射/错误 stack、真机/PWA、时延资格。新 eager const 初始化是未做完整运行资格的有意代码变化；不能从 AST/link PASS 推导全部语义与性能等价。

## 原件归档与产品不变

`original-evidence.tar.gz` 保存 Temp 冻结的全部 **129 文件 / 2978941 B**；压缩后 **634329 B**，SHA256：

`886be0611607523dca5c0ec1ab853e7c1acf532d43a07ac7f19bb6295eadf2e1`

`archive-audit.json` 列出每份长度/SHA；实际在新 Temp 解压，逐文件比对通过。原件含完整英文说明、v1/v2 协议/工具/失败事实、两份前置静态图、所有转换位置、完整 summary、输入 manifest、全部候选/轮次字节。输入 manifest 在测量后从已证明未变的产品精确复制，其 SHA 与 summary 测量输入一致，时间边界已注明。原件库存 sorted JSON SHA：`01ee2929ccddfb9dc99ad29a48195a12f50b6769feaca871473b60e3a5314144`。

summary SHA：`5751324308838bde63b40346de281fd36950c697b9b334d02f3b50efb88cfe1c`；v2 protocol：`56d57f660ef7ca8d7800c5d7771b417c8de203f0d8bbf9e26d5147a043d8cf00`；v2 probe：`d45b8efae5a63a8520e4901d796533010ad7f9c860537a3a66d96599dc3122a5`。归档不是自带 node_modules 的独立运行环境，不能在历史目录重跑覆盖。

试验前后 73 JS、127 文件 / 92507677 B site、构建 recipe 与 graph 工具库存相同。未安装依赖、未改项目业务/构建/配置/版本/预算。当前产物新跑实际 graph 命令 PASS，原预算命令仍 exit1/all FAIL。没有重跑完整 test/build/E2E/时延；第38节原配方回归只作为对应历史窗口，不冒称本轮新执行。无新 CI、Gist 写入、真实金融源/设备/OCR 验收，未提交推送/合并/部署。**M3 IN PROGRESS / 15.0.2。**

归档完成后的 [final-verification.json](final-verification.json) 及 `verification-tool.mjs.txt` 再实核129份解压原件、库存JSON SHA、现有73JS/site/recipe/graph工具与试验前后记录一致；critical 仍 `4bda36bc3ed361fcbf69d44d96f30af47fc1fff3b75eefd8728a341a45680948`。该收据保存现产物 graph/budget 与 Git 只读检查的完整 stdout/stderr/退出码；它不是补造未保存的试验原始终端日志，也不是重跑构建或候选运行资格。
