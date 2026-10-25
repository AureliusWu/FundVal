# 完整估值管线原型：有限前置边界与来源缺陷检查点

2026-10-22。状态：`PARTIAL IMPLEMENTATION / NOT ADOPTED / M3 IN_PROGRESS`。应用仍为15.0.2；不是发布或完整性能候选。

## 本轮做到了什么

从冻结的246份实际工作树输入建立一个系统Temp候选，未使用干净HEAD代替脏工作树。唯一候选业务改动是 `js/runtime/worker-contract.js`：把原 wire validation 与原 late-spread legacy materializer 分开，原公开函数签名/default和验证顺序保留。没有新私有HTTP、resource内部模型、aggregate importer或App接线；不能声称默认bundle已经删除任何旧构造器。

一次有限公开边界对照：64个 stored OLD / fresh OLD / candidate记录全相同，3负控匹配，共131调用、native0/stderr0；denied fetch/localStorage/sessionStorage均0。原raw 6,421,240B/SHA256 `53c2700a5768242168d98caf1632311d184765c130610a716dac12d5f9710918`。这是公开wire边界，不是完整私有HTTP或整个输入域的证明；没有构建/净gzip结果。

两个独立代理建立另外的真实OLD控制，主代理完整阅读报告，并由第三代理只读复核方法和界限：

| 控制 | 实际结果 | 必须保留的失败/限制 |
| --- | --- | --- |
| R01/R03/S01/S03 | 234/234 root/frozen完整记录相同；native0；599资源子操作/侧 | 第一次冻结遗漏calendar JSON，native1/completed0；原件保留。纠正目录的计划/runner等未改。并非任意输入或完整App/coordinator证明。 |
| A08/M04/C01 | 34/34 root/frozen完整记录相同，68顶层调用 | 原预测33/34正确；HK预计entry、实际rejected，baseline native1保留。后验双模型kind断言另native1保留。不能写成“34预期全绿”。 |

234 raw 37,057,036B/SHA256 `54402bff2876697d005b301bc0fc16686c8f88f8a3fbdf2c7d98fb1ac263737c`；34 raw 6,704,652B/SHA256 `56dfd31b9116842bb21ee59eae31e4631b2e817d2d1947e886bface0869b83d2`。代理原native收据、脚本、fixtures、源副本和完整raw均保留，而非仅摘选通过的summary。

## 不能把旧控制说成全覆盖

- 234顶层五个继承字段的实测是own/absent，**未覆盖真正的inherited属性**；早期协议措辞不能升级覆盖范围。
- 234 scope只测fresh acquire/stage/flush和写次数，不涵盖cache-hit/use-time/cancel全矩阵；context是明确的合成adapter。
- 234异常记录name/message/constructor.name及sentinel `===`，不是全instanceof/prototype契约。34中的HTTP另记录真实WorkerContractError class绑定；两者范围不可互换。
- App AST原文切片使用真实依赖，但没有启动全App/DOM；render回调未执行。M04在build后**显式调用**真实accuracy入口，而生产App的enriched回调没有该hook，因此不是生产PhaseB记账验收。
- HK旧实际拒绝有可追溯原因：当前calendar没有HK，Quote为delayed，而HTTP row仍有est_realtime=true，resource拒绝冲突。未来candidate执行前有单独acceptance correction，仍保留旧错误forecast；不能修改旧case或放宽validator。
- 独立旧控制相同只说明记录已固化；不是新算法互证、全QA、真实数据源对账、时延/设备/生产资格。

## P1-M04-PROVENANCE：可达的候选来源归属错误

真实 `data/overseas-models.json` 的“沪深300”规则也会匹配境内cn-index基金；刷新允许其重仓、又为所有active选择市场模型，两条路径可在同代运行。`composeFundEnrichment`先安装重仓1.2%/coverage60，`buildFundData`再安装市场模型3%/coverage100并覆盖共享est_*，但不清理est_holdings_model。`normalizeHoldingLookthroughQuote`读到的是后写3%，同时继承est_model，结果季度来源候选也成了model_estimate。季度来源只有holding_lookthrough能力，候选来源与值/类型的归属不真实。

这是有真实配置可达证据的候选provenance P1，**未证明线上已发生或用户主金额错误**：本批最终selected是market-model，主Quote/金额与3%一致；不能扩大成资金损失或整个市场数据不可信。正常缓存优先已有selected Quote；无selected的legacy路径尚未在本批执行。另发现App enriched未走accuracy hook，仅为代码级覆盖缺口，不宣称已测出生产漏记发生率。

