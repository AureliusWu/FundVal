# 单case parser overlay：适配通过，优化器前置仍停止

2026-10-23，`15.0.2 / M3 IN_PROGRESS / NOT_RELEASED`。独立工具实验，没有修改项目业务/配置/依赖、原预算或输出目标。**不采用本固定Closure方案；没有候选产物、压缩收益或新性能资格。** §53原JAR的解析失败保留为历史，不覆盖、不改判。

## 一个有因果依据的新前提

对同版Compiler.java先共同做官方shaded packaging翻译（21条import+唯一FQ Supplier类型，共22处），再仅在B1增加缺失的ES2022 parser映射。没有使用ESNEXT代替输入、没有改SIMPLE参数、没有改8组fixture/期望或放宽错误/特殊值/副作用约束。

| 输入/源码 | 实际身份 |
| --- | --- |
| 官方Compiler.java | 172135 B / `c9d418116b88311397bc172b1bd6de34d936d00b2b0fb772831306cde8756a9e` |
| 官方rules.jarjar | 457 B / `643dbb4ce1977f227decd1ec2964aab7a192fc917de7c15f0ae93459671f0f65` |
| B0共同重定位、未修bridge | 172927 B / `1a8ec1893f2979ba8f344a850447a908e6428e88748c9f5724900e07859f5f41` |
| B1只比B0多1个case | 172987 B / `7974acca148ffea2650f57a632372e60b68aa1f93092abef4c25e016c005485a` |
| 原shaded JAR | 14997454 B / `7dfedc111cb06024d3aa132443cd4952da415635c59342d84d96883083df853c`，未修改 |

