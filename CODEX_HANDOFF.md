# FundVal（蜉蝣基金）代码级审计交接文档

> 审计日期：2026-08-29（Asia/Shanghai）
> 审计基线：`main` / `3f89327a58c6d5ded7efc0031676aa08733d149d`
> 审计方式：代码逐层阅读、Git/依赖/构建/测试检查、代表性外部接口只读探测、生产静态资源只读核验。
> 修改边界：本次未修改业务代码、配置、依赖或已有文档；唯一新增文件为本文件。
> 结论先行：项目可以正常测试、语法检查和构建，但发现 3 项 P0、若干 P1；在这些问题修复前，不应把基金行情/收益整体和主页面凭据安全标记为“可信”。

## 审计证据与限制

- 审计开始时本地 `main`、`origin/main` 和远端 `main` 均为 `3f89327`，工作树干净。审计末尾检测到另一并发流程在 2026-08-29 18:17:46 回填了 `README.md`、`docs/V15_AUDIT.md`、`docs/v14.0.0/IMPLEMENTATION_FEEDBACK.md` 的 v14.0.4 发布状态；本审计没有产生或回退这些已有文件修改，自身唯一新增文件仍是 `CODEX_HANDOFF.md`。
- `npm test`：286/286 通过，共 47 个 `*.test.js` 文件，约 1.63 秒。
- `npm run check`：通过。
- `npm run build`：连续 3 次通过，耗时约 2.425 秒、1.890 秒、1.801 秒。
- 首页生产包每次均为 162,946 bytes raw / 52,241 bytes gzip；硬门禁为 52,254 bytes，只剩 13 bytes 余量。
- `npm audit --audit-level=high --registry=https://registry.npmjs.org`：0 个已报告漏洞。
- GitHub Actions 最近一次发布运行 `33247073251` 成功；2026-08-29 只读请求确认生产 `js/version.js` 和 `manifest.json` 均为 14.0.4。
- 代表性 Worker 探测：`/estimates?codes=005844` 与 `/holdings?code=005844` 均返回 HTTP 200；服务端源码不在本仓库，因此只能审计浏览器端契约，不能确认 Worker 内部实现、上游抓取、缓存和部署安全。
- 未执行真实 Gist 写入、破坏性同步、实体 Android/iOS 测试。MuMu 模拟器和历史长图证据只作为已有记录，不等同于本轮真机验收。
- `docs/V15_AUDIT.md` 第 1—17 节明确是 2026-08-25 / v14.0.2 历史基线，不能直接当作 14.0.4 当前事实；本报告以当前代码为准。

# 1. 项目基本信息

| 项目 | 当前事实 |
|---|---|
| 项目名称 | FundVal（蜉蝣基金） |
| 当前版本 | 14.0.4。版本源见 `package.json`、`js/version.js`、`manifest.json`、`sw.js`、`CHANGELOG.md`。 |
| 项目定位 | 轻量、移动端优先的个人基金盘中观察 PWA；展示自选基金估值/正式净值、持仓市值与收益，支持本地截图 OCR 和可选 Gist 同步。不是交易系统，也不是完整投研平台。 |
| 当前主要功能 | 基金估值与可信状态、正式净值降级、重仓穿透估算、海外模型、指数/黄金、持仓 CRUD、0 份额关注、内联基金详情、JSON 导入导出、Gist 云同步、本地支付宝截图 OCR、PWA 缓存/更新、页面存活期间的 14:30 通知。 |
| Web 形态 | 零框架 HTML/CSS/原生 ES Modules 静态应用；生产构建将首页模块图打成单一 `js/app-shell.js`。 |
| PWA 形态 | `manifest.json` + `sw.js`，`standalone`、竖屏、应用壳离线缓存、受控更新。 |
| 后端形态 | 本仓库没有 FastAPI、Python、Node 服务端、数据库或 Worker 源码。估值/重仓依赖外部 Sinan Cloudflare Worker；其他数据直接来自东方财富、腾讯和 GitHub Gist。 |
| 生产部署 | GitHub Pages，`main` push 或手动 workflow 触发 `.github/workflows/deploy.yml`；流水线执行 npm ci、审计、测试、语法检查、静态构建、发布指纹和线上 smoke。 |
| 生产地址 | `https://aureliuswu.github.io/FundVal/` |
| 主要技术栈 | HTML5、CSS、原生 JavaScript ES2022、Web APIs、Service Worker、Vite 8.2.2、esbuild 0.28.2、PaddleOCR JS 0.4.2、ONNX Runtime Web 1.27.0、Tesseract.js 7.0.0（保留链路）。 |
| package manager | npm；`package-lock.json` lockfileVersion 3；CI Node 24。本机审计环境 Node 24.14.0 / npm 11.9.0。 |
| Python 环境 | 无法确认有项目级 Python 环境；仓库中没有 `pyproject.toml`、`requirements*.txt`、`Pipfile` 或 Python 源文件，当前运行/构建不依赖 Python。 |

并发状态提醒：审计开始读取到的 HEAD 版 `README.md:3` 仍写线上 14.0.3；审计末尾本地并发差异已把它回填为 14.0.4，但这 3 份发布文档修改尚未包含在 `3f89327` 中。下一位 AI 应先检查 `git status`，不要覆盖这组用户/并发工作。

# 2. 当前项目目录结构

以下为整理后的源码树；忽略 `node_modules/`、构建产物 `site/`、本机临时目录和缓存。

```text
FundVal/
├─ .github/
│  ├─ workflows/deploy.yml          # CI、Pages 发布、发布指纹、线上 smoke；生产部署入口
│  └─ dependabot.yml                # npm / GitHub Actions 每周依赖检查
├─ css/
│  ├─ style.css                     # 主页面、移动布局、safe-area、底部导航
│  └─ ocr.css                       # OCR 独立页面与确认弹层样式
├─ data/
│  ├─ fund-catalog.json             # 27,487 条本地基金目录；OCR 名称/代码匹配
│  └─ overseas-models.json          # 海外/QDII 模型配置与代理规则
├─ docs/
│  ├─ V15_AUDIT.md                  # v15 分阶段历史审计/实施记录；含旧基线，阅读时注意日期
│  ├─ v15-ui-prototype.html         # v15 UI 原型，不是当前生产入口
│  └─ v14.0.0/IMPLEMENTATION_FEEDBACK.md
├─ js/
│  ├─ bootstrap.js                  # 前端源码启动入口：事务恢复、迁移、完整性检查、加载 app
│  ├─ app.js                        # 核心业务/UI 编排，约 3,021 行
│  ├─ version.js                    # 应用版本入口
│  ├─ config.js                     # 超时、TTL、刷新间隔、模型 URL
│  ├─ calculator.js                 # 市值、今日/累计收益计算
│  ├─ eastmoney-estimate.js         # 外部 Worker /estimates 客户端
│  ├─ fund-holdings.js              # 外部 Worker /holdings 客户端
│  ├─ holdings-estimate.js          # 十大重仓穿透估算
│  ├─ overseas-model.js             # 海外模型加载、选择、计算
│  ├─ freshness.js                  # 旧式新鲜度兼容层
│  ├─ accuracy.js                   # 海外模型准确度台账
│  ├─ storage.js                    # localStorage 安全包装和旧缓存 helper
│  ├─ integrity.js                  # 恢复/诊断纯函数，含部分遗留函数
│  ├─ resilience.js                 # 启动自检、错误与运行时守卫
│  ├─ migrations.js                 # 历史一次性迁移逻辑
│  ├─ alipay-ocr-parser.js          # 支付宝 OCR 文本/基金匹配
│  ├─ ocr-table-layout.js           # 长截图坐标去重与三列表格重建
│  ├─ holding-import-plan.js        # OCR 确认计划、份额/成本门禁、批量映射
│  ├─ fund-catalog.js               # 基金目录按需加载与查询 helper
│  ├─ paddle-local-ocr.js           # 当前 PaddleOCR 本地识别封装
│  ├─ local-ocr.js                  # Tesseract 遗留/回归链，不是当前 UI fallback
│  ├─ ocr-import-page.js            # OCR 页面状态机与确认写入
│  ├─ ocr/
│  │  ├─ capability.js              # WebGPU/WASM 能力探测
│  │  ├─ engine.js                  # WebGPU→WASM 单次回退与 Worker 生命周期
│  │  ├─ asset-manifest.js          # OCR 资产路径、版本和哈希契约
│  │  └─ performance-ledger.js      # 不含识别内容的有界性能账本
│  ├─ runtime/
│  │  ├─ quote-contract.js          # Quote Envelope 数据契约
│  │  ├─ quote-normalizer.js        # 各来源归一化与候选选择
│  │  ├─ quote-presentation.js      # 面向 UI 的可信状态/日期展示
│  │  ├─ market-session.js          # 多市场时区和交易窗口
│  │  ├─ source-registry.js         # 数据源能力、优先级、健康状态
│  │  ├─ refresh-coordinator.js     # 刷新代际、取消、合并和 source cooldown
│  │  ├─ refresh-generation.js      # 刷新 generation helper
│  │  └─ request-signal.js          # AbortSignal 与超时
│  └─ storage/
│     ├─ holdings-schema.js         # Schema 3 持仓/文档模型
│     ├─ holdings-migration.js      # Schema 1/2/3 迁移和未来 Schema 防降级
│     ├─ holdings-repository.js     # 事务、journal、备份、回读、兼容投影
│     ├─ cloud-sync.js              # Gist 合并、稳定快照、写后读回
│     └─ gist-remote.js             # Gist HTTP adapter、设备 shard
├─ scripts/
│  ├─ build-site.mjs                # 生产静态构建入口；生成 site/ 和 app-shell
│  ├─ build-paddle-ocr.mjs          # 生成 Paddle Worker/模型/ORT 资产
│  ├─ paddle-ocr-entry.mjs          # 实际生产 Paddle batch/Worker 配置
│  ├─ release-fingerprint.mjs       # 发布关键文件和 OCR 资产指纹
│  ├─ serve-site.mjs                # 只读本地静态服务器 127.0.0.1:4173
│  └─ refresh-fund-catalog.mjs      # 显式更新基金目录
├─ test/                            # 47 个 Node test 文件，286 项测试
├─ index.html                       # 主页面结构；开发入口加载 js/bootstrap.js
├─ ocr-import.html                  # 隔离 OCR 文档；独立 CSP
├─ manifest.json                    # PWA 配置入口
├─ sw.js                            # Service Worker、缓存和通知
├─ package.json                     # npm 脚本、版本、依赖
├─ package-lock.json                # 锁定依赖
├─ README.md / CHANGELOG.md         # 使用/版本说明
├─ AGENTS.md / CLAUDE.md            # AI/维护者工程约束
└─ THIRD_PARTY_NOTICES.md           # OCR/运行时第三方许可
```

