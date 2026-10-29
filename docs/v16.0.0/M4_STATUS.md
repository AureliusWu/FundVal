# M4 Gist 同步可靠性：实施中

> 10-28 最新本地冻结见 [LOCAL_QA_20261028.md §6](LOCAL_QA_20261028.md)：永久test/集2139 pass/3 skip（含Temp的宽发现计数另列）、281 syntax、74/74 E2E、两次确定性构建。用户已取消全部非OCR总量硬限（all95,884 B只记录），cold51,283/52,241 B PASS；下面旧90KiB FAIL保留为历史。新的纯验收relay独立原六probe修复后99/99，加正交6/6；真实built-App driver/创建封存交接仍未完成，READY=false。专用账号已选summersin77但本机未登录，真实Gist写为0；不是M4 EXIT或发布。

更新：2026-10-26。状态：`IMPLEMENTING / NOT_M4_EXIT / NOT_RELEASED`。应用仍为 **15.0.2**，当前代码为 `codex/v16.0.0-m3-continuation` 上、HEAD `f67675746276173fd3b84b770287e1ab5bea27fb` 之后的未提交工作树。M3 的精确提交签收见 [M3_STATUS §62](M3_STATUS.md)。本文件不是生产准入或 v16 发布声明。

## 已实施的路径

- `js/storage/gist-remote.js` / `gist-http.js`：完整且有界的兼容档案枚举；多档案不再取首个；固定 GitHub host/path、hex ID、分页/截断/64 分片限制；401/403/404/409/429/5xx 与安全限流元数据。PATCH 网络结果未知或 5xx 后不盲重放。
- `js/runtime/sync-status.js` / `sync-policy.js`：七态 UI model、最多 8 次带抖动指数退避、手动/定时/online 不绕过冷却；404 保留档案身份；未知写入先读；配置 epoch / AbortSignal / 锁内 guard 阻止旧操作污染新配置。清除/取消不提前释放忙态，PWA 更新互锁保留。
- `js/storage/gist-credentials.js`：默认 sessionStorage，显式选择才持久化；无同意标记的旧 Token 只提示、不启用也不读取值。存储写入/删除回读失败明确返回固定原因，不回退到持久保存；当前实例不重新启用被撤销的旧值。
- `js/app.js` / `index.html` / `cloud-archive-ui.js`：真实表单的档案选择、会话/记住选项与风险说明；默认无云凭证启动不加载 cloud；延迟凭证模块不得覆盖用户已编辑输入。首次 POST 在同一操作内受控采纳新 ID，再读回同一档案；未知 POST 未确认时禁止重复创建。
- `js/storage/cloud-sync.js`：保留完整 canonical 内容比较、Schema 3、device shard、tombstone、legacy、备份与事务边界；仅补安全错误策略传播。规范化语义指纹不是可公开的摘要，不进入状态/诊断。
- `js/integrity.js` / `resilience.js`：运行诊断仅持久化合法时间和固定类型；旧错误正文在下一次启动/追加时净化，不保存任意错误中的持仓/OCR 内容。通用脱敏覆盖 fine-grained Token 和 Gist URL；诊断时间字段也验证，不允许作为内容旁路。用户主动持仓导出仍是有意包含持仓的备份，不混同诊断导出。

## 实际已运行的检查点（不可外推到后续修改）

原生记录在 `Temp/m4-qa-20261025-parent/`，独立子任务记录在系统 Temp 的 `FundVal-m4-*`、`M4-e2e-child/`；仍需在最终冻结时归档。所有均为合成数据，无真实 Gist 写入。

| 运行 | 实际结果 / 范围 |
| --- | --- |
| 首轮完整单测 `full-test-1` | 1557 total / 1510 pass / 44 fail / 3 skip，native 1。新凭证 dirty 语义使旧 PWA VM 缺接口；另有 facade/源码接线断言未迁移。原失败保留，不改判。 |
| 第二轮完整单测 `full-test-2` | 1563 total / **1560 pass / 0 fail / 3 既有 Windows skip**，native 0。不把 skip 算通过；明确标注的 M3 历史 fixture 不算新 M4 活动验收。不从此合计推导单模块活动覆盖数量。 |
| `syntax-1` | 235 JavaScript 源码/测试，native 0。 |
| `build-1` | native 0，17 chunks；**cold 50,570 / 52,241 B**；**all 94,382 / 92,160 B：FAIL**。构建仅冷包门禁成功不等于总包通过。 |
| 独立 `budget-1` | `scripts/release-fingerprint.mjs --assert-app-bundle-budget site` 实际 native 1，all 超 2,222 B；原 90 KiB 政策、冷包及其他门禁未放宽。 |
| 新增同步 Chrome E2E | 8/8 首跑通过，0 retry，30s / expect 8s 原门禁；12743；固定 site 的 index/app-chunks 前后 SHA 不变。全通过所以没有失败截图/trace，list reporter 未保存 passed testInfo 附件，缺口不补造。 |
| 完整 Chrome E2E `full-e2e-1` | **43/43**，native 0，12744，约 1.4 分钟；实际运行的是 `build-1`。352B NO_COLOR/FORCE_COLOR 告警保留。这是隔离模拟网络的桌面验证，非真实云端或物理设备。 |