这属于明确标识的**本地工具fork**，不是未修改官方发布版。上游Apache2 header、LICENSE和修改说明都保留；原JDK/JAR不重复打包。包装重定位按[官方rules](https://github.com/google/closure-compiler/blob/v20261020/rules.jarjar)，原源码/缺失case见[Compiler.java](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/Compiler.java#L3377-L3393)。

## 已实际通过的有限工具检查

- 两侧各一次`javac --release 21 -proc:none -encoding UTF-8 -cp <sameJar>`，均native0；各完整13个Compiler/Compiler$*类，文件名集合精确等于原JAR对应族。不是只覆盖一个class、把旧inner混进来。
- 两份javac stderr各211 B，是GB18030中文“使用或覆盖已过时API”提示；原字节保留，无抑制、无按提示重编译。UTF8直读会乱码，不能误判业务错误或称stderr0。
- 原JAR/B0/B1独立进程检查全部16个LanguageMode设置的实际映射/异常和CodeSource。B0全部同原JAR；B1只在2022由原IllegalStateException变为parser2022。实际来源确认是各自完整overlay目录。
- 全部13类`javap -p -s`的private/public声明和描述符，原JAR/B0/B1逐字相同：LF63868 B / SHA `3e550c2227f3d4733696e7cf3ed31f642b0a6736abfbebff06993e91edd69b3d`。ABI和16映射只是有限前提，不是任意编译器行为等价证明。

首次默认Node fetch失败，尚无源payload；代理变量已配置而Node代理开关未启用，但原收据未保存底层cause，不能据此确认唯一网络根因。native curl取得并复算固定源码。首次native准备器把rules对齐空白误当单空格而断言失败；原plan/RESULT/下载/native均保留。独立无网络relocate只按三个精确token识别同一条规则，翻译仍严格22处。没有修改来源规则/JS参数/用例来换PASS。

## 完全相同的8组固定案例：唯一实际运行

新目录DRIVER与8主fixture+4support（共13文件）和§53逐字节相同；controller仅增加严格B1 overlay路径/13类库存/父收据SHA和classpath适配，CASES/EXPECTED/observe/AST/warning/fail-fast原文不变。新manifest2844 B/SHA `4f76d1e40fca4f57df6441348413d21ba4039857857e7f40c48fdf5a4bb54d5f`。

唯一`run-01`于2026-10-23 01:57 UTC：

1. F01原版真实独立Node sanity **native0**，导出名、arity、值、函数身份和fetch/Storage guard=0符合固定期望。
2. 使用B1通过原解析停止点，随后优化器抛出：

```text
java.lang.NullPointerException: NAME publicFn 5:21
at RemoveUnusedCode.getVarForNameNode(RemoveUnusedCode.java:826)
at RemoveUnusedCode.traverseNameNode(RemoveUnusedCode.java:650)
```

Java **native2**；stdout485 B/SHA `ce55d911fe7c94240e4f0a262ec9f69d224da7b1a728325ab0675faf288fd192`，stderr2789 B/SHA `04fc38704a441d9caffe574e5de32a28b40bb74341048ee4273f703fbbe30a29`。driver对所有Throwable统一标`SETUP_OR_DRIVER_FAILURE`，原件保持该标签；实际栈的精确阶段是 **OPTIMIZER_INTERNAL_EXCEPTION**，不是再次缺失parser映射，也不是Java安装/ABI失败。

controller及外层显式传出的Node均native2；主执行器postflight无错误。**没有compiledCode、F01转换版、AST输出对照或运行行为差异证明；F02–F08全部NOT_RUN。** 不能叫“金融语义RED/金额错误”、不能归因FundVal业务，也不能称8/8通过。固定配置在合法export alias前置上已不合格；按停止线不继续修RemoveUnusedCode，不删除优化pass，不扫flags/改期望/补更多extern。

## 构建集成读审（未实施）

只读报告另核当前Vite8.2.4/Rolldown1.2.5：常规renderChunk实际在内建OXC之前，正确顺序是 **Closure→OXC→hash→generateBundle**，不是默认OXC成品再Closure。任何未来候选必须明确选定真实阶段。两TLA保留OXC路径不要求最终SHA不变：依赖hash变动会合法改写import/preload路径；不能为了旧SHA保留旧hashed URL。最终linker/preload/manifest/全部16块SW CORE必须基于同一实际产物，禁止命名后改site字节。本次没有执行这个候选或测量其收益。

## 当前项目和原件范围

所有工具/试验前后反复核对：273完整source（272 noDocs+固定v15反馈）、127site、68明确安装、HEAD170fd3e/分支/index均同；原JAR、B1全部13类和所有受冻probe源前后同。当前source行SHA `d0d9554fef7d2ef4b75f67a7db4fef558e03bb03f0897f2305617c6361090a3e`、site行SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`。不覆盖既有dirty修改。

现有产物仍 **all85969/cold46149**，原all上限77227.7仍FAIL/至少还差8742整数B。没有新root build/test/check/E2E/统计时延/CI/生产或真实金融源对账；§52的1313PASS/3skip、35/35和三轮构建只保留相同身份，不称重跑。旧800不继承；完整v16后续门槛不缩小。

归档保存完整新overlay源码/共同翻译/单case差、26个实际classes、编译/16映射/ABI全部native、唯一probe所有原件、父执行/库存和只读评估/集成报告。原JDK/shadedJAR binary不重复保存，当前产品只有完整清单（真实源码payload已在§52归档）；原失败/已停止旧probe不改写。归档自身、事后独立诊断和审计addendum在包外，成员数/SHA/新解压逐项结果以`archive-audit.json`为准。

当前不采用、不发布；下一步应转向有材料性依据的不同优化切面，而不是延长这个失败的编译器fork。预算、数据/兼容/时钟语义、ES2022输出和五分组继续保留。

## 归档后 addendum

实际归档 **241成员 /2224809 B**，压缩 **481029 B /SHA256 `836d704a1b8519593c6d2102a98bb7697fbdf9839fa3c3999d0d95b54c2c888e`**；成员清单行SHA `23207f2f16c5dd19315b1020f344cd498b1264860c08b25fc8da7a7bbbd68de9`。全新解压逐成员路径/大小/SHA同，17项归档检查native0，**并非策略PASS**；root source/site/install/Git及全部已完成工作区在归档窗口前后同。`git diff --check` native0，既有1822 B换行警告保留。首次归档入口因Windows ESM绝对路径缺file URL在模块加载阶段native1，尚未执行归档逻辑；原源码保留，独立v2只纠正import URL，未重跑任何编译/案例。原始工具错误在会话，不冒称独立原生错误文件存在。

[独立只读优化器诊断](DIAGNOSIS.md)7739 B/SHA `862b6778c053c0ed09eb6ba65364b133c7911b17178e2f366d34b8f462fcee25` 为包外addendum：固定F01位置是非本地export alias，实际pass把该NAME送入词法scope查找而得到null。没有中间AST/pass dump，不能断言具体前一pass已如何改名；只确认当前异常阶段与固定配置不合格。未再修编译器/改参/重跑。