数据库/数据文件说明：没有服务端数据库。用户数据主要在浏览器 `localStorage`；可选云副本在用户自己的 GitHub Gist；`data/*.json` 是只读静态配置/目录。

# 3. 系统架构

```text
用户浏览器 / 已安装 PWA
│
├─ GitHub Pages 静态站点
│  ├─ index.html
│  │  └─ js/bootstrap.js
│  │     ├─ 恢复 journal / 执行迁移 / 完整性检查
│  │     └─ js/app.js
│  │        ├─ 行情与持仓 UI
│  │        ├─ Quote 归一化、时效、排序、收益计算
│  │        ├─ localStorage Schema 3 仓储
│  │        ├─ Gist 同步
│  │        └─ 第三方行情请求
│  ├─ ocr-import.html
│  │  └─ 本地 PaddleOCR Worker → 表格重建 → 人工确认 → Schema 3
│  ├─ data/fund-catalog.json
│  ├─ data/overseas-models.json
│  └─ sw.js / Cache Storage
│
├─ Sinan Cloudflare Worker（仓库外）
│  ├─ GET /estimates
│  └─ GET /holdings
├─ 东方财富（push2、pingzhongdata、基金目录维护源）
├─ 腾讯行情（指数、重仓证券、海外模型成分）
└─ GitHub Gist API（可选用户持仓云同步）
```

## 3.1 职责划分

- 前端负责全部页面、持仓写入、迁移/恢复、收益计算、Quote 选择、数据状态展示、OCR、缓存、定时刷新与 Gist 客户端同步。
- 本仓库没有可运行后端。外部 Sinan Worker 负责把需要服务端访问条件的估值/重仓数据转成浏览器可消费 JSON，但其源码、缓存和上游实现“无法确认”。
- 数据进入浏览器后先由 adapter 校验基础结构，再归一化为 Quote Envelope；UI 通过 `quote-presentation.js` 展示数值种类、来源、日期、覆盖率、置信度与不可用原因。
- 用户持仓主存储为本地 Schema 3。Gist 是用户显式配置后的可选同步副本，不是账号数据库。
- 缓存包括：localStorage 行情/正式净值/黄金/准确度/诊断/OCR 性能账本，内存重仓与详情缓存，以及 Service Worker 的同源静态资源 Cache Storage。
- 没有服务端定时任务。浏览器内存在自动刷新、每分钟 Gist 拉取、5 秒推送防抖、每 30 秒市场状态/通知检查、每 30 分钟 SW 更新检查；页面被系统挂起后这些任务不能保证运行。

# 4. 前端现状

项目没有 Vue/React，也没有 URL 路由器。`market` 与 `edit` 只是同一文档内的 class 切换；OCR 是独立 HTML。

| 页面/功能 | 对应文件 | 当前实现方式 | 完成度与明显问题 |
|---|---|---|---|
| 行情首页 | `index.html:29-69`、`js/app.js:1913-2075` | 顶部指数/黄金、基金卡、可信状态、排序、展开详情 | 核心完成；删除后旧卡可能残留；大量整表 `innerHTML` 重绘；只有涨跌排序按钮真正可用。 |
| 持仓页 | `index.html:71-152`、`js/app.js:2091-2220` | 输入 6 位代码、名称、份额、成本；编辑、tombstone 删除、0 份额关注 | 基础 CRUD 完成；没有完整基金搜索/自动补全；未知成本显示和 OCR 复用有 `null` 体验问题。 |
| 页面路由 | `js/app.js:2211` | `switchPage('market'/'edit')` 切 class，不写 history/URL | 仅两页切换；无深链、前进/后退和独立设置/详情 URL。 |
| 基金搜索 | `js/fund-catalog.js:61-82` | 有本地目录查询 helper，但主页面未接入 | 主页面未实现；用户须知道基金代码。 |
| 基金详情 | `js/app.js:1652-1718, 1885-2060` | 行情卡内展开，加载重仓、基金规模/经理/费率 | 部分完成；无独立详情页、历史净值曲线、风险/交易信息；部分旧详情解析器已停用。 |
| 收益计算 | `js/calculator.js`、`js/app.js:904-958` | 份额 × 当前/基准净值，计算市值、今日和累计盈亏 | 基础完成；无交易流水、分红、定投、XIRR；错误行情会直接污染收益。 |
| 用户数据 | `js/storage/*` | localStorage Schema 3、备份/journal、兼容投影、可选 Gist | 可靠性设计较完整；无账号/服务端用户系统。 |
| 设置 | `index.html:110-151`、`js/app.js:256-688` | Gist Token、同步状态、诊断嵌在持仓页 | 部分完成；没有独立设置页，通知/缓存/隐私控制不集中。 |
| 导入/导出 | `js/app.js:206-253` | JSON 全量读取、迁移、合并、事务写入 | 已实现；导入缺少文件大小和记录数前置限制，错误提示过于笼统。 |
| OCR | `ocr-import.html`、`js/ocr-import-page.js`、`js/paddle-local-ocr.js` | 独立页面、本地 PaddleOCR、基金目录匹配、人工确认、事务保存 | 主链已实现；16 MB/16 MP 和固定裁剪范围限制长图；真机仍未验收；匹配算法可很慢。 |
| 图表 | 无 | 无图表依赖或画布实现 | 未实现。 |
| PWA | `manifest.json`、`sw.js`、`js/app.js:2630-2970` | 安装壳、分策略缓存、受控更新、通知 | 核心完成；OCR 非完整离线；iOS 图标/真机、键盘遮挡待确认。 |
| 移动适配 | `css/style.css`、`css/ocr.css` | mobile-first、safe-area、固定底栏、768px 断点、下拉刷新 | 基础完成；OCR 使用 `100vh`，没有 `dvh`/visualViewport；实体设备未覆盖。 |
| 通知 | `js/app.js:2528-2607`、`sw.js:76-86` | 页面存活期间 14:30 检查并调用 Notification/SW | 部分完成；不是后台调度，可把 stale/model/official 值称为“今日涨跌”。 |

# 5. 后端现状

## 5.1 FastAPI 扫描结论

仓库中没有 `main.py`、`FastAPI()`、`APIRouter`、`uvicorn`、Python 依赖文件、服务端数据库或后端测试。因此：

- FastAPI 后端入口：不存在。
- 本仓库 API 路由：不存在。
- 后端日志/异常中间件/数据库/定时刷新：不存在。
- 外部 Worker 的实现、鉴权、上游 Referer、缓存内部逻辑：无法从本仓库确认。

## 5.2 前端实际调用的外部接口

| 接口 | 请求参数 | 浏览器消费的返回 | 对应实现 | 缓存/错误处理 |
|---|---|---|---|---|
| Sinan `GET /estimates` | `codes=六位代码CSV`；强刷时 `_=timestamp` | `{fetched_at, items[]}`；item 读取代码、名称、类型、净值、估值、涨跌、日期、来源、状态、覆盖率/诊断等 | `js/eastmoney-estimate.js` | 10 秒超时、`no-store`、结构校验；失败回退其他源/缓存。Worker 服务端不在仓库。 |
| Sinan `GET /holdings` | `code=六位基金代码`；可带 `_=timestamp` | `{status, report_date, fetched_at, source, items:[{code,name,ratio}]}` | `js/fund-holdings.js` | 10 秒超时、`no-store`；前端内存缓存 12 小时；code 校验不足，存在 XSS。 |
| GitHub `POST /gists` | description + legacy/V3 文件内容 | 新 Gist id | `js/app.js:537` | 15 秒同步超时；错误转 toast/诊断。 |
| GitHub `GET/PATCH /gists/{id}` | PAT、Gist id；PATCH 当前设备 shard | Gist files、etag/updated_at、读回内容 | `js/storage/gist-remote.js`、`cloud-sync.js` | `no-store` GET、备份、确定性合并、PATCH 后 GET 规范化校验；API 无 CAS。 |
| GitHub `GET /gists?per_page=100&page=N` | PAT，最多 5 页 | Gist 列表 | `js/storage/gist-remote.js:164` | 最多扫描 500 条，超出时可能误报未找到。 |
| 东方财富 `stock/get` | `secid=0.{fundCode}&fields=f43,f169,f170` | 当前值、涨跌额、涨跌幅 | `js/app.js:721` | 7 秒超时；这是证券行情接口，基金代码碰撞会查到同代码股票，属于 P0。 |
| 东方财富 `pingzhongdata/{code}.js` | 基金代码 + cache bust | 全局 `Data_netWorthTrend`、规模、经理、费率 | `js/app.js:799` | 7 秒超时；全局变量导致串行；第三方 JSONP 在主页面执行。 |
| 东方财富 `ulist.np/get` | 重仓证券 secids、`f12,f3,f124` | 股票代码、涨幅、时间 | `js/app.js:1746` | 与腾讯备源组合；用于重仓穿透估值。 |
| 东方财富黄金 `stock/get` | 三个候选 secid、行情字段 | 黄金价格、涨跌、时间 | `js/app.js:2274` | 2 分钟 TTL；失败可用最长 7 天陈旧缓存并明确降级。 |
| 腾讯 `qt.gtimg.cn` | 指数/证券/海外模型 codes | JSONP 全局变量行情 | `js/app.js:1435, 1792, 2338` | 8 秒超时；三套近似队列/清理代码，主页面第三方脚本执行。 |
| 东方财富基金目录 | 构建维护时下载公开 `fundcode_search.js` | 解析后静态 JSON | `scripts/refresh-fund-catalog.mjs` | 不是用户运行时 API；显式维护命令才更新。 |