后续 controller 共用操作骨架已单独 102/102 通过。POST/PATCH 共享读回判定候选也实际测量，但没有达到减包目标，已撤销实验 helper/API，只保留实际创建路径两处 await 后的 scope gate 修复及真实 owner 行为回归；没有把减少源码行数当成 gzip 收益。

### 后续源的检查点

- `full-test-3`：1581 total / 1577 pass / 1 fail / 3 skip，native 1。唯一失败为 M3 结构测试仍要求已无消费者的 App `handleCloudFailure` 包装；M4 真正的错误策略 owner/API 未移除。改为检查仍消费的委托与旧包装已退休，不重新添加死代码来满足过期断言。
- `full-test-4`：**1581 total / 1578 pass / 0 fail / 3 Windows skip**，native 0；`syntax-2` 实际检查 236 文件。新增的 17 项读回测试直接走 POST/PATCH owner，保留 null/0、份额、future schema、属性顺序、ack 差别和异步 scope 边界，不依赖已撤销实验 helper。
- `build-2` 实际 all 94,448 B；候选的业务 gate 没有放宽。`build-3` 撤销该候选并保留安全修复后实际 **all 94,375 / 92,160 B，仍超 2,215 B**；**cold 50,537 / 52,241 B**。相对 `build-1` 总包仅净减 7 B，不称优化达标。`budget-2` 实际 native 1 / FAIL。
- `full-e2e-1` 只属于前述 `build-1`；`build-3` 已另行完成 `full-e2e-2`：**43/43、native 0、0 retry**，12745，09:08:59.512Z→09:10:26.540Z；352B 颜色环境告警保留。单测与 E2E 通过不改变总包 FAIL。尚未进行新的最终配对性能/不可变提交 CI 或真实 Gist 双端。

## 先红与审查闭环

- 错误策略传播新 5 项：原实现 1 pass / 4 fail → 5/5；与既有云合并测试合跑 29/29。
- 诊断隐私最初 3 项真实失败后修复；另加入 JSON `type:{toString:null}` 的真实失败，避免启动净化引入 TypeError，再修为固定 unknown。
- Gist adapter/discovery 最终 40/40；凭证模块最终 34/34。保存全部中间失败，不把 missing-module RED 记为全部行为先红。
- PWA 测试仅补 live credential 接口/remember 控件及 4 项新脏输入保护；旧 oracle 原字节、ACK/drain/跨页/来源断言保留，定向 54/54。
- M1 的七个档案选择场景已通过 `test/gist-selection-contract-v16.test.js` 纳入默认 Node 门禁。接口从“异常附描述 + selectedGistId”演进为“仅 id/schema/updatedAt 的安全 DTO + controller 显式选择”，候选不再包含用户描述。七个原场景保留，原 RED 接口在 Git 历史可追溯，不遗留未执行的失败契约。

## 仍未通过 / 下一步

1. **总包硬门禁仍失败**。仅做有测试保护的真实重复逻辑收敛；不再次提高预算、不删兼容/校验、不换目标或加载组。
2. 最终源冻结后的完整单测、语法、确定性构建、总包/冷图、完整 E2E、依赖审计、配对性能与精确提交 CI 尚需完成；M3 的旧性能不继承为当前 M4 结果。
3. 专用测试账号的真实合成 Gist 双端往返、冲突、离线恢复、日志/导出验证尚未执行。两个隔离浏览器 context 的内存 route 模拟不代替它。
4. 浏览器拒绝删除持久凭证时，当前实例会停用，但新页面仍可能读取未能删除的已同意凭证。当前失败提示已明确“刷新或重开可能恢复旧凭证”，要求清除此网站存储，且有对应单测；不宣称永久撤销成功。
5. M5 OCR/移动端/PWA 与 M6 物理设备、同产物发布、生产/回滚/观察全部未豁免；未升版、未合并 main、未创建 tag 或发布。

## 2026-10-26 追加检查点（不是冻结准入）

用户已明确批准的唯一预算变动为全部非 OCR gzip 上限 **92,160 B**。冷启动 **52,241 B**、ES2022/OXC、五组加载边界、数据校验、Schema 3、兼容与性能门禁均保持。下列结果来自移动工作树；最终不可变源/CI仍需重新验证。

