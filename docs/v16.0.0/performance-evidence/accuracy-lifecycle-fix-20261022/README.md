# 海外 accuracy 自动生命周期：有限 P1 修复检查点

2026-10-22（Asia/Shanghai）。`15.0.2 / M3 IN_PROGRESS / NOT_RELEASED`。这是本地合成数据正确性修复，不是压缩策略采用、M3 EXIT、生产金融对账或发布。实施前协议见 [PROTOCOL.md](PROTOCOL.md)。总包预算仍失败。

## 真实问题、修复与边界

§51 的模型证据修复后，主结果通常先发布正式净值，市场模型在 enrichment 才到达；`js/app.js` 只在 primary commit 触发 accuracy，enriched 只 upsert/render。因此真实 App/Bridge 已显示合格模型，但自动预测账本仍空。

本轮只改变 `js/app.js`、`e2e/v16-refresh.spec.js`，新增 `test/accuracy-lifecycle-v16.test.js`（12 项）：primary/enriched 共用 private accuracy 调度；动态 import 完成后再次通过原 generation `context.commit`，并检查当前 code 对应对象仍是同一个基金投影。旧代、被替换/删除的对象不能晚写账本。成功后使用原去重渲染；没有重复调用包含自动改名和持仓事务的整个 primary commit。`js/accuracy.js` 核心预测、去重、结算、持久化格式未改。

没有改变模型公式/优先级、独立来源证据、null/0、市场时区/时段、缓存 TTL、五加载组、OXC、ES2022、Bridge sandbox、Schema 3、云同步或 OCR。没有提升预算、版本或依赖。

## OLD → GREEN 与真实浏览器观察

独立 Temp 的 accepted-session v4 用例、输入和期望在修复前冻结，修复后保持同字节。它通过真实已构建 App/bootstrap/opaque Bridge，不直接调用 accuracy 函数。

- OLD `red-04`：模型 `value=1.212 / changePct=1 / baseNav=1.2 / baseDate=2026-09-25 / targetDate=2026-09-28 / market-model / rule-v1 / confidence=.35`、独立证据与页面显示均通过；账本期望 1、实际 0，native **1**。
- NEW `green-01`：完全相同 v4 用例 **1/1 PASS / native0**。完整正式 E2E 再验证自动预测、暖刷新后账本结果保持一条、后续公布正式净值的结算。
- US 实际行情时段为 9/28 16:00 EDT→中国 9/29 04:00；中国 9/29 14:30 的预测目标是 **9/28 下一公布净值**，不是中国“今日涨跌”。1.212 不回填为官方净值。
- 正式 E2E 进入下一中国日后给出正式 NAV `1.224 / base1.2`：保留原一条预测 `predicted_change=1`；`actual_change≈2`、`error≈−1`、`direction_correct=true`，9/30 结算。旧美股时段不足以支持新目标时，不制造第二条预测。真实浏览器版本 `155.0.8059.86`。
- 暖刷新断言证明账本**结果幂等**，不证明零写入尝试或命中内部某个 dedup 分支；现有 `saveAccuracy` 仍可能写入。单测 import seam 明确替换为受控 loader，不冒充 ESM 行为证明；真实模块由上述 E2E 补充。
- 所有数据/Storage 为独立合成 context，未读写真实持仓/Gist。未证明统计面板 DOM、所有存储失败、所有取消路径的真机 E2E 或真实行情精度；信任结论仅 `CONDITIONALLY_TRUSTED` 于这组字段/时段/生命周期。

### 原失败一并保留

`red-01` 的 CJS/fileURL loader 和 `red-02` full-title grep 均为工具配置失败（0 项测试），不算金融 RED；`red-03` 夹具的 US session 与目标不匹配，被产品正确拒绝，也不算本 P1。分别创建新配置/用例，保留旧 native/receipt/trace，没有覆盖失败。RED04/GREEN01 的 stderr 各有两条 `NO_COLOR` 提示；不写成 stderr=0。完整 E2E 的相同提示也保留。

## 完整原配方 QA / 实际成本

| 检查 | 实际结果 |
| --- | --- |
| `test-01` | 1316 total，**1313 PASS / 0 fail / 3 原有 Windows skip**，native0 / stderr0 |
| `check-01` | 215 JavaScript 源码/测试语法通过，native0 / stderr0 |
| `e2e-01` | **35/35 PASS**，native0；stderr352 B（两条颜色环境提示） |
| `build-02 / 03 / 04` | 三次 native0 / stderr0，完整 **127** 文件路径/大小/SHA 相同 |
| 完整 site rows SHA256 | `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31` |
| 当前 chunks | 16；raw **252,331 B**；all gzip **85,969 B**；cold gzip **46,149 B** |
| 相对 §51 修复前 | all **+13 B**、cold **+20 B**；不把正确性成本隐藏为压缩收益 |
| 原 budget CLI | native **1 / FAIL**：all85,969 >77,227.7；cold46,149 ≤52,241；至少还需减少 **8,742整数B** |
| 原 graph CLI | native0；static binding / literal import closure true；`evaluated/startupOrder/dynamicNamespaceMembersVerified=false`，不是完整运行语义证明 |