2026-08-29 实测 Worker 响应的 `Access-Control-Allow-Origin` 固定为 `https://aureliuswu.github.io`。生产可用，但 `http://127.0.0.1:4173` 浏览器开发会被 CORS 阻止，从而悄悄走降级源。

## 5.3 废弃、重复、未调用和不匹配

- 已停用的 `jjxx` / `jjfl` 详情接口只剩注释和未调用解析器：`js/app.js:1690, 1839`。
- `sw.js:92` 保留 `/api/` network-only 分支，但当前应用没有同源 `/api/*` 调用，属于占位。
- `js/storage.js` 的旧云载荷 helper、`js/integrity.js` 的部分旧持仓归一化/合并函数、`preferredDailyMove` 等没有生产调用，主要只在测试或历史兼容层出现。
- 腾讯 JSONP 的指数、重仓、模型链路重复实现相似的 script/global/timeout 清理。
- 前端调用 `/estimates` 与 `/holdings`，但本仓库没有对应后端源码。这不是运行时 404，而是“前端依赖仓库外服务”；下一位 AI 不能只改 FundVal 就完成端到端修复。
- README 仍称 push2 为“备选净值”，实际请求证券 `stock/get` 且没有验证资产身份，文档和能力定义不匹配。

# 6. 数据模型和数据流

## 6.1 Canonical Quote Envelope

定义：`js/runtime/quote-contract.js:102`。

| 字段 | 含义/来源 | 使用位置 |
|---|---|---|
| `fundCode`、`fundName` | 基金身份；持仓/adapter | 列表、详情、缓存 |
| `market`、`assetKind` | 名称规则分类 | 市场时钟、模型、展示 |
| `valueKind` | `intraday_estimate` / `official_nav` / `model_estimate` / `holding_lookthrough_estimate` | 标签、优先级、收益口径 |
| `value`、`changePct` | 归一化后的可空数值 | 净值、涨跌、收益 |
| `sourceId`、`sourceTier` | 来源及 primary/secondary/model/cache | 排序、诊断 |
| `observedAt`、`fetchedAt`、`officialNavDate` | 行情时间、请求时间、官方净值日期 | 新鲜度和 UI 副标题 |
| `status`、`ageMs` | realtime/delayed/stale/model/official/unavailable | 可用性与排序 |
| `coverage`、`confidence`、`modelVersion` | 模型/重仓质量 | 详情与可信解释 |
| `reasonCodes` | 有界原因码 | 诊断、不可用说明 |

关键规则：未知数值由 `nullableNumber` 保持 `null`，不能用 `0` 代替；候选按状态、层级和时间选择。正式净值、盘中估值和“下一净值模型”是不同语义。

## 6.2 Schema 3 持仓

定义：`js/storage/holdings-schema.js:67`。

| 字段 | 约束/来源 | 存储与使用 |
|---|---|---|
| `id` | 必须为 `fund:{fundCode}` | 稳定合并键 |
| `fundCode` | 6 位数字 | CRUD、行情请求 |
| `fundName` | 最长 120 | UI、市场分类 |
| `shares` | 非负有限数；0 表示仅关注 | 市值/收益 |
| `costNav` | 非负有限数或 `null` | 累计收益；未知不能归零 |
| `createdAt`、`updatedAt` | ISO 时间且顺序有效 | 冲突选择 |
| `deletedAt` | `null` 或与 `updatedAt` 相同 | tombstone，防旧设备复活删除项 |
| `revision` | 正安全整数 | 并发/版本 |
| `deviceId` | 非空设备标识 | Gist shard 与冲突判断 |
| `note` | 可空，最长 500 | 预留/同步字段 |

文档字段：`{schema:3, updatedAt, deviceId, holdings[]}`。主存储 key 为 `fuyu_holdings_v3`；同时生成旧版 `fuyu_holdings_v1` 投影，供历史 UI/版本兼容。`holdings-repository.js` 还维护最近/上一备份、journal、投影元数据和云快照备份。

运行中的旧式 UI 结构为 `{code,name,shares,cost,updated_at,deleted}`，由 Schema 3 转换而来。`cost` 与 canonical `costNav` 并存是历史兼容点，不能机械全局改名。

## 6.3 Gist 云模型

- 永久兼容文件：`fuyu-holdings.json`。
- V3 canonical/历史入口：`fuyu-holdings-v3.json`。
- 当前设备 shard：`fuyu-holdings-v3-{16位设备哈希}.json`。
- 最多合并 64 个 V3 文件；当前设备只写自己的 shard。
- 拉取会合并所有 V3 与真正较新的 legacy 变更；未来 Schema 或无法无损表示的旧 Schema 写入 fail closed。

```text
本地 Schema 3
→ GET Gist 并备份原始持仓文件
→ 解析所有 V3 shard + legacy
→ revision/timestamp/tombstone 确定性合并
→ expectedDocument 校验并稳定写入本地
→ PATCH 当前设备 shard
→ GET 读回并比较 canonical 内容
→ 成功或保留 pending，稍后重试
```

## 6.4 基金显示数据

基金卡对象由 `buildFundData` 在 `js/app.js:904` 组装：源响应、持仓份额/成本、正式净值、海外/重仓模型、Quote 候选、收益字段、详情缓存和展示字段混在同一对象中。它不是独立持久数据模型，`SKIP_CACHE_KEYS` 只排除部分瞬时字段。

## 6.5 OCR 候选与导入计划

识别候选主要字段：

- `rawFundName`、匹配状态/候选、基金代码/名称；
- `holdingAmount`、`dailyProfit`、`holdingProfit`、`holdingProfitRate`；
- 布局坐标、来源证据、warnings。

确认计划主要字段：

- `action`：add/update/skip；
- `code`、`name`、`shares`、`cost`；
- `useScreenshotCost`、既有持仓快照、warnings。

OCR 不从截图推断真实份额。用户必须填写大于 0 的真实份额；只有主动选择时，才按 `（持有金额 - 累计收益）÷ 真实份额` 换算成本净值。确认写入使用 `expectedDocument`，陈旧 OCR 页面不能覆盖另一个标签页的新持仓。

## 6.6 主要行情数据流

```text
活动持仓快照
→ 批量 Worker /estimates
→ 每基金并行：
   ├─ 东方财富错误的 stock/get 降级
   └─ 串行 pingzhongdata 正式净值
→ 归一化 Quote 候选并选择主报价
→ 先提交主卡
→ 后置 enrichment：
   ├─ 重仓披露 + 当日证券行情 → 重仓穿透模型
   └─ overseas-models + 腾讯/黄金行情 → 海外模型
→ 重新选择 Quote、计算收益、缓存、渲染
```

# 7. 当前已经实现的功能清单

### 已完成

- [x] 零框架移动端基金行情主页面与顶部指数/黄金。
- [x] Schema 3 持仓 CRUD、0 份额关注、tombstone、revision、deviceId。
- [x] 本地事务 journal、双备份、启动恢复和未来 Schema 防降级。
- [x] Quote Envelope、来源/时间/状态展示、缺失值保持 `null`。
- [x] 最新正式净值、海外模型、重仓穿透估算的基础链路。
- [x] 单基金失败隔离、刷新 generation/取消、数据源 cooldown。
- [x] 基础市值、今日盈亏、累计盈亏计算。
- [x] JSON 导入导出。
- [x] Gist 设备 shard、多版本合并、PATCH 后读回验证。
- [x] 支付宝/蚂蚁财富截图本地 PaddleOCR、表格重建、人工确认、事务写入。
- [x] PWA manifest、应用壳缓存、受控更新和部署资源指纹。
- [x] Node 单元/契约/回归测试和 GitHub Pages 自动发布。

### 部分完成

- [~] 基金详情
  - 当前完成：内联展开，重仓、披露日、规模、经理、费率、来源说明。
  - 缺失：独立路由、历史净值/图表、风险/交易信息；旧接口解析已停用。
- [~] 基金搜索
  - 当前完成：OCR 使用本地 27,487 条目录匹配，存在查询 helper。
  - 缺失：主持仓输入没有搜索、自动补全或代码校验后的元数据预览。
- [~] 收益能力
  - 当前完成：基于份额、成本净值和当前/基准净值的静态计算。
  - 缺失：交易记录、分红、定投、资金流、XIRR、历史曲线。
- [~] 设置
  - 当前完成：Gist 凭据、同步、导入导出、诊断入口。
  - 缺失：独立设置页、通知开关、缓存/隐私控制。
- [~] 通知
  - 当前完成：页面存活时的 14:30 本地通知。
  - 缺失：真正后台调度、交易日历、只推送当天可信报价。