- 手动上传/下载/档案发现 UI 在每个 await 后消费原 controller 的配置 scope，不能让旧结果修改新配置的 pending、toast、自动拉取或候选列表。按钮 WeakMap 只清理由本调用仍拥有的原控件，不另造配置 epoch。定向 124/124，见 `Temp/M4-scope-20261026-child/REPORT.md`。
- 清除凭证结果新增仅限内部 UI 的 `current` getter，消费时检查原 controller scope。实际 App singleton loader、clear/save、credential store、controller 与 UI 组合定向最终 **138/138，0 skip，6 项 syntax native0**；新保存/reset 抑制旧清除提示，单纯编辑草稿不隐藏真实清除失败警告。见同目录 `CLEAR_RESULT_REPORT.md`。这是当前调用图的排序证据，不是通用任意重入操作队列。
- 一个初读解析收敛候选保留了原 IO await；早期 async helper 被真实 microtask 测试击穿（120 total/118 pass/2 fail），同步版 120/120。统一构建候选 **94,583 B**，同一 App/UI 下撤销该候选后 **94,564 B**，反增 **19 B**，故已恢复 `cloud-sync.before.js.txt` 的精确 SHA `26a504eab24b8ee3242f78c8505b884d43ea65206bbda5c18d944b4ac20ccb05`。独立 oracle/取消时序测试保留。见 `Temp/M4-read-convergence-20261026-child/REPORT.md` 和父级 `read-convergence-{build,baseline}-1.*`。不要把源码少几行记为减包。
- 父级 `Temp/m5-qa-20261026-parent/integrated-test-1.*`：**1890 total /1887 pass /0 fail /3 既有 Windows skip**，native0；`integrated-check-1.*`：255 文件/native0。这是更早检查点，不覆盖其后 clear getter、最终同步解析测试及尚未集成的预处理 Worker。
- 当前已测构建 `read-convergence-baseline-1`：17 chunks/native0，**cold 50,690/52,241 B PASS；all 94,564/92,160 B FAIL（超 2,404 B）**。构建过程仅内置冷包门禁，不能以 build native0 宣称 all 达标。该次七文件 before/after 清单不是全树冻结签名；后续父级 runner 已扩为全部 runtime/test/script 及实际 site 内容清单，不追溯改写旧收据。
- `integrated-e2e-1`：**56/56、native0、0 retry**，12764，2026-10-26T07:08:02.799Z→07:09:48.198Z，351B 颜色环境告警；含 10 项真实表单同步 E2E（模拟 HTTP）、10 项 OCR 页面及 1 项实际 codec。实际运行 `read-convergence-baseline-1` 的 site，原有产物文件 hash 前后不变，只新增 `.playwright-results/` 测试输出。期间源树唯一变化是未被该 site 集成的 `preprocess-worker.js`，故不声称全源冻结或当前 Worker 通过。旧上传污染新配置、clear 结果微任务等组合单测不能自动外推为每项都有新增浏览器覆盖。

### 真实 Gist 验收准备仍不是执行证据

`scripts/verify-live-gist-m4.mjs` 当前是 fail-closed 准备入口，`LIVE_GIST_BROWSER_DRIVER_READY=false`；即使传 execute 参数也在读取 Token/HTTP 之前拒绝。默认 dry-run 为 PREPARED_NOT_RUN，真实请求 0，不应列为 M4 双端通过。

`scripts/lib/live-gist-m4-scope.mjs` 目前只经 mock 验证唯一新建合成档案、精确账号、exclusive durable journal、节流、未知写入禁止重放及可选 owned cleanup。实际 built-App 双 Chrome driver、原响应忠实 relay、限流标头、独立 canonical 读回见证仍需实现审查。专用账号或主账号仅新建合成 Gist 的范围选择尚待用户明确，不能从本机完全访问权限推断允许使用主账号真实写入。

### 未知首次POST跨重开防重：P1有限修复及独立复审

