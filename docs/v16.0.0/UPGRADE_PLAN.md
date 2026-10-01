# FundVal（蜉蝣基金）v16.0.0 总体升级方案

> 文档状态：`IMPLEMENTING / M1 IN PROGRESS`（M0 退出证据见 `M0_STATUS.md`；不是已发布状态）
> 制定日期：2026-09-30（Asia/Shanghai）
> 基线版本：v15.0.2，提交 `40e68edab9cb3fba0b17338dc3672a82d13ad17e`
> 生产地址：<https://aureliuswu.github.io/FundVal/>
> 适用仓库：`D:\AI项目\FundVal`

## 1. 决策摘要

v16.0.0 不应继续以“增加更多估值算法”为主线，而应把 FundVal 升级成一个**日期含义可信、降级状态可解释、刷新成本可控、手机端可长期使用、发布过程可回滚**的基金持仓 PWA。

本版本按以下顺序推进：

1. 先修正“今日估算”和缓存来源的语义，任何数值都必须能回答“哪两天、什么来源、是否缓存”。
2. 再重构刷新计划，避免每次刷新重复抓取正式净值、重仓与静态信息，并继续拆解 `js/app.js`。
3. 完成 Gist 同步状态机与真实双设备验证，使用户知道数据是已同步、待同步、冲突还是只读。
4. 收紧 OCR 自动导入条件，重点解决 Android 长截图的内存、取消、重试、后台恢复和误匹配问题。
5. 把物理 Android/iOS、已安装 PWA 升级、生产数据日期和同一构建产物发布纳入硬门禁。

v15.0.2 当前没有确认的 P0，但存在会误导用户判断的 P1：非当日区间被标为“今日估算”、过期正式净值缓存失去缓存身份、刷新路径过量请求、外部 Worker 缺少版本化响应契约、Gist 同步状态不完整，以及 OCR 不可靠布局仍可能进入可导入候选。

## 2. 当前基线与已验证事实

### 2.1 本地与生产基线

| 项目 | 当前状态 |
| --- | --- |
| Git | `main` 与 `origin/main` 同步，工作树在规划前为干净状态 |
| 当前版本 | 15.0.2 |
| 单元/行为测试 | `npm test`：410/410 |
| 静态检查 | `npm run check`：通过 |
| 构建 | `npm run build`：通过 |
| 浏览器 E2E | `npm run test:e2e`：12/12 |
| 高危依赖审计 | `npm audit --audit-level=high`：0 vulnerabilities |
| 冷启动 gzip | 51,941 / 52,241 B，处于现有预算内 |
| 非 OCR chunks | 70,207 B |
| 生产版本 | 页面、运行时、manifest、Service Worker 均为 15.0.2；缓存桶 `fuyu-v15.0.2` |
| 生产部署 | GitHub Pages；`main` 推送会触发部署 |
| 真机验收 | Android Chrome/PWA 与 iOS Safari/PWA 尚未完成 |

### 2.2 2026-09-30 数据抽查

Worker 的 `/estimates?codes=005844,012920` 返回 `status=degraded`、`source=eastmoney_official_nav`，并保留了真实净值日期：

- 005844：2026-09-28 的 3.2037 → 2026-09-29 的 3.2259，+0.69%。
- 012920：2026-09-24 的 3.8463 → 2026-09-28 的 3.7218，-3.24%。
- `/holdings?code=005844` 返回 10 条记录，报告期为 2026-06-30。

这些数据可以作为“最近正式净值区间”，但不能因为请求发生在 9 月 30 日就显示成“9 月 30 日今日估算”。v16 必须把请求时间、来源时间、基期和目标日期完全分开。

### 2.3 v15 已解决、v16 不重复重做的边界

- Quote Envelope 已绑定 `baseNav/baseNavDate/targetDate`，缺失值维持 `null / --`，不把 0 与缺失混为一谈。
- 海外模型已经拒绝未来、过期、混日和跨多日冒充单日涨幅的输入。
- 持仓危险写入已经使用 Web Lock、事务内重读和基线比较。
- OCR 已按整张长截图切片，不再只识别固定顶部区域；截图仍只在本地处理。
- Bridge 已有队列、容量、取消、请求期限和 iframe 故障重建。
- 诊断、导入导出、准确率等模块已经按需拆包，现有冷启动预算必须保留。
- Schema 3、tombstone、device shard、legacy 兼容与 OCR 隐私边界不得因 v16 重构而破坏。

## 3. v16.0.0 目标与非目标

### 3.1 必须达成的目标