- [~] PWA 离线
  - 当前完成：首页应用壳和已缓存静态数据。
  - 缺失：新一次 OCR 所需的约 82–88 MB 大资源明确为 network-only。
- [~] OCR 长截图
  - 当前完成：固定分片、重叠去重、真实 1440×9317 历史样本和 MuMu 模拟器记录。
  - 缺失：超过 16 MP/16 MB、不同支付宝版式、动态表头/尾部、实体 Android/iOS 验收。
- [~] 多维排序
  - 当前完成：内部保留市值/收益等分支。
  - 缺失：UI 只有“可信等级优先 + 涨跌升降”切换，README 的多维排序不可达。

### 未完成 / 占位

- [ ] 独立基金搜索页。
- [ ] 独立基金详情页和历史图表。
- [ ] 交易流水、分红/定投/XIRR。
- [ ] 账号系统和自有服务端数据库。
- [ ] 本仓库 FastAPI 后端。
- [ ] 实体 Android Chrome/安装 PWA 与 iOS Safari/PWA 自动化验收。
- [ ] 可重复浏览器 E2E 测试。

# 8. 当前版本最近的改动

## 8.1 版本主线

- 14.0.4：补齐 OCR 失败/回退性能遥测，强化 SW HTTP 缓存重验证、发布关键文件指纹、OCR 23 项资产线上哈希验证；不改变持仓 Schema 和 OCR 模型。
- 14.0.3：v15 前置兼容桥；Quote Envelope、刷新代际/取消、source registry、Schema 3、设备 Gist shard、WebGPU→WASM、受控 SW 更新、单一 app-shell。
- 14.0.2：海外模型季度有效性、日韩时间、Node/Vite/Actions 依赖与供应链审计。
- 14.0.1：Android 文件选择/能力检查/单 Worker 内存优化、Pages workflow 修复。
- 14.0.0：支付宝长截图本地 PaddleOCR 和人工确认导入。
- 11–13：估值接口替换、正式净值降级、重仓穿透、QDII 模型、新鲜度与启动/同步可靠性。

## 8.2 最近 20 个提交

