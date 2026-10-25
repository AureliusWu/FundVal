# M3：UglifyJS 与严格 scalar 共享的有限排除（2026-10-20）

两组试验均未采用。原产品仍 all **80494 B** / cold **42985 B**，原 all 上限 **77227.7 B**；至少还需减少 **3267 个整数 B**。本记录不是源码无法优化的数学证明，也不是 M3 退出或 v16 发布。

## 1. UglifyJS：固定两配方、三轮真实构建

用户已授权独立验证新的压缩策略。先通过官方 registry 核实 `uglify-js@3.19.3` 的版本、SRI、tarball、engines 和 scripts；仅在独立 Temp 用 `--ignore-scripts` 安装，新增 1 包、审计 2 包 / 0 vulnerabilities，无生命周期安装脚本。没有修改项目 package/lock/安装策略。

从真实 build-site AST 提取配方，使用同一份冻结 170fd 业务快照。保留五组、write:false、ES2022 target、原入口/路径/启动隔离；固定顺序 OXC→候选 / 候选→OXC / OXC→候选，共 6 次。通过 Vite 原 terser renderChunk 接口，以 Uglify 替换该 hook；接收 **421864 B 未压缩输入**，不是对 OXC 已压缩代码二次压缩。由 Rolldown 继续生成最终文件名和引用。

