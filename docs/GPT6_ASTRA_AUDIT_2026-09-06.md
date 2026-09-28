# FundVal 全面复审 — GPT-6 Astra

审计日期：2026-09-06（Asia/Shanghai）
审计目录：`D:\AI项目\FundVal`
审计基线：`main`，`5e135b51ce2b9c0fbe37c4119b62cab4b1c33927`，版本 **15.0.1**。
方法：主审集成复核 + 三个明确指定 `gpt-6-astra` 的专项审计（估值、存储安全、OCR 移动端）。

## 0. 先读结论

FundVal 是已经发布的、零框架的个人基金 Web/PWA 工具，不是 Vue + FastAPI 项目。现有架构有明显进步：报价契约、刷新代际隔离、Gist 分设备分片、本地备份事务、隔离 JSONP、独立本地 OCR、构建和发布校验都已经存在。

但“模块分别通过测试”尚未形成“组合后的金融数据和用户持仓始终正确”。本次确认 **12 项 P1、10 项 P2**，另列维护债务和待验证风险；未确认 P0。最需要先修的是正式涨幅字段适配、报价与基准期间的一致性、持仓写入和编辑冲突、OCR 长图完整性，以及 Bridge 排队超时。

| 验证项目 | 本轮结果 | 不能据此推断的内容 |
| --- | --- | --- |
| `npm test` | 337/337 通过 | 不能证明未覆盖的组合场景正确 |
| `npm run check` | 通过 | 语法校验不等于类型、语义或安全校验 |
| `npm run build` | 通过 | 不等于手机实际使用已验收 |
| `npm run test:e2e` | 8/8 通过，8.2 秒 | OCR 测试没有跑真实图片到确认写入的完整流程 |
| `npm audit --omit=dev --json` / 全依赖 audit | 均 0 已知漏洞 | 仅为当时 npm 公告数据库结论，不是无漏洞证明 |
| Git 状态 | 审计开始干净，fetch 后 HEAD 与 origin/main 一致 | 本轮没有发布新版本 |
| 最近正式部署工作流 | `33830208358`，2026-09-04，success | 本轮未重新完整执行生产资源指纹/真机验收 |

数据可信度结论：**NOT TRUSTWORTHY（限于当前组合估值、期间盈亏和特定并发写入边界）**。不是说所有已公布净值都错，而是存在已复现的路径，使取得了正确源数据后仍显示旧值、计算不一致盈亏，或静默覆盖持仓。不能把这些路径用于无需核对的决策或自动化。

### 证据边界

- 实际阅读了入口、核心运行时、存储、OCR、计算、构建、部署和相关测试；仓库 `js/scripts/test/e2e` 共 111 个 JS/MJS 文件，其中 57 个 `test/` 文件。并不声称逐行人工读过第三方包或二进制模型。
- 复现使用原始模块、从真实 `app.js` 截取的函数、内存 storage/VM、临时隔离浏览器上下文；没有读取或修改用户真实浏览器持仓、Token、Gist。
- 公开行情只做 GET。直接读东方财富 JS 时仅抽取 JSON 数组，没有执行远程代码。
- 本轮只新增本报告；未修改业务代码、配置、依赖、版本；未提交、推送、部署。build/E2E 产生的 `site/` 内容为既有忽略目录内的构建/测试产物。
- 保留根目录 `CODEX_HANDOFF.md`：其版本描述仍为 14.0.4，是历史审计快照，不能当作当前版本事实。本报告不覆盖历史证据。
- 本报告所有相对代码路径均相对 `D:\AI项目\FundVal`；行号以以上 Git 基线为准。

## 1. 项目基本信息

