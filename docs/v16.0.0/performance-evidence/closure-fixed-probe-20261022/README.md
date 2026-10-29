# 固定 Closure 前置实验：实际停止，未采用

2026-10-22，`15.0.2 / M3 IN_PROGRESS / NOT_RELEASED`。已执行用户允许的独立新 JS 压缩策略前置验证，不放宽原预算、ES2022输出目标、加载分组或任何金融/兼容规则。**结果：SETUP_OR_DRIVER_FAILURE，未得到候选产物或压缩收益，不采用。**

## 固定配置与冻结输入

完整实施前协议和原件在归档中 `probe/PLAN.md`：唯一配置为 Closure `v20261020` Java API SIMPLE，in/out `ECMASCRIPT_2022`、module NONE +实验性 module rewriting=false、dynamic import允许/no alias、dependency none、LOCAL/property OFF、getter/property假设false、optimizeCalls=false、不注入polyfill/runtime；没有ADVANCED、custom extern、目标stub、整图合并或flagsweep。每次只编译一份真实输入，support模块只在运行时原样加载。

8组固定夹具包括export alias冲突/unused export、default/named/namespace import与reexport、live binding、arity/错误对象、getter/Proxy/Symbol/descriptor/−0/NaN/时钟、错误顺序、dynamic import身份、side-effect import顺序。原版和转换版各在全新Node进程运行，分别对固定期望及彼此比较；不是两个wrapper互比。预检只覆盖声明的合成域，不代表任意ESM/实际产品兼容。

所有审查修正均在执行前完成：允许合法export declaration布局差异，不冻结局部标识符；F05检查真实Symbol身份及输出描述符；源manifest完成时重新比较初始SHA；原生混合stderr保留待人工审查，不能自动算合格。只做过JS syntax-only检查，不把它称为预先行为PASS。

冻结manifest **2085 B / SHA256 `4e8d73bfadf03c5d6fd4cd6477b95cbc0ec99a101d5d315dd92624d0bf73d6d1`**，15受冻文件，含manifest共16文件/53798 B。controller28752 B/SHA `9f14f0777b2dc0c0a239af8939ef886e0b42c95d276029532c0e42e572407ef4`。主执行器在唯一运行前另行冻结全部输入和manifest，窗口后再核对；没有运行后改配置、用例或期望。

## 实际运行与停止点

唯一 `run-01`：2026-10-22 08:19 UTC。Java版本调用native0；F01原版固定sanity **native0**，实际keys、函数arity、值、export identity和guard=0都符合预声明期望。随后Java driver **native2**，结构化结果为：

```text
java.lang.IllegalStateException: Unexpected language mode: ECMASCRIPT_2022
at com.google.javascript.jscomp.Compiler.getParserConfigLanguageMode(Compiler.java:3392)
```

完整stderr1184 B/SHA256 `fd3b806c219b03b6efce27e355e22ef02f551c80a399a3aff7982e80e4442d71`；driver stdout454 B/SHA `d2dd6922cb94e8fc0d3af28677bdc7324204cbf8d1bfe7edc12c8cf8518b430c`。controller native **2 / SETUP_OR_DRIVER_FAILURE**；root执行器保存该原生子状态，PowerShell外层工具报告exit1，二者不混称。controller stdout497 B/SHA `5473b5b08eb9e4fcbb223cb4e9c7f0b4b534a056dc5ad6ed662c47d461ef8db4`，stderr0。

这发生于解析前，不是编译后金融值/ESM语义RED，也不能断言FundVal回归或Closure所有配置均不可行。F01转换版没有执行；**F02–F08全部NOT_RUN**，没有完成8/8、AST输出对照、产品转换、完整候选QA、确定性/包体或新时延。按协议停止，没有调整参数再次运行。

## 工具获取与原失败