选项原件在压缩归档的 `series-uglify-v1/protocol.json` 和 `compare-uglify-v1.mjs`：module/toplevel、passes2、keep_fargs=true、pure_getters=false、annotations=false、所有 unsafe=false、无 property mangle/define/pure_funcs/drop_console/drop_debugger。没有启用宽松 getter、跳过 validator 或依赖新增纯函数假设。输入中的 84 个 PURE 标记不等于已撤销前一 Rolldown DCE；本轮只关闭候选 minifier 的注解假设。Uglify 本身没有使用 ES2022 编译开关；原 Vite target 不变，并对**每份最终输出**额外使用 Acorn `ecmaVersion:2022,sourceType:module` 验证语法范围。API 及选项依据见 [UglifyJS 官方文档](https://github.com/mishoo/UglifyJS)。

| 配方 | all gzip B | cold gzip B | raw B | 与原 OXC 差异 |
| --- | ---: | ---: | ---: | --- |
| 原 OXC | 80494 | 42985 | 235647 | 基线 |
| Uglify 保守 p2 | 80355 | 42724 | 229359 | all −139；cold −261；raw −6288 |

三轮各自 fingerprint/字节重复；96 份捕获输入与 96 份最终产物实核匹配记录。候选 lazy 部分增加 **122 B**，不能只宣传 cold 收益。all 收益仅约 0.17%，即便采用仍至少差 3128 B，不足以启动新工具链采用，未继续扫描选项。

16 chunks 的 module→chunk-name→role hash 相同：`edf5d8384ccea08f72b2eb25274ab218f0be449d804f74e339a7bdf2a1adab91`。最终 AST 依赖路径与 metadata 一致，新增独立 literal cold/完整可达闭包和 native static binding 检查均通过。它们**不证明**函数引用身份、运行时、任意 getters/时序或压缩 API 的完整等价；没有候选完整 API/E2E/配对时延资格，不因三次确定性而采用。

## 2. 两处严格 primitive 共享：固定四变体、三轮

候选只合并已经相同的转换步骤，不合并 Worker/cache 的不同信任边界或数字/日期语法：

- clock：`contractClock`、私有 `finiteNow/clockValue` 和 createQuote 局部相同的 Date/Number→finite/fallback 转换；保留公开 wrapper 名称/arity。不得把另两处重复读取 options.now 的表达式改成一次 helper 参数读取。
- HMS：只共享三处按原顺序检查 hour>23、minute>59、second>59 的短路表达式，保留不同 regex、起始偏移、完整日期、时区、返回/throw 和 future guard。
- 新内部 helpers 放既有 post-integrity quote-contract 模块；不新增模块/组，也不增加 18-API facade 导出。六份源的变换均只通过 Temp build plugin 提供。

固定轮序 baseline/clock/HMS/combined；combined/HMS/clock/baseline；clock/baseline/combined/HMS，共 12 次真实 write:false 构建。

| 变体 | all gzip B | cold gzip B | raw B | all/cold 差值 B |
| --- | ---: | ---: | ---: | --- |
| baseline | 80494 | 42985 | 235647 | 0 / 0 |
| clock | 80461 | 42982 | 235417 | −33 / −3 |
| HMS | 80482 | 43007 | 235610 | −12 / +22 |
| combined | 80472 | 43007 | 235372 | −22 / +22 |

每变体三次 fingerprint/字节一致；最优仅 −33 B，组合不能相加。全部 16 chunks，记录的 module/role/static/dynamic 拓扑 digest `cf069f8aa97c3bd64fb4052b936d807ae5bfceebb570cdbea31b4240be1b3e1b` 一致。此 digest 的完整拓扑 preimage 未单独保存，独立审查没有将“12次摘要一致”升级成重新构造了全部模块图；实际 chunk 字节和文件依赖仍可检查。原构建阶段隔离及最终代码 literal closure/native binding 检查均通过。

124 组 clock + 4806 组 HMS 逐 case 输出与访问/调用/coercion/短路轨迹相同，保留 undefined、非有限值、−0 和同 sentinel/error name/message；不比较 stack。**仅 primitive 切片**，不是集成 API/任意异常栈/浏览器/设备/时延等价。

12 次构建后才给 `probe.mjs` 增加 trace 归档 instrumentation 和 `--trace-only`，再运行一次纯 trace 流程，保存全部 4930 对原/候选记录，新增构建数为 0。因此归档脚本不是最初构建启动时逐字相同的工具版本；其变换/配方逻辑保留，但不能隐去这个时间边界。原始启动 stdout 没有另外完整捕获，不冒称完整终端日志归档。

## 3. 原件、复核与当前产品

`original-evidence.tar.gz`：**439 文件 / 8544431 B 原始内容**（Uglify 204、scalar 235）；压缩后 2185750 B，SHA256：

`e040969bc237cafcffd2ef099ea7323786f8880650cd292592ebbc8ec3018feb`

包括确切协议/选项/锁文件、所有捕获输入、18 次完整产物、每轮记录、六源四变体文本、4930 对 trace、工具和原说明。排除 node_modules、全业务快照源树与 root site。`archive-audit.json` 列出每个文件长度/SHA，已在全新 Temp 解压后逐文件验证；归档仅是文档证据，不是产品压缩手段。

独立审查读取实际文件重算字节/gzip/SHA、轮序、报告算术和 trace 对照；没有重新执行压缩、构建、link 或 trace。Uglify 报告 SHA `ead8aef64fe97d4c6a1067de4e6ff11454fca6fa3b7b2ee0c50a065ded49e3ee`；scalar summary SHA `fc069b99b2da3f2ab33e56760a1977f3d3c921818702bcadab38f8f2aab64fee`。

当前 JS 73 文件与快照逐文件 LF 规范化后相同，合计 690165 B；原始换行导致 raw 库存不同，不能称 raw 相同。Uglify 实测窗口的 before/after JS/site/git-status 一致，六份 scalar 源与原 recipe SHA 也匹配。全产品仍 127 文件 / 92507677 B，release-critical 指纹仍 `4bda36bc3ed361fcbf69d44d96f30af47fc1fff3b75eefd8728a341a45680948`。

本轮未重新运行项目全量 test/build/E2E 或时延采样，因为没有采用任何业务/工具源码变化；第38节产品字节相同的回归仍作为历史窗口证据，不伪称本轮新执行。现有产物新跑实际模块图命令 PASS，预算命令 exit1/all FAIL。没有真实金融源对账、新 CI、Gist 写入、OCR/真机、merge 或部署；数据链未变，不能授予新的实时行情 TRUSTED 判定。**版本仍 15.0.2，M3 IN PROGRESS。**
