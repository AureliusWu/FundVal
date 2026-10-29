# v20261020 ECMASCRIPT_2022 输入解析桥接诊断

2026-10-22。只读核对既有唯一运行与 pinned 官方源码；只新增本文件。未改旧 probe/controller/driver/manifest/fixtures、root、A/B 或旧 evidence，未改 flags、重跑、下载、构建或执行 Java。

## 结论

这是 **pinned v20261020 的输入 LanguageMode→parser Config.LanguageMode 桥接遗漏**。不是 F01 导出/别名的语义 RED，不是 F01 源码语法被正常诊断拒绝，也不是 Java 运行时缺失或 DRIVER.java 没编译成功。公开 `ECMASCRIPT_2022` 枚举及相应 parser 枚举均存在，但二者之间的 switch 漏了该 case。异常发生在读取 `languageIn`、建立 parser config 时，早于本轮 SIMPLE/module/renaming 行为资格。

**本固定配置已真实 STOP，不能改判 PASS。** 本文不提出替代 flags/模式，不改原计划或目标，不授权重跑；也不据此宣称所有 Closure 策略不可能。输出 ES2022 目标与输入解析 API 是不同路径：此次结果只直接证明所固定的 `setLanguageIn(ECMASCRIPT_2022)` 解析桥接失败，没有证明输出目标本身失败，更没有输出契约或收益证明。

## 1. 实际原件

目录：`C:/Users/84046/AppData/Local/Temp/FundVal-closure-fixed-probe-20261022-parent/run-01/`。

- F01 original 独立 Node sanity native0，固定 keys/arity/values/identity 全同，fetch/Storage guard均0；stderr0。
- F01 Java source-launch实际进入 DRIVER/Closure，Java21.0.12.1/Eclipse Adoptium；Java native2。结构化 stdout：`SETUP_OR_DRIVER_FAILURE`，`java.lang.IllegalStateException`，message `Unexpected language mode: ECMASCRIPT_2022`。
- stderr 栈首为 `Compiler.getParserConfigLanguageMode(Compiler.java:3392)`，经 `getParserConfig:3401`、`CompilerInput$JsAst.parse`、`parseInputs`；不是正常 JS `Result` 的 errors/warnings 返回，未生成 compiledCode，也未运行 transformed F01。
- controller native2；F02–F08全部 NOT_RUN。`frozenSourcesUnchanged:true`，初始 manifest SHA为`4e8d73bfadf03c5d6fd4cd6477b95cbc0ec99a101d5d315dd92624d0bf73d6d1`。

| 原件 | bytes | SHA256 |
| --- | ---: | --- |
| summary.json | 9217 | 1a243d719fde8ab8800959a83e092066a3521eb69313d959fa7fe13875c8bc81 |
| native/F01-original.stdout | 228 | 31ca5e826990932fe88d085eec821238a2f2a503cd7b6a450afb7fe9fa223a09 |
| native/F01-java.stdout | 454 | d2dd6922cb94e8fc0d3af28677bdc7324204cbf8d1bfe7edc12c8cf8518b430c |
| native/F01-java.stderr | 1184 | fd3b806c219b03b6efce27e355e22ef02f551c80a399a3aff7982e80e4442d71 |

另读父执行器 `C:/Users/84046/AppData/Local/Temp/FundVal-closure-probe-execution-20261022-parent/RESULT.json`（5849B/SHA256 `633f881a8353112f2e2f5d67af15d6aa0e0cf5178b469fbc859fc338a85ddbac`），状态PREREQUISITE_STOP、postflightError:null，before/after完整对象相同：source273、site127、installed68、Git HEAD/branch/index同；site行SHA仍`0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`。这是读取既有收据，不是本轮另执行 QA/构建/产品转换。

## 2. pinned 官方源码的直接因果链

本轮只读 `https://raw.githubusercontent.com/google/closure-compiler/v20261020/` 同版文本，HTTP200，并计算文本SHA；没有下载二进制或改源码。

