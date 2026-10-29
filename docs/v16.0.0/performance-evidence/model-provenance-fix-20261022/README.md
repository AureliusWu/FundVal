# 独立双模型来源正确性修复（本地，未发布）

2026-10-22。状态：`LOCAL_FINITE_REGRESSION_PASS / M3_IN_PROGRESS / NOT_RELEASED`。协议见 [PROTOCOL.md](PROTOCOL.md)。本轮是数据来源正确性修复，不是新压缩策略的等价性采用。应用仍15.0.2，HEAD170fd3e、分支codex/v16.0.0-m3-continuation，保留既有脏修改。

## 问题和实施范围

真实`data/overseas-models.json`的沪深300规则可与季度重仓模型同时命中。旧App先安装重仓、后安装市场模型，共享`est_*`最后写入者覆盖值/时间/说明，但遗留两个flag；季度候选因此可能带市场数值和错误kind。这是可达的候选来源P1，旧记录最终selected仍是正确市场模型，不能推断线上主金额损坏或用户损失。

本轮只改五个业务文件：

| 文件 | 修复 |
| --- | --- |
| `js/holdings-estimate.js` | 成功安装时保存冻结、绑定基金和报告日期的独立`holdings_model_evidence`，保留旧公开字段/签名 |
| `js/runtime/fund-model-enrichment.js` | 独立`market_model_evidence`保留该模型自己的值、基期/目标、时间、覆盖、版本/置信及有效期 |
| `js/runtime/quote-normalizer.js` | 新槽只读自身数据属性；固定source/kind/tier，验证身份、计算关系、周期、时钟和有效期；损坏槽不从共享别名救活；无新槽的旧单模型继续适配，无证据的旧双模型不冒认任一来源 |
| `js/app.js` | 模型安装边界传入采集时间；已有selected缓存仍优先，但证据绑定/有效期失败则保留原值/时钟并降stale；说明及次要模型显示绑定实际来源 |
| `js/accuracy.js` | 预测入口只接受同基金市场模型Quote；0保留、null/未知不从共享旧字段补齐，过期新槽不记录预测 |

没有改Schema3、Gist写入、Worker、OCR、依赖、版本、Service Worker、ES2022、五个加载组或原预算。模型新槽是aggregate投影，不进入严格resource白名单。没有加enriched accuracy hook。

## 先红、修复和最终验证

唯一OLD13测试：7个金融来源RED、6个控制PASS，13案全部完成/native1；原件不覆盖。P09“双向歧义均不可usable”在首次执行前经审定，非看结果后改预期。最初GREEN和最终`green-02`均使用与OLD完全同字节的案例/测试，最终13/13/native0。每轮选定35份源前后70项SHA检查同，逐case无真实fetch/Storage；这些守卫不覆盖imports，原13也没有完整selected/App/accuracy生命周期断言，正式测试及E2E另补有限覆盖。

最终源码的原生门禁：

| 门禁/记录 | 结果 |
| --- | --- |
| `gates/test-03` | 1304 tests；1301 PASS/0 FAIL/3原有Windows条件skip，native0、stderr0 |
| `gates/check-02` | 214份JS语法检查，native0、stderr0 |
| `gates/e2e-03` | Chrome本地34/34，native0；stderr保留两条NO_COLOR/FORCE_COLOR告警，不称零告警 |
| `gates/build-04/05/06` | 原配方/固定epoch1792046773，三轮native0；每轮完整127文件字节及SHA一致 |
| `gates/graph-02` | 16chunk、18静态/10literal动态边、6cold；literal closure/static binding通过，非动态成员/完整启动顺序证明 |
| `gates/budget-02` | **native1 / FAIL**；all85,956 > 77,227.7 B，cold46,129 < 52,241 B |

完整127文件库存SHA（JSON行序列）：`4182f49e01661469cbc13c51d9ff7ddcfb0081a4908d2511736609eb47606da2`。16chunk raw252,257 B；相对修复前all84,187/cold44,699，正确性成本为**+1,769/+1,430 B**，原all预算还需至少压减**8,729整数B**。不会为这项修复调整预算或删验证。

新增正式测试：`test/model-provenance-v16.test.js`60项、`test/model-consumers-v16.test.js`20项。覆盖真实规则双模型、身份/损坏/访问器、旧单/双flag、JSON、null/0/负值、时钟不续期、报告与模型有效期、已有selected缓存、来源绑定说明和accuracy入口。原`test/accuracy.test.js`增强合格Quote fixture；原重仓集成源码断言只更新显式采集时钟参数，没有移除该断言。

新增真实App E2E沿bootstrap→Bridge→刷新→render→cache reload，外部响应均合成：基值1.2，重仓80%×2%=1.6%→1.2192，市场100%×3%=3%→1.236；selected市场、金额123.6/当日3.6，说明是市场覆盖100而非重仓80，重载保留两个槽的原采集时间。没有真实用户持仓、云写入或线上行情。list reporter不持久化成功用例的内存attachment；本次保留原生输出、测试源码/断言及`.last-run.json`，不声称成功用例JSON附件文件已落盘。

