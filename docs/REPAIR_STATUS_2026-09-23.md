# FundVal 可靠性修复验证记录

修复日期：2026-09-23；最终测试：2026-09-24；交付复核：2026-09-28。范围：`D:\AI项目\FundVal`，基于 v15.0.1 / `5e135b51ce2b9c0fbe37c4119b62cab4b1c33927` 的本地未提交补丁。不修改司南基金、第三方 Worker 或用户真实持仓；没有升级依赖、提交、推送或发布。

本记录补充 `GPT6_ASTRA_AUDIT_2026-09-06.md`，不改写历史审计结论。下列内容必须结合最终验证结果阅读；单元/浏览器合成测试不是生产或实体手机验收。

## 1. 本轮修复

| 原审计编号 | 修复与约束 | 主要实现 / 回归 |
| --- | --- | --- |
| P1-D01 | 正式净值按实际日期排序；同日期同净值优先完整候选 | `js/runtime/quote-contract.js`；`test/quote-period.test.js` |
| P1-D02 | Quote 携带 `baseNav/baseNavDate/targetDate`；盈亏只能使用被选中 Quote 的基期，旧缓存不借用其他数据补基数 | `js/runtime/quote-normalizer.js`、`js/calculator.js`、`js/app.js` |
| P1-D03 | 当期涨幅不得重复叠加到已含当期的 NAV，也不得用单日涨幅跨越多日 NAV 缺口；美股使用交易所日期 | `js/holdings-estimate.js`、`js/overseas-model.js`、`test/quote-period.test.js` |
| P1-D04 | 接通 Worker `value_nav/value_change/base_nav/base_nav_date/value_date`，保留 0 和 null 的区别 | `js/eastmoney-estimate.js`、`js/runtime/quote-normalizer.js` |
| P1-S01 | 主仓储、兼容投影、journal、备份遇到未来 Schema 停止写入；手动恢复不能绕过该保护 | `js/storage/holdings-repository.js`、`js/runtime/holdings-transfer.js`；`test/storage-reliability.test.js`、`test/holdings-transfer.test.js` |
| P1-S02 | 启动恢复、仓储读改写、OCR、云同步结尾使用同一 origin Web Lock；锁不可用时停止危险写入 | `js/bootstrap.js`、`js/resilience.js`、`js/storage/holdings-repository.js` |
| P1-S03 | Schema 3 到旧格式的兼容投影保留 note，普通保存不清空备注 | `js/storage/holdings-schema.js`、`test/storage-reliability.test.js` |
| P1-S04 | 页面先构造候选数据，成功写入才安装；quota/journal 失败不把未保存份额混入页面 | `js/runtime/holding-edit.js`、`js/app.js`；`test/holding-edit.test.js`、`e2e/v15.spec.js` |
| P1-S05 | 编辑基线固定在打开表单时；其他标签页/云同步更新或删除时拒绝旧表单覆盖；切换页面保留草稿 | `js/runtime/holding-edit.js`、`js/app.js`；双标签页 E2E |
| P1-O01 | OCR 确认使用识别结果展示时的基线，锁内检查所选基金变动，保留截图外新增项，不复活已删除项 | `js/ocr/import-transaction.js`、`js/ocr-import-page.js` |
| P1-O02 | 长截图全高度分片，不再按 16%～90% 固定裁剪 | `js/paddle-local-ocr.js` |
| P1-R01 | Bridge 网络超时从实际派发开始；等待队列可取消且有总等待上限，活动请求失败销毁旧沙箱 | `js/runtime/quote-bridge-client.js`；`test/quote-bridge-queue.test.js` |

另修复：云同步结束安装旧快照/错误清空 pending 的竞态；损坏持仓页面恢复时覆盖别页已修复数据的窗口；黄金将证券代码误作价格、将昨收标为当前的错误；指数缺少来源时间时不再标当前；本地预览服务器遇到错误 URL 编码返回 400 而不退出。

OCR 的 A/C 类候选歧义默认跳过；缺失金额、收益或收益率分别保留 null，不再导致整行丢失或数字串列。模型清单下载、Worker 初始化/预测/销毁增加期限和取消保护，离开页面时终止活动 Worker。相关实现位于 `js/ocr-table-layout.js`、`js/ocr/asset-manifest.js`、`js/paddle-local-ocr.js`、`scripts/paddle-ocr-entry.mjs`；OCR 定向回归 120/120 通过，已包含在全量 410 项测试中。