1. **数据可信**：页面展示的涨跌、净值和收益都能追溯到明确的 `baseDate`、`targetDate`、来源等级与缓存状态。
2. **刷新高效**：一次刷新只获取本代所需数据；行情、正式净值、重仓和元数据按不同 TTL/发布日期调度。
3. **同步可解释**：云同步具有清晰状态、冲突处理、退避和真实双设备证据。
4. **OCR 安全导入**：不可靠布局、歧义名称和份额类别默认不自动写入；长截图在目标真机上不崩溃且可取消重试。
5. **PWA 可升级**：已安装 v15.0.2 能安全升级到 v16.0.0；用户编辑中的数据不会被更新流程覆盖。
6. **发布可治理**：PR 验证与生产部署分离，生产发布的是已经通过门禁的同一份构建产物。
7. **可维护**：`js/app.js` 降低职责密度，刷新、展示、同步和页面协调形成明确模块边界。

### 3.2 明确不做

- 不承诺不存在可信数据源时仍生成“实时估值”。无法证明时显示正式净值、旧数据或 `--`。
- 不用“请求日期”补齐“行情日期”，不把未知值转成 0。
- 不在 v16 同时更换 OCR 引擎、模型、解析器和 UI；每次只改变一个可测变量。
- 不迁移 Schema 3，除非先完成双向兼容、回滚和真实数据迁移演练。
- 不把约 84 MiB 的 OCR 资源加入 Service Worker CORE 缓存。
- 不把 Gist Token 写入代码、日志或明文导出；浏览器端“加密”也不能被描述为可抵抗同源 XSS。
- 不把 MuMu、桌面浏览器或合成图片结果视为物理 Android/iOS 验收。
- 不在 FundVal 仓库中静默修改外部 Worker；Worker 契约升级应作为独立、协调发布的任务。

## 4. 主要问题与优先级

### P1：必须在 RC 前关闭

| 问题 | 代码证据 | 影响 | v16 方向 |
| --- | --- | --- | --- |
| 非当日区间仍显示“今日估算” | `js/app.js` 的收益计算使用所选 Quote 区间，但界面固定写“今日估算” | 用户会把最近正式净值变化误认为今天表现 | 引入 `ValuationPeriod`，只有中国时区目标日期为今天时才允许“今日”标签 |
| 过期正式净值缓存失去缓存身份 | `js/app.js` Bridge 失败后可返回 `fuyu_nav_move_*`，下游又标成普通 `official_nav` | 旧值看起来像刚获取成功 | 缓存记录携带原来源、写入时间、过期时间和 cache state；旧缓存只能以 stale/cache 返回 |
| 刷新图过度抓取 | 每只基金都会启动正式净值；部分路径还重复获取重仓与个股行情，`force:true` 绕过稳定缓存 | 首屏慢、第三方压力大、失败面扩大 | 使用分类 Refresh Plan、批量行情和分层 TTL，手动刷新也不默认强刷稳定数据 |
| Worker 响应无协议版本 | `/estimates`、`/holdings` 依赖形状约定，没有 `schema_version/service_version/capabilities` | Worker 独立变化会静默破坏前端 | 建立版本化契约、能力协商和 fail-closed 校验 |
| Gist 多档案与状态不清 | `js/storage/gist-remote.js` 发现多个 V3 gist 时取首个；UI 主要显示最后同步时间 | 可能同步错误档案，用户不知道待同步/只读/冲突 | 档案选择 + 同步状态机 + 退避 + 双设备 E2E |
| OCR 不可靠布局仍可进入候选 | `js/ocr-table-layout.js` 给出 `importable`，但 `js/ocr-import-page.js` 未完整据此封锁导入 | 错配基金、A/C 类或跨行金额会污染持仓 | 非 importable、歧义和低置信候选全部默认跳过，只允许用户显式激活 |
| `main` 可直接部署生产 | `.github/workflows/deploy.yml` 与仓库设置形成推送即发布链路，主分支未保护 | 未审阅提交可直接上线 | 保护 `main`，PR CI 与生产部署分离，部署已验证产物 |

### P2：应在 v16 内收敛

- 重仓列表需拒绝重复 `market+code`、总占比超过 100% 及不完整行，并返回稳定 reason code。
- 市场会话只含周末/时段启发式，没有生产节假日日历；不同位置还有重复判断。
- OCR 在检查像素上限前已执行完整 `createImageBitmap` 解码，超大图片仍可能先触发内存峰值。
- manifest 缺少明确 `id`、`scope` 和 Apple touch icon；安装身份与 iOS 桌面体验不够稳定。
- OCR 资源和 Tesseract fallback 的角色不清晰；fallback 资源存在但未形成完整 UI 能力链。
- `js/app.js` 约 2,693 行，仍集中负责刷新、渲染、同步、PWA 更新和持仓交互。
- 部分低覆盖模块位于高风险路径：通知、Gist、OCR/恢复和 Bridge runtime。

