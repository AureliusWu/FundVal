# M3 压缩策略独立验证：未采用（2026-10-18）

## 结论

用户本轮明确授权：可在临时目录独立验证新的 JS 压缩策略，仅完整测试、确定性构建和性能验收合格后才考虑采用；原预算、ES2022、加载分组、校验、兼容功能不放宽，不直接发布。这是相对第35节固定压缩器范围的**新授权**，不是继续声称换压缩器不被允许。

冻结业务源为 `170fd3eadc6da02750882f8a542904ee2358d0d9`，版本仍15.0.2。三个独立对照系列，每个事前固定一组候选配置及三轮顺序 `OXC→候选 / 候选→OXC / OXC→候选`，共18次真实 Vite/Rolldown 内存构建。不是全部配置空间的穷举，也不是18次首页性能测试。

| 配方 | all gzip B | 相对原配方 | cold gzip B | raw B | 判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| 原 OXC（每个系列3次，共9次） | 80,494 | 0 | 42,985 | 235,647 | 原all预算FAIL |
| Terser 5.51.2，保守p2 | 80,916 | +422 | 43,192 | 237,249 | 更大，拒绝 |
| esbuild 0.28.2，完整压缩 | 82,871 | +2,377 | 43,934 | 238,490 | 更大，拒绝 |
| SWC 1.16.18，保守p2 | 80,328 | −166 | 42,956 | 233,930 | 仅省0.21%，仍比all上限大3,100.3 B，未采用 |

每种配方各三次字节/完整chunk指纹均重复；全部为16 chunks，相同模块→chunk名称→cold/lazy归属hash `edf5d8384ccea08f72b2eb25274ab218f0be449d804f74e339a7bdf2a1adab91`。原启动隔离函数与最终输出AST静态/动态import路径检查全部通过。原始字段 `finalImportLinkVerified` 只指specifier路径、目标文件存在及chunk metadata一致；**没有验证named-import/export绑定或执行ESM链接**。文件名内容hash随压缩器变化，**不是文件名和完整依赖图原样不变**。

即使把四种配方每个chunk的最小gzip简单相加，也只是80,288 B（−206），算术值仍至少差3,061整数B，因此没有继续构建角色级hybrid。这个算术筛选不是实际hybrid产物、严格数学下界或可发布指纹；真实混合会联动import文件名及hash，不能以相加代替构建。

**没有合格的压缩器替换。** 原实际site预算CLI仍输出 `cold 42985/52241 PASS`、`all 80494/77227.7 FAIL`，exit1，至少差3,267整数B。没有调整gzip算法/级别、把JS搬到data或内联、放宽预算、删功能或去掉校验。M3仍IN PROGRESS，未进入M4/M5/M6，未改版本或发布。

## 试验隔离与复核口径

