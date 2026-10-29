# M3 执行跳过事实与新的依赖安全阻断

日期：2026-10-22（Asia/Shanghai）。版本仍15.0.2；分支 `codex/v16.0.0-m3-continuation`，HEAD仍 `170fd3eadc6da02750882f8a542904ee2358d0d9`。本轮业务/测试为本地未提交工作，不是v16发布。

## 当前结论

- 已完成原6.3“为何跳过”的最小执行观察：估值/重仓/模型源 claim 拒绝，以及重仓/模型本代半开额度已用。只记真实拒绝分支，不重放判定、不倒推精确冷却原因。
- 最终全量1224项：1221 PASS /0 FAIL /3既有Windows条件skip，8005.9732ms；syntax212；原生Chrome E2E **33/33 PASS（1.1m）**。
- E2E后原配方固定epoch1792046773三次真实build，全127文件逐字一致，230选定输入前后相同。
- cold **44699/52241 B PASS**；all **84187/77227.7 B FAIL**，至少仍需减少 **6960整数B**。本轮增加功能all540B，不是减包优化。
- 本轮官方npm审计首次network timeout，随后一次20s/0-retry检查实际返回 **1个high依赖项：vite@8.2.2**，关联6条GHSA。审计native exit1，不能引用10月20日的0作为当前结果。没有运行audit fix/force、install或改变package/lock。
- 无新相对时延资格/精确提交CI/真机/实时金融核对/云写入/生产部署。**M3 IN PROGRESS，不进入M4或发布。**

## 原范围与最小实现

原 `UPGRADE_PLAN.md:213` 要求计划、缓存、跳过、请求、取消和最终Quote可诊断；M3退出条件还包括TTL、去重、过期代不写和性能。它没有要求全量门控细因历史。因此本轮不新增registry taxonomy、全量逐资源事件或新的M3硬退出条件。最终Quote仍由逐基金数据说明展示，不复制金融值/金额到Store。

`executionSkips` 是每个阶段的新冻结快照，固定五键：

| 字段 | 真正的含义 |
| --- | --- |
| estimate_claim_denied | 全部实际进入的估值client调用均同步上报合法bool后，原claim拒绝次数；未完整观测为null |
| holdings_claim_denied | 原重仓 `!claim.allowed` 拒绝分支发生次数 |
| holdings_probe_used | 原重仓 `halfOpen && probeUsed` 本代额度耗尽分支次数 |
| model_claim_denied | 原模型 `!claim.allowed` 拒绝分支发生次数 |
| model_probe_used | 原模型 `halfOpen && modelProbeUsed` 本代额度耗尽分支次数 |

计数单位是门控检查，不是唯一资源/证券/基金数，也不是“省掉的HTTP数”。一份拒绝claim可在本代被复用；模型被拒绝时共享境内证券仍可能请求。拒绝可来自cooldown、unavailable或已占用探针，不统一叫冷却。

### 代码路径

- `js/app.js:fetchRefreshEstimateRows` 第五参数为可选私有bool观察器，默认arity仍4；原claim.allowed只读一次，原日志/错误码/dispatch/Date读取/return不变。observer throw/reject/then getter均隔离，不await。历史 `source_cooldown` 日志未改，不能把该旧名称当精确原因。
- `js/runtime/refresh-execution.js` 默认无diagnostics时仍传四参数；观察开启才给第五闭合collector。只接受调用返回前首次合法bool，非法不强转/不封死，重复及Promise/thenable/微任务迟到回调忽略。每次真实client入口计visited；started或visited=0或observed!=visited时，估值拒绝值为null。两批只观察一批，不能显示0。原其余四业务参数AST独立锁定。
- 重仓/模型原combined判断拆为两个if，保留allowed→halfOpen短路和读取次数，只在原拒绝分支递增本地计数。source registry、两个coordinator、scope、security batch及金融验证代码未改；不增claim/health/clock操作。
- `js/runtime/refresh-generation.js` 固定五键、自有data descriptor、安全非负整数/null、复制冻结。初次显式自有data字段即opt-in（invalid也为未观测null）；缺失/继承/accessor不让旧记录新增字段。一旦opt-in，新accepted缺失/invalid为null，不继承旧0。started-only终态为null，真实晚drain可补；原三槽、阶段/代际及planReasons继承不变。
- `js/runtime/diagnostics-ui.js` 固定五中文标签，真实0保留，缺失为“未观测”；明确“按门控检查次数统计，非请求或唯一资源数；拒绝细因未记录”。读取/复制不写持仓、缓存、云或加载OCR。

## 验证与时序边界

