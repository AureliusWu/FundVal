# Worker 解析边界的有限独立验证：不采用单独拆分

2026-10-22；应用仍为15.0.2，M3仍IN_PROGRESS。本轮没有改root业务源码、配置、依赖、site或版本，没有提交、推送、合并或部署。

结论：同文件header/items/tail拆分通过本次有限行为与定向接口检查，但实际总包 **84,187→84,257 B（+70）**、冷启动 **44,699→44,702 B（+3）**，不采用为独立减包方案。只在系统Temp保留候选，既有dirty工作树不回滚、不覆盖。这个边界可供以后完整管线候选研究，不能当作已经省下6,960 B。

## 先审边界，再做唯一候选

- 实际产物审查确认source-health通用factory已tree-shake，仍live的固定声明校验不能删；Bridge发出请求与接收opaque iframe响应不是同一信任边界；主renderer的live工作也不能用整个函数大小冒充重复收益。没有据此生成新小变体。
- 主代理另用真实coordinator/executor/Store及两个合成组合检查“producer可信即可跳过Store复制”的前提：producer provider键为稀疏0/2/5项，而Store输出固定7键、未观察为null；watch计划顺序也不同，复制/冻结确实是唯一规范化边界。这条捷径在写候选前被否决。第一次探针把watch全基金失败错期望为complete，保留原v1，仅纠正合成预期后v2通过；不是修产品或择优采样。原v1完整终端字节未另存，工具历史与原脚本保留。
- 更大EvidenceBook设计明确：旧公共API必须保留，但不意味着都必须进入默认bundle；私有facade可以静态窄化。真正的成本是旧持久化形状、alias/opaque覆盖、独立模型证据、两个缓存写入时钟政策以及各自严格验证仍要保留。整个business/post-integrity chunk不是可删收益池，没有合格的≥6,960 B净gzip预测。

唯一实现候选从已归档的246份非历史输入逐项hash复制，只改`worker-contract.js`、`fund-holdings.js`、`eastmoney-estimate.js`。保持原Error class/row normalizer逐字不变，公共parser签名/default不变；原header/items/tail语句精确提取，仍先header再端点分支、最后尾字段重读。两个客户端仅改固定入口import/callee，保留`options.now`读取位置。无新module路径、分组、minifier或target变化。

复制初收据`sourceBytes:null`是PowerShell对OrderedDictionary求和的工具缺陷，原件未改；独立直接求246行得12,107,657 B，复制前后每文件SHA仍完整。候选246份共12,109,099 B，恰三文件改变、其余243份相同。主代理完整重构整个候选worker文件并复核库存/原收据，648项静态检查通过；不是只检查substring，也不是行为或压缩证明。

## 冻结旧实现与有限行为资格

先固定64案和3个负控，冻结完整旧实现相对依赖14文件/101,266 B，再运行。初稿56案在首次冻结/结果前补至64，没有结果后增删案例。

- 64案：52公共parser、11公共normalize、1无fetch的parse→normalize时钟链；24返回/40预期异常均保留。旧root/冻结副本128次完整结果64/64一致。
- 新候选generic64同时对已存旧原件和本次fresh冻结旧实现，三路完整结果均64/64一致。
- fixed52对独立旧parser的literal-bound adapter，52/52完整一致；39 estimates/13 holdings，包含错误payload。只排除11 normalize-only及invalid-endpoint，清单测前固定。候选比较没有过滤trace；仅旧bound对旧generic的辅助检查少一项endpoint读取。
- runner函数原文5,214 B，SHA256 `66fcbdd3212b4fc18830cd0f86e2b70eaea4c5f48adf7a76af02b91918d22a75`，新模块只有原函数加import/export。独立对照不是两个新wrapper共用新core互证。
- 235次调用、3负控；ChangingDate两侧各3次读取，真正WorkerContractError safe-rescue、伪装类不rescue、late sentinel传播、key/order/descriptor/symbol/null/NaN/-0/冻结/引用标记均参与。调用trace先封存，结果序列化不混入读取轨迹；stack文本不参与。
- 行为阶段禁网/真实Storage守卫尝试0。主代理178项独立原件重算通过；有限64/52不是全API/所有getter/options输入域证明。

旧raw：4,437,260 B / SHA256 `80792820d1fc2c69f72fc07512183fd5f9556cb222189159ce1fa442db62a751`。候选资格raw：10,021,622 B / SHA256 `361cece0f65c6c4dc76b30657d7d83f1a71befe5e55db025ce565d29259afd33`。原件、cases、runner、controllers、前后库存和native收据均保留。

## 定向接口测试与实际六轮构建