### P3：作为工程质量改进

- Node/npm 运行时未在仓库层面完全固定。
- 缺少正式的 lint、format、类型检查、SAST/CodeQL 和覆盖率阈值。
- Dependabot PR #4/#7/#8/#9 已过期或失败，不能直接合并，应基于当前主线重新变基并逐项验证。
- 安装脚本依赖（esbuild、protobufjs、tesseract 等）应建立明确 allowlist 和来源审查。

## 5. 目标架构

```text
用户 / 已安装 PWA
        │
        ▼
页面协调层（轻量 app shell）
        │
        ├── Holdings Domain ── Schema 3 Repository ── localStorage / Gist shard
        │
        ├── Refresh Planner ── Refresh Generation / cancellation / dedupe
        │         │
        │         ├── Estimate Batch Client ─────── 司南 Worker（版本化契约）
        │         ├── Official NAV Client ───────── Bridge / 官方净值 / 分层缓存
        │         ├── Holdings Snapshot Client ──── Worker / 12h 与报告期缓存
        │         └── Security Quote Batch Client ─ Provider-batched 行情
        │
        ├── Quote Selection ── ValuationPeriod ── Presentation Model
        │
        ├── OCR Import Pipeline
        │      选择图片 → 预检/缩放 → 分片识别 → 表格解析
        │      → 匹配/歧义门禁 → 用户确认 → 原子写入
        │
        └── PWA Update Coordinator ── update guard / cache lifecycle / offline state
```

核心原则：

- `Quote` 只描述数据；`ValuationPeriod` 描述日期区间；`Presentation Model` 决定可显示的标签。三者不能互相猜测。
- `Refresh Planner` 决定是否请求；数据客户端不再自行随意强刷。
- 所有跨代异步结果都必须带 generation，并在写入缓存或 UI 前确认仍为当前代。
- 缓存命中不改变原来源日期和原来源身份；只增加缓存元数据。
- 页面只消费经过契约校验和选择策略的模型，不直接拼第三方响应字段。

## 6. 核心设计

### 6.1 `ValuationPeriod` 与“今日”语义

建议新增稳定模型：

```js
{
  baseDate,          // YYYY-MM-DD，真实基期
  targetDate,        // YYYY-MM-DD，真实目标期
  periodKind,        // intraday | latest_official | historical | stale | unavailable
  isTodayInChina,    // 由唯一 China clock 计算
  profitAmount,      // null 表示不可计算
  displayLabel,      // 今日估算 / 最新正式净值变动 / 历史区间 / 暂无数据
  sourceStatus       // live | official | modeled | cached_fresh | cached_stale
}
```

规则：

- 只有 `targetDate === ChinaToday` 且来源契约允许当日含义时，才显示“今日”。
- 最近两个正式净值之间的变化必须显示日期或“最新正式净值变动”。
- QDII/海外基金不得把跨多日净值差包装成当日估值。
- 排序字段从含糊的“今日收益”改为按 `periodKind` 可解释的“当前展示区间收益”；不同区间默认不混排或给出提示。
- 请求时间只用于诊断和缓存，不参与市场日期推断。

### 6.2 来源、缓存与新鲜度

统一缓存 envelope：

```js
{
  payload,
  originalSource,
  sourceTier,
  sourceDate,
  cachedAt,
  expiresAt,
  cacheState,        // fresh | stale | expired
  schemaVersion,
  fetchedAt
}
```

硬规则：

- stale fallback 只能返回 `sourceTier=cache` 与 `cacheState=stale/expired`，不得续期成官方成功。
- 缓存读失败、字段不完整、未知枚举、日期倒置、重复基金项应 fail closed。
- 缓存 TTL 与市场日期是两件事；TTL 未过不代表数据属于今天。
- 每次 refresh generation 至多集中持久化一次缓存，避免每只基金多次同步写 localStorage。
- 继续保持 `null / --`；只在明确收到数值 0 时显示 0。

### 6.3 分层刷新计划