| Commit | 日期 | 摘要 |
|---|---|---|
| `3f89327` | 2026-08-29 | release: publish v14.0.4 telemetry maintenance bridge |
| `c2d3ea9` | 2026-08-28 | release: add v15 compatibility bridge as 14.0.3 |
| `fc71555` | 2026-08-24 | chore(deps-dev): bump vite from 6.4.3 to 8.2.2 (#2) |
| `202f773` | 2026-08-24 | release: upgrade FundVal to 14.0.2 |
| `8407bae` | 2026-08-12 | fix: harden Android OCR and Pages deployment |
| `c51a7d4` | 2026-08-12 | docs: record v14 release evidence |
| `58c24e0` | 2026-08-12 | release: upgrade FundVal to 14.0.0 |
| `a2129a5` | 2026-08-08 | release: upgrade FundVal to 13.0.0 |
| `5a253b7` | 2026-07-28 | fix: align QDII base NAV date |
| `6ff7b43` | 2026-07-28 | fix: prioritize current QDII model estimates |
| `a4ae121` | 2026-07-27 | feat: add same-day holdings valuation model |
| `6857a4a` | 2026-07-26 | fix: restore quarterly fund holdings |
| `02d31c8` | 2026-07-26 | fix: show official NAV when market is closed |
| `6d90496` | 2026-07-22 | fix: restore estimates through server proxy |
| `c2dcd67` | 2026-07-22 | release: upgrade FundVal to 11.0.0 |
| `dbe7328` | 2026-07-15 | docs: align Claude guide with 10.1.0 |
| `5cdc05f` | 2026-07-15 | docs: align agent guide with 10.1.0 |
| `0749ca4` | 2026-07-15 | docs: document 10.1.0 resilience layer |
| `58619b0` | 2026-07-15 | release: harden startup and persistent state in 10.1.0 |
| `d9e351c` | 2026-07-15 | fix: preserve user holding order during repair |

并发文档状态：`3f89327` 提交中的 README 仍把线上写成 14.0.3；审计末尾出现的本地文档差异已回填 14.0.4 发布证据，但尚未提交。本报告保留该差异，不归因于本次审计。

# 9. 已知问题和潜在 Bug

严重度按用户给定定义：数据错误和可利用安全问题归 P0。

## P0

### P0-1 基金代码被当作同代码股票查询，可能静默生成错误净值/收益

- 位置：`js/app.js:721-742, 872-901, 950-957`。
- 原因：`fetchFromEastmoney` 把六位基金代码拼成 `secid=0.{fundCode}` 调用证券 `stock/get`，既不验证证券类型/名称，也未使用明确单位转换。
- 复现证据：基金代码 `000001` 的请求实际返回股票“平安银行”数据，而不是“华夏成长基金”；`parseNav` 又直接 `Number(value)`。
- 影响：当主估值缺失且正式净值链也失败时，错误股票价格可成为 stale 基金报价；`nav_change_amt × shares` 还可能进入“今日收益”降级计算。属于用户可见财务数据错误。
- 推荐方向：删除该基金降级源，或改成身份、资产类型、日期、单位均可验证的基金接口；增加“基金代码与股票代码碰撞”契约测试。

### P0-2 第三方 JSONP 与持久 Gist PAT 在同一页面安全域

- 位置：PAT `js/app.js:47, 256, 583`、输入 `index.html:114`；JSONP `js/app.js:799, 1435, 1792, 2338`；主 `index.html` 无 CSP。
- 原因：东方财富/腾讯脚本以页面脚本身份直接执行，同时 PAT、持仓和配置以明文存在同源 localStorage。
- 影响：任一 JSONP 上游、DNS/链路或供应链被攻陷，可读取并外传 Gist PAT 与用户财务数据。
- 推荐方向：停止主页面跨域脚本执行，统一通过受控代理获取结构化 JSON，或把第三方脚本置于无主站存储权限的隔离上下文；凭据输入/保存与行情页隔离。仅“补 CSP”无法兼容当前 JSONP。

### P0-3 重仓 code 未校验且原样进入 innerHTML，形成可利用 XSS 链

- 位置：输入 `js/fund-holdings.js:12-17`；输出 `js/app.js:2013-2016`。
- 原因：Worker 的 `row.code` 只要求非空，`s.name` 被转义但 `s.code` 未转义即拼入 HTML。
- 影响：被污染/恶意 Worker 响应可注入标签或事件脚本，并进一步读取 PAT、持仓及所有 localStorage。
- 推荐方向：按 A/H/US 市场严格白名单校验证券代码，所有远端字段输出统一转义，优先用 `textContent`/DOM 节点；增加恶意 payload 回归。

## P1

### P1-1 删除基金后旧行情卡可能残留并写回新缓存

- 位置：`js/app.js:1158-1168, 1227-1240, 1913, 2193-2206`。
- 原因：删除只写 tombstone；刷新按 active snapshot 更新/新增 `fundsData`，从未裁掉 snapshot 外旧项；渲染和 `saveCache(fundsData)` 使用全数组。
- 影响：多持仓删除其中一只后，旧卡仍显示，甚至进入新 holdings hash 的缓存；云端 tombstone 拉取也受影响。
- 推荐方向：每个刷新代际用 active code 集合裁剪列表和详情缓存，加入真实 DOM/集成测试。

### P1-2 启动刷新重复且被每基金正式净值 JSONP 串行阻塞

- 位置：`js/app.js:83, 784-876, 1243-1254, 3003-3014`。
- 原因：首页先发 forced startup refresh；`overseas-models.json` 加载完成后再发第二轮 forced refresh。每基金主卡等待全局串行 `pingzhongdata`，forced 又跳过 10 分钟正式净值缓存。
- 影响：网络数和首屏完成时间随持仓数近似线性增长，第一代请求常被第二代浪费；本地开发主源又受 CORS 阻断，体感更差。
- 推荐方向：缓存/批量估值先提交主卡，正式净值作为后置 enrichment；合并模型加载与首轮刷新，只刷新受模型影响的基金；启动允许复用新鲜 NAV。

### P1-3 14:30 通知可把陈旧/正式净值/模型称为“今日涨跌”

- 位置：`js/app.js:1545-1547, 2542-2601`。
- 原因：通知只排除 unavailable，stale、official、model 仍可进入；交易日只判断周一至周五。
- 影响：节假日、源降级或模型过期时可能发送误导通知。
- 推荐方向：只接受当天且满足 freshness 的 realtime/delayed 报价，或在通知中明确值类型/日期/状态；接入真实交易日历。

### P1-4 Worker CORS 阻断本地浏览器主数据源

- 位置：`js/eastmoney-estimate.js:4`、`js/fund-holdings.js:3`。
- 原因：实测 ACAO 固定生产源。
- 影响：`npm run serve` 的 `127.0.0.1:4173` 调试不能真实命中估值/重仓主链，开发者易把降级成功误判为主链成功。
- 推荐方向：Worker 增加受限开发 origin，或本地 server 提供明确同源代理；测试/UI 诊断显示实际命中的 source。

### P1-5 OCR 长截图核心场景仍有硬边界

- 位置：`js/paddle-local-ocr.js:14, 39, 424`。
- 原因：16 MB/16 MP 上限；只扫描顶部 0–18% 和持仓区 16–90%；布局依赖当前支付宝版式。
- 影响：更长/更高 DPI 截图或版式变化可能被拒绝、漏首尾基金。历史 1440×9317 样本约 13.4 MP 可通过，不代表所有“长截图”。
- 推荐方向：动态识别表头/列表尾部，评估安全下采样或增量解码，建立多机型/多版式 fixture。

### P1-6 OCR 基金匹配重复扫描全目录

- 位置：`js/alipay-ocr-parser.js:414-520`、`js/ocr-import-page.js:191`。
- 原因：每个候选重新规范化约 27,487 条目录，模糊匹配再对候选执行全量 Levenshtein，布局组合会反复调用。
- 影响：长截图确认阶段明显耗时；历史 MuMu 总耗时约 20–26 秒，低端手机可能更慢/内存更高。
- 推荐方向：目录一次规范化，建立 code/exact/share-class/trigram 索引，对 OCR 文本 memoize 后再缩小模糊集合。

### P1-7 首页 gzip 构建门禁只剩 13 bytes

- 位置：`scripts/build-site.mjs:10-13`。
- 原因：当前 52,241 B，预算 52,254 B，已经到 v14.0.2 基线 +20% 的边界。
- 影响：下一版本极小首页代码增长即可让 CI build 失败；也说明首页职责继续膨胀不可持续。
- 推荐方向：先拆出非首屏/详情/同步模块为真实按需 chunk，或通过等价压缩减少 shell；不能简单提高预算而没有新基线。

### P1-8 关键手机门禁仍未完成

- 位置：`CHANGELOG.md`、`README.md`、`docs/V15_AUDIT.md` 的验证记录。
- 原因：只有桌面浏览器、历史生产和 MuMu Android 15 模拟器证据；物理 Android Chrome/安装 PWA、iOS Safari/PWA 为 NOT_RUN。
- 影响：文件选择、内存杀进程、键盘、safe-area、更新和离线边界没有实体设备证据，不能宣称 v15 移动验收完成。
- 推荐方向：建立实体设备验收表与可复现截图/视频/资源日志，作为发布硬门槛。

## P2

| 问题 | 文件位置 | 原因/影响 | 推荐方向 |
|---|---|---|---|
| 未知成本显示为“成本null”；OCR 既有 `null` 变字符串 | `js/app.js:2097`、`holding-import-plan.js:68-71` | 用户看到错误文案，更新时被迫重填 | 显示 `--`，计划模型保留真正 `null` |
| OCR 人工选中候选后仍可能保持 `skip` | `holding-import-plan.js:47-74`、`ocr-import-page.js:515` | 用户以为已选中但最终未导入 | 选择明确候选时同步 action，保留显式确认 |
| 数据源“业务全空”也记 success | `js/app.js:1043-1057, 1211-1217` | 断路器/诊断与用户实际覆盖不一致 | 记录 requested/usable/unavailable/coverage 的 partial success |
| JSON 导入无大小/条数限制 | `js/app.js:206-253` | 手机一次性读大文件可能卡死/内存峰值 | 文件大小、记录数、字符串上限 |
| Gist PATCH 无 CAS | `js/storage/gist-remote.js:136` | 同设备身份或多标签仍可能并发覆盖 | 跨标签 lease、写后稳定复查；长期评估有条件写存储 |
| Gist 自动发现最多 500 条 | `gist-remote.js:164` | 超范围时误报未找到 | 明示扫描上限、允许手填 id/继续分页 |
| 每次 enrichment 整表重绘 | `js/app.js:1004-1015, 1124-1131` | 多基金时 DOM 更新近似 O(N²) | keyed/局部更新、批量提交 |
| 市场节假日未接真实集合 | `market-session.js:105-129` | 节假日仍按工作日窗口刷新/标状态 | 注入维护良好的交易日历；显示来源 |
| 主头部市场状态偏中国市场 | `js/app.js` 的 `updateMktStatus` | 海外持仓时“休市”不代表成分市场 | 汇总实际 active market 状态 |
| OCR 非完整离线 | `sw.js:88-104` | 已安装 PWA 离线无法开始新 OCR | UI 明示，评估可选离线包而非默认预缓存 88 MB |
| 通知权限在首次任意交互申请 | `js/app.js:2529-2539` | 缺少上下文，用户易永久拒绝 | 放到设置/功能触发点 |
| PWA/iOS 元数据不完整 | `manifest.json`、`index.html` | 无 apple-touch-icon、截图、shortcuts/id/scope；兼容待确认 | 按真实安装需求补齐并真机验收 |
| OCR 弹层 `100vh` | `css/ocr.css:12` | 移动键盘/动态地址栏可能遮挡 | `dvh` + visualViewport/滚动焦点策略 |
| 发布文档一致性依赖人工 | `test/version.test.js:26-29`、审计末尾的 3 份并发文档差异 | 现有测试只检查版本格式，不能保证部署后 README/审计文档同步；本轮虽已本地回填但未提交 | 发布后自动校验/回写，或不在 README 保存易漂移的“线上版本” |

## P3

- `js/app.js` 约 3,021 行，UI、行情、同步、通知、PWA 和诊断强耦合。
- 大量 inline `onclick` 和 `Object.assign(window, ...)`，阻碍 CSP、模块边界和 DOM 测试。
- `parseFundTypeData`、`parseFundFeeData`、`preferredDailyMove`、旧 storage/integrity helper 等未被生产调用。
- Tesseract 代码、依赖和资产仍部署，但 OCR UI 的自动 fallback 实际是 Paddle WebGPU → Paddle WASM；维护者容易误判。
- `createPaddleOcrOptions` 的测试配置与 `scripts/paddle-ocr-entry.mjs` 真实生产 batch 配置不同，容易改错文件。
- API URL、OCR 阈值、裁剪比例、刷新/手势 magic number 分散。
- 项目为纯 JS，无静态类型；跨模块 Quote、持仓、OCR token 主要靠约定与测试。
- 没有发现遗留 `TODO` / `FIXME` / `debugger`；`console.log` 主要是构建脚本正常输出，不属于运行时调试泄漏。

# 10. 技术债

| 类别 | 当前证据 | 影响/建议 |
|---|---|---|
| 超大组件/文件 | `js/app.js` 3,021 行；`style.css` 1,088 行；OCR parser/layout/page 均 500–780 行 | 先按行情编排、渲染、同步、详情、通知拆模块，不建议一次性框架重写。 |
| 强耦合 | 基金显示对象混合源响应、持仓、Quote、收益、详情和 UI 状态 | 建立只读 view-model 边界，缓存 canonical 数据而非整张 UI 对象。 |
| 重复代码 | 腾讯 JSONP 三套；文本/finite/escape/error 包装散落 | 建共享 adapter，但保持各市场字段契约可测试。 |
| Magic number | OCR 16 MP、分片 1500/160、0–18%/16–90%；刷新和手势阈值 | 归入命名配置并注明来源、边界和测试。 |
| 硬编码 URL | Worker、东方财富、腾讯、GitHub API 分散于 app/adapter | 收敛 source adapter/配置，生产和开发 origin 分离。 |
| API 重复/遗留 | 旧 `jjxx/jjfl` parser、`/api/` SW 占位、旧 cloud payload helper | 先用引用图和行为测试确认，再删除；不要误删兼容迁移。 |
| 类型缺失 | 全项目原生 JS，无 TypeScript/JSDoc 完整 schema | 可先给 Quote/Holding/OCR/Gist 加 JSDoc + runtime schema，不必立即 TS 迁移。 |
| `any` 滥用 | 不适用：没有 TypeScript；但大量无类型 object spread 等价地放大风险 | 用窄 adapter 和运行时校验替代任意对象透传。 |
| 无用文件/依赖 | `local-ocr.js` 和 Tesseract 运行链未接当前 UI；仍用于回归/许可证/可能降级 | 标为“保留链”并决定产品策略后再移除；不能仅凭无 import 删除。 |
| 数据结构不统一 | canonical `fundCode/costNav/updatedAt/deletedAt` 与 UI legacy `code/cost/updated_at/deleted` 并存 | 这是兼容桥。下一版逐层收敛，不可全局机械替换。 |
| 老旧/临时代码 | `migrations.js` 是历史专项迁移；`docs/V15_AUDIT.md` 含旧基线；本机临时目录不属于生产源 | 不要把一次性迁移模式复制到新 Schema；文档须看审计日期。 |
| 测试债 | 逻辑测试多，但无真实 DOM/E2E/物理设备/恶意响应测试 | 优先补 P0/P1 的可复现浏览器测试，再扩功能。 |

# 11. 安全检查

## 11.1 总体判断

主页面凭据安全当前为 **NOT TRUSTWORTHY**。OCR 独立页和 Schema 3 本地仓储的安全/并发边界相对完整，但不能抵消主页面 JSONP、PAT 与 XSS 链带来的系统级风险。

| 检查项 | 结果 | 证据与说明 |
|---|---|---|
| API Key / Token / Secret | 未发现仓库内真实密钥 | secret 形态命中为测试夹具；本报告未输出任何真实密钥。 |
| `.env` | 仓库中不存在 | `.gitignore` 未显式忽略 `.env*`，属于预防性 P3。 |
| Gist PAT | 高风险 | 用户 PAT 明文持久在 `localStorage:fuyu_gist_token`，且与第三方 JSONP 同域；见 P0-2。 |
| CORS | 本仓库无服务端 CORS | 外部 Worker 实测仅允许生产 GitHub Pages origin；本地开发被阻断。Worker allowlist 实现无法确认。 |
| 用户输入 | 持仓 code/数值有基础校验 | 基金名称进入 HTML 前通常转义；导入文件缺少大小/条数限制。 |
| 文件上传 | OCR 图片不上传服务器 | 仅接受用户选择的 Blob，检查类型、魔数、16 MB/16 MP；拒绝 URL/Base64。JSON 导入仍需资源上限。 |
| OCR 图片处理 | 较安全 | 独立文档、同源资源、本地 Worker；确认前不写持仓；性能账本不含图片/原文/金额/路径。 |
| XSS | 存在已确认外部响应链 | 重仓 `code` 未转义；主页面大量 `innerHTML` 与 inline handler 增加攻击面。 |
| CSP | OCR 页有；主页面无 | `ocr-import.html:8` 的 CSP 仅同源脚本/连接/Worker，因 WASM 含 `wasm-unsafe-eval/unsafe-eval`；主页面当前 JSONP 架构阻碍严格 CSP。 |
| 路径访问 | 未发现明显穿越 | `scripts/serve-site.mjs` 用 `relative(root,target)` 拒绝越界；OCR manifest 校验安全相对路径；构建脚本校验输出必须为 `site/`。 |
| 敏感日志 | 有脱敏但仍有残余 | `integrity.js:194` 遮蔽 GitHub token、Authorization、查询参数和 data image；外部 error message/stack 仍可存本地诊断。 |
| 依赖供应链 | 当前自动门禁良好 | Actions 固定完整 SHA；官方 npm registry audit 为 0；有 Dependabot。 |

优先顺序：先消除 P0-2/P0-3 的可执行脚本链，再讨论 PAT 加密。浏览器端“加密后仍由同页 JS 解密”不能解决同域脚本窃取问题。

# 12. 性能检查

## 12.1 本轮可复现基线

| 指标 | 结果 | 说明 |
|---|---:|---|
| `npm test` | 286 项，约 1.63–2.12 秒 | 本机 Node 24，结果受机器影响，仅作当前基线 |
| `npm run build` | 1.801–2.425 秒，3/3 成功 | 不含网络部署 |
| 首页 app-shell | 162,946 B raw / 52,241 B gzip | 预算 52,254 B，仅余 13 B |
| `site/` 总量 | 约 92.22 MB / 75 文件 | 构建实测 |
| OCR 相关产物 | 约 88.20 MB / 24 文件 | 占构建绝大多数，且不进首页 CORE |
| 非 OCR 静态文件 | 约 4.02 MB / 51 文件 | 包含 2.82 MB 基金目录 |

构建中最大的 OCR 资源包括多个 13–27 MB ORT WASM、约 11 MB Worker、检测/识别模型和保留的 Tesseract 资产。README 所称约 82.36 MB 是按 OCR manifest 的主链口径；`site/assets/ocr` 目录总占用更高，两种口径不能混写。

## 12.2 主要瓶颈

1. **首页启动网络链**：一批 `/estimates` 外，每只基金仍请求一次错误 push2 降级和一次全局串行 `pingzhongdata`。startup 与 overseas-models 又产生两轮 forced refresh。首屏卡片提交仍等待正式净值 JSONP。
2. **重仓 enrichment**：国内/港股候选会后台预取重仓，再获取最多十只证券行情；并发虽限为 2，但持仓多时网络/CPU 仍大。
3. **全表渲染**：每只基金主提交和后置 enrichment 都调用 `renderFundList(fundsData)` 重建整个 HTML，多项完成时接近 O(N²) DOM 工作。
4. **OCR 冷启动**：选择图片后才下载/初始化大 Worker、模型和 ORT，保护了首页，但首次 OCR 网络与内存成本高；离线无法新启识别。
5. **OCR 基金匹配**：多次全目录规范化 + 全量 Levenshtein，长图条目越多越慢。
6. **基金目录**：约 2.82 MB / 27,487 条，只在 OCR 按需加载，首屏设计正确；若接入主页面搜索，必须使用索引/懒加载，不能直接塞入 app-shell。
7. **第三方延迟**：JSONP 全局变量迫使串行，单源超时 7–10 秒；本地 CORS 使主链不可测。浏览器 timeout 不等同于服务端可用性证明。

## 12.3 最值得优化

- 第一优先：合并启动 refresh，主报价先提交，正式净值/详情后置；移除错误 push2 基金降级。
- 第二优先：让详情、云同步、通知等真正按需加载，为 app-shell 释放稳定预算。
- 第三优先：基金列表按 code 局部 patch 或批量一次渲染。
- 第四优先：OCR 目录建立一次性索引和查询 memo，记录阶段耗时但不记录识别内容。
- 第五优先：建立固定持仓数、网络档位和实体设备上的 p50/p95，而不是只报单次“打开快/慢”。

# 13. 移动端 / PWA 状态

| 项目 | 当前状态 | 问题/待确认 |
|---|---|---|
| viewport | `viewport-fit=cover` | 已实现 |
| safe-area | 顶栏/底栏使用 env safe-area | iOS 实机未验证 |
| 响应式布局 | mobile-first，768px 桌面断点，横向指数条 | 无自动视觉回归 |
| 底部导航 | 固定底栏、safe-area padding | 与键盘/小屏弹层组合未真机验证 |
| 页面滚动 | 主页面和 OCR 独立滚动；支持下拉刷新 | OCR 长确认列表、焦点恢复待真机 |
| manifest | standalone、portrait、192/512 图标、theme/background | 无 `id`、显式 `scope`、screenshots、shortcuts；无单独 apple-touch-icon |
| 图标 | `purpose: "any maskable"` | Android/iOS 实际裁切待确认 |
| Service Worker | CORE 预缓存；导航 network-first；JS/CSS/data SWR；icon cache-first；OCR network-only | OCR 不是完整离线；缓存策略必须与 build 替换标记一起维护 |
| 安装 | 具备 manifest/SW | 物理 Android/iOS 安装流程 NOT_RUN |
| 更新机制 | 检查未保存输入/同步状态，用户确认后 `skipWaiting`；跨标签协调 | 真机挂起/恢复、旧版本混合边界仍需验收 |
| iOS Safari | 代码含 safe-area | 文件选择、安装、更新、通知、内存均 NOT_RUN |
| Android Chrome | 空 MIME/`application/octet-stream` 后仍以图片魔数确认；能力预检 | 只有 MuMu Android 15 模拟器记录；物理设备 NOT_RUN |
| 相册/截图 | PNG/JPEG/WEBP 本地 Blob | 超过 16 MB/16 MP 拒绝；部分系统提供格式行为待实机 |
| 弹窗/键盘 | OCR 确认 UI 可滚动 | `100vh` 非 `dvh`，无 visualViewport，键盘可能遮挡 |
| 通知 | SW/Notification 均可发 | 首次任意交互就请求权限；不是后台任务；语义可误导 |

MuMu 证据可以用于定位 Android 问题，但报告/发布必须写“模拟器通过、实体设备未运行”，不能改写成 Android 全面通过。

# 14. OCR 模块状态

## 14.1 当前定位

- OCR 入口：主持仓页“选择截图” → `ocr-import.html`。
- 当前优先场景：支付宝/蚂蚁财富基金持有长截图，解析三列/双列表格。
- 引擎：`@paddleocr/paddleocr-js@0.4.2` + PP-OCRv6 tiny + ONNX Runtime Web 1.27.0。
- 后端选择：优先尝试 WebGPU；失败后单次回退单线程 WASM。真实生产 batch=1 配置在 `scripts/paddle-ocr-entry.mjs:214-216`，不要误改仅供测试的 wrapper 选项。
- 运行位置：浏览器本地 Worker；图片不上传，不调用 OCR 服务器，不产生按次 OCR 服务费。首次仍需下载同源静态 OCR 资源，网络/流量并非零。
- Tesseract：`js/local-ocr.js` 和依赖/资产保留，但当前 UI 不把它作为 Paddle 失败后的自动 fallback。

## 14.2 真实链路

```text
选择本地截图
→ 校验 Blob、MIME/扩展名容错、真实文件头、16 MB/16 MP
→ 检查 Worker / createImageBitmap / OffscreenCanvas / WASM / structuredClone
→ 加载并校验同源 OCR asset manifest、版本、路径和哈希
→ WebGPU 尝试；初始化失败时只回退一次 WASM
→ ImageBitmap 解码
→ 顶部来源区 + 持仓区纵向分片（1500 px，高度重叠 160 px）
→ 单 Worker 串行 Paddle 检测/识别，返回文字和 polygon
→ 坐标回映、重叠 token 去重
→ 三列布局重建、严格数值解析
→ 27,487 条本地基金目录名称/类别匹配
→ 支付宝/蚂蚁财富来源证据校验
→ 形成候选：名称、代码、持有金额、昨日收益、持有收益、收益率
→ 用户逐项确认代码/名称、填写真实份额和成本
→ 总确认 + expectedDocument 并发门禁
→ Schema 3 事务写入、pending 标志、返回首页
→ 安排 Gist 重试并刷新估值
```

## 14.3 字段与安全语义

- 基金名称：OCR 文本规范化后与本地目录匹配。
- 基金代码：目录匹配结果；A/C/E 类别接近时不静默混用，歧义进入人工确认。
- 持有金额、昨日/日收益、累计收益、收益率：依据坐标列和严格数字解析，证据不足保持 `null`。
- 真实份额：截图不可靠提供，必须由用户输入且 > 0。
- 成本净值：用户输入，或明确勾选后按截图金额/累计收益和真实份额换算。
- 截图、完整 OCR 原文、文件路径、金额：不写性能账本/诊断/Gist。
- OCR token：形成候选后清空引用；确认前不写入持仓。

## 14.4 完成度与问题

已完成：长图分片、坐标重建、来源门禁、类别防误配、人工确认、事务写入、并发快照保护、WebGPU/WASM 回退、资产完整性、非敏感性能账本、Android 空 MIME 容错。

仍有问题：

- 固定百分比区域和 16 MP 上限不等于“任意长截图”；
- 首次冷启动资源/内存大，低端真机风险未量化；
- 全目录模糊匹配性能差；
- 未匹配行选择候选后的 action 交互易误解；
- 既有 `cost:null` 转字符串问题；
- 无 CI 真实 Paddle 推理长图测试，无物理 Android/iOS 门禁；
- OCR 资源 network-only，因此“本地识别”不等于“完全离线识别”。

# 15. 测试状态

## 15.1 已有测试

47 个测试文件、286 项 Node 测试，覆盖：

- 估值/可信语义：calculator、freshness、Quote contract/presentation、重仓估算、海外模型、准确度；
- 刷新：估值/重仓 adapter、generation、AbortSignal、refresh coordinator、source registry；
- 数据：storage、Schema 3、迁移、repository、integrity、resilience；
- 云同步：Schema 2/3、设备 shard、合并、读回验证、失败关闭；
- OCR：图片格式/魔数、分片/坐标、支付宝解析、三列布局、基金匹配、导入计划；
- OCR 运行时：能力检测、WebGPU/WASM 回退、性能账本、Paddle wrapper；
- 构建/PWA：app-shell budget、OCR 构建/manifest、SW 生命周期/缓存、deploy workflow、release fingerprint、版本一致性；
- 若干源码级 regression/integration 约束。

本轮结果：

```text
npm test       PASS 286/286
npm run check  PASS
npm run build  PASS（连续 3 次）
npm audit      0 vulnerabilities（官方 registry）
```

## 15.2 重要未覆盖区域

- 无 Playwright/Cypress/Puppeteer 等真实浏览器 E2E；
- 无覆盖率采集和阈值；
- “integration/regression”中相当一部分是源码字符串/正则约束，不是 DOM 用户流程；
- 无添加→编辑→删除→刷新→云 tombstone 的整链 UI 测试；
- 无恶意 Worker 重仓 code/XSS 回归；
- 无基金代码/同代码股票碰撞测试；
- 无真实上游、Worker CORS、Gist 写入合约自动集成；
- 无自动完整 Paddle 模型真实长图推理；
- 无视觉回归、可访问性、键盘/safe-area/横竖屏；
- 无物理 Android/iOS/安装 PWA；
- 无真机 OCR 冷启动、内存峰值和崩溃率门槛。

历史真实截图/模拟器记录在文档中，不是仓库内可重复测试 fixture，不能算 CI 覆盖。

# 16. 构建和运行方法

## 前置安装

```bash
npm ci
```

## 前端开发/本地预览

项目没有热更新 dev script。仓库定义的准确方式是先构建，再启动只读静态服务器：

```bash
npm run build
npm run serve
```

服务监听 `http://127.0.0.1:4173`，读取 `site/`。注意外部 Worker 当前 CORS 不允许 localhost，不能用本地页面证明生产主估值链正常。

## 后端开发

不适用：本仓库没有后端启动命令、FastAPI 或 Python 服务。外部 Sinan Worker 的仓库/运行命令无法确认。

## 检查与 Build

```bash
npm test
npm run check
npm run build
```

OCR/目录维护命令：

```bash
npm run build:ocr
npm run refresh:fund-catalog
```

`refresh:fund-catalog` 会更新 `data/fund-catalog.json`，不是普通启动步骤；下一位 AI 未获授权时不要运行。

## Production

向 `main` push 后由 `.github/workflows/deploy.yml` 自动：

```text
npm ci
→ 官方 registry 高危依赖审计
→ npm test + npm run check
→ npm run build
→ 静态/OCR 产物检查
→ 发布关键文件 fingerprint
→ GitHub Pages artifact 部署
→ 线上 app-shell / SW / OCR manifest 和资产字节 smoke
```

本仓库没有手工服务器部署命令。不要直接编辑或提交 `site/`。

# 17. 当前依赖

## 17.1 前端/构建依赖

| 依赖 | 版本 | 用途 | 审计标记 |
|---|---:|---|---|
| `@paddleocr/paddleocr-js` | 0.4.2 | 当前本地 OCR 主 SDK、Worker 构建输入 | 固定版本；与模型/manifest/Worker 强绑定 |
| `onnxruntime-web` | 1.27.0 | Paddle 浏览器推理 WASM/WebGPU | `npm outdated` 最新 1.29.0；不可直接升，须真机 OCR 兼容验证 |
| `tesseract.js` | 7.0.0 | 保留的 Tesseract 降级/回归链 | 当前 UI 未接自动 fallback，可能冗余 |
| `tesseract.js-core` | 7.0.0 | Tesseract WASM core | registry latest tag 显示 6.1.2，属异常，不应降级 |
| `@tesseract.js-data/chi_sim` | 1.0.0 | 简体中文训练数据 | 随保留链部署，当前 UI 未使用 |
| `vite` | 8.2.2 | app-shell 和 OCR 静态构建 | 当前使用；2026-08-24 刚升级 |
| `esbuild` | 0.28.2 | Vite minifier / 显式满足 optional peer | 直接源码无 import，但构建需要，不应误删 |

依赖锁：`package-lock.json` lockfileVersion 3；官方 npm audit 当前为 0。`package.json` 没有 `engines`，仓库也没有 `.nvmrc`/`.node-version`；CI 虽固定 Node 24，本地复现依赖文档约定，属 P3。

Tesseract 三件套不能简单称为“完全无用”：构建脚本、许可证和测试仍引用；但生产 OCR 页面只动态导入 Paddle。下一版本应明确选择：

1. 真正接通但仍隔离下载的第二引擎；
2. 只保留开发/测试、不再部署；
3. 经回归后彻底移除。

## 17.2 后端/Python依赖

| 依赖 | 版本 | 用途 |
|---|---:|---|
| 无 | 不适用 | 本仓库没有后端或 Python 环境 |

外部 Worker/Cloudflare 依赖版本无法确认。

# 18. 下一版本最值得迭代的位置

## 必须处理

1. **先修可信与安全 P0**：删除同代码股票降级；隔离/取消主页面 JSONP；严格校验并安全渲染重仓字段；补回归测试。
2. **修复删除一致性**：active code 裁剪 `fundsData`、详情和缓存，覆盖本地删除与云 tombstone。
3. **重构启动刷新路径**：单轮启动、缓存/批量报价先呈现、正式净值/详情后置；明确主源实际命中。
4. **给 app-shell 留出可持续预算**：详情/同步/通知按需加载，不能只把 52,254 B 上限调高。
5. **建立移动发布门槛**：物理 Android/iOS、安装 PWA、长图选取、键盘、前后台、更新、断网；结论必须保留 NOT_RUN 边界。
6. **建立浏览器级 P0/P1 E2E**：至少覆盖持仓 CRUD/删除、恶意响应、CORS/source 标签、OCR 确认并发和 SW 更新。

## 建议处理

- 统一 source adapter 的业务成功/部分成功/失败统计；
- OCR 基金目录一次索引 + memo，动态版式锚点与安全下采样；
- DOM keyed/批量更新，减少整表 `innerHTML`；
- 主页面搜索自动补全，但保持基金目录按需加载；
- 交易日历和多市场头部状态；
- JSON 导入资源上限、错误分类、Gist 扫描上限提示；
- JSDoc/runtime schema 明确 Quote/Holding/OCR/Gist 类型；
- 决定 Tesseract 的真实产品策略；
- 补 Node 版本文件、Git tag 和发布后文档一致性检查。

## 可以延后

- 历史净值图表和完整基金详情；
- 交易流水、分红、定投、XIRR；
- 独立账号/服务端数据库；
- 完整设置中心和主题系统；
- 高级投研/回测。

## 不建议现在动

- 不建议在修 P0 前迁移 Vue/React 或整体重写；
- 不建议改写 Schema 3、设备 shard、tombstone/revision 语义；
- 不建议把未知值改成 0，或混合正式净值/盘中估值/模型估算；
- 不建议把 OCR 重资产塞进首页或 SW CORE；
- 不建议让 OCR 页面重新加载主行情 JSONP；
- 不建议直接升级 Paddle/ORT/Vite 组合而没有真实长图和实体设备基线；
- 不建议编辑生成的 `site/`。

# 19. AI 接手开发时必须知道的事项

1. 源码首页入口是 `index.html → js/bootstrap.js`；生产首页入口是构建生成的 `site/js/app-shell.js`。只改源码，不改 `site/`。
2. FundVal 不是 Vue 项目。页面切换不是路由，`market/edit` 是 class 状态，OCR 才是独立文档。
3. 本仓库没有 FastAPI/Worker 源码；`/estimates`、`/holdings` 的服务端修复需要找到 Sinan Worker 仓库。
4. 当前真实生产是 14.0.4；审计末尾已有并发文档差异回填发布状态，但尚未包含在 `3f89327`。先检查并保留工作树。
5. `docs/V15_AUDIT.md` 前 17 节是 v14.0.2 历史基线，后续章节才记录兼容桥，不能混用。
6. Quote 的 `valueKind`、`status`、`observedAt` 是 UI 可信语义的唯一权威；请求时间不能冒充行情时间。
7. 正式净值、盘中估值、重仓估算、下一净值海外模型必须分开；未知值保持 `null/--`。
8. Canonical 持仓字段是 `fundCode/costNav/updatedAt/deletedAt`，UI 仍使用 legacy `code/cost/updated_at/deleted`；这是兼容投影。
9. tombstone、revision、deviceId、note 和未来 Schema fail-closed 是云同步不可破坏的边界。
10. Gist 永久保留 legacy 文件，新版只写当前设备 V3 shard；不要静默把 Schema 3 降成 Schema 2。
11. Gist API 没有可靠 CAS；当前安全来自设备 shard、稳定合并、expectedDocument 和读回验证。
12. OCR 页面故意不加载 `app.js`/行情 JSONP，以保护图片选择器和识别内容。
13. OCR 必须保持“选图后才加载重资源”；`data/fund-catalog.json` 也只在 OCR 确认时按需加载。
14. 当前 OCR fallback 是 Paddle WebGPU → Paddle WASM；`local-ocr.js` 的 Tesseract 不是运行时自动 fallback。
15. 真正 Android 内存配置在 `scripts/paddle-ocr-entry.mjs`，不是 `createPaddleOcrOptions` 测试 helper。
16. SW CORE 在 build 时会用 marker 替换为唯一 app-shell；改缓存/入口时必须同时检查 `build-site.mjs`、SW 测试和发布 fingerprint。
17. OCR asset manifest、package 版本、模型 integrity、Worker 和哈希联锁，不能单改一处。
18. 首页 gzip 只剩 13 B；开始新功能前先决定拆包策略。
19. Worker 本地 CORS 会使 localhost 主源失败；必须查看可见 source/网络证据，不能把降级页面当主链通过。
20. `fetchFromEastmoney` 当前会把基金 code 当股票 code，是已确认数据错误，不要继续扩展该 fallback。
21. 删除基金要同步裁剪 `fundsData` 和缓存，不能只改 holdings tombstone。
22. OCR 性能/诊断不得保存图片、OCR 原文、金额、路径或底层敏感错误。
23. `npm run refresh:fund-catalog` 会修改数据文件，普通运行和只读审计不要调用。
24. 物理 Android/iOS 是 NOT_RUN；MuMu/桌面证据不能冒充真机。

# 20. 关键文件索引

| 文件 | 作用 | 重要程度 |
|---|---|---:|
| `AGENTS.md` | 架构约束、数据语义、维护注意事项 | ★★★★★ |
| `package.json` | 版本、脚本、直接依赖 | ★★★★★ |
| `index.html` | 主 UI 结构与开发入口 | ★★★★★ |
| `js/bootstrap.js` | 启动顺序、恢复/完整性入口 | ★★★★★ |
| `js/app.js` | 核心 UI、行情、同步、通知编排 | ★★★★★ |
| `js/runtime/quote-contract.js` | Quote Envelope 真值契约 | ★★★★★ |
| `js/runtime/quote-normalizer.js` | 来源归一化、候选选择、新鲜度 | ★★★★★ |
| `js/runtime/quote-presentation.js` | 面向用户的状态/日期解释 | ★★★★★ |
| `js/runtime/refresh-coordinator.js` | 刷新代际、取消、source health | ★★★★★ |
| `js/runtime/source-registry.js` | 数据源能力和健康策略 | ★★★★★ |
| `js/storage/holdings-schema.js` | Schema 3 持仓/文档契约 | ★★★★★ |
| `js/storage/holdings-repository.js` | 本地事务、备份、journal、并发门禁 | ★★★★★ |
| `js/storage/holdings-migration.js` | 旧版迁移与未来 Schema 保护 | ★★★★★ |
| `js/storage/cloud-sync.js` | Gist 合并和写后验证 | ★★★★★ |
| `js/storage/gist-remote.js` | Gist 文件/shard 与 HTTP adapter | ★★★★★ |
| `js/eastmoney-estimate.js` | Worker 估值 adapter | ★★★★★ |
| `js/fund-holdings.js` | Worker 重仓 adapter；当前 XSS 输入点 | ★★★★★ |
| `js/calculator.js` | 市值/收益计算语义 | ★★★★☆ |
| `js/holdings-estimate.js` | 十大重仓穿透估算 | ★★★★☆ |
| `js/overseas-model.js` | QDII/海外模型选择和计算 | ★★★★☆ |
| `data/overseas-models.json` | 海外模型规则和权重 | ★★★★☆ |
| `ocr-import.html` | 隔离 OCR 页面与 CSP | ★★★★★ |
| `js/ocr-import-page.js` | OCR 页面状态机、确认与写入 | ★★★★★ |
| `js/paddle-local-ocr.js` | 图片校验、分片、本地 OCR wrapper | ★★★★★ |
| `scripts/paddle-ocr-entry.mjs` | 真正生产 Paddle Worker/batch 配置 | ★★★★★ |
| `js/ocr/engine.js` | WebGPU/WASM 回退和引擎生命周期 | ★★★★★ |
| `js/ocr/asset-manifest.js` | OCR 资产版本/路径/哈希契约 | ★★★★★ |
| `js/ocr-table-layout.js` | 长截图坐标去重和表格重建 | ★★★★★ |
| `js/alipay-ocr-parser.js` | 支付宝字段解析、名称/份额类别匹配 | ★★★★★ |
| `js/holding-import-plan.js` | OCR 人工确认、份额/成本门禁 | ★★★★★ |
| `js/fund-catalog.js` | 本地基金目录加载/查询 | ★★★★☆ |
| `data/fund-catalog.json` | OCR 基金身份目录；大文件 | ★★★★☆ |
| `sw.js` | PWA 缓存、更新和通知 | ★★★★★ |
| `manifest.json` | PWA 安装配置 | ★★★★☆ |
| `scripts/build-site.mjs` | 生产构建、app-shell 和 gzip 门禁 | ★★★★★ |
| `scripts/build-paddle-ocr.mjs` | OCR 资产构建与完整性 | ★★★★☆ |
| `scripts/release-fingerprint.mjs` | 发布关键资源一致性 | ★★★★☆ |
| `.github/workflows/deploy.yml` | CI、Pages 部署、生产 smoke | ★★★★★ |
| `test/quote-contract.test.js` | Quote 语义回归 | ★★★★☆ |
| `test/storage-holdings-repository.test.js` | 持仓事务/恢复回归 | ★★★★☆ |
| `test/cloud-sync.test.js` | Schema 3 云同步边界 | ★★★★★ |
| `test/paddle-local-ocr.test.js` | OCR 图片/分片/wrapper 回归 | ★★★★☆ |
| `test/service-worker.test.js` | SW 缓存和更新回归 | ★★★★☆ |
| `CHANGELOG.md` | 版本行为与历史边界 | ★★★★☆ |
| `docs/V15_AUDIT.md` | v15 历史基线/实施证据；需按章节日期阅读 | ★★★☆☆ |

# Codex 给下一位 AI 的项目摘要

FundVal 14.0.4 已经不是一个简单的“基金列表网页”，而是一套实际部署在 GitHub Pages 上的零框架移动 PWA。它以浏览器 localStorage 的 Schema 3 文档为持仓真值，包含 tombstone、revision、deviceId、journal、双备份和旧版投影；可选 GitHub Gist 通过按设备 shard、确定性合并和写后读回实现跨设备同步。行情侧已经建立 Quote Envelope，把盘中估值、正式净值、重仓穿透、海外模型和缓存分成不同 value kind，并保留来源时间、可信状态、覆盖率和原因码。OCR 侧也有较清晰的隐私边界：截图在独立 CSP 页面、本地 Paddle Worker 内识别，不上传，用户确认真实份额和成本后才用 expectedDocument 事务写入。当前 286 项测试、语法检查、构建、官方依赖审计和 GitHub Pages 发布均通过，生产静态资源确认是 14.0.4。

但“能构建并已上线”不等于“数据和安全可信”。当前最大的五类问题是：第一，`fetchFromEastmoney` 把基金代码当作同代码股票查询，主链和正式净值同时缺失时可能把股票价格/涨跌额算成基金净值和收益；第二，主页面明文持久 Gist PAT，却直接执行东方财富和腾讯 JSONP，第三方脚本拥有读取全部同源数据的能力；第三，Worker 返回的重仓 code 未严格校验且未转义进入 innerHTML，形成外部响应到脚本执行的 XSS 链；第四，删除 tombstone 没有裁剪 `fundsData`，旧基金卡和缓存可残留；第五，启动同时发两轮 forced refresh，并让每只基金等待串行正式净值 JSONP，持仓越多越慢。其后还有 OCR 16 MP/固定区域边界、全目录模糊匹配、误导通知、本地 CORS、无真实浏览器 E2E和物理 Android/iOS门禁。首页 app-shell 52,241 B，距硬上限只剩 13 B，也使“直接继续往 app.js 加代码”不可行。

架构健康度应分层判断：Schema 3 仓储、Gist 防降级、Quote 契约、OCR 隔离与发布指纹是可以保留的健康基础；`app.js` 约三千行、第三方 JSONP、安全域、启动请求和整表渲染则是不健康核心。下一版本不要先做框架迁移、图表或交易流水，应从可复现测试开始，先锁住三项 P0、删除一致性和启动时序，再把正式净值/详情/同步后置或按需拆出，为首页恢复预算。随后优化 OCR 目录索引和动态版式，并以物理 Android/iOS、安装 PWA、长图、键盘、前后台和更新作为发布门槛。

最不应随便改的是 Quote 的可空/时间语义、Schema 3 的 tombstone/revision/device shard、未来 Schema fail-closed、OCR 独立页面和按需重资产、SW 构建 marker/指纹链。`costNav` 与 UI `cost`、canonical 与 legacy 字段看似重复，实为兼容桥；`local-ocr.js`/Tesseract 看似无引用，却仍被构建、测试和许可证链使用，删除前必须先做产品决策。立即接手时，建议先阅读 `AGENTS.md`、`app.js` 的 720–1280/1913–2207 行、Quote/runtime、storage 五个文件和 OCR 主链；为 P0 建失败测试，再做最小修复，并始终用生产 source/date/value 的可见证据验证，不能用 localhost 降级页面、MuMu 或单次 build 冒充完整发布验收。