- 环境：本机Windows、Node24.14.0/npm11.9.0、项目已锁定Vite8.2.2/esbuild0.28.2。Terser/SWC只装进独立Temp目录，均使用官方npm registry和 `--ignore-scripts`；两次安装各自audit0。SWC使用已下载的Windows可选原生包，没有执行postinstall。未修改项目package、lock、安装脚本白名单或node_modules。
- 从上述Git提交archive出独立 `source/`，不是在生产工作树打补丁。archive与工作树原始JS字节数有EOL差异；73文件逐一LF规范化后inventory相同，见[source-identity.json](source-identity.json)，不能把原始hash不同隐去。
- 每个工具从快照 `scripts/build-site.mjs` AST提取真实build对象、原5groups、模块集合、图遍历和启动隔离函数；不另造一个简化build。`target:'es2022'`、ESM、`write:false`、入口/分组/预算不变。源码、原site、快照源码在每个系列前后inventory及Git porcelain相同。
- 原site始终127文件/92,507,677 B，whole inventory `7d4d8c1e0828f09164bf10b8ef64e8be6f06ccb8cdca61ed7dc2f031c0e68e37`；它是排序 `{path,bytes,sha256}` JSON的hash，不是critical-set指纹。只在全部测量结束后向仓库新增这份证据及状态索引，未改业务或构建配置。
- Terser用Vite真实hook，固定 `passes:2 / pure_getters:false / unsafe:false / keep_fargs:true / builtins_pure:false / properties:false`，不drop console/debugger或注入global_defs/pure_funcs。完整选项见机器记录。其[官方选项](https://terser.org/docs/options/)不能替代本项目的压缩产物兼容测试。
- esbuild走完整Vite minifier，不是OXC后再次压缩；显式 `ignoreAnnotations:true`，未启用property mangle/pure/define/drop/async降级。Vite本机实现 `node_modules/vite/dist/node/chunks/node.js:3474` 与 `:33758` 确认路径；Vite导出的静态esbuildVersion不是实际包版本证据。历史第12节已经排除此策略的旧源码版本，本次仅做当前源码的一次有界复核，不宣称新策略发现。
- SWC借Vite terser模式关闭Rolldown原生minify，在同一renderChunk点替换为固定SWC；由Rolldown继续生成最终chunk hash及链接。显式 `ecma:2022/module:true/toplevel:true/passes:2/pure_getters:false/unsafe:false/keep_fargs:true`，mangle只顶层词法名，不启用props。不是先OXC、再SWC。[SWC官方文档](https://swc.rs/docs/configuration/minification)列有编译假设，显式保守选项不等于任意Proxy/getter/内建对象环境的行为等价保证。
- 三种候选的压缩前输入每轮均记录84个PURE类注解及逐chunk内容hash。源码本身没有这些标记不代表打包后输入没有；本轮没有声称全面关闭注解假设。Terser/SWC保留some注释的设置也不等于忽略输入注解。
- 初版审计工具把无表达式的静态TemplateLiteral动态import误判为非字面量，未完成有效系列。旧工具及失败尝试保留；v2只补接受一个quasi/零expression/字符串cooked值，真实计算import仍拒绝。不是运行时产品Bug，不把失败尝试抹去或记作完成测量。

## 未执行的准入与采用门槛

候选未能填平缺口或提供足够的工程收益，本轮**未启动采用**，因此没有为候选运行完整public API压缩镜像测试、浏览器E2E、离线/SW更新验证、新200配对或生产检查；不得把源测试、旧CI或上述确定性构建写成这些验证已通过。buildWallMs仅保留原样，未控制并行线程/缓存/构建预热，不作启动速度或运行时性能判断。

如果未来出现值得采用的材料性候选，仍须两层验证：

1. 严格loader约束的完整公开API压缩镜像，保留模块路径/JSON资产且禁止回退源码；覆盖ChangingDate三次时钟读取、Proxy/getter轨迹、错误身份、对象字段顺序、AsyncFunction执行前拒绝及thenable拒绝、公开arity。源码切片/AST测试单独报告，不能冒充压缩镜像行为测试。
2. 最终真实manifest产物上的公开façade及完整浏览器流程，确认请求实际命中压缩chunk、迁移/完整性顺序、105基金官方lane、懒加载、SW CORE/OCR隔离、离线与更新。`site/js/`保留的未压缩源码不是压缩产物测试证据。再按新的预声明协议测相对性能，不继承旧200-pair总体INCONCLUSIVE。

没有新行情完整摄取、手机真机、OCR识别、Gist写入或云/生产操作；也没有再次操作Windows校时。本文不是FundVal v16发布或当前金融数据可信性的证明。

## 同期源码边界复查（只读，未实施）

| 方向 | 实际边界与本轮结论 |
| --- | --- |
| 持仓端点与Worker DTO拆分 | `js/runtime/worker-contract.js`第一次行投影后第二阶段重写status/source_status/transport_status；保留公开legacy/getter/错误顺序的简单拆文件不能消除两阶段语义。没有合格的大块删码候选。 |
| resource cache与aggregate投影 | `js/runtime/refresh-resource-cache.js`读返回规范化对象，序列化则验证后保留旧raw envelope/未知字段与原时钟；复用读结果会改变旧缓存。应用slim仍被其他保存入口使用，没有整算法可直接删除。 |
| 行情展示统一 | `buildFundData`、旧缓存展示与render分别承担新选择、旧投影保留和老化，不是三个等价的重新选择器；render重新选择会改变选中来源及旧/官方优先级。 |
| property mangle | Quote/持仓/资源行进入公开DTO/持久化；scope counters由 `generation-resource-scope.js:126` spread进snapshot并被executor读取；仓储 `v3Raw/v1Raw/projectionMetaRaw`是journal/backup与反射格式；Bridge/coordinator是导出可观察实例，均不属于封闭字段族。`holdings-estimate.js:106/124`的局部quoteMs仅一写一读，不是材料性优化。不能按对象私有就全局改掉同名的公开字段。 |

这些是有限方向的静态审查，不是证明所有未来重构不可能。下一步应有新的、可刻画兼容行为的结构性源码候选；不重复历史helper/布局/字段表/压缩器参数扫参，也不为了推进里程碑擅自修改预算。

## 试验结束后的原配方回归（不是候选验收）

归档证据期间按项目规则另跑当前未换压缩器的完整门禁，见[baseline-regression.json](baseline-regression.json)：`npm test` 1064/1061PASS/0FAIL/3Windows条件skip（6009.1525ms）、`npm run check` 205文件、两次 `npm run build` 均exit0；本机Chrome `npm run test:e2e` 31/31（1.1m），使用预先确认未占用的12437端口，完成后端口不再监听。E2E的NO_COLOR/FORCE_COLOR告警保留，不宣称所有console信息为零。官方npm audit实际0。

两次build固定 `SOURCE_DATE_EPOCH=1792046773`，构建日志逐字一致。E2E结束后最后一次build清理测试产物，whole inventory恢复为前述7d4d8c1e/127文件/92507677B；critical集为4bda36bc，两者不是同一种指纹。实际字节/SHA核验app16chunks/235647B、OCR23assets/88196906B通过，未运行OCR引擎。最初OCR核验误传site根而非site/assets/ocr，报缺asset-manifest；已按CLI要求改正并独立exit0，不把调用错误隐去或误记作产品故障。

这批回归针对**原OXC最终产物**，不是Terser/esbuild/SWC候选；不得覆盖 `summary.json` 在试验结束时保存的NOT_RUN状态，或把它升级为候选压缩镜像/兼容/相对时延证明。最终budget仍exit1。原始完整日志在Temp，本文归档其hash与命令，不宣称raw日志本体全部入库。

## 证据与复现

- [summary.json](summary.json)：三个系列各自的事前协议、全部18次测量/输入hash、代表chunk逐字节信息、前后inventory、算术hybrid筛选及NOT_RUN边界。raw report SHA绑定原Temp报告，未声称raw报告本体全部入库。
- [archive-audit.json](archive-audit.json)：工具、初版失败工具、Temp独立package/lock的原始与LF规范化SHA。`tools/*.txt`是证据副本，不是项目运行脚本或依赖变更；保留所有试验选项，不只留下最小的一次。
- 原始输入、候选输出、各轮record/protocol及raw报告：`C:\Users\84046\AppData\Local\Temp\fundval-m3-minifier-5806c73ce04e4538992a1f6a39f21444`。Temp可能日后清理，所以已把协议、指标、逐输入hash、工具及依赖锁存入本目录；原始完整chunk尚仅在Temp。
- 复现须新建独占Temp，准备该提交 `source/`，在试验目录按归档package/lock执行冻结且忽略脚本的npm安装，SWC在 `swc-probe/`同样处理；用未改动项目Vite/esbuild及相同Node/npm执行工具副本（恢复 `.mjs`名）。脚本拒绝覆盖已有series目录；每轮自己重新验证baseline与图隔离。工具中的绝对工作树路径需按实际位置明确调整并报告，不能把改工具后的结果冒充原封不动复现。

本轮仅归档证据，不提交/推送新的业务变更，不触发部署。旧精确源码提交的CI不继承为这份新增文档的CI。