| 数据类别 | 建议策略 | 手动刷新行为 | 失效与降级 |
| --- | --- | --- | --- |
| 盘中/即时行情 | 一代一次、按 provider 批量、短 TTL | 允许强刷，但去重同代请求 | 保留上次值并标明时间；无可信值则 `--` |
| 最新正式净值 | 按基金与公布窗口判断；同一目标日去重 | 默认不越过 TTL；提供诊断级强刷入口 | stale 必须显式标记，保留原 source date |
| 基金重仓 | 12 小时或报告期版本缓存 | 普通手动刷新不强刷 | 无完整 10 条/占比异常时禁用模型估值 |
| 基金元数据 | 7 天或版本化静态缓存 | 不强刷 | 旧值可显示并标记；关键字段缺失 fail closed |
| Gist 远端 | 脏数据触发 + 可见性/联网事件 + 退避 | 显式同步立即尝试 | 429/5xx 指数退避，不覆盖本地未提交数据 |

Refresh Plan 需要输出可诊断结构：计划了什么、命中什么缓存、为何跳过、实际发出几次请求、取消多少请求、最后选中了什么 Quote。

### 6.4 Worker 版本化契约

FundVal 与外部 Worker 至少约定：

```json
{
  "schema_version": 2,
  "service_version": "...",
  "generated_at": "...",
  "status": "ok|partial|degraded|unavailable",
  "capabilities": ["estimates_v2", "holdings_v2"],
  "items": []
}
```

前端要求：

- 对未知版本、未知状态、重复 code、缺少日期/来源、部分结果语义不明一律拒绝进入可信 Quote。
- `partial/degraded` 必须逐条携带状态与原因，不能只在顶层给一个模糊标识。
- 契约测试保留真实样例的脱敏/固定 fixture，不依赖实时网络。
- Worker 必须先兼容旧客户端，再发布 FundVal v16；随后才能移除旧契约。
- 若 Worker 本轮无法同步发布，FundVal v16 应保留 v1 adapter，但 UI 仍按 v16 的 fail-closed 语义展示。

### 6.5 Gist 同步与凭证

同步状态机：

```text
local-only → pending → syncing → verified
                    ├→ readonly
                    ├→ conflict
                    └→ failed（退避后重试）
```

具体要求：

- 多个兼容 Gist 时让用户选择并显示档案标识，不再隐式取第一个。
- 保存后只有“远端读回 + 内容哈希一致”才能进入 `verified`。
- 处理 401/403/404/409/429/5xx，并显示可操作原因；429/网络失败采用带抖动指数退避。
- 本地脏数据、远端更新和 tombstone 合并必须继续遵守 Schema 3 与 device shard 规则。
- 默认 token 仅保存在当前会话；持久保存需要用户显式选择并看到风险说明。
- 导出、诊断和日志必须过滤 token、Authorization 头、Gist 私有 URL 参数与用户内容。
- 使用专用测试账号和纯合成持仓完成双设备 E2E，不操作真实用户 Gist。

### 6.6 重仓与模型估值

- 单行校验之外，新增集合不变量：`market+code` 唯一、权重在合法范围、总权重不超过 100%、报告期有效、必要字段完整。
- 校验失败返回稳定 reason code，并在 UI 明确解释为何模型估值不可用。
- 个股行情按 provider 批量，缺失股票不按 0% 涨跌处理。
- 模型输出明确写“模型估算”，展示覆盖率、报告期和计算时点；覆盖率不足时不出单一精确百分比。
- 不能从重仓推断的现金、债券、衍生品、汇率和调仓部分必须保留为未知误差，不做隐式补齐。

### 6.7 市场日历与统一时钟

- 建立唯一 `MarketClock`，合并 `js/runtime/market-session.js` 与 `js/app.js` 中重复的周末/时段逻辑。
- 日历文件包含版本和 `valid_until`；超过有效期后降级为“日历待更新”，不得自信宣称交易日。
- 中国内地、香港和主要海外市场分别判断，不用中国周末规则替代所有市场。
- 外汇和海外多日累计收益没有可靠源时维持 unavailable，不从相邻日期猜测。

## 7. OCR、Android 与移动端方案

### 7.1 OCR 安全边界

继续坚持：截图在浏览器本地处理，不上传图片或 OCR 文本，不把真实用户截图提交到仓库或测试产物。

导入链路调整为：

```text
选择截图
→ 文件/尺寸预检
→ 低内存缩放或区域解码
→ 分片 OCR（进度、取消、超时）
→ 表格几何与文本解析
→ 基金代码/名称/份额类别匹配
→ importable 与歧义门禁
→ 用户逐项确认
→ 原子写入持仓
→ 写后校验与可撤销反馈
```

### 7.2 长截图与低内存