下一步应先隔离定义模型来源修复：保留两套模型时必须保存各自独立值、时钟、基期/目标、coverage/version/note；旧双flag且缺少独立季度证据时不得从被覆盖的共享est_*伪造季度来源。只改kind并不能修复数值归属。选择单一模型的覆盖政策也应明确，不以减包为由暗改。

本轮只修正Temp协议的自设边界：原“复现双flag/shared writes”仅用于不可变OLD记录，不能充当采用该缺陷的要求。原协议保留并追加说明；**没有修改root业务，也没有模型修复实现**。后续有意修复须独立回归和保留旧RED，不能反填旧oracle；完成修复后变更源码身份的候选不能继承既有800配对性能结果。

## 默认图仍未闭合

独立源码复核确认：App fresh build和缺Quote旧缓存仍调用 `buildFundQuoteCandidates`；详情重仓仍调用公开 `fetchFundHoldings`；`normalizeExistingQuoteFreshness`在resource、cache和render仍为共享活算法。只迁移刷新HTTP不能证明generic parser或旧适配器被tree-shake；多次调用也不是多份重复源码。

完整候选至少还需同时闭合：私有静态入口/namespace、Worker公共finisher、私有HTTP及第二钟校验/真类rescue、resource严格输入与presence codec、官方/独立模型生产者、三路旧aggregate importer、App/详情/accuracy投影、两个outer writer。旧缓存解释和codec有真实成本，移动/改名不算删除。暂时没有支持净减6960B的量化资格，不能以原始行数或被移动文件大小相加代替gzip测量。

## 归档协议与停止点

本README先于归档执行写入。只做一次新检查点归档：完整复制四个已冻结Temp工作区（公开边界原型、234首次失败、234纠正、34旧控制），并保留父级归档脚本及引用的原root身份库存。原workspaces不删除/覆写；归档不包含root完整site/安装依赖的payload，相关库存只是身份复核，不冒称全载荷。

归档前后重新核验：root270构建输入、完整127 site、68显式已安装文件和Git HEAD/branch/index；候选246输入只有worker-contract一处预期差异；全部OLD脚本/原native/raw仍不变。不重新运行任何业务case、不修复产品、不build、不扫minifier、无网络/浏览器/真实Storage/OCR/云操作。压缩包在新Temp安全解压后，重新枚举全部成员逐项复算字节/SHA；归档工具完成状态与保留的业务native1分开报告。

本轮没有新的完整test/check/build/E2E/audit/时延/CI。原root包体积 **84,187 B / cold44,699 B** 只是未变产物的复核；all上限 **77,227.7 B**，至少仍差 **6,960整数B**。原预算、ES2022、五组、启动隔离、功能和校验不放宽；未采用压缩候选、未推送/合并/部署/升版，未进M4/M5/M6。

归档结果将在同目录 `archive-audit.json` / `inventory.json` 中记录；它们是归档后的旁证，不在其自身压缩包内。

### 归档执行结果（包外追加）

主工具唯一一次执行于06:05:58.043Z→06:06:18.155Z，native0、stderr0，23项检查通过；没有重新运行业务case。原件 [original-evidence.tar.gz](original-evidence.tar.gz) 为13,253,373B/SHA256 `28d433c676c4fbf33a222ef1a8cd5bf1cfabd698309463dd2f308e7882345960`。916成员/128,278,491B，rows SHA256 `070103c82d3a13e40f59e0be9ae596993a73bb753c1fa95645b3b8d3f67de0ec`；新Temp完整解压后逐个重新枚举、字节/SHA一致，四个源workspace仍未变。

root270输入、127site、68显式安装文件及HEAD/branch/index前后相同，实际产物gzip仍84187/44699。`git diff --check` native0；stderr的9项旧LF→CRLF告警原样保留，不是新业务失败或零告警。完整 [archive-audit.json](archive-audit.json)、[inventory.json](inventory.json)、[主native收据](parent-native.json) 及工具/原输出在本目录；它们和此追加段是包外旁证，包内保留追加前README，不冒称包内文本与后加段相同。

原型只有一处源改动，不采用；当前仍缺完整默认图/模型来源修复/完整QA/确定性构建/净gzip/新性能与CI资格。保持M3进行中。