海外持仓保留证券市场身份，支持字母数字代码；不能确认市场的海外证券不再凭六位代码猜为 A 股，同代码不同市场分别路由。实现和回归位于 `js/fund-holdings.js`、`js/holdings-estimate.js`、`test/fund-holdings.test.js`。缺少市场身份时显示 `--`，同时清理旧缓存中无法确认市场的涨幅，避免沿用错配股票行情。

## 2. 数据流与保守降级

```text
Worker / 隔离 Bridge 的已校验响应
  → Quote（值、涨幅、基期、目标日期、来源时间、状态）
  → 选择同一候选
  → 同一 Quote 的基期计算盈亏 / 渲染来源与日期

用户编辑 / OCR 确认 / 文件导入
  → 原始基线 + 候选数据
  → Web Lock 内重读、冲突检查、备份、写入、读回
  → 成功后安装页面状态；失败保留原数据与输入
```

- 不接入伪“实时”源，不把请求时间当行情时间，不将未识别值补成 0。
- 本地模型的 next-weekday 检查不是交易所节假日日历。节假日、多市场错日或缺失多日行情时宁可回退正式净值，不能拼出一个虚假的当日结果。
- 海外预测账本改存确定的基准/目标 NAV 日期，并由刷新代际保护异步记账。
- OCR 始终本地运行；没有上传截图、真实 OCR 文本、持仓数据或 Token。测试使用合成数据。

## 3. 真实公开数据抽查（2026-09-22）

只读查询公开数据，不属于本次部署验收：

- 005844：东方财富正式净值序列最近两项为 **2026-09-18：3.4770；2026-09-21：3.4496**。Worker 同时返回 **base_nav=3.4496、base_nav_date=2026-09-21**，两处基数一致。
- Worker 的 2026-09-22 14:52:10 样本为重仓模型：value_nav=3.42776247968、estimate_change=-0.633045%、value_change=null、value_date=2026-09-22；适配层按明确字段回退读取 estimate_change，不把 null 当作零。
- 012920 的样本是正式净值，日期 **2026-09-18**，基期 **2026-09-17**，value_nav=3.8063、base_nav=3.7399、value_change=1.78%。没有将该日期改成请求日期。

复核来源：`https://sinan-estimate-push.ligugu69.workers.dev/estimates?codes=005844,012920`、`https://fund.eastmoney.com/pingzhongdata/005844.js`。后者仅读取文本并解析 JSON 数组，没有执行远程脚本。以上是采样时点证据，不保证后续所有数据源持续可用。

## 4. 验证结果

| 检查 | 日期 | 结果 |
| --- | --- | --- |
| `npm test` | 2026-09-23 | **410/410 通过**，无跳过、无取消 |
| `npm run check` | 2026-09-23 | **通过** |
| `npm run build` | 2026-09-23 | **通过**；最终业务补丁完成后执行，构建产物与 9 月 24 日浏览器测试一致 |
| `npm run test:e2e` | 2026-09-24 | **12/12 通过**，耗时 14.5 秒 |
| `git -c core.safecrlf=false diff --check` | 2026-09-24、2026-09-28 | **通过**；仅避免本地 CRLF 配置干扰补丁检查，未修改 Git 配置 |

9 月 24 日收尾仅补充验证记录，没有继续修改业务代码。9 月 28 日再次核对 HEAD、版本、工作树、依赖/锁文件和 PWA/构建配置，未发现终验后的业务代码或配置漂移。以上是本地工作树验证，不是 GitHub 或生产版本的状态。

浏览器测试包含：保存 quota 失败保留原值、两个标签页的编辑冲突、草稿跨页面保留、按需诊断与导出、持仓增删重载、隔离 Bridge、恶意字段拒绝、数据源失败不串成股票、云读回不一致、OCR 确认页、更新兼容与 PWA 离线。

## 5. 性能与构建口径

使用 data-reliability-audit 约束日期/缺失值/来源降级；使用 performance-regression-check 保留 **52,241 B** 冷启动 gzip 预算，未调高门禁。