| 项目 | 当前事实 |
| --- | --- |
| 名称 | FundVal / 蜉蝣基金，npm 名 `fuyu-fund` |
| 版本 | 15.0.1；`package.json`、`js/version.js`、manifest、SW 有版本入口 |
| 定位 | 自选/个人持仓、基金行情及估值、盈亏展示、可选 Gist 同步、支付宝持仓截图本地识别 |
| 前端 | 原生 HTML/CSS/JavaScript ES Modules；无 Vue/React、无路由器 |
| 运行形态 | 静态 Web + PWA；OCR 是独立文档；第三方 JSONP 在隔离 iframe 内 |
| 生产 | GitHub Actions 构建 `site/` 并部署 GitHub Pages；[生产地址](https://aureliuswu.github.io/FundVal/) |
| 后端 | 本仓库无 FastAPI/Python/数据库服务/生产 Node 服务；依赖外部 Cloudflare Worker 和公共数据源 |
| 包管理 | npm + package-lock.json；本轮 Node v24.14.0、npm 11.9.0；CI Node 24 |
| Python | 本项目未定义 Python 运行环境，不能把机器上其他项目的 Python 当成本项目依赖 |
| 账户 | 无自建用户注册登录；可选 GitHub Token + Gist 配置；数据默认属于当前浏览器来源 |

## 2. 重要目录

```text
FundVal/
├─ index.html                         # 主界面入口，行情/持仓两个面板
├─ ocr-import.html                    # 独立 OCR 页面、严格同源 CSP
├─ quote-bridge.html                  # 无同源权限的 JSONP 隔离页面
├─ manifest.json / sw.js              # 安装、离线缓存、版本更新
├─ css/
│  ├─ style.css                       # 主界面、窄屏、底部导航
│  └─ ocr.css                         # OCR 表单、滚动和视口兼容
├─ js/
│  ├─ bootstrap.js                    # 恢复→迁移→自检→加载主应用
│  ├─ app.js                          # 核心编排/UI/行情/同步适配，约 2935 行
│  ├─ config.js / version.js          # 刷新、TTL、接口、版本
│  ├─ update-compat.js                # 新 HTML 与旧缓存壳安全更新按钮兼容
│  ├─ calculator.js / freshness.js    # 盈亏和新鲜度
│  ├─ eastmoney-estimate.js           # Worker 报价适配
│  ├─ fund-holdings.js                # 季报重仓适配
│  ├─ holdings-estimate.js            # 境内重仓模型与 enrichment
│  ├─ overseas-model.js / accuracy.js # 海外模型及预测误差账本
│  ├─ runtime/                       # Quote 契约、选择器、刷新代际、数据源健康、Bridge 客户端
│  ├─ sandbox/quote-bridge-runtime.js # 受限远程脚本、结构校验、串行队列
│  ├─ storage/                       # Schema 3、迁移、仓储事务、Gist 和云合并
│  ├─ storage.js / migrations.js      # 基础缓存/历史兼容和迁移入口
│  ├─ integrity.js / resilience.js    # 自检、恢复、脱敏诊断
│  ├─ ocr-import-page.js              # 图片选择、结果表单、用户确认写入
│  ├─ paddle-local-ocr.js             # 文件验证、切片、Paddle 调用
│  ├─ ocr-table-layout.js            # 坐标/列语义重建
│  ├─ alipay-ocr-parser.js           # 支付宝解析、基金名称匹配
│  ├─ holding-import-plan.js         # 候选与持仓合并规则
│  ├─ fund-catalog.js                # 本地基金目录及缓存
│  ├─ local-ocr.js                   # Tesseract 备用/历史路径
│  ├─ ocr/                          # 能力检测、引擎、资产契约、脱敏性能账本
│  └─ notifications/                # 页面内 14:30 通知控制器
├─ data/
│  ├─ fund-catalog.json              # OCR 身份匹配目录，不是用户持仓
│  └─ overseas-models.json           # 海外基金/代理证券静态配置
├─ vendor/paddle-ocr/models/         # 固定版本模型与来源说明
├─ scripts/                         # 构建、受控 OCR 补丁、指纹、预览代理、目录刷新
├─ test/                            # Node 单元及源码契约测试
├─ e2e/v15.spec.js                   # Playwright 浏览器测试
├─ playwright.config.mjs
├─ .github/workflows/deploy.yml      # 测试→构建→Pages→资源核验
├─ docs/                            # 历史审计、原型、发布证据及本报告
├─ AGENTS.md                        # 开发约束，接手前必须读
├─ CODEX_HANDOFF.md                  # 历史 14.0.4 交接，不是当前快照
└─ package.json / package-lock.json / README.md / CHANGELOG.md
```

## 3. 真实架构和数据流

```text
浏览器 / 安装态 PWA
 ├─ bootstrap：本地事务恢复→迁移→完整性检查→主应用
 ├─ index.html + app-shell（构建后）
 │   ├─ Worker /estimates 批量报价、/holdings 季报重仓
 │   ├─ Quote Bridge（sandbox="allow-scripts"，opaque origin）
 │   │   ├─ 东方财富 pingzhongdata：最近两期正式净值/元数据
 │   │   └─ 腾讯：指数、股票、海外代理行情
 │   ├─ 东方财富 push2：黄金及部分证券行情
 │   ├─ 本地海外模型 / 境内重仓模型
 │   └─ 可选 GitHub Gist：设备分片、合并、读回验证
 ├─ Quote 规范化→候选选择→盈亏→DOM
 ├─ localStorage：持仓、配置、缓存、备份、日志、精度账本
 ├─ Service Worker + Cache Storage：静态应用资源
 └─ ocr-import.html
     └─ 本地 File→ImageBitmap→切片→单 Worker→OCR token
         →表格/名称匹配→人工确认真实份额→本地仓储→回主页可选云同步
```

前端不仅渲染，也承担数据适配、估算、状态选择、持仓数据库职责。外部 Worker 源码不在本仓库；无法仅凭 FundVal 确认其部署配置、缓存一致性和日志策略。`scripts/serve-site.mjs` 只是本地预览服务器；其 `__fundval_dev` 路由是固定上游代理，不是生产后端。

刷新是页面存活期间的 timer/visibility/online/手动触发，不是可靠后台任务。Gist 每 60 秒自动拉取、延迟 5 秒推送等参数在 `js/config.js`。通知也依赖页面执行，没有推送服务保证关闭 App 后 14:30 唤醒。

## 4. 前端功能现状

| 功能 | 文件与实现 | 完成度/边界 |
| --- | --- | --- |
| 首页行情 | `index.html:47`、`app.js` 卡片/排序/展开详情 | 已实现；显示选择和基准存在 P1 |
| 持仓 | `index.html:72`、`app.js:2100` 后的表单 | 增删改/仅关注已实现；没有独立路由，跨页草稿与并发有缺陷 |
| 基金搜索 | 手输六位代码，名称可补全；OCR 使用目录匹配 | 不是完整搜索页/全站搜索路由，不应称已实现基金搜索中心 |
| 基金详情 | 卡片展开重仓、基金类型/规模/经理/费率、模型信息 | 已实现；海外证券身份处理有 P2 |
| 收益 | `calculator.js` 份额×净值、成本及基准差 | 是快照计算，不是完整交易账本/现金流收益率系统 |
| 交易记录 | 未见独立买卖/分红/费用流水数据模型及页面 | 不能把持仓 revision 或 OCR 日收益当交易记录 |
| 用户数据 | 本地 Schema 3 + 旧版投影；可选 Gist | 无自建账户后端；备份不是跨标签锁 |
| 设置/诊断 | 持仓页内 Gist、通知、导入导出、诊断 | 已实现；启动失败时诊断可达性仍需优化 |
| 导入/导出 | JSON、备份恢复、OCR 独立页 | 已实现；复杂导入后的 metadata 往返仍有缺陷 |
| 图表 | 当前主要是数值卡片、重仓表和误差摘要 | 没有完整净值走势/收益曲线图表系统，也无图表库 |
| PWA/移动 | manifest、SW、safe-area、底部导航 | 桌面模拟窄屏通过；实体手机验收未补齐 |

## 5. API 和外部服务清单

| 调用 | 输入 | 输出/处理 | 实现与约束 |
| --- | --- | --- | --- |
| Worker `GET /estimates` | `codes` 六位基金代码逗号列表；可有 `_` | `items[]`、`fetched_at`；部分适配新 `value_nav/base_nav/kind` 和 legacy 字段，但漏 `value_change`，基准绑定也不完整 | `eastmoney-estimate.js`、`quote-normalizer.js`；10 秒默认超时，批量读取 |
| Worker `GET /holdings` | `code`，可有 `_` | 季报日、证券代码/名称/净值权重 | `fund-holdings.js`；详情/境内模型使用 |
| 东方财富 `/pingzhongdata/{code}.js` | 基金代码、时间 cache-bust | 远程 JS 的净值序列/规模/经理/费率 | 只允许在隔离 Bridge 中执行，校验基金身份和最近两条数据 |
| 腾讯 `https://qt.gtimg.cn/q=...` | 白名单指数/证券代码 | `~` 分隔行情，字段 3/4/30/32 等 | Bridge 限制操作/数量，编码 gbk，严格消息 schema |
| 东方财富 push2 stock API | `secid`、固定 fields | 黄金/股票价格、涨幅/时间 | `app.js`；不得把基金代码直接变成股票身份 |
| GitHub Gist | GET/PATCH/创建 Gist、用户 Token | 旧文件、Schema 3 设备 shard、同步元数据 | `gist-remote.js`、`cloud-sync.js`；非本轮真实写入测试 |
| 本地 JSON/模型资源 | 静态文件 | 基金目录、海外模型、OCR manifest/WASM/权重 | 同源，无服务器 OCR 推理 |
| 本地 `GET /__fundval_dev/{estimates,holdings}` | 代码及允许的查询键 | Worker 原样 JSON | 仅 `npm run serve`；固定上游，禁止任意 URL 代理 |

本仓库无 FastAPI 路由，无法列出不存在的 FastAPI 请求类、Python 日志或数据库刷新任务。本次未发现前端调用一个“本仓库应该存在却不存在”的 FastAPI API；这里的跨源调用本就是架构设计。

重复/历史路径主要是 `storage.js` 的旧云 payload 辅助函数、`integrity.js` 旧修复/合并函数、`calculator.chooseDisplayValue`、`app.preferredDailyMove` 等历史策略及对应测试。当前生产主路径不使用其中若干函数，但旧测试仍会通过；不要误当成现行策略。

## 6. 重要数据模型

| 模型 | 字段 | 来源与存储 | 使用位置 |
| --- | --- | --- | --- |
| Schema 3 文档 | `schema,updatedAt,deviceId,holdings[]` | `fuyu_holdings_v3` | 仓储、云同步、OCR |
| 持仓记录 | `id=fund:{code},fundCode,fundName,shares,costNav,createdAt,updatedAt,deletedAt,revision,deviceId,note` | 人工/确认导入/云合并；稳定 ID、tombstone | canonical 持仓和兼容投影 |
| legacy 持仓 | `code,name,shares,cost,updated_at,deleted` | `fuyu_holdings_v1` 和页面内存 | 当前 app 大量沿用；投影丢 note 是已确认问题 |
| Quote Envelope | `fundCode,market,assetKind,valueKind,value,changePct,sourceId,sourceTier,observedAt,fetchedAt,officialNavDate,status,ageMs,coverage,confidence,modelVersion,reasonCodes` | 数据适配器/模型；冻结对象 | 显示、选择器、通知、缓存；**未绑定 baseNav 是缺口** |
| 展示基金对象 | legacy 净值对 + `source_quote/latest_nav_move/quoteCandidates/quote/primary_*` + 盈亏 | 各数据源 enrichment 后生成 | `buildFundData`；新旧两层并存造成耦合 |
| OCR token | 文本、bbox、置信度、区域、切片坐标 | 本地 Worker，内存 | 布局重建、表头语义、基金匹配 |
| OCR 候选 | 名称/代码候选、金额、日收益、持有收益/收益率、真实份额、成本选择、skip/确认状态 | 识别 + 用户表单 | `holding-import-plan.js`→仓储 |
| 精度账本 | 预测/目标/基准日期、模型版本、预测与实际涨幅 | `accuracy.js` 本地存储 | 海外模型回测摘要；不是交易账本 |
| 用户设置 | Gist Token/ID、同步时间、通知发送日期 | localStorage | `app.js`；Token 不应出现在诊断和报告中 |

缓存与用户持仓不是同一层：`fuyu_funds_cache_v1`、每只基金 NAV/重仓缓存等可失效；持仓和备份不能当普通缓存清空。源码 TTL 包括盘中 60 秒、正式净值 10 分钟、重仓 12 小时、元数据 7 天；强制刷新与各源取数路径仍需分别观察，不代表所有缓存都命中。

## 7. P0 / P1 问题（必须优先处理）

P0：本轮未确认全站不能运行、实际密钥泄露或无需特定边界即可发生的灾难级故障。这不降低以下 P1 的数据风险。P1 指正常产品使用或可预期升级/失败条件下，核心数据可能错误或丢失，应在扩大功能前解决。

### P1-D01：新正式净值已取得，选择器仍可能选旧值

- **位置**：`js/runtime/quote-contract.js:78`、`:175`；`js/runtime/quote-normalizer.js:282`。
- **原因**：正式净值 `observedAt` 是 date-only，时间解析器有意不把它当盘中时间；比较器却把无法解析的日期统一当 0。同来源/等级的官方候选因此按原数组顺序保留，proxy 候选先于独立官方补充候选。
- **复现**：proxy 09-03 NAV 1.10/+10%，补充源 09-04 NAV 1.20、前净值 1.10；原始候选构建与选择函数最终仍选 09-03 的 1.10。
- **影响**：不是“数据源没更新”，而是新数据已经返回也没被选中。
- **方向**：正式净值按 `officialNavDate` 比较，明确日期/来源优先规则；保持 date-only 不能冒充实时这一约束，不能简单删除时间解析保护。

### P1-D02：选中报价和盈亏基准来自不同候选

- **位置**：`js/calculator.js:29`；`js/holdings-estimate.js:156`；`js/app.js:973`。
- **原因**：Envelope 绑定了值、涨幅，却不绑定对应基准；`resolveQuoteBaseNav` 回读被其他 enrichment 改写的 `last_nav/latest_nav_move`。
- **复现 A**：选中旧 1.10/+10%，同时读到新官方记录的前净值 1.10；100 份今日盈亏变成 0。
- **复现 B（不依赖 D01）**：主源 base 1.00、估值 1.10/+10%；重仓补充把 `last_nav` 改为 1.05；主源仍胜出，100 份盈亏却变成 5 元，而非与该主源对应的 10 元。
- **方向**：候选携带不可变 `baseNav/baseNavDate/targetDate`，计算只消费被选候选的完整上下文；补 producer→normalizer→selector→calculator 集成测试。

### P1-D03：模型可能重复计算已计入正式净值的当期涨跌

- **位置**：`js/holdings-estimate.js:147`；`js/app.js:1587`；`js/overseas-model.js:165`。
- **境内复现**：09-04 正式净值已是 1.10，重仓仍为 09-04 收盘 +10%；应用再乘一次，得到 1.21。
- **海外复现**：北京时间 09-05 10:00，官方日期 09-04 NAV 1.10，底层为北京时间 09-05 04:00 的美股 09-04 收盘 +10%；输出 1.21、`stale=false`，声称“下一净值”。
- **原因**：只看行情够不够新，没有证明组件收益期间晚于基准净值；官方落后多日时，单日涨幅也不能代替累计期间收益。
- **方向**：显式定义基准净值日、各市场 session 日和目标净值日；已结算期间不重复估算。无法证明期间一致时，仅显示行情参考，不生成“下一净值”及相应盈亏。

### P1-D04：当前 Worker 正式涨幅字段未被读取，实际源有值却显示未知

- **位置**：`js/runtime/quote-normalizer.js:109`、`:206`；`js/eastmoney-estimate.js:29` 后的适配；候选排序关联D01。
- **实际公开样本**：005844 的 `value_nav=3.1234,value_change=-3.34`，012920 的 `value_nav=3.632,value_change=0.03`；两者 `estimate_change/est_change` 都为null，契约明确是正式净值。
- **复现**：将本轮取得的真实响应相关字段回放给原始 `normalizeEstimateRow`，得到 `source_quote.status=official`、净值正确、`changePct=null`。再加入同日期、同净值、涨幅完整的 `latest_nav_move`，选择器仍保留先入列的空涨幅候选。
- **原因**：值读取了 `value_nav`，涨幅却仅查 `estimate_change/est_change/changePct`，未查 `value_change`；同质量候选也没有对同一值的完整性作明确选择。
- **影响**：这不是仅在假设旧日期时才发生；当前真实接口契约已可导致官方涨幅丢失，与已计算的盈亏不一致。
- **方向**：按 `kind/valueKind` 显式适配正式 `value_*` 与估算 `estimate_*` 字段，保留合法0与null差异；同一日期/同一基准候选明确选择规则，不能任意把不同来源/期间字段拼起来。新增当前公开契约脱敏固定样本回归。

### P1-S01：本地未来 Schema 会被旧版备份自动降级覆盖

- **位置**：`js/storage/holdings-repository.js:304`、`:334`；启动入口 `js/resilience.js:79`。
- **复现**：主键为 Schema 4，备份为有效 Schema 3；`loadHoldingsRepository` 返回 `ok=true, reason=backup_recovered`，主键变回 Schema 3，未来原文未保留在原位置。
- **原因**：parser 已正确给出未来版本只读标记，仓储未在自动恢复前处理这一分支。
- **影响**：旧缓存/版本回退打开新数据可能抹掉新字段和新持仓；额外损坏原文备份有长度限制，不能保证可完整恢复。
- **方向**：未来 Schema 直接只读，主键/备份全部不得更改；测试整个启动和仓储链，不只测试 parser。

### P1-S02：跨标签事务双方都成功，仍可丢一方新增持仓

- **位置**：`js/storage/holdings-repository.js:170`、`:195`、`:232`；`js/resilience.js:153`。
- **复现**：A 校验 prepared journal 后、写 V3 前，B 将 A 日志认作未应用事务并恢复/提交；A 随后覆盖 B。两个调用均 `ok=true`，B 新增 `000003` 消失。
- **原因**：CAS 检查、日志检查、多个 localStorage 写入不原子；崩溃恢复无法识别另一个页面仍在执行的事务。
- **方向**：读/恢复/迁移/写入统一使用跨页面互斥（如 Web Locks），或迁至 IndexedDB 真事务；OCR 页必须参与同一协议。再加一次读回不能消除窗口。
- **边界**：真实仓储的内存交错已复现；未测真实浏览器多进程竞争发生概率。

### P1-S03：一次普通保存可清空所有既有备注

- **位置**：`js/storage/holdings-schema.js:201`；`js/storage/holdings-repository.js:404`、`:419`。
- **复现**：Schema 3 `note="keep me"` 经页面 legacy 投影后普通保存，结果 `note=null`、revision 增加；未编辑的基金也受影响。
- **原因**：投影不输出 note；回写把“字段不存在”解释成“用户明确清空”。
- **方向**：缺失字段保留原 metadata；只有显式编辑才能清空。补完整 metadata round-trip 测试。

### P1-S04：保存失败后页面仍使用未保存的新份额

- **位置**：`js/app.js:219`、`:2159`；新增、删除逻辑同样需检查。
- **复现**：备份写入模拟额度不足：磁盘仍 10 份，内存已变 99 份，错误 `backup_failed`，toast 却是“保存失败，原持仓已保留”。
- **原因**：先原地改 `holdings`，失败结果无 document 时不恢复内存。
- **影响**：页面计算/后续保存使用未经持久化的新状态，重载又突然变旧。
- **方向**：编辑 candidate，持久化成功后才安装页面快照；失败保留草稿，但已确认展示数据不变。

### P1-S05：后台云同步可以让陈旧编辑表单通过冲突检查

- **位置**：`js/app.js:435`、`:453`、`:2122`、`:2159`。
- **复现**：打开表单 10 份；云拉取变成 20 份；表单未更新。用户只改名称保存，最终份额回到 10，revision 正常升至 3。
- **原因**：全局 `holdingsDocument` 已被云同步替换，保存用新全局文档当 CAS 基线，却提交旧表单全部字段。
- **方向**：编辑开始记录该行不可变 revision/快照；变化后显示冲突，或只提交用户实际改过的字段并明确合并规则。

### P1-O01：OCR 确认页也会覆盖期间变更，甚至自动恢复已删除持仓

- **位置**：`js/ocr-import-page.js:467`、`:504`、`:537`；`js/holding-import-plan.js:76`。
- **复现**：生成表单时 100 份/成本 2，另一页改为 200 份/成本 3；点击确认又保存回 100/2。期间删除时，页面自动形成 `allowRestoreCodes=['005844']`，tombstone 被静默撤销。
- **原因**：生成候选时没有保存完整编辑基线，点击时现读 document 只保护最后几次同步调用之间的窗口，不保护用户核对期间。
- **方向**：记录候选生成时的 revision，保存前检查变化，重新展示差异和确认；不能以“现读发现已删”代替用户明确恢复意图。

### P1-O02：固定百分比裁剪导致长截图静默漏基金

- **位置**：`js/paddle-local-ocr.js:39`；`js/ocr-import-page.js:205`。
- **复现**：`planPaddleRowOcrTiles(1080,10000)` 属于合法的 10.8 MP 图，但持仓切片只覆盖 y=1600..9000。source 区识别出的 y=1000 基金不参加表格重建；9000 以下不识别。
- **触发**：长图基金更多、页头比例变小、页脚更短或用户裁剪原图后，基金不再严格落在 16%..90%。
- **影响**：页面仍可提示识别完成，漏行并不会作为需核对项出现。截图外旧持仓不删除是已有保护，但不解决首次导入漏行。
- **方向**：全高切片后语义筛选，或按真实表头/页脚坐标定位；不同高度、固定页头高度、末尾基金都需测试。
- **边界**：确定复现的是裁剪/过滤算法，不冒称本轮已重新跑用户实图模型。

### P1-R01：串行 Bridge 与入队即计时导致成批超时

- **位置**：`js/sandbox/quote-bridge-runtime.js:38`、`:332`；`js/runtime/quote-bridge-client.js:174`；`js/app.js:1321`、`:1338`；`js/config.js:2`。
- **原因**：所有操作共用 `requestQueue.then(task, task)`，正式净值、指数、海外行情互相排队；客户端 7/8 秒从发送起计时，队列内部单请求上限却是 12 秒；客户端超时/abort 不会移除远端队列任务。
- **真实模块 + 内存 DOM 复现**：三个正式净值请求同时发出，模拟每个上游均恰好 3 秒，无上游失败。

| 请求 | 开始取上游 | 客户端结果 | 上游完成 |
| --- | ---: | --- | ---: |
| 005844 | 5 ms | 3013 ms 成功 | 3011 ms |
| 012920 | 3013 ms | 6015 ms 成功 | 6015 ms |
| 539002 | 6015 ms | 7020 ms 超时 | 9018 ms |

- **影响**：并非单源超过 7 秒，第三只也失败；旧代际已经取消的任务仍占队列，影响新刷新。主应用对多只基金并行触发补充净值，路径实际可达。
- **方向**：保留 JSONP 全局变量隔离所需的安全约束，增加有界/可取消调度与明确队列 deadline；可按互不共享全局状态的隔离单元分队列。不能简单无限延长客户端超时或在同一 JS 全局随意并发。

## 8. P2 问题

| ID | 问题、证据、位置 | 影响与方向 |
| --- | --- | --- |
| D04 | `fund-holdings.js:12` 拒绝 `285A`；`app.js:1817/1857` 把全部六位重仓码当 A 股。生产 539002 的 `000660=SK海力士`、`005930=三星电子` 被错路由；012920 的 `285A=KIOXIA` 被过滤，十只剩九只 | 详情行情缺失或串证券。统一 market/exchange/securityId，未知市场不按长度猜；静态海外模型中的 `kr/jp` 身份是正确的，不能误称所有海外模型都错 |
| D05 | `holdings-estimate.js:165` 写 `est_holdings_coverage`，`quote-normalizer.js:261` 读 `est_coverage`；60% 进入 Envelope 后成 null | 可信提示丢覆盖率。统一 producer/consumer 字段，补真实链路测试 |
| D06 | `holdings-estimate.js:107` 使用 `Number(null)`；五只各 10% 的 null 涨幅可得 available=true/change=0/coverage=50。同日未来时刻也缺拒绝 | 计算器不满足未知不补零。当前正常线上 fetch 路径会清理字段，显式 null 可达性未证实；拒绝 null/空串/boolean、未来时间及重复/过量权重 |
| D07 | `market-session.js:113` 支持 holidays 参数，但生产调用没有日历输入；app 顶部时段还另写一套周内时段判断 | 法定休市工作日状态/刷新错误。接有来源/有效期的交易日历，或明确标识仅按常规交易时间推断 |
| G01 | `app.js:2270` 黄金请求不取源时间；`:2280` 最新价缺失会用昨收，`:2307` 却标 `current`；指数 `:2363` 同样将成功响应直接标 current | 获取成功不等于当前行情；展示只在 status=stale 时标“旧”。应区分昨收 fallback、源时间未知/延迟，不能用抓取时间替代行情时间。此项为确定控制流，未声称线上金价本轮已错误 |
| O03 | `ocr-table-layout.js:238` 仅接受 matched；歧义候选经布局变为 name=''、match=null。合成 A/C 示例 matcher 本有两个 0.857 候选 | 最需要人工选身份的行却失去提示。保留未确认名称锚点/候选，仅禁止自动选中 |
| O04 | `ocr-table-layout.js:371/383/436` 以收益率为锚且要求四数字齐全。仅去掉收益率 token，金额1000/日收益10/持有收益100也全变 null | 局部 OCR 错误扩大成整行丢数。在可靠行边界内独立保留字段，不能跨行补数 |
| O05 | `scripts/paddle-ocr-entry.mjs:118/315/339` pending 无 deadline/Abort，dispose 还等待回复；`ocr/asset-manifest.js:175` fetch 无超时；`ocr-import-page.js:142` active task 控制按钮 | Worker/下载不报错但悬挂时无法在本页重试。分阶段 deadline、强制 terminate、清 pending、短 dispose 超时；未把真实 GPU 卡死声称为本轮真机复现 |
| R02 | `app.js:2242` 切回行情直接 cancelEdit；浏览器实测把份额草稿100→999，再切行情/持仓，输入框变空且未提示 | 未保存草稿静默丢失。页内导航纳入现有 dirty guard，或保留草稿；beforeunload 不覆盖 class 面板切换 |
| R03 | `scripts/serve-site.mjs:31` decodeURIComponent 在 try 外；仅对自建临时进程请求 `/%E0%A4%A` 即 URIError/exit1 | 本地预览/E2E 可被单次畸形请求终止；生产 Pages 不运行这个进程。无效 URL 应回400，后续正常请求应仍可用 |

## 9. P3、技术债及待确认风险

- **超大编排器**：`app.js` 约2935行、`alipay-ocr-parser.js` 945行、OCR页674行、cloud-sync606行、layout589行、OCR构建581行。不是“长就错”，但报价/存储副作用/DOM交错使跨层测试和不变量难维护。
- **新旧字段并存**：Envelope 与 legacy `est_* / primary_* / latest_nav_move` 双套状态；已有 P1/P2 证明不仅是风格问题。优先在边界统一，不建议全仓重写。
- **旧策略测试造成错觉**：未被生产消费的 `chooseDisplayValue/preferredDailyMove`、旧 cloud payload/integrity helper 仍存在。注明历史用途后再决定移除，不可见到“未用”就直接删。
- **性能预算漏自动加载图**：构建把嵌套 dynamic import 全归 lazy，但 Bridge 在启动时加载，通知在 idle 自动加载；详见第12节。
- **重复请求/渲染写放大**：每只 enrichment 分别 `saveCache(fundsData)`，可能反复序列化整表；详情拼 innerHTML 重建，海量基金时可能产生近似平方级总工作。尚无大持仓基准，不能声称当前7只必卡。
- **硬编码源与模型**：Worker域名、证券格式、阈值与季度配置散落；模型覆盖、期间、未披露仓位假设须有单一契约，不能单改UI标签掩盖不确定性。
- **秘密防误提交规则**：`.gitignore` 未列 `.env`/私钥模式；当前没发现实际 `.env` 或真实密钥，仅属预防性缺口。
- **历史审计/发布文档状态叠加**：旧文件内有不同阶段 NOT_RUN/BLOCKED 与后续发布证据，接手 AI 应按时间和版本解释，不把早期结论或后来模拟器结果泛化。
- **Bridge 生命周期待加强**：`quote-bridge-client.js` iframe 尚在加载时 destroy，没有立即清理尚未赋到 `this.frame` 的节点；加载事件不保证 runtime 已就绪，失败后的 frame 缺少重建健康探测。静态风险，未作为本轮新增P1计数。
- **OCR 解码前内存**：`paddle-local-ocr.js:446` 完整 ImageBitmap 解码后才检查像素上限；压缩很小但像素巨大的图仍可能先触发内存峰值。未运行OOM破坏试验。
- **OCR bfcache**：`ocr-import-page.js:637/667` pagehide 清理但无 pageshow重建，监听 once；返回历史文档的结果恢复需实测，不直接判定所有返回都坏。
- **收益率语义**：Bridge只保留净值点，官方 `equityReturn`/分红信息未进入快照计算。除息日回报可能需要复权/现金分红账本；未取真实除息日样本，此项待专项验证。
- **模型假设不同**：海外部分重仓收益按已覆盖权重归一到全基金，境内未披露部分按0贡献；不直接判定二者公式错误，但应明确说明假设及区间，不共用模糊“穿透”文案。
- **源码调试扫描**：`js/scripts` 的 TODO/FIXME/debugger/console.log 扫描仅见构建脚本正常体积输出；没有据此确认业务 console 泄露。源码检查不是完整日志脱敏证明。

## 10. 安全审计

### 已有保护

- 主页面第三方 JSONP 已移到 opaque-origin iframe，sandbox只含 `allow-scripts`；没有 `allow-same-origin`。主页面Token/持仓不能由该iframe直接读取。
- Bridge操作、代码格式、请求ID、WindowProxy来源、返回字段均校验；`postMessage('*')` 是opaque origin所需，不能仅看到星号就判定漏洞。
- 主页面名称等渲染经过 `esc`；已覆盖恶意远程重仓字段的浏览器测试；本轮未确认名称XSS或直接Token外传。
- OCR独立文档，CSP限制同源代码/资源；只接受本地 File/Blob，文件头与类型校验，原图和全文不持久化、不发送服务器。
- Gist云端未来Schema阻断、分设备分片、PATCH后读回、备份失败阻断写入存在；**本地未来Schema的仓储分支仍有S01缺陷，不能混为“全部fail-closed”**。
- CI Action固定SHA、构建只读权限，部署才有pages/id-token写权限；PR不部署；构建按allowlist复制，不整体暴露仓库。
- 开发代理只允许固定上游的两个GET端点，限制代码格式、查询键和数量；未发现任意URL代理。

### 仍需明确的边界

Token存localStorage是现有设计事实，不是“有Token就算漏洞”；但同源代码被攻破、浏览器扩展或用户设备失陷仍可读取，Gist也不是端到端加密保险箱。备份和导出包含财务资料，应由用户自行保护。

对136个Git跟踪文本文件做GitHub Token/AWS key/private-key标头扫描，只命中测试脱敏样例，未确认真实密钥；未扫描完整Git历史、真实用户浏览器和私人未跟踪文件。本报告不记录任何真实密钥。npm官方registry本轮没有报告已知漏洞，不能推出应用无逻辑/供应链风险。

## 11. 公开数据复核

2026-09-06约13:14—13:18北京时间，读取Worker及东方财富公开净值序列。下面是最近正式净值，不是周日“实时估值”。

| 基金 | 东方财富前一期 | 东方财富最新一期 | Worker实际契约说明 |
| --- | --- | --- | --- |
| 005844 | 09-03：3.2313 | 09-04：3.1234 | 后续完整抽样value_nav=3.1234，base_nav=3.2313，官方降级 |
| 012920 | 09-02：3.6310 | 09-03：3.6320 | value_nav=3.632，base_nav=3.631，官方降级 |
| 539002 | 09-02：2.3300 | 09-03：2.3300 | 初次抽样为latest_official；零变化可以是真实零，不应变成缺失 |
| 025209 | 09-03：2.3376 | 09-04：2.2665 | 初次抽样为latest_official；last_nav=2.3376是基准，不是最新净值 |

来源：[Worker估值样本](https://sinan-estimate-push.ligugu69.workers.dev/estimates?codes=005844,012920,539002,025209)、[005844净值序列](https://fund.eastmoney.com/pingzhongdata/005844.js)、[012920净值序列](https://fund.eastmoney.com/pingzhongdata/012920.js)、[539002净值序列](https://fund.eastmoney.com/pingzhongdata/539002.js)、[025209净值序列](https://fund.eastmoney.com/pingzhongdata/025209.js)。动态接口未来会变化，以上只代表本次观察时点。

完整Worker样本明确区分 `base_nav/base_nav_date`、`value_nav/value_change/value_date` 与为空的 `estimate_*`；legacy `est_nav=null` 不代表没有正式净值。005844诊断记录重仓模型 `http_5xx`；012920为 `overseas_model_forbidden`，前者不能用一次观测认定长期故障，后者是此代理模型范围限制。FundVal本地海外模型另有独立逻辑。

生产重仓样本：[539002](https://sinan-estimate-push.ligugu69.workers.dev/holdings?code=539002)、[012920](https://sinan-estimate-push.ligugu69.workers.dev/holdings?code=012920)，支持第8节P2-D04所述韩国数字码与日本285A身份问题。

13:28专项复核再次获得上述005844/012920正式字段；源有 `value_change`，当前前端适配后却丢失，详见P1-D04。主审随后用此前已读取的真实字段回放，独立确认同日补充候选也未能取代空涨幅候选。一次后续公开GET触发8秒审计超时，未无限重试；该额外请求不混入第12节原先连续5次同查询性能样本。

这些读取说明部分源数据本身可以正确、最新地返回；D01—D03是合成边界数据在真实代码中的复现，**没有宣称当前所有在线基金正在触发同一错误**。

## 12. 性能检查

使用性能检查技能，区分静态体积、客户端初始化、上游等待。本轮没有改代码，因此不存在可以诚实声称的“本轮优化前后提升”。建立当前基线，并对已有体积预算核对。

| 指标 | 既有基线/预算 | 当前 | 差异/判定 | 方法 |
| --- | ---: | ---: | --- | --- |
| 构建静态cold图gzip | 52,241 B（脚本记录v14.0.4预算） | 51,598 B | -1.23%，静态门槛PASS | Vite产物，逐chunk gzip求和 |
| 启动会实际自动加载的app chunks | 无同口径历史实测 | 57,427 B gzip | WARN：比构建cold口径多5,829B | 资源实测发现Bridge/通知自动加载，再按manifest求和；不是实际网络压缩传输统计 |
| 全部非OCR app chunks | 无 | 63,167 B gzip | 基线 | 构建输出；SW安装会预缓存这些chunk |
| 空持仓冷启动可用 | 无同环境历史值；通用关注3秒 | 中位186ms，最慢241ms | 本地合成PASS；不能外推手机 | 三个独立Chrome上下文：241/186/118ms |
| HTTP缓存热启动可用 | 无同环境历史值 | 中位50ms，最慢54ms | 本地合成PASS | 46/50/54ms；资源transferSize=0确认HTTP缓存 |
| Worker四基金批量GET | 无同链路历史值 | 中位124ms，最慢6286ms | 尾部WARN/超过3秒；无法证明版本回归 | 5次：6286/124/120/124/121ms |
| Bridge三基金均3秒源 | 每请求7秒deadline | 第三只7020ms失败 | 功能FAIL，见R01 | 实际client/runtime+内存DOM |

客户端方法：Windows桌面Chrome headless，390×844，无CPU/网络降速；loopback临时静态服务器、HTTP缓存1小时；SW关闭，以CDP阻止HTTPS，避免源等待影响页面初始化；无真实用户持仓。可用定义为bootstrap migration=ok且版本标签已由应用初始化。热启动不是PWA离线测量。一个冷样本出现51ms long task，其余无；FCP有一个样本缺失，因此不提供伪造的FCP中位数。宽度测量无横向溢出。

公开接口首个慢样本与后续相同 `fetched_at` 的快样本符合缓存/连接复用影响，但没有服务端trace，**无法确认是Worker冷启动、上游慢或网络导致**。

OCR发布manifest资产共88,196,072 B（约84.1MiB），其中Worker约11.34MB、两个模型约6.32MB、不同ORT变体合计约64.68MB、fallback约5.79MB。它们不是首页自动下载，也不是每次识别必下载全部；实际后端只选择部分变体，HTTP缓存另有作用。首先应测真实手机首次模型下载、解码/识别/确认各阶段，而不是把84MiB当首页bundle。

优化优先顺序：先修Bridge排队失败和OCR可取消性；再完善真实资源请求预算、合并重复序列化/渲染；最后以真实持仓数和中低端手机基线决定是否继续拆app。没有证据支持立即换框架。

## 13. 移动端/PWA

| 检查 | 当前事实/风险 |
| --- | --- |
| viewport/safe-area | 主页面和OCR有viewport-fit、safe-area；OCR兼容100dvh；390px合成测试无横向溢出 |
| 底部导航/滚动 | fixed导航、底部安全区、OCR独立滚动区域存在；页内导航丢草稿见R02 |
| 软键盘/相册 | inputmode/文件选择入口存在；实际iOS/Android键盘、相册权限与内存表现未本轮真机验证 |
| 安装 | manifest start_url相对路径、standalone、192/512图标；不能将桌面安装/模拟器等价成实体手机通过 |
| SW | 版本缓存fuyu-v15.0.1；安装cache reload；保留一个上版缓存；静态壳/懒加载资源预缓存 |
| 更新 | waiting提示、dirty/sync阻断、其他页面BroadcastChannel询问、刷新drain、点击后SKIP_WAITING；独立update-compat保留旧壳按钮通路 |
| 离线 | 本轮E2E可重开缓存壳；报价仍应为旧数据/未知，不能offline补0 |
| 缓存边界 | 跨源API不被SW缓存；本地dev路径不含`/api/`，可能落入通用networkFirst缓存，开发环境语义需补专项测试 |
| 更新兼容范围 | 本轮包含legacy guarded updater组合测试和首次安装离线测试；不是完整生产v14→v15双版本迁移闭环 |
| 实机状态 | 历史docs有MuMu Android15/Brave证据，也明确实体Android/iOS及已安装PWA门槛仍BLOCKED_FOR_DEVICE_VALIDATION；本轮未解除 |

未来更新必须继续保留主存储键/Schema、独立兼容脚本和Bridge隔离。旧缓存可能运行旧代码，S01必须先解决再谈未来Schema升级。BroadcastChannel的450ms等待/后台冻结、多个版本静态资源混合、bfcache恢复均值得真实双页面/双版本验收；不据静态代码直接宣称所有更新已不安全。

## 14. OCR 独立分析

当前主路径优先支持支付宝三列基金持仓长截图，不是通用任意银行/券商文档OCR。

```text
选择PNG/JPEG/WebP本地File/Blob
→ 后缀/MIME/文件头及16MiB检查
→ ImageBitmap解码、约16Mi像素上限检查
→ source区域 + 固定16%..90%持仓重叠切片（当前漏行点）
→ 同源manifest/固定Paddle0.4.2、PP-OCRv6 tiny、ORT1.27.0
→ 单Worker、单批次、WebGPU尝试→失败后WASM
→ 有坐标token、映射回原图、表头/列语义
→ 基金目录精确/模糊匹配（歧义跨层保留有缺口）
→ 展示金额/日收益/持有收益/收益率和身份候选
→ 用户填写/核对真实份额、主动选择截图成本、逐项skip/确认
→ 备份+仓储写入（确认期间冲突有缺口）
→ 返回主页刷新；有Gist配置时由主页同步确认后的持仓
```

引擎本地运行，不调用收费OCR推理API；静态下载仍需要网络和流量，不能叫完全零网络。原图/原文只在内存，性能账本只存受限脱敏字段。Worker串行、ImageBitmap transferable、切片及时释放都是应保留的移动端措施。

必须真实份额>0，不允许用金额/估值猜份额；成本未知为null；截图成本换算需要主动选择。未匹配默认skip，截图外已有基金不删除。份额与成本正确的确认原则已经实现，但缺少候选生成到确认期间的revision保护。

Tesseract相关资源和`local-ocr.js`仍存在，属于备用/回归路径；当前OCR页面没有自动从Paddle失败降级到Tesseract。不能把“依赖安装着”描述成“备用识别已接通”。

本轮没有跑真实长图模型精度或Android/iOS硬件推理；O02/O03/O04是图像区域/坐标token级确定复现，O05为缺失超时恢复保护。下一轮需实图全流程，而不是再次只测按钮存在。

## 15. 完成度清单

### 已完成

- [x] 静态主应用、行情/持仓页、卡片详情、基础盈亏。
- [x] 报价Envelope、源状态/新鲜度、取消/刷新代际保护、缓存降级。
- [x] 官方/重仓/海外多来源及模型说明、部分精度账本。
- [x] Schema3、稳定ID/tombstone、历史投影、本地备份和日志、Gist设备分片/读回。
- [x] 独立本地OCR、同源资产、WebGPU/WASM、人工确认份额、导入/导出。
- [x] PWA壳、安装资源、更新兼容、诊断、CI构建/指纹与Pages部署。

### 部分完成

- [~] 可信估值：已分清来源/状态；缺同一候选基准、期间校验、官方日期选择。
- [~] 持仓可靠性：已有备份/CAS；缺跨标签互斥、陈旧编辑保护、未来本地Schema完整只读、metadata无损投影。
- [~] 长图导入：已有切片/定位/确认；缺全高完整性、歧义/部分字段保留、超时取消、确认冲突。
- [~] 移动/PWA：桌面自动化和历史模拟器证据存在；实体手机、安装态更新/OCR矩阵仍待验收。
- [~] 性能：静态预算存在；实际启动资源图、完整首个有效行情/大持仓/真机OCR基线不足。

### 未实现或不是当前范围

- [ ] 自建用户后端、FastAPI、服务器数据库。
- [ ] 完整交易流水、现金分红、现金流收益率、收益/净值曲线系统。
- [ ] 通用多平台截图自动同步、无人确认写持仓。
- [ ] 关闭页面后保证送达的后台14:30推送。

以上不是要求下一版全部补齐；后端/交易系统属于产品范围选择，不是静态PWA必须有的缺陷。

## 16. 最近改动

最近改动主线是Android本地OCR、生产资产和发布链加固，随后v15引入报价/存储/刷新/PWA等可靠性结构，v15.0.1补旧缓存壳安全更新通路。以下来自实际Git，而非只读README。

| Commit | 日期 | 摘要 |
| --- | --- | --- |
| 5e135b5 | 09-04 | 记录v15.0.1发布证据 |
| 4df72bc | 09-04 | 修复不同缓存版本间的安全PWA更新 |
| ed79017 | 08-29 | 记录v15发布证据 |
| 9b935ad | 08-29 | 稳定Service Worker E2E过渡测试 |
| 24886d2 | 08-29 | 发布v15.0.0 |
| 3f89327 | 08-29 | v14.0.4遥测维护桥接版本 |
| c2d3ea9 | 08-28 | v14.0.3引入v15兼容桥 |
| fc71555 | 08-24 | Vite6.4.3→8.2.2 |
| 202f773 | 08-24 | 升级14.0.2 |
| 8407bae | 08-12 | 加固Android OCR与Pages部署 |
| c51a7d4 | 08-12 | v14发布证据 |
| 58c24e0 | 08-12 | 升级14.0.0 |

年份均为2026。最新正式部署：[Actions 33830208358](https://github.com/AureliusWu/FundVal/actions/runs/33830208358)。本轮只读核对工作流终态，不将历史生产smoke等同于本轮新实机验收。

## 17. 测试现状与缺口

已有57个Node测试文件，337测试；覆盖计算/新鲜度、Schema迁移/云读回、刷新代际/熔断、Bridge校验、文件签名、切片/坐标、OCR后端回退、脱敏、构建/manifest/SW契约等。浏览器8项覆盖持仓增删重载、opaque Bridge、恶意字段、估值失败不串股票、云读回失败、OCR页面/skip、安全更新兼容及离线壳。

关键缺口：

1. 同数据源不同官方日期候选的顺序互换；Quote选择后与基准计算的一致性。
2. 当日净值已公布、海外跨时区/多日滞后、除息日、法定节假日。
3. 未来Schema进入完整启动仓储、metadata往返、quota失败后页面状态不变。
4. 双标签真实写入交错、编辑期间云拉取、OCR确认期间删除/修改。
5. Bridge多个慢源的队列饥饿、客户端取消后的远端任务释放。
6. 实图选择→下载模型→Worker→布局→候选→人工输入→保存全流程；不同比例长图、歧义/单字段缺失。
7. Worker无响应、模型下载挂起、bfcache、真机键盘、相册、内存峰值。
8. 同一生产来源不同版本缓存、未保存编辑、已安装PWA、后台冻结、完整断网恢复矩阵。

部分测试是`assert.match`源码契约，能防止保护语句被误删，却不能证明事件顺序和跨层数据流正确。例如OCR存在`expectedDocument`并不意味着使用的是用户开始核对时的document。建议新增行为集成测试先固定上述反例，再修代码；不要以增加源码正则代替复现。

## 18. 依赖和运行方法

| 依赖 | 锁定版本 | 用途/状态 |
| --- | --- | --- |
| @paddleocr/paddleocr-js | 0.4.2 | 当前本地OCR；受控vendor补丁和模型契约不能随意变 |
| onnxruntime-web | 1.27.0 | WebGPU/WASM推理 |
| tesseract.js / tesseract.js-core | 7.0.0 / 7.0.0 | 备用/历史识别路径，不等于当前自动fallback |
| @tesseract.js-data/chi_sim | 1.0.0 | Tesseract中文数据 |
| @playwright/test | 1.62.1 | 浏览器E2E |
| esbuild | 0.28.2 | 主应用minify/OCR构建 |
| vite | 8.2.2 | 代码分块构建；不是Vue运行依赖 |

没有后端Python依赖表。未对所有依赖查最新版本，因此不臆断“明显过时”；本次audit无已知漏洞，也没有升级/移除任何依赖。Paddle/Tesseract有替代关系但承担历史回归/备用用途，删除前必须确认脚本、文档和发布资产契约。

在项目根目录，已存在且本轮验证的命令：

```powershell
npm test
npm run check
npm run build
npm run serve
npm run test:e2e
```

锁定安装命令为CI真实使用的`npm ci`。`serve`服务`site/`，所以先build；监听`127.0.0.1:4173`，不是支持源码HMR的`npm run dev`。E2E使用Chrome channel并可复用4173服务，注意别误测已有旧产物。生产由main推送触发既有GitHub Actions发布，不存在可编造的uvicorn/FastAPI命令。`npm run build:ocr`、`npm run refresh:fund-catalog`是已有维护脚本，本轮未拿刷新目录当只读动作执行。

## 19. 下一版本方向（仅工程优先级）

### 必须处理

1. 先固定D01—D04反例，补齐当前Worker正式涨幅映射，统一“值、涨幅、基准、目标期间、来源”的不可变候选契约。
2. 统一仓储互斥/恢复入口，未来Schema拒绝写入，保存成功后才替换内存。
3. 主表单与OCR表单共用revision冲突原则，保留metadata和删除意图。
4. 修复长截图裁剪和Bridge队列超时；这两项直接影响用户此前反馈的识别完整性/行情延迟。
5. 完整真实图片/双标签/双版本集成回归，再补实体手机验收。

### 建议处理

- 统一证券市场身份、覆盖率字段、交易日历；完善来源时间和模型期间文案。
- OCR部分字段/歧义保留、超时取消/资源回收；保持未知值null和人工确认。
- 真实启动请求图预算、接口尾延迟/首个有效行情、大持仓与移动OCR阶段基线。
- 将app编排器按已稳定边界渐进拆分，标明历史兼容函数，更新交接文档的版本适用范围。

### 可以延后

- 新图表、复杂收益统计、更多截图平台、更多海外模型；先明确产品收益与数据来源。
- 类型系统可优先在DTO/存储边界用JSDoc/类型检查渐进引入，不必一口气全仓迁移。

### 不建议现在动

- 为“看起来现代”整体换Vue/React、增加FastAPI或重写存储后端。
- 用0/最新抓取时间掩盖未知/旧数据；用金额反推真实份额。
- 删除legacy存储投影、update-compat或给Bridge加allow-same-origin。
- 先改最终版本号再补关键数据与实体设备验收证据。

## 20. AI接手必须知道与关键文件索引

先读`AGENTS.md`和本报告，以当前代码最高优先；不要把根历史handoff里的14.0.4当当前版本。FundVal与`fund-compass`是独立仓库，Worker/FastAPI责任边界不能混用。正式净值、盘中估值、下一净值估计是三种期间语义；基金六位代码也不等于股票代码。用户数据以localStorage Schema3为准，任何清缓存/升级/回退都不能误清持仓。诊断不可带Token、原图、OCR全文；测试只用隔离合成数据。

| 文件 | 作用 | 重要程度 |
| --- | --- | --- |
| AGENTS.md | 数据/隐私/兼容/发布约束 | ★★★★★ |
| js/app.js | 数据与UI/云同步总体编排 | ★★★★★ |
| js/bootstrap.js | 启动顺序、失败边界 | ★★★★★ |
| js/runtime/quote-contract.js | 报价不可变契约与排序 | ★★★★★ |
| js/runtime/quote-normalizer.js | 源字段和候选生成 | ★★★★★ |
| js/calculator.js | 基准选择与持仓盈亏 | ★★★★★ |
| js/holdings-estimate.js | 境内模型与合并 | ★★★★★ |
| js/overseas-model.js | 海外模型期间/收益假设 | ★★★★★ |
| js/storage/holdings-schema.js | Schema3、ID、revision/tombstone | ★★★★★ |
| js/storage/holdings-repository.js | 主数据、备份、日志、CAS | ★★★★★ |
| js/storage/holdings-migration.js | 旧/新Schema适配 | ★★★★★ |
| js/storage/cloud-sync.js | 云快照合并、失败状态 | ★★★★★ |
| js/storage/gist-remote.js | Gist读取/分片/PATCH读回 | ★★★★★ |
| js/ocr-import-page.js | 用户核对到写入闭环 | ★★★★★ |
| js/holding-import-plan.js | 真实份额、成本、跳过、合并 | ★★★★★ |
| js/paddle-local-ocr.js | 文件/切片/资源生命周期 | ★★★★★ |
| js/ocr-table-layout.js | 坐标行列与完整性 | ★★★★★ |
| js/alipay-ocr-parser.js | 支付宝语义、身份匹配 | ★★★★★ |
| js/runtime/quote-bridge-client.js | 客户端隔离与deadline | ★★★★★ |
| js/sandbox/quote-bridge-runtime.js | 远程脚本执行边界/串行队列 | ★★★★★ |
| sw.js | 缓存与更新生命周期 | ★★★★★ |
| js/update-compat.js | 历史缓存壳安全更新通路 | ★★★★★ |
| js/runtime/refresh-coordinator.js | 刷新代际、取消、提交 | ★★★★☆ |
| js/runtime/source-registry.js | 源健康/熔断/缓存策略 | ★★★★☆ |
| js/runtime/market-session.js | 市场时段/假日接口 | ★★★★☆ |
| js/freshness.js | 时间新鲜度兼容 | ★★★★☆ |
| js/eastmoney-estimate.js | Worker契约适配 | ★★★★☆ |
| js/fund-holdings.js | 季报重仓身份/字段 | ★★★★☆ |
| js/resilience.js / js/integrity.js | 存储恢复/脱敏诊断 | ★★★★☆ |
| js/ocr/engine.js | OCR能力与引擎生命周期 | ★★★★☆ |
| js/ocr/asset-manifest.js | 同源资产/版本契约 | ★★★★☆ |
| scripts/paddle-ocr-entry.mjs | Worker协议与推理包装 | ★★★★★ |
| scripts/build-paddle-ocr.mjs | 受控补丁/模型和ORT产物 | ★★★★★ |
| scripts/build-site.mjs | app拆包、预算、SW CORE生成 | ★★★★★ |
| scripts/release-fingerprint.mjs | 部署资产一致性 | ★★★★☆ |
| .github/workflows/deploy.yml | 自动化门槛与Pages发布 | ★★★★☆ |
| e2e/v15.spec.js | 浏览器验证及mock边界 | ★★★★★ |
| index.html / ocr-import.html | 两个安全上下文和DOM入口 | ★★★★☆ |
| data/overseas-models.json | 海外证券市场身份/模型配置 | ★★★★☆ |
| docs/v15.0.1/IMPLEMENTATION_FEEDBACK.md | 历史生产/模拟器证据及限制 | ★★★★☆ |

## Codex给下一位AI的项目摘要

FundVal当前是已发布到GitHub Pages的v15.0.1原生JavaScript基金PWA。它没有本仓库后端，核心计算和持仓管理发生在浏览器；行情来自外部Cloudflare Worker、东方财富和腾讯，用户持仓默认存在localStorage，可选同步到GitHub Gist。主页面是行情和持仓两个面板，OCR是独立HTML。不要按Vue/FastAPI脚手架理解，更不要把另一个fund-compass仓库的运行环境当成这里的依赖。

v15不是空原型：Quote Envelope、刷新代际取消、数据源健康、Schema3稳定ID和删除记录、本地备份/日志、Gist设备分片与读回、独立JSONP沙箱、本地PaddleOCR、PWA安全更新及发布指纹都已实现。本轮337单元测试、语法检查、build和8项E2E全部通过，依赖公告检查也没有发现已知漏洞。现有模块边界方向是健康的，应保留；然而主app仍约2935行，新旧数据结构并存，跨层不变量没有得到充分验证。因此不能把通过构建和较多测试等同于金融语义与用户数据始终正确。

最大的五类问题是：第一，当前Worker的正式涨幅value_change未映射，报价选择器对正式净值日期比较失效，且被选报价没有绑定盈亏基准，造成“源有值却丢失”“已经取得新值却显示旧值”或“涨幅和盈亏不对应”。第二，境内和海外模型没有证明组件收益期间晚于基准净值，可能把已公布净值中的同一期涨跌再算一遍。第三，本地仓储日志不是跨标签事务锁，未来Schema可被旧备份覆盖，普通保存还会丢备注；保存失败后页面内存也可能仍停留在未保存的新份额。第四，主编辑页和OCR确认页没有保留用户开始编辑时的revision基线，后台同步或另一页修改/删除可被旧表单静默回滚；OCR固定16%至90%裁剪还会漏掉合法长图中的基金。第五，所有Bridge操作串行，却从入队即开始7/8秒计时，即使每个源都只需3秒，第三个并行提交的基金也会超时，过期任务还继续占用队列。

下一版本最值得做的是可靠性闭环，而不是继续加面板和新模型。先为本报告反例建立真实模块组合测试；明确Quote的值、基准、目标日、组件交易日和来源；统一仓储互斥以及主表单/OCR表单的冲突检查；修全高截图重建和Bridge调度；再用实图、双标签、双版本缓存和实体手机验收。应将期望的数据不变量写在测试里，避免仅检查源码出现expectedDocument之类关键词。

最好不要随便改的部分包括AGENTS约束、Schema3主键与legacy兼容投影、tombstone、Gist分设备文件、备份失败阻断、opaque-origin的allow-scripts沙箱、位于主壳前的update-compat以及OCR固定版本补丁/资产清单。未知价格、成本、涨幅必须继续保持未知；不能为了不显示空白用0补齐，不能从截图金额猜份额。历史发布文档证明过桌面和MuMu的一些行为，但实体Android/iOS与安装态PWA验收仍缺失，不能把模拟器当真机。

如果马上开始开发，先从quote-contract/normalizer/calculator和holdings-repository两个边界入手，固定D01—D04、S01—S05反例，再接OCR确认基线和Bridge调度。不要先重写app或迁框架，否则会扩大变更而使已有数据兼容保护更难验证。本轮仅做分析，业务代码和版本未修改；所有新结论都以2026-09-06、提交5e135b5为基线，后续代码变化后须重新核对行号与复现。