1. Store/view RED为39项28 PASS/11 FAIL，实施后39/39。原工作树已有中断留下的9项新契约测试，本轮补2项；不称十一项全为本轮新创或旧金融Bug。显式invalid opt-in的夹具契约已澄清，保留原日志。
2. 真实旧site唯一诊断测试1 FAIL：缺“执行跳过”行。新site完整E2E包含其GREEN。
3. 新 `test/refresh-execution-skips-contract-v16.test.js` **48/48**：独立冻结完整旧App函数AST恢复比较，十类VM路径getter/dispatch/日志/clock/sentinel及0/null；observer异常不产生unhandled；旧默认arity4、同步/非法/重复/late/thenable/两批全部/部分观测、无client入口、冻结与业务/cache等价。父进程在首次测试前已实施App/executor，**没有live实施前业务RED**。最初括号AST、跨VM原型、被既有allowlist清除的夹具字段错误均为测试问题，不当产品回归。旧App函数及旧四参call表达式只作明确标名负控，不是完整历史executor/产物。
4. 原完整executor harness新增6个GREEN-only真实coordinator/registry样本：cooldown/unavailable/已占用probe三种拒绝同为generic事实且无额外claim；两持仓半开只请求一次；模型拒绝但共享境内证券仍有合法0；65个模型需求只派发64个的首批，后批额度拒绝不能计成第二次网络请求。连同Store/view定向88/88，不能泛化为全部金融输入等价。
5. 新原生Chrome非零E2E：三次实际估值源失败触发原threshold3，公开online启动第4代，无私有hook/改policy；第4代估值/nav/holdings网络均0，五键为 `[1,0,0,0,0]`，其他证券/黄金/腾讯请求共4。官方1.1900（9-25）→1.2000（9-28）/+0.84%保持，稳定envelopes/hash不续；诊断再读无网络/所有localStorage变更API/云写入/OCR，摘要脱敏。
6. 第一次完整E2E32 PASS/1 FAIL，新非零夹具把既有kindLabel错写“正式净值”，实际是“最新净值涨跌”（正式净值是status语义）。仅修一行精确预期，未改产品/放宽数值日期。保留首次完整stdout/stderr、失败截图/trace；修后单项普通及JSON各一次PASS，JSON保留真实attachment正文，再完整33/33。
7. 最终unit/check在上述一行E2E夹具修正后重新运行，分别1224/1221/3skip与212；不是把较早窗口授予最终源码。两个coordinator等保护文件对HEAD无diff。

所有数据为合成，不是实时金融源/实际用户账户。诊断计数契约结论 **CONDITIONALLY TRUSTED**；新审计告警和性能不足使整体不具备发布资格。

## 构建与性能

| 指标 | 第43节产物 | 当前 | 差值 |
| --- | ---: | ---: | ---: |
| all gzip | 83647 | 84187 | +540 |
| cold gzip | 44514 | 44699 | +185 |
| 16 chunks raw | 243660 | 245170 | +1510 |
| whole site bytes | 92532345 | 92537133 | +4788 |

三轮whole JSON库存 `5b946d23a08cd42743e5151b3ba5bb62ec52b7b6016dcd83eafaac42817124a9`（127文件），critical `3103251a7107ebb76d61c0a7131430ccf221e204e6aac931a319649c7608bf55`。230选定source/tool/test/config库存 `ac1ef4adf7e4f117b43087d370b6eb99d4de3eb98295769e5161a3a0e32bed20`，构建前后同；不含docs/evidence/node_modules/Temp。

原五组/ES2022/配方/依赖/预算不变。实际图16chunks/18静态边/10字面动态边/6cold、native绑定PASS，不evaluate或证明所有启动/TDZ行为；OCR23/88196906B仅核字节，不运行引擎。预算原CLI native **exit1**；wrapper expected=1而exit0只表示捕获预期失败。没有重跑800/1000配对或新策略筛选，旧4bda时延不继承。

## 新的安全结果，不沿用旧audit0

原完整audit因官方bulk端点网络超时退出1，不是零漏洞；随后 `npm audit --registry=https://registry.npmjs.org --audit-level=high --fetch-timeout=20000 --fetch-retries=0` 成功收到报告但因漏洞退出1。1个high依赖项vite@8.2.2关联六公告；具体high来自[Windows存在性检查绕过公告](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm)。其余五项为[百分号转义](https://github.com/vitejs/launch-editor/security/advisories/GHSA-698v-4r3x-3vcv)、[编辑器参数解释](https://github.com/vitejs/launch-editor/security/advisories/GHSA-r825-w8mm-5pxw)、[自定义middleware跨源脚本](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw)、[非Windows路径范围](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)、[WASM错误前4字节](https://github.com/vitejs/vite/security/advisories/GHSA-vfpm-58rq-9qcg)。不是六个已证实的线上漏洞。

官方公告列8.2分支 `8.2.4` 为修复版本。当前项目serve是自写Node静态服务，Vite用于build；没有把告警推成“静态Pages已经可RCE”或宣称完全不受影响。后续须在隔离目录验证最小安全patch、来源/锁/脚本allowlist、完整回归和确定性产物，再决定采用；不直接按npm提示force到8.3.5。此处仅triage，未安装或修复。

补充只读triage见[六公告矩阵、精确registry元数据和资格清单](security-triage/README.md)：8.2.4是保留当前minor的最小受支持候选，声明的engines/dependencies/optional/peers与8.2.2一致，不等于包内容或产物相同。Vite内联launch-editor，lock没有独立条目不代表安全。该补充在93文件归档封存后单独保存于security-triage/，不冒称属于原压缩归档，仍未安装/验证/采用。

## 原件

[机器摘要](qa-summary.json)、[归档审计清单](archive-audit.json)、[归档工具](archive-tool.mjs.txt)。[完整原件](original-evidence.tar.gz)为1015099B，SHA256 `f0d7588bc99df478c4ecb15ac4735f680e5b185e27e23dd84bfca631a40aec1b`；93文件/2411303解压字节，新Temp解压逐路径/长度/SHA全同。

main含命令原始stdout/stderr/exit、四份窗口前源码/九份最终源码测试、当前diff/Git、三轮全库存、16份实际非OCR JS+manifest和两轮完整E2E附件；store/contract含定向日志与参考/夹具边界；e2e-red是真实旧site缺行，e2e-nonzero是标签修正前副本，e2e-correction含精确一行修正与JSON attachment。并非所有中间编辑态都另存快照；原repo Temp冻结副本仍保全未删除。CLI audit网络错误和实际high报告均保留。

**未提交/推送/合并/部署/升版；M3 IN PROGRESS。** 依次仍须处理安全patch资格、材料性减包、最终候选相对性能与精确CI；不以新增全面gate细因历史、M4云功能或M6真机作为额外M3硬门禁。