首轮新增校验曾使首屏超预算，因此将真正按需的诊断中心、持仓导入导出/恢复和海外准确率账本拆为动态加载；通知权限未授予时不再预加载通知模块。OCR 不进首页模块图和 SW CORE。

| 指标 | 修复前历史基线 | 最终值 | 判定口径 |
| --- | ---: | ---: | --- |
| cold 图 gzip | 51,598 B（9 月 6 日审计） | **51,942 B（+344 B / +0.67%）** | **PASS**；低于 52,241 B，余量 299 B；逐 chunk gzip 求和 |
| 所有非 OCR chunks gzip | 63,167 B（历史审计） | **70,209 B（+7,042 B / +11.15%）** | **WARN**；PWA 首次安装的预缓存负担增加超过 10%，不能只看 cold |
| 空持仓冷启动可交互 | 无同口径历史基线 | **中位 178.5 ms / 最慢 182.2 ms** | 390×844，本地 Chromium、合成网络、3 次 |
| 同上下文热重载可交互 | 无同口径历史基线 | **中位 104.3 ms / 最慢 132.9 ms** | 本地服务 no-store，不代表 HTTP 热缓存 |
| 保存到列表反映成功 | 无同口径历史基线 | **中位 82.8 ms / 最慢 98.7 ms** | 浏览器真实表单交互、3 次 |

9 月 24 日原始计时样本（毫秒，展示保留一位小数）：

| 样本 | 冷启动 | 热重载 | 保存到列表 |
| --- | ---: | ---: | ---: |
| 1 | 182.2 | 104.3 | 82.8 |
| 2 | 175.2 | 132.9 | 98.7 |
| 3 | 178.5 | 101.9 | 76.2 |

性能样本保存为 Playwright 的 `local-performance.json` 附件，并留存于 `docs/REPAIR_PERFORMANCE_2026-09-24.json`。计时用例隔离浏览器上下文、阻止 Service Worker、模拟网络数据；另有独立 PWA 离线用例。构建大小来自 `site/js/app-chunks.json`。小样本只作为本地回归门禁；没有同口径历史计时，不能声称提速比例，也不能据此声称生产网络、iOS 或 Android 真机提速。全部分包增长应作为后续优化项保留。

## 6. 尚未完成的验收及已知限制

1. 本记录完成本地终验时尚未提交、推送或发布，代码版本仍为 15.0.1；其后续 v15.0.2 发布状态与生产证据以 `docs/v15.0.2/RELEASE_CHECKLIST.md` 为准。本记录本身没有执行真实 Gist 写入验收。
2. Web Locks 只能协调遵守同一协议的新页面；仍打开的旧版标签页必须关闭/刷新。不支持 Web Locks 的浏览器会显示受控提示并停止写入，没有伪装成跨标签安全的内存锁。
3. Android/iOS 实机长截图识别率、模型冷下载和低内存场景未在本轮完成；合成块坐标测试不能替代真实截图到确认页的验收。
4. 尚未接入完整节假日历、外汇调整和缺失多日的累计海外收益；相关模型宁可不显示，正式净值保留真实公布日期。
5. 手动备份恢复仍保留备份的历史 revision；后续云合并可能重新选取较高 revision。恢复与多设备合并的产品语义需要单独明确，未在本轮擅自改为全设备回滚。
6. 第三方公开接口可失效或延迟；数据真实性无法由前端单方面保证。本轮只证明采样和回归覆盖的边界。
7. 海外重仓未提供明确市场身份时，涨幅可能显示 `--`；这是防止同代码串市场的保守降级，需要上游补充市场映射才能恢复对应行情。

## 7. 信任结论

**CONDITIONALLY TRUSTED（有条件可信）**：本轮所列本地计算、事务、解析和请求调度修复已完成，410 项自动化测试、12 项浏览器测试、语法检查和构建通过。该结论仅覆盖补丁及回归所验证的边界，不代表整个产品不存在其他问题，也不撤销历史审计中未被本轮覆盖的风险。

发布、真实云同步及实体手机验收仍未完成；分包总量增长、节假日/海外多日模型和手动恢复的跨设备语义保留为限制。不得用本报告替代生产发布或真实手机 OCR 验收。