两侧各一次固定六测试文件：worker contract、wire characterization、HTTP characterization、fund holdings、eastmoney estimate、request signal；每侧 **97/97 PASS、0 fail/cancel/skip/todo**，native0、stderr空。Node原生实际输出为spec格式，捕获文件虽名`stdout.tap`，不冒称TAP语法；没有改reporter重跑。不是完整1224项QA。

同一Node24.14.0、已固定68份安装manifest/lock/native/launcher库存及同一node_modules junction；没有install。原`build-site.mjs`、OXC、ES2022、五组、启动隔离检查、OCR构建器及预算均不改。固定epoch1792046773，唯一顺序A1 B1 B2 A2 A3 B3，无重试/筛选/修候选。只清理经独立路径/非链接检查的Temp各side/site，不构建root/site。

| 侧 | 三轮native | app raw | all gzip | cold gzip | 完整site |
| --- | --- | ---: | ---: | ---: | --- |
| A原版 | 全0 | 245,170 | 84,187 | 44,699 | 127文件 /92,537,133 B |
| B候选 | 全0 | 245,505 | 84,257 | 44,702 | 127文件 /92,538,910 B |

A三轮每个成员均精确复现原锚`4e8dddb5ce4f81992f384afd0ee552431787c6b30600a643bcb97f6a0837e4e4`；B三轮完整库存相同，`83ffa4092ee6a5762dcd45b38af5ae9c2a955b9c5a05ee7eeb0ef001974b4fee`。这是原sampler的path/NUL/fileSHA/LF算法，不是sorted-JSON摘要。

固定四次最终CLI：A graph native0、A budget **native1**、B graph native0、B budget **native1**。两侧实际字面import闭包/native binding通过，budget真实FAIL JSON与stderr保留，不把外层记录器完成0称预算PASS。原build阶段隔离检查通过，不等于完整运行时或startup顺序独立证明。

主代理另139项只读复核：重新读取六份完整127成员payload、两份最终site和root/site，逐chunk重算gzip、完整输出SHA、97项实际spec footer/成功行、四CLI及同窗口身份收据，均通过；不重跑SUT。候选全包至少差7,030整数B，原产品至少仍差6,960 B。

## 身份、原件范围与停止

每轮前后A/B各246源、root完整270输入（含24历史dot输出）、root127产物、68安装库存、HEAD/branch/index/tracked/status相同。最终capture于2026-10-22T05:27:17.303Z完成，之后才更新root文档。未把旧完整tests/E2E/audit或第48节800配对称本轮新跑；未对B继承时延资格。

归档入口为`original-evidence.tar.gz`、`inventory.json`、`archive-audit.json`；复现程序为`archive-tool.mjs.txt`。**684成员/88,898,119 B**已压缩为12,304,770 B，SHA256 `2c58de679641036b7d3a7b9d9335feaee9546070dcac7e25e82ce683a9e56c77`；pack/unpack均native0，另新Temp全量枚举/每文件bytes与SHA相同。归档含完整246 baseline源、候选三文件overlay、全部行为原件/协议/程序/native记录、六轮完整库存及每轮实际chunks/manifest/index/SW。完整六份site留在原Temp；归档不重复OCR/依赖payload或六份重复public source/assets，不能称完整六份127 payload全已归档。

主包封存后完成的[下一完整HTTP纵切面字段/存在性规格](next-http-boundary/README.md)单独保存，不混称属于684原件或已经实施。它明确先影响Quote后剪掉的opaque、真类第二钟rescue、双Quote身份、双模型顺序碰撞和两writer的top unknown/时钟差异；接受矩阵标注尚未新增差分的缺口，没有从字段数量推算gzip收益。

最后`final-audit-tool.mjs.txt`实际native0/23检查通过，重新枚举270原输入、127原site和68明确安装条目，重新核684解压成员及archive SHA，并验证下一规格的9项源码SHA/明确的LF及相对链接派生。`final-status.json`和八份Git原始输出单独保存于目录，不属于684主包。HEAD/branch/index不变，文档有意更新；`git diff --check`实际0，既有LF→CRLF警告原文保留。没有把这些文档后检称新SUT/完整QA执行。

原全包门槛77,227.7 B、cold52,241 B不变。**不采用该单独拆分；root仍84,187/44,699 B，15.0.2/M3 IN_PROGRESS，未进入M4/M5/M6或发布。** 没有新完整QA、E2E、时延、CI、真机、OCR引擎、Gist写入、真实金融源或生产验收。下一步只能对完整估值管线边界建立兼容字段/写入政策与实际净删图，再验证一个有限整边界候选；不继续此helper拆分的参数扫，也不将有限排除扩大成全程序不可能性证明。