- 当前示例 1440×9317，约 13.42 MP，处于现有 16 MP 门槛内，必须作为固定回归样例的几何规格；仓库使用合成/脱敏等价图，不提交真实截图。
- 在 `createImageBitmap` 完整解码前读取图片头/尺寸并作预检；需要时先缩放或采用区域解码，不能仅把 16 MP 上限调大。
- 保留整图 1500px 分片和 160px overlap 的方向，增加重复行消解、跨片行一致性和内存释放断言。
- 每片完成后可见进度；取消到停止工作不超过 2 秒；超时、切后台和内存压力后允许安全重试。
- 引擎、Worker、bitmap、canvas 和临时 URL 在成功、失败、取消三条路径均必须释放。

### 7.3 自动匹配和确认页

- `layout.importable === false` 时所有候选默认 skip；只有用户逐项显式启用才能写入。
- 名称相近、基金代码缺失、A/C 类不确定、金额跨行、收益率符号不确定时一律视为歧义。
- 现有持仓匹配也不得自动绕过歧义门禁。
- 数字字段按同一行/同一列几何绑定；未知保持 `null`，不借用邻行数据。
- 确认按钮固定可见，离开含未保存修改的页面必须二次确认。
- OCR UI 明确显示本地处理、当前阶段、耗时、错误原因和手动修正入口。

### 7.4 手机界面与导航

- 320/360/390px 宽度必须无横向滚动，关键触控目标至少 44×44px，表单字号至少 16px。
- 支持 `safe-area-inset-*`、`visualViewport` 和软键盘遮挡，底部导航/确认按钮不与系统区域重叠。
- 建立最小 hash/history 状态，使 Android 返回键优先回到行情页或关闭当前子页，而不是直接退出 PWA。
- 覆盖相册选择、取消、再次选择同一文件、切后台恢复、网络恢复和屏幕旋转。

### 7.5 OCR 资源策略

- PaddleOCR 资源继续按需下载，不进入 SW CORE；UI 显示首次下载与离线能力状态。
- 明确 Tesseract fallback 的产品决策：若 v16 不完整接入，则从发布能力描述中移除，不让静态资源存在被误认为已支持。
- 若提供“离线 OCR 包”，必须由用户显式下载，并展示大小、校验、删除和更新入口。
- ORT 1.30 升级只能在独立分支验证，必须重建 Worker/manifest 并通过长图与目标真机；不得与模型、解析器或 UI 改动混在同一批次。

## 8. PWA 与离线升级

- manifest 补充稳定 `id`、正确的 `/FundVal/` `scope/start_url`、Apple touch icon，并区分 `any` 与 `maskable` 图标。
- Service Worker 继续使用版本化缓存桶；v16 安装成功且接管后再清理旧运行时缓存。
- 检测到持仓编辑、OCR 确认或导入未保存状态时，更新流程只能提示，不能强制刷新。
- 离线启动应在 3 秒内进入可用壳层，并明确显示“离线/数据可能过期”，不能把缓存值显示成实时。
- 从已安装 v15.0.2 升级到 v16.0.0 后：Schema 3 持仓哈希不变、无永久 waiting worker、最终只保留预期的新旧缓存桶。
- 回滚采用向前补丁版本，不把 SW/cache 名称直接降回 `fuyu-v15.0.2`。

## 9. 模块化与性能预算

### 9.1 `js/app.js` 拆分顺序

不进行一次性重写，按行为测试保护逐步移动：

1. `valuation-period.js`：日期区间、标签和展示收益。
2. `refresh-plan.js`：按数据类型决定请求、TTL、去重和 generation。
3. `cache-envelope.js`：缓存来源和 stale/fresh 语义。
4. `sync-status.js`：Gist 状态机与 UI model。
5. `pwa-update-controller.js`：更新 guard、版本提示和离线状态。
6. `market-clock.js`：市场日期/会话唯一入口。

每次迁移都先加 characterization test，再移动代码；外部字段和 Schema 3 不随文件拆分改名。

### 9.2 性能目标

| 指标 | v15.0.2 参考 | v16 门禁 |
| --- | --- | --- |
| 冷启动 gzip | 51,941 / 52,241 B | 不高于既有 hard budget；相对基线增长 >5% 必须说明，>10% 阻断 |
| 全部非 OCR chunks | 70,207 B | 不超过基线 10%，且首屏同步加载不得新增重模块 |
| 桌面 E2E 冷启动 | 147.8 / 153.8 / 203.6 ms 样本 | 同一机器中位数回归不超过 15%，p95 回归不超过 20% |
| 桌面 E2E 暖启动 | 88.9 / 117.3 / 148.8 ms 样本 | 同上 |
| 保存操作 | 74.7 / 86.6 / 97.0 ms 样本 | 中位数不超过基线 15% |
| 刷新请求数 | 先建立 v16 M0 机器基线 | 相同持仓冷/暖刷新请求数分别设预算；暖刷新不得重复获取未过期重仓/元数据 |