1. [CompilerOptions.java:2021–2031](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/CompilerOptions.java#L2021-L2031)：`setLanguageIn(LanguageMode)`只排除NO_TRANSPILE并保存输入模式（STABLE有单独映射）。因此 Java API/枚举能设置，不代表后续 parser bridge 完整。
2. [CompilerOptions.LanguageMode:3692–3699](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/CompilerOptions.java#L3692-L3699)：存在2021、2022和NEXT公开枚举。`fromString:3751–3766`按该枚举解析；不是调用方拼错了一个不存在的常量。
3. [parsing/Config.java:44–62](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/parsing/Config.java#L44-L62)：parser自己的LanguageMode也明确有ECMASCRIPT_2022，并绑定FeatureSet.ES2022_MODULES。所以不能写成“此版本parser enum没有2022”。
4. **直接 throw 点**：[Compiler.java:3377–3393](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/Compiler.java#L3377-L3393)。`getParserConfigLanguageMode(CompilerOptions.LanguageMode)`逐项映射输入与parser枚举，但2021后直接进入NEXT/UNSTABLE/UNSUPPORTED；没有2022分支，default在3392抛IllegalStateException。`getParserConfig:3401`实际把`options.getLanguageIn()`传入此函数，恰与现有二进制运行栈位置/message一致。这个缺失分支已足以解释本轮结果，不需要猜测ESM、getter、arity或TLA。
5. [Config.java:58–59/93–95](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/parsing/Config.java#L58-L95)另有更新最高语言级的注释，而latestEcmaScript仍返回2021，是同版语言级接线不齐的旁证；**它不是本次栈里的直接抛错点**。本轮不推断上游作者意图、引入commit或已确认的issue/修复状态，也不扩展历史搜索。

## 3. 输入模式不等于输出目标

[CompilerOptions.java:2034–2050](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/CompilerOptions.java#L2034-L2050)对输出使用独立的`setLanguageOut`路径，经`languageOut.toFeatureSet()`设置输出feature set；[同文件:3770–3784](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/CompilerOptions.java#L3770-L3784)已有ECMASCRIPT_2022→ES2022_MODULES分支。[FeatureSet.java:88–97](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/parsing/parser/FeatureSet.java#L88-L97)也定义ES2022_MODULES及ES_NEXT的相应关系。

因此，准确说法是：**固定的input2022 API在这个版本的parser适配switch失败；output2022 feature-set声明存在，但本轮未走到可验证其最终输出的阶段。** 不能把“声明存在”写成输出行为PASS；也不能把输入桥接异常写成“保持ES2022输出目标不可能”。本诊断不建议降低ES2022目标、绕过语义门禁、修改夹具/期望或更换本次配置；未来任何不同的输入适配都不是这个已停止固定运行的后验修补。

## 4. 官方文本指纹与证据边界

| 同tag路径 | bytes | SHA256 |
| --- | ---: | --- |
| src/com/google/javascript/jscomp/Compiler.java | 172135 | c9d418116b88311397bc172b1bd6de34d936d00b2b0fb772831306cde8756a9e |
| src/com/google/javascript/jscomp/CompilerOptions.java | 132428 | 7ea7c7810f31029186f0a776a9d3a4921c07a4025a8877930e1257850d0f1d05 |
| src/com/google/javascript/jscomp/parsing/Config.java | 7199 | 36cda3268a2677bf6829a249a49f3e0db356a89321231e8a8a8f085c30fca3f8 |
| src/com/google/javascript/jscomp/parsing/parser/FeatureSet.java | 22999 | c0e675f2aaf38f3df0319f386d363704aa565ae3bce8ecdeb7f02ff6c2062929 |

此前准备审查核对了公开API签名/枚举及模块开关，未发现此parser bridge漏项；本次原生失败补足了该前提证据。旧报告/协议/唯一运行保留原样，不改写为已经完整验证API可执行，也不以新诊断擦除native2。

performance-regression-check技能在此仅用于区分前提失败、行为结果与收益：本轮无新运行、转换产物、压缩数据或M3资格；原all85969/77227.7 FAIL、15.0.2/M3 IN_PROGRESS不变。到此停止。