四次 build（含前置 build-01）身份一致；最终三次使用固定 `SOURCE_DATE_EPOCH=1792046773`。当前完整输入273（比 §51 多一个测试）、非历史输入249；只有计划内两修改/一新增。24 个历史 Android 大输出只核对清单，不重复打包。安装依赖明确68项、HEAD/分支/index 前后不变；不是 immutable main candidate。源和产物详细身份由归档审计给出。

工具限定：早期 `CURRENT_CONTROL.json` 明确从旧 control 展开，新 source/site/chunks/all/cold 已覆盖，但未使用的 `raw` scalar 仍继承旧252257；原件保留不改写。当前252331由真实chunks字节及最终归档新枚举计算，不依赖该旧scalar。gate 的272行是排除docs后的输入，再加固定历史反馈一行才是完整273。

## 同轮前置研究，不等于当前候选资格

- 在本 accuracy 修复之前，用 §51 的272输入/248非历史源码重建 A/B：只 B 的 `worker-contract.js` 使用旧验证/legacy-finisher 分界改法。固定公开64例逐侧对原保存控制和 A/B 完整比较，3 negative controls、131 调用；fetch/local/sessionStorage 保护为0；两侧固定6测试各 **97/97**。没有完整 private pipeline、构建/包体收益或采用。第一次 recheck 因错误测试路径 native1，结果未及时持久化，不能算合格；更正独立 v2 才获得实际 raw。
- 该旧分界即便通过公开控制，也未证明足够删除闭包：不以“移动所有者/新增 envelope”冒充减少算法。报告/两侧全部248实际源码/输入/输出/工具/失败保留。
- Closure hybrid 只读源码研究：可保留2个 TLA OXC chunks、对其余14单独 SIMPLE Java API 试验；**ADVANCED NO-GO**。单独 `Es6ModuleTranspilation.NONE` 不足，仍需实验性 `enableModuleRewriting=false`，LOCAL/exports/getter/Proxy/live binding/arity 须实际 fail-fast。报告基于修复前 §51 清单，未执行编译器、未证明收益。
- 有限本机盘点没有找到 Java；只读 Temurin 固定 JDK21 ZIP metadata。Java 报告最初对齐旧 `v20261007` 源码基线，Closure 报告后来单独核到 Maven 实际 `v20261020` JAR；前者不能替代后者的二进制运行证据。**本检查点未下载/安装/执行 Java 或 Closure**，未改 PATH/JAVA_HOME。

## 原件及后续门槛

`original-evidence.tar.gz`、`inventory.json`、`archive-audit.json` 保存本轮 lifecycle 原件（全部失败、实际 trace/截图/JSON、同字节 RED/GREEN case、全部 gates/native）、旧源 A/B重基线和只读压缩/JDK报告、当前249实际非历史源码以及选定产物。归档自身和归档后原生审计为显式 addenda。完整127产物及68安装依赖是清单身份，不能声称都含原始 payload；旧 A/B `unpacked` 是 §51 已归档的791成员重复解包，明确不再复制。归档成员数/SHA、逐成员新解压结果以 `archive-audit.json` 为准。

当前新统计性能、精确候选 CI、真实金融源对账、Gist/OCR/真机/PWA升级与生产/回滚均 **NOT_RUN**。旧800配对样本属于修复前身份，不继承。下一安全步骤是在**当前**身份冻结独立固定压缩配置，先实际 fail-fast，再考虑完整产物行为/包体/确定性/性能；不得扫 flags、删保护或移入 HTML/eval 隐藏字节。M3 总预算未过，不进入 M4、不发布；本轮未提交、推送、合并、部署。

## 归档后 addendum

主归档审计实际 **28项 PASS / native0**，tar create/list/extract全部native0/stderr0；新解压全量成员字节/SHA相同。归档 **25,355,843 B / SHA256 `893e5a0128bdd4af995744c0ef658c1d228d9632a47060a1e2270093b011fbc3`**；**1,196成员 / 62,962,286 B**，成员清单SHA256 `a9ec96f2299b91919705512bb2aa2791fd15cc412267cb42f508828f4d19663b`。当前273完整源行SHA256 `d0d9554fef7d2ef4b75f67a7db4fef558e03bb03f0897f2305617c6361090a3e`，与完整site127、安装68、HEAD/分支/index在归档窗口前后同。`git diff --check` native0，但stderr1822 B为既有LF→CRLF警告，未冒称stderr空。此addendum及包外审计原件不在已冻结tar中。