性能报告必须区分网络等待、服务端、主线程和渲染；不能只凭主观“更快”。

## 10. 测试与验收矩阵

### 10.1 自动化硬门禁

- `npm audit --audit-level=high`
- `npm test`
- `npm run check`
- `npm run build`，连续两次构建指纹一致
- `npm run test:e2e`
- 新增契约 fixture：v1/v2、partial/degraded、重复项、未知枚举、日期倒置、缺失来源。
- 新增日期属性测试：跨月/跨年、时区午夜、周末、节假日、QDII 延迟、未来日期。
- 新增缓存状态测试：fresh/stale/expired、Bridge 失败、旧缓存回退不续期。
- 新增刷新图测试：同代去重、跨代取消、批量请求、TTL 命中、手动刷新不误强刷。
- 新增 Gist 测试：多档案、只读、冲突、429/5xx、读回哈希、legacy/device shard/tombstone。
- 新增 OCR 测试：长图分片、跨片重复、A/C 歧义、跨行数字、不可导入布局、取消/超时/释放。
- 新增 PWA 更新测试：脏表单 guard、v15→v16、离线启动、缓存清理。

建议从 M0 起保存机器可读基线：coverage、chunk/asset fingerprint、网络请求计数、启动/保存/OCR耗时。覆盖率先作为基线，不在第一天凭空设过高阈值；但以下高风险模块必须补足关键分支：

- `js/notifications/notification-controller.js`
- `js/storage/gist-remote.js`
- `js/local-ocr.js`、`js/paddle-local-ocr.js`
- `js/resilience.js`
- `js/sandbox/quote-bridge-runtime.js`

### 10.2 数据可靠性门禁

- 选取境内、QDII、港股/海外、仅正式净值和模型估值等代表基金。
- 页面显示值与独立源逐项核对：值、基期、目标日期、来源、状态和缓存时间。
- 上游缺失、延迟、失败和冲突时验证不会转成 0、今天或新鲜成功。
- 生产 smoke 只使用读请求；任何写入用独立合成测试账户。

### 10.3 物理设备硬门禁

目标设备：

- 4 GB 内存 Android 实机 + Chrome。
- 主流 ≥8 GB Android 实机 + Chrome 与已安装 PWA。
- 当前受支持 iOS 实机 + Safari 与主屏幕 PWA。

每台设备至少连续 3 次：

| 项目 | 通过标准 |
| --- | --- |
| 长图识别 | 参考几何对应 15/15 候选；错误自动匹配 0；A/C 错配 0；至少 12/15 自动匹配，其余可手动完成 |
| 数字可靠性 | 不跨行借值；未知字段保持 null；写入前均可人工确认 |
| Android 耗时 | 主流机中位数 ≤35s、单次 ≤60s；4 GB 设备单次 ≤90s |
| iOS 耗时 | 单次 ≤75s |
| 稳定性 | 3/3 无崩溃、无永久卡死；取消 ≤2s；失败后可重试 |
| 隐私 | OCR 期间网络仅同源静态 GET；图片/OCR 文本上传为 0 |
| PWA 升级 | v15.0.2→v16.0.0 成功；脏输入受保护；持仓哈希不变；更新后无永久 waiting |
| 移动交互 | 相册选择/取消/重选、返回键、后台恢复、断网恢复、键盘和 safe area 全部通过 |

任何一项未跑都写 `NOT_RUN`，不能用模拟器结果代替。

## 11. 里程碑与工作包

### M0：治理和可重复基线（第 1 周前半）

- 保护 `main`：要求 PR、状态检查，禁止 force push。
- 将 CI 与 deploy 拆开：PR/提交只生成候选产物；tag 或显式批准部署同一 SHA/产物。
- 固定 Node/npm 版本，保存测试、覆盖率、bundle、OCR 资源、性能和请求数基线。
- 加入 CodeQL/SAST，审查依赖安装脚本 allowlist。
- 输出 `BASELINE.json`、发布责任人/回滚人清单和环境证据。

退出条件：未改业务行为；当前 410/410、check、build、12/12 全部继续通过；候选产物可追溯到提交 SHA。

### M1：契约和语义测试先行（第 1 周后半）

- 写 `ValuationPeriod`、缓存 envelope、Worker v2 和重仓集合不变量的契约测试。
- 为当前误标“今日”、stale 缓存续期和 OCR non-importable 建立失败用例。
- 与 Worker 仓库确认双向兼容发布顺序。