- 首次固定Temurin JDK下载180秒超时，实际native1/TimeoutError，保留109600832 B partial，未解压/执行；不是产品/编译语义失败。
- 随后单独声明传输纠正协议：同官方URL，单次HTTP206断点请求，起终点与总大小精确匹配；将原partial独占复制到新文件追加，不改原件。完整205073461 B/SHA `f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e`核验；原prefix SHA `15d92b7f2a6e1b707850f8135a93d778ae82369a6d44a22a6c7f9cd5fd21eb68`前后同。
- Maven JAR14997454 B/SHA `7dfedc111cb06024d3aa132443cd4952da415635c59342d84d96883083df853c`实际下载校验。Java/javac版本为Temurin21.0.12.1，Closure banner `v20261020`，三项native0。工具可运行不等于该API配置可用。
- JDK ZIP成员路径检查后只解压在系统Temp，以绝对路径调用；未安装到系统、未修改PATH/JAVA_HOME、项目lock/依赖/config。未下载/使用旧v20261007 Maven缺失坐标。
- 官方来源：[Temurin固定release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1)、[Maven固定JAR](https://repo.maven.apache.org/maven2/com/google/javascript/closure-compiler/v20261020/closure-compiler-v20261020.jar)、[固定Compiler源码](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/Compiler.java)。

## 当前产品与归档范围

主执行窗口前后：§52的273完整源（272 noDocs+固定v15反馈）、127site、68明确安装、HEAD/branch/index均同。源码行SHA `d0d9554fef7d2ef4b75f67a7db4fef558e03bb03f0897f2305617c6361090a3e`，site行SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`；受冻probe源也不变。当前产物仍all85969/cold46149，至少需减少8742整数B；这里没有新build、预算PASS或相对性能资格。§52的1313PASS/3skip、Chrome35/35及三轮构建身份保留，但未重跑。旧800不继承。

归档包含完整probe源/manifest/唯一run原件、主执行器和原生子状态、工具协议/脚本和版本输出、传输结果的**明确脱敏派生摘要**（非原始HTTP收据），以及当前完整产品清单。JDK/JAR/partial二进制和含临时签名重定向URL的原HTTP headers只留Temp，不提交；派生摘要保留其原件大小/SHA供本机核对。当前273产品payload已在[§52原件](../accuracy-lifecycle-fix-20261022/README.md)完整限定保存，此处只留清单，不重复声称全量产品payload。归档数字与新解压结果由`archive-audit.json`给出；归档自身及后续审计/文档为包外addendum。

下一步仅可先查清固定版本parser API的官方映射，独立说明新的前提；不得把本失败改成PASS或降低输出目标来继续。当前不采用此固定配置、不发布、不改变M3门槛；精确CI、新统计时延、Gist/OCR/PWA/真机、真实金融源、生产/回滚等完整v16门禁仍未闭合。

## 归档后诊断与 addendum

[只读源码诊断](DIAGNOSIS.md)确认：pinned `Compiler.java:3377–3393` 的输入LanguageMode→parser模式桥接switch漏了2022项，尽管两端enum均存在；`setLanguageOut`走独立feature-set路径。**只解释当前解析前异常，不宣称ES2022输出目标成功/失败，更未取得压缩行为资格。** 原协议、native2与全部NOT_RUN保留，没有重跑或改参。诊断7615 B/SHA256 `1e178fe4f0b2dbe70d431eb14895f11e32fb6a8895052de7123db54212066455`，为已冻结归档之外的addendum。

原件归档实际 **106成员 /301040 B**，压缩 **86645 B /SHA256 `4d70f02b306e45914976fd526b5e25105edf07d030081adbd37f5319cbf650f5`**，成员行SHA `5caa5554bd0c9240146cbe3e57bc854edb8223178a07e4bdfbcb40f15acebd69`；新解压逐成员路径/大小/SHA全同，14项归档审计native0，**这不是实验PASS**。首次归档工具因未建stage/parent而ENOENT/native1，尚未生成tar；旧工具/plan/stage保留，原始工具错误见会话（不冒称独立stdout/stderr收据存在）。独立v2只创建缺失归档目录并用新工作区/plan，没有动原probe或再执行编译器。`git diff --check` native0、1822 B既有换行告警保留。