## 原始失败不能抹去

- `test-01`：native1，1300 PASS/1 FAIL/3 skip；唯一失败是原集成源码正则未包含新显式fetchedAt参数。修正fixture/断言后`test-02/03`通过，不改业务来迎合旧文字。
- `e2e-01`：native1、33 PASS/1 FAIL；新fixture让重仓证券涨幅同时覆盖sh000300主源数据，真实App按来源优先级得到2而非期望3。分离两类合成输入。
- `e2e-02`：native1、32 PASS/2 FAIL；fixture用`??1`把显式null变成默认1，破坏原缺值测试。改为保留own-null，仅有限数值生成价格；原缺值断言未改。
- `e2e-03`最终34 PASS。三轮生成目录均在构建前移动到本次Temp工作区保留；前两轮trace/screenshot/error-context为合成测试原件。未删除实质文件或真实用户资料。
- OLD工作区事后`POSTFLIGHT.json` native1完整保留：三份root源在OLD采样结束后被本次修复改变，不代表OLD采样窗口源漂移；OLD内部70项仍同。没有将这个失败包装成PASS。
- 早期`targeted-01/test-02/check-01/build-01..03/graph-01/budget-01`保留原记录；早期构建产品字节同，但后来的E2E fixture源码发生变化，最终资格以本节指定final记录为准。

## 证据身份和归档边界

主工作区：`C:/Users/84046/AppData/Local/Temp/fundval-model-provenance-fix-20261022-parent`。OLD工作区：`C:/Users/84046/AppData/Local/Temp/FundVal-dual-model-P1-red-20261022-a1`。本目录归档包含两完整工作区、最终248份非历史输入实际字节、最终构建的chunks/manifest/index/SW、全部127输出库存及68份安装库存。24份历史Android输出、127site非selected文件和68份安装payload只保库存，不冒称完整字节均在压缩包中。归档自身/事后原生收据/审计结果为包外addendum；实际SHA、成员、大小和新解压核验以`archive-audit.json`为准。

最终整体输入库存为272（含24份历史输出和1份固定旧反馈doc）；相比上一检查点270，只允许五业务文件、原两单测/E2E共8处修改和两份新增测试。归档工具独立重算这些差异、最终门禁输入一致、包体积、安装68和HEAD/branch/index，完整diff另存但不等于一次提交。

## 信任、性能和仍未闭合事项

数据可信判定：**CONDITIONALLY_TRUSTED，仅指本地有限双模型provenance回归**。未做新真实源对账，不等于全应用或生产金融数据TRUSTED。新说明仍由原渲染escape路径处理；新槽不接受外来getter/基金换绑，原Bridge sandbox/CSP不动。

accuracy测试显式调用入口；真实App hook仍位于primary publish且只对海外类基金调用，enriched只更新投影。**自动预测/异步正式净值结算的完整生命周期未闭合**，本轮新E2E没有accuracy ledger断言。不能把入口规则通过称为生命周期完成。

本地Chrome/固定合成时钟/route mock/SW blocked，不是真机、生产、PWA离线/升级、Gist/OCR引擎验收。没有新统计时延/p95、精确SHA CI或依赖网络审计；第48节800配对针对修复前源码，不能继承给当前。旧审计记录仅作历史，在安装/锁身份未变的有限条件下引用，不冒称新跑。

M3仍IN_PROGRESS，未进入M4/M5/M6，未提交业务、推送、合并、部署、发布或升版本。下一步应先把未完整的压缩管线原型移植到本次修复后的正确性基线，再做完整边界等价/净gzip验证；不得使用修复前共享字段bug作为必须兼容oracle，亦不得以这项修复替代原all预算/新性能/精确CI与后续全部门禁。

## 归档后补记（包外addendum）

唯一归档实际native0，主30项检查通过、stderr0；791成员/33,481,328 B，全新解压全成员路径/大小/SHA一致。`original-evidence.tar.gz`：11,490,572 B，SHA256 `0c127a5bb5fec6ab518a4308c9a59d4f6337fd631cf15553f42d4f3cfb75fde1`；成员库存行SHA `888dbc90cf931ca78eb67c8dacf23cdd267c621eb929ee09c5be0d888cc7898a`。最终272输入行SHA `c0aa9a6547a912df85e1477fd3a4076305a910b71b03d22cdaaa905a2cf92008`，68安装库存SHA `2da11b473eaff8bcaa1fef492e4b595629145b97f8c7f2ea18f4e7fb5b074e1c`。

最终真实OLD13同字节GREEN收据为`runs/green-02/native.receipt.json`，13/13/native0；该35文件控制不覆盖accuracy模块，最终全量单测/新增消费者测试另覆盖其入口。三次最终构建为build-04/05/06，不混用早期源码身份。归档审计、原生父收据及本补记发生于封包后，均明确位于包外，封包中的README为封包前版本，不包含本补记。没有重打或覆盖原包。