退出条件：关键 P1 均有先红后绿所需的可重复测试；不依赖实时网络。

### M2：数据可信核心（第 2 周）

- 实现 Quote → ValuationPeriod → Presentation 的边界。
- 实现缓存 provenance 与 fail-closed 解析。
- 加入重仓集合不变量、reason code 和统一 MarketClock 的第一阶段。
- 更新所有“今日”标签、排序、诊断和通知文案。

退出条件：代表性日期矩阵通过；任何旧/正式净值不再冒充当日估值；null/0 与 Schema 3 兼容测试通过。

### M3：刷新图、模块化与性能（第 3 周）

- 实现 Refresh Plan、批量证券行情、TTL 策略和每代一次缓存持久化。
- 按 9.1 顺序拆出 `app.js` 高风险职责，不做 UI 大改。
- 加请求计数、取消/去重诊断和性能回归报告。

退出条件：暖刷新不重复抓取稳定数据；同代无重复请求；过期代不能更新 UI/缓存；性能门禁通过。

### M4：Gist 同步可靠性（第 4 周）

- 实现档案选择、同步状态机、退避和凭证策略。
- 继续保留 Schema 3/device shard/tombstone/legacy 行为。
- 使用专用合成 Gist 做双浏览器/双设备往返、冲突和离线恢复。

退出条件：远端读回哈希验证成功；冲突不丢数据；日志/导出无 token；真实双端证据保存。

### M5：OCR、移动端与 PWA（第 5 周）

- 实现解码前预检/缩放、严格 importable 门禁、取消/重试/内存释放。
- 补全移动导航、键盘、安全区和确认页交互。
- 修复 manifest 身份、图标和 v15→v16 更新 guard。
- 执行模拟器/桌面预检，但不把它们标为真机通过。

退出条件：自动 OCR/PWA 门禁通过，目标真机矩阵具备可执行 RC 包。

### M6：RC、真机与生产发布（第 6 周；第 7 周作为缓冲）

- 冻结 RC，不再混入功能性重构。
- 完成三类物理设备各 3 次门禁。
- 完整运行本地与 CI 门禁，生成版本、清单、指纹、SBOM/依赖审计和候选产物。
- 使用 tag/显式批准部署同一候选产物，执行生产静态、PWA、数据日期和读-only smoke。
- 发布后观察错误率、Worker 降级、同步失败和缓存升级；形成实施反馈与发布清单。

退出条件：Definition of Done 全部满足；不能完成的项目要降级版本范围或延期，不能带着未声明风险直接标记 RELEASED。

## 12. 依赖升级策略

- Dependabot PR #4/#7/#8/#9 基于最新主线重新变基，逐个合并，禁止打包成一次“大升级”。
- `actions/deploy-pages`：只改发布流水线时单独验证。
- Vite：独立验证构建指纹、chunk 路径、Pages 子路径和 SW 资源清单。
- Playwright：先确定目标浏览器矩阵，再升级浏览器二进制和基线。
- ONNX Runtime：只在独立 OCR 实验分支升级到 1.30，按第 7/10 节完整验证。
- `tesseract.js-core` 当前版本高于注册表显示的所谓 latest，不做降级。
- 每个升级 PR 都需要：变更原因、上游 changelog、安装脚本审查、测试/构建/E2E、bundle/OCR 指纹和回滚点。

## 13. 发布、观测与回滚

### 13.1 发布前

- 同步 `package.json`、`js/version.js`、页面、manifest、SW、缓存桶、文档与生成产物到 16.0.0。
- 生成不可变候选：提交 SHA、tag、Actions run、产物 SHA-256、chunk 清单、OCR 资源清单。
- 保存 v15.0.2 生产基线和 v16 RC 对照，不因 CRLF/LF 直接误报内容漂移。
- 确认 Worker 向后兼容、生产 URL、Pages base path 与所有关键资源 200。

### 13.2 发布后

- 页面/manifest/runtime/SW/cache bucket 均必须一致为 16.0.0。
- 验证生产产物与 RC 哈希一致；Pages 换行差异归一化后比较。
- 对代表基金检查精确值、基期、目标日期、来源和状态，不只检查页面能打开。
- 检查旧安装升级、离线启动、console/network、Gist 合成写读回和 OCR 静态资源。
- 任何未执行的生产写入或设备门禁明确记为 `NOT_RUN`。

### 13.3 回滚

