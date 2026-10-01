# M1 契约与先红证据

> 日期：2026-10-01（Asia/Shanghai）
> M0 主线起点：`4c04e7fec9635d099191c0899dc57a25dd343fab`
> 分支：`codex/v16.0.0-data-contracts`
> 本阶段不修改业务代码、生产版本或依赖。失败用例是待修复证据，不是通过门禁。

## 已复现的现存行为

| 命令 / 文件 | M1 结果 | 真实失败 |
| --- | --- | --- |
| `node --test test/data-semantics-v16.test.js` | 12 项：1 通过、11 失败 | `1%2` 变成 12；旧正式净值提升为 secondary/official；新候选覆盖缓存身份；源 stale 被抹掉；canonical null 借旧别名补数；缺区间展示；新鲜请求时钟允许旧区间通知；重复/超权重进入模型；2 月 30 日有效；stale 正式净值变模型基期；未披露部分误写按 0 贡献 |
| `node --test test/worker-contract-v16.test.js` | 31 项：0 通过、31 失败 | 13 项直接现存客户端错误，18 项因新契约模块未实现失败 |
| `node --test contracts/ocr-import-safety.contract.mjs` | 2 项：0 通过、2 失败 | 不可导入布局匹配旧持仓仍 update、新基金仍 add；改 action 即可绕过逐项启用 |
| `node --test contracts/gist-selection.contract.mjs` | 7 项：4 通过、3 失败 | 同页/跨页多 V3 档案仍取首个；显式选第二个仍返回第一个 |
| `npm run test:e2e -- e2e/v16-data-contracts.spec.js`（端口 12437） | 1 项失败，9.3 秒 | 3.2037→3.2259 已显示为正式净值，详情收益却为“今日估算 最新净值”，预期“最新正式净值变动” |

浏览器用例固定时间 2026-09-30 14:00（中国），所有行情/持仓为合成 fixture；第三方请求被阻断，没有实际 Gist 写入。失败发生在真实渲染标签断言，不是依赖新模块不存在，也没有以修改断言或重试规避。

## 尚未实现的纯函数契约

以下先红是 `ERR_MODULE_NOT_FOUND`，不能把它们描述为现有业务错误的运行时复现；现存行为另由上表证明。

- `test/valuation-period-v16.test.js`：14 个声明用例。
- `test/cache-envelope-v16.test.js`：10 个声明用例。
- `test/market-clock-v16.test.js`：5 个声明用例。
- Worker 契约文件中的 18 个纯接口用例。

### 日期区间

`createValuationPeriod(quote, { shares, now, cacheState })` 只读取已经绑定的 `baseNavDate/targetDate`，不把 observed/fetched/请求日期补成市场日期。官方区间（包括正式目标日等于今天）永不叫今日估算；有效旧区间可以展示区间收益，但标旧。无日期、无 NAV 或无真实正份额保持 null；真实相等 NAV 的收益为 0。不同区间用 `comparisonKey` 分组排序。

### 缓存

`createCacheEnvelope` / `readCacheEnvelope` / `adaptLegacyNavMoveCache` 时间使用有限非负 epoch 毫秒。保留 `originalSource/originalSourceTier/sourceDate/fetchedAt/cachedAt/ttlMs/expiresAt`；新读或失败回退不续期。TTL 边界为 stale，显式最大 stale 策略才给 expired。旧 `fuyu_nav_move_*` 只按原 fetchedAt 适配，未知/倒置/未来日期或来源拒绝，不改持仓 Schema 3。

### Worker

只有不存在 `schema_version` 才走兼容 v1；显式数字 2 要求版本、带时区生成时间、能力和状态完整。重复/未知/对不上请求数量的响应 fail closed。质量状态与 transport 状态分开，canonical null 不借旧字段补数。官方 v1 的 `value_nav` 与刻意为空的 `est_nav` 是合法兼容特例，不强迫外部 Worker 先改仓库。本项目不修改司南 Worker；HTTP v2 与行级 `estimate-wire-v8.0` 是不同协议层。

重仓 whole-set 验证 `market+code` 唯一、有限权重、总和不超过 100%、最多 10 行、合法有效报告期；不删除坏行后把剩余结果装成完整。v1 缺市场保持缺失，不能猜海外市场。低覆盖或 missing 行情不按 0% 填充。

### 唯一时钟

`chinaDateKey/chinaTimeParts/marketClock` 合并中国日边界和交易所当地时区。日历带 version/valid_from/valid_until；缺失、未来或过期日历时不能宣称 weekday=open。注入合成日历测试跨年、DST、假日与提前收市；生产日历将从交易所官方资料确认，不用港股通日历代替香港现货。

## 后续里程碑显式未通过契约

OCR 修复在方案中属于 M5。`contracts/ocr-import-safety.contract.mjs` 当前必须显式执行，**仍为 RED / M5 PENDING**，不把它算成 M2 自动门禁通过。M5 必须实现后将其纳入自动测试；最终发布不得留该失败未关闭。不提前改 OCR 引擎或导入链。

Gist 多档案契约 `contracts/gist-selection.contract.mjs` 为 **RED / M4 PENDING**。7 个纯 GET mock 用例中，单一 V3/单一 legacy/无匹配/显式选首项 4 个兼容对照通过；3 个选择问题失败。候选字段脱敏断言尚未运行到，不能宣称已实现防泄露。M4 必须纳入自动测试并关闭失败；同步账户、真实双端读回与设备验收尚未执行。

## 执行边界

- M1 red 测试提交留在实施分支，不单独合并失败 CI 到 main。
- M2 只实施日期/缓存/Worker/重仓/时钟与相应呈现、排序、诊断和通知；刷新图、Gist 状态机与 OCR/PWA 分别保留给 M3/M4/M5。
- 数据展示字段兼容保留，持仓 Schema 3、device shard、tombstone、legacy、Web Lock、事务基线及 Bridge sandbox 不改变。
- 冷启动预算仍为 52,241 B；M2 新模块不能用提高预算绕过构建失败。
- 版本仍为 15.0.2，生产发布未执行。