- 独立actual UI/controller/App-AST/真实Schema3仓储纯内存probe复现：服务端合成已创建但客户端收到503或网络异常，同页冷却120秒后POST仍1；同Storage新controller、startup complete-empty后再次上传却变成**POST2**。闭包readFirst不是持久屏障，普通pending/备份也没有恢复消费者。canonical持仓未变，但可产生重复私有档案/分叉。见 `Temp/M4-unknown-create-reload-review-20261026-child/REPORT.md`，native0代表复现成功，不是安全通过。
- 已实现独立本机`fuyu_cloud_create_intent_v1`：原origin锁内完成备份后read→唯一nonce写入→精确回读，才允许锁外POST；无id UI提前检查。读取失败、损坏、未来版、存储拒写均fail closed，unknown/取消/崩溃/空发现不自动解锁；普通reset/clear meta不删除。已知id正常同步不受此新建屏障阻断。只明确权威拒绝或已durably采纳ID且canonical/meta成功才可同nonce清理。
- 作者定向最终 **253/253、0skip、native0，6 syntax**，见 `Temp/M4-create-intent-fix-20261026-child/REPORT.md`。实际UI/controller/App-AST跨重开两路gate原期望POST1时native1，修复后native0且总POST1；保留原复现及RED，不把复现命令native0当安全通过。原frozen actions literal SHA `960bed7f59218c43b34ad324d51fb802f63501697c3b5439aad85859bd0654a5`、105条原assert文字/相对顺序不变；仅白名单三场景在唯一`sync-status`后插一个`create-intent-read`，不是过滤新事件。
- 独立只读复审 **18/18、native0、stderr0**，见 `Temp/M4-create-intent-independent-20261026-child/REPORT.md`（SHA `44bf85beed0c815e96a2409e11f1f6b9be290074c3856df9ec9498f7be15eb9d`）。独立导入真实store/UI/controller/Schema3仓储，在纯内存HTTP/Storage/锁探针中验证nonce替换、实际配置reset/token变化、final锁失效、time/install失败、无WebLocks零POST、known-id不读barrier和fresh-controller不重发；也独立运行严格trace delta及负控。未发现新增P0/P1/fail-open，不代表真实浏览器持久性或GitHub落盘已验证。
- 这项采用**保守origin级屏障**，不引入`/user`/Token摘要或声称账号身份已验证；不能判定旧意图归属时切账号也阻止新建。未知id的人工恢复/账号隔离仍未闭合，不能把安全保守阻断算完整UX或M4退出。清空整个站点Storage、另一设备/浏览器、非协作脚本不在此本地屏障的保证内；最终全套仍需单独记账，源码未发布。
- 后续父级PWA检查点`pwa-second-observation-test-1`为1948total/1945pass/3Windows skip，syntax262，均native0，**不覆盖随后intent/manifest新测试**。最新实际构建`offline-intent-build-1`为all**95,208/92,160 FAIL（超3,048）**、cold**50,754/52,241 PASS**。真实Paddle和离线测试复用该site，不把移动源码视为最终不可变源；完整证据边界见[M5_STATUS](M5_STATUS.md)。

### 统一当前检查点（2026-10-26，后续变更不继承）

- `candidate-test-1` **2041 total /2038 pass /0fail /3既有Windows skip**、`candidate-check-1` 272文件，均native0；完整`candidate-e2e-1` **70/70/native0/0retry**，含原10项真实表单模拟HTTP同步回归。这仍不是GitHub真实双端，也未单独覆盖跨重开native Storage的未知POST恢复，后者正在补独立用例。
- 为修正实际`/FundVal/`预热URL，build仅增加相对base；两次构建产物逐字节同，17chunks，cold**50,763/52,241 PASS**，all**95,223/92,160 FAIL（超3,063）**，独立预算CLI原生1。OXC/ES2022/五组、Schema3/校验/兼容均未豁免；该配置修复不是减包。
- chunks/模块图/静态绑定/23OCR资产校验及npm audit均native0（audit0漏洞）；完整当前输入/产物窗口、stdout/stderr及汇总SHA见[M5_STATUS](M5_STATUS.md)。尚无最终配对性能、精确提交CI、生产/真实云签收，未升版或发布。

### 后续native跨reload与最终本地检查点

- 新`e2e/v16-create-intent-reload.spec.js` 两项真实built-App/native Storage+WebLocks：合成POST先apply C后503/network-abort，真实page.reload+4次完整空列表后再上传，POST仍1、create确认仍1，86字符intent和完整raw/canonical持仓逐字不变，未知阶段无ID/time/verified。随后真实UI明确选择B，PATCH1+至少2 GET可verified，但C未知屏障不清。不是GitHub真实落盘、账号隔离或未知创建恢复证明。
- 定向`native-reload-3` **2/2/native0**；先前fixed clock的timeOrigin断言RED、Playwright block在opaque frame读取SW getter的5个SecurityError RED全部保留。仅新harness采用原生时钟、自有allow context+contained server固定503拒SW，registrations0/controllerfalse、pageerrors0、context/server真实close均硬断言，未改sandbox或生产逻辑。报告`Temp/M4-create-intent-browser-20261026-child/REPORT.md` SHA `2f7de2b20d43f95d388547002b1c9aee8bdf58fef2eb8e4a6829b82ab9cfc4c0`。
- 后续统一最终本地 **2044 total/2041 pass/3既有skip、274syntax、72/72 E2E**，两次build逐字节同，全部原生0；独立总包仍native1（95,223/92,160），冷包50,763/52,241通过。收据/清单/明确未退出项见[最终本地检查点](LOCAL_QA_20261026.md)，不替代M4真实云/性能/CI或M5/M6。