- 目标：发布异常 10 分钟内作出回滚决定，20 分钟内完成部署与验证。
- 不 force reset，不只替换 `index.html` 或单个 SW 文件。
- 使用 v15.0.2 业务代码创建**向前补丁版本 16.0.1**，统一生成新的页面、runtime、manifest、SW、缓存桶和产物；避免浏览器拒绝“倒退”缓存/版本。
- Schema 3 不回滚；如 v16 新增可选字段，v15 代码路径必须能忽略它们。
- 回滚后重复生产版本一致性、持仓哈希、离线和代表数据 smoke。

## 14. 风险登记

| 风险 | 概率/影响 | 控制措施 | 触发回滚/延期条件 |
| --- | --- | --- | --- |
| Worker 契约无法同步上线 | 中/高 | v1 adapter + v2 capability negotiation，Worker 先兼容发布 | 关键字段仍无日期/来源时不发布 v16 |
| OCR 内存优化降低识别率 | 中/高 | 引擎/缩放/解析分批实验，固定长图 corpus，真机 3 次 | 错误自动匹配 >0 或目标真机崩溃 |
| app.js 拆分引入行为漂移 | 中/高 | characterization test，小步迁移，保持字段名/Schema | 数据日期、null/0、持仓写入任一回归 |
| PWA 缓存升级造成白屏/旧版常驻 | 中/高 | v15→v16 E2E + 真机，dirty guard，版本化缓存 | waiting 永久存在、离线不可用或持仓变化 |
| Gist 真实环境限流/冲突 | 中/高 | 退避、状态机、专用合成账户、读回哈希 | 丢失本地数据、错误覆盖远端、token 泄露 |
| 依赖升级扩大 RC 变量 | 中/中 | 独立 PR、逐项合并、冻结期停止升级 | 无法归因的 OCR/构建/浏览器回归 |
| 直接推 main 自动上线 | 中/高 | M0 先保护分支、部署需批准 | 治理未完成前禁止 v16 功能提交进入 main |

## 15. Definition of Done

只有同时满足以下条件才可发布 v16.0.0：

- [ ] 所有 P1 均有测试、实现和可复核证据。
- [ ] “今日”只用于中国时区真实当日目标数据；其他区间标签含义准确。
- [ ] stale/cache/official/modeled/live 状态可从 UI 和诊断中辨认，缓存不续写来源日期。
- [ ] 刷新请求图符合预算，同代去重、跨代取消和稳定数据 TTL 正常。
- [ ] Worker 契约版本化或兼容 adapter 已验证，未知/部分数据 fail closed。
- [ ] Gist 双端合成 E2E 通过，读回哈希一致，无凭证泄露。
- [ ] OCR reference corpus、错误匹配、取消/重试、隐私与三类真机门禁通过。
- [ ] v15.0.2 已安装 PWA 到 v16.0.0 的升级、离线和持仓哈希门禁通过。
- [ ] `npm audit`、test、check、两次确定性 build、E2E、数据可靠性和性能门禁通过。
- [ ] 生产部署使用已验证的同一 SHA/产物，版本面与缓存桶一致。
- [ ] 回滚产物与操作步骤已演练，负责人、时间和证据路径明确。
- [ ] `IMPLEMENTATION_FEEDBACK.md`、`RELEASE_CHECKLIST.md`、性能与数据抽查报告完成。

## 16. 交付物

v16 完成时至少应产生：

- `docs/v16.0.0/UPGRADE_PLAN.md`（本文件）
- `docs/v16.0.0/BASELINE.json`
- `docs/v16.0.0/IMPLEMENTATION_FEEDBACK.md`
- `docs/v16.0.0/RELEASE_CHECKLIST.md`
- `docs/v16.0.0/PERFORMANCE.json`
- `docs/v16.0.0/DATA_RELIABILITY.md`
- `docs/v16.0.0/DEVICE_ACCEPTANCE.md`
- Worker v2 契约/fixture 与兼容性记录
- 构建产物指纹、SBOM/依赖审计、Actions run、tag 和回滚点

## 17. 建议启动顺序

```text
M0 分支保护/CI-Deploy 分离/基线
  ↓
M1 契约与失败用例
  ↓
M2 日期语义/缓存来源/重仓不变量
  ↓
M3 刷新计划/模块化/性能
  ├──────────────┐
  ↓              ↓
M4 Gist        M5 OCR/PWA/移动端
  └──────┬───────┘
         ↓
M6 RC/物理设备/生产发布/观察
```

第一批实际开发应从 M0 与 M1 开始。不要先改视觉、升级 OCR 引擎或直接把版本号改成 16.0.0；版本号应在所有硬门禁具备可发布候选时统一更新。
