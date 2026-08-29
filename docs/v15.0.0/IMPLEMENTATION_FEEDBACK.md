# 蜉蝣基金（FundVal）v15.0.0 实施反馈

实施日期：2026-08-29
版本主题：可信架构重构（Trustworthy Architecture）
发布状态：`BLOCKED_FOR_DEVICE_VALIDATION`

本文件按《FundVal v15.0.0 迭代方案》要求记录实现、证据与未完成门禁。模拟器、桌面浏览器和自动化结果均不会被写成实体 Android/iOS 验收。

## 1. Git 与工作区

| 项目 | 结果 |
|---|---|
| 开始 HEAD | `3f89327a58c6d5ded7efc0031676aa08733d149d` |
| 结束实现 HEAD | 尚未创建 release commit；将在推送后的发布证据提交中回填精确 hash |
| 分支 | `main` |
| 远端 | `origin` / `https://github.com/AureliusWu/FundVal.git` |
| 开始状态 | 工作区非干净；已有 `README.md`、`docs/V15_AUDIT.md`、`docs/v14.0.0/IMPLEMENTATION_FEEDBACK.md` 修改和未跟踪 `CODEX_HANDOFF.md` |
| 保护措施 | 未 reset、未 checkout、未 stash、未覆盖并发文档；相关历史更新一并保留 |
| 结束状态 | 提交前只包含本版本及开始时已存在的相关文档改动；提交/推送结果见发布检查表 |

## 2. 基线与最终门禁

### v14.0.4 基线

| 门禁 | 结果 |
|---|---|
| `npm test` | `286/286 PASS` |
| `npm run check` | `PASS` |
| `npm run build` | `PASS` |
| 首页冷启动图 | `162,946 B raw / 52,241 B gzip` |
| `site/` | 75 个文件，92,218,645 B |
| OCR 产物 | 24 个文件，88,200,892 B；非 OCR 4,017,753 B |

### v15.0.0 最终候选

| 门禁 | 结果 |
|---|---|
| `npm test` | `332/332 PASS` |
| `npm run check` | `PASS` |
| `npm run build` | `PASS`；cold 51,597 B gzip，预算 52,241 B |
| `npm run test:e2e` | `7/7 PASS` |
| app chunks manifest | `PASS`；16 chunks / 180,728 B 均通过清单校验 |
| `git diff --check` | `PASS`；仅 Windows LF→CRLF 提示 |
| npm 高危审计 | `PASS`；0 vulnerabilities |
| GitHub Actions / Pages | 尚未执行；将在 release commit 推送后记录 workflow 与部署证据 |
| 生产 smoke | 尚未执行；将在 Pages 部署后核对静态产物、chunk 指纹和代表性基金数据 |

## 3. P0-1：基金/股票代码碰撞

状态：`CLOSED`

- 基金主报价候选链已删除“基金代码 → `secid=0.{fundCode}` → 证券 `stock/get`”能力。
- 证券 `stock/get` 仍只用于明确的黄金 AU9999 JSON 数据，不接受基金代码，也不成为基金净值候选。
- 删除 `nav_change_amt ÷ shares` 与旧净值涨跌的危险推断；无法确认身份时进入 `unavailable` 或显示 `--`。
- 回归用 `000001` 及另外两个碰撞 fixture 证明股票名称/价格不能进入 fund quote、NAV、今日收益或累计收益。

重点文件：`js/app.js`、`test/p0-security-regression.test.js`、`test/app-resilience-regression.test.js`。

## 4. P0-2：JSONP 与凭据隔离

状态：`CLOSED`

```text
FundVal 主页面（Schema 3 / Gist PAT）
          │
          ├─ fetch JSON → Sinan Worker / GitHub API / 东方财富 push2 JSON
          │
          └─ postMessage → sandbox="allow-scripts" iframe
                               │
                               ├─ 固定 operation
                               ├─ 固定 provider/URL 模板
                               └─ 东方财富 / 腾讯 JSONP
```

- 新增 `quote-bridge.html`，CSP 默认拒绝，仅放行同源 runtime、`fund.eastmoney.com` 与 `qt.gtimg.cn` 脚本。
- iframe sandbox 精确为 `allow-scripts`，没有 `allow-same-origin`、表单、弹窗或顶层导航权限，因此第三方脚本不能读取主持仓和 Gist PAT。
- Bridge 只支持固定 operation；父页面不能传任意 URL。
- 主页面验证 `event.source`、`requestId`、operation、请求代码集合、数组数量、字符串长度与有限数值；opaque origin 不被单独当成身份凭证。
- 主 `index.html` CSP 的 `script-src` 只有 `'self'`，并禁止 script attribute；旧 inline handler 已改成 `data-action` 事件委托。
- Gist Token 仍按既有边界保存在 localStorage，本版没有做没有安全收益的同域“加密”迁移。

仍为 JSONP 的源及位置：

| 源 | 位置 | 用途 |
|---|---|---|
| 东方财富 `pingzhongdata/{code}.js` | `js/sandbox/quote-bridge-runtime.js` | 正式基金数据/净值趋势 |
| 腾讯 `qt.gtimg.cn` | `js/sandbox/quote-bridge-runtime.js` | 指数、证券与海外成分行情 |

安全 fetch JSON：Sinan `/estimates`、Sinan `/holdings`、GitHub Gist API、东方财富 push2 黄金 JSON。主页面不存在第三方 `<script>` 注入。

## 5. P0-3：远端 XSS

状态：`CLOSED`

- `js/fund-holdings.js` 对对象、证券代码、名称、占比、条数、披露日期和来源逐项校验；最多接受 10 项。
- 重仓证券代码与名称在 HTML 输出前完整转义 `& < > " '`。
- Bridge/Worker/OCR/Gist/导入内容继续一律作为不可信输入。
- 恶意 `img/onerror`、`script`、`svg/onload`、`javascript:` fixture 被拒绝或只显示为纯文本，E2E 证明没有执行 payload。

重点文件：`js/fund-holdings.js`、`js/runtime/remote-schema.js`、`test/fund-holdings.test.js`、`test/p0-security-regression.test.js`、`e2e/v15.spec.js`。

## 6. Schema 3 与云同步边界

- Schema 版本仍为 3；`id/fundCode/fundName/shares/costNav/createdAt/updatedAt/deletedAt/revision/deviceId/note` 语义未变。
- tombstone、revision、future-schema fail-closed、expectedDocument、journal、双备份和 legacy projection 均保留。
- Gist 文件名与分片协议没有迁移；Schema 2 仍不能覆盖/降写 V3 字段。
- 云同步被移出冷启动图，按用户进入持仓/配置同步后动态加载。
- E2E 用 hermetic Gist 响应验证 PATCH 后 GET 读回不一致时 fail-closed，不会把未确认写入标成成功。
- 首次创建 Gist 时固定上传快照；读回完成后重新加载 canonical 本地文档。上传期间的新编辑与上传快照不同即保持 `pending`，不会被清空。

## 7. 删除一致性

- `js/runtime/active-holdings.js` 以 canonical active holdings 为唯一集合。
- tombstone 后立即裁剪 `fundsData`、行情/元数据/详情缓存与在途 request map，并重新渲染；刷新、重启和缓存恢复都不会复活已删除 code。
- 0 份额关注项仍是 active holding；只有 tombstone 才删除。
- 单元测试和浏览器 E2E 均覆盖新增、刷新、编辑、删除、再刷新。

## 8. 刷新架构 v2

启动 generation 数：`1`。

```text
bootstrap / Schema 3 恢复
            ↓
立即渲染合法本地缓存
            ↓
创建一次 startup refresh generation
            ↓
Sinan 批量主报价 → 先提交可用基金卡
            ↓
┌───────────────┬────────────────┬─────────────────┐
│ 正式净值 Bridge │ 十大重仓 enrichment │ 海外模型 enrichment │
└───────────────┴────────────────┴─────────────────┘
            ↓
仅更新仍属于当前 generation 且仍为 active 的基金
```

- 海外模型配置完成不再触发第二次 forced 全量刷新。
- refresh coordinator 支持停止/排空和 generation 过期保护。
- source registry 新增 partial 业务结果，部分基金可用不会被错误记成整源成功或整源失败。
- render 通过 `requestAnimationFrame` 合并提交，避免每个 enrichment 立即重绘完整列表。
- enrichment 每次从不可变主报价按“正式净值 → 重仓估算 → 海外模型”固定顺序重建；网络返回先后不再改变估算净值基准。
- 正式净值 Bridge 将东方财富时间戳按北京时间转换日期，避免中国午夜被 UTC 截成前一天。

## 9. 首页拆包与性能

| 指标 | v14.0.4 | v15.0.0 | 变化 |
|---|---:|---:|---:|
| cold raw | 162,946 B | 149,279 B | -13,667 B |
| cold gzip | 52,241 B | 51,597 B | -644 B / -1.23% |
| 全部 chunk raw | — | 180,728 B | 含 lazy；lazy 31,449 B |
| 全部 chunk gzip | — | 63,166 B | lazy 11,569 B |

硬门禁保持 `52,241 B gzip`，没有为了通过构建调高。未达到建议的 48 KiB，主要原因是当前零框架主编排仍集中在 `app.js`，且 Schema 3 恢复/迁移、Quote Contract 和 SW 更新保护属于启动必需边界；本版本优先建立可验证的动态 import 和发布清单，避免高风险大重写。

Lazy chunks：

| 角色 | raw | gzip |
|---|---:|---:|
| cloud-sync wrapper | 335 B | 221 B |
| cloud-sync implementation | 10,237 B | 3,009 B |
| fund-holdings | 1,399 B | 849 B |
| gist-remote | 3,533 B | 1,661 B |
| notification-controller | 4,720 B | 2,121 B |
| quote-bridge-client | 11,225 B | 3,708 B |

`js/app-chunks.json` 记录 16 个 cold/lazy chunk 的 path、role、raw、gzip 和 SHA-256；Service Worker CORE、构建门禁与部署 smoke 共用该清单。

同一 HEAD 连续两次完整构建得到相同 `app-chunks.json` SHA-256 和相同整站发布指纹；OCR manifest 在没有显式 `SOURCE_DATE_EPOCH` 时使用 Git 提交时间，消除了每次构建写入当前时钟造成的指纹漂移。

本地 Chrome 在阻断第三方网络、禁用 Service Worker、每轮新 context 的 5 次导航采样中，中位数为：TTFB 7 ms、DOMContentLoaded 88 ms、load 90 ms、FCP 104 ms。该结果只用于当前构建的可重复本地回归，不等同于生产网络或低端手机体验。

## 10. 通知可信语义

- 首次交互不再请求通知权限；只有用户点击“启用 14:30 通知”才加载 controller 并请求权限。
- 只允许 `status=realtime/delayed`、`valueKind=intraday_estimate`、当日北京时间、抓取与观察时间均不超过 10 分钟的数据。
- `changePct=0` 合法；null、NaN、Infinity、official/model/stale/unavailable/holdings/跨日全部 fail-closed。
- 没有任何符合条件的基金时不创建误导性空通知。

## 11. OCR 状态、性能与隐私

- OCR 仍在独立 `ocr-import.html` 本地执行；不加载主盘、Gist PAT、行情或第三方 JSONP，不上传、不保存原图和完整 OCR 文本。
- 基金目录建立一次性 exact、份额类别与 trigram 索引，同一导入会话复用，模糊候选最多 96 个且 A/C 份额隔离。
- 合成 5 名称基准：v14 线性扫描约 `529.40 / 500.96 / 486.99 ms`；v15 首次建索引 `334.78 ms`、随后匹配 `37.79 ms`，复用索引为 `16.80 / 17.53 ms`。这是同机合成方向性基准，不冒充真实设备总 OCR 耗时。
- 未识别成本保持 `null`，界面显示 `--`；只有用户提供真实份额并显式选择截图成本换算才计算 costNav。
- expectedDocument 冲突继续拒绝旧截图覆盖较新持仓，要求重新识别和确认。
- 性能账本新增 catalogLoad/match/commit 时间，但不会记录截图、OCR 文本、基金名、代码、金额、收益或文件路径。
- 16 MP / 16 MB 输入门禁保留，超限时明确要求裁剪或分段，防止移动端 OOM。

真实截图结果：用户提供的支付宝长截图没有提交到仓库；在 MuMu Android/Brave 中本地完成识别，约 23.5 秒得到 15 条候选、12 条自动匹配、3 条需人工确认。测试没有勾选确认，也没有写入持仓或发起云同步。

## 12. Android、iOS 与 PWA 更新

| 门禁 | 结果 | 说明 |
|---|---|---|
| MuMu Android 模拟器 / Brave | `PASS_WITH_BOUNDARY` | Android 15 x86_64 模拟器；浏览器 UA 为 Chromium 152/Android 兼容标识。持仓新增→刷新→编辑→刷新→删除通过；真实长截图 OCR 通过 |
| PWA 受控更新 | `EMULATOR_PASS` | 真实从 14.0.4 waiting worker 点击“安全更新”到 15.0.0；旧缓存保留一个版本符合 SW 回滚设计 |
| 物理 Android Chrome/PWA | `NOT_RUN` | 无实体设备，不能由 MuMu/Brave替代 |
| 物理 iOS Safari/PWA | `NOT_RUN` | 无实体设备 |

因此不能使用 `READY_TO_RELEASE`，最终状态必须是 `BLOCKED_FOR_DEVICE_VALIDATION`。

## 13. E2E

`playwright.config.mjs` 使用本机系统 Chrome、单 worker、同源本地服务和 hermetic route。第三方行情与 Gist 写入全部阻断或桩化，不触碰真实账户。

覆盖：

1. UI 新增/刷新/编辑/删除/再刷新。
2. Bridge sandbox 权限精确且不能读主页面 storage。
3. 恶意重仓文本不执行 XSS。
4. 估值失败时不得按基金代码查询同代码股票。
5. 云同步 PATCH 后 GET 不一致 fail-closed。
6. OCR 页面、候选与确认行为。
7. Service Worker 缓存 lazy/Bridge 资源并离线重开。

## 14. 本地开发代理

- `scripts/serve-site.mjs` 只在本地提供 `GET /__fundval_dev/estimates` 与 `GET /__fundval_dev/holdings`。
- 上游固定为 Sinan Worker；只接受严格代码/参数，不支持任意 URL、任意方法或 Gist。
- `js/config.js` 仅在 localhost/127.0.0.1 选择该同源路由，生产继续使用正式 Worker URL。
- `npm run serve` 使用 Node 24 的 `--use-env-proxy`，让企业/系统代理环境中的内置 `fetch` 与浏览器、PowerShell 走同一网络出口；无代理环境不改变行为。
- 修复后本机同源 proxy smoke：`/estimates` 返回 `degraded / eastmoney_official_nav`（正式净值降级，不冒充盘中实时），`/holdings` 返回 `ok / eastmoney_fund_archives`、报告期 `2026-06-30`、10 项；非法 URL/代码继续被 400 拒绝。

## 15. 依赖与许可证

唯一新增直接依赖是开发依赖 `@playwright/test@1.62.1`，许可证 `Apache-2.0`，要求 Node `>=20`；项目 CI/本机使用 Node 24。生产运行依赖未增加。

## 16. 新增、修改与删除文件

新增业务/基础设施文件：

- `quote-bridge.html`
- `js/sandbox/quote-bridge-runtime.js`
- `js/runtime/quote-bridge-client.js`
- `js/runtime/remote-schema.js`
- `js/runtime/active-holdings.js`
- `js/runtime/notification-policy.js`
- `js/notifications/notification-controller.js`
- `scripts/dev-data-proxy.mjs`
- `playwright.config.mjs`
- `e2e/v15.spec.js`
- v15 对应的 9 个新增 Node 测试文件
- `docs/v15.0.0/IMPLEMENTATION_FEEDBACK.md`
- `docs/v15.0.0/RELEASE_CHECKLIST.md`

另有预先存在且被保留的未跟踪审计文件 `CODEX_HANDOFF.md`。主要修改文件包括 `js/app.js`、OCR parser/import/catalog、`index.html`、`sw.js`、构建/指纹/部署脚本、README/CHANGELOG/AGENTS 与相关测试。删除文件：无。

## 17. 已知 P1/P2 与后续配合

### P1

- 物理 Android Chrome/已安装 PWA 与 iOS Safari/PWA 尚无证据；影响最终发布门禁，不影响代码构建。
- JSONP Bridge 解决凭据隔离与执行面问题，但第三方仍可能返回业务上错误的数据；Quote normalizer/expected-code 只能降低风险，长期仍建议由受控 Worker 转成结构化 JSON 并加入来源签名/一致性检查。

### P2

- v15 cold gzip 低于旧基线但没有达到建议 48 KiB；`js/app.js` 仍是最大的维护单元。
- Android 模拟器使用 Brave 而不是实体 Chrome，且没有覆盖系统级断网、后台恢复、安装图标与文件选择器权限矩阵。
- OCR 大模型首次下载和低内存设备 OOM 风险仍需物理设备分层测试。

Worker 仓库后续建议：为正式净值、指数和证券行情提供固定 schema 的 JSON endpoints，逐步淘汰客户端 Bridge；本版本没有跨仓库修改。

## 18. 未完成项与发布状态

未完成：

- 物理 Android Chrome：普通网页、已安装 PWA、前后台、断网恢复、系统文件选择器和真实 OCR。
- 物理 iOS Safari/PWA：safe-area、安装、更新、文件选择、键盘/弹窗、断网恢复和真实 OCR。

发布定义：

```text
P0：3/3 CLOSED
代码 / 自动测试 / 构建 / E2E：完成（最终数字见门禁表）
Android 模拟器：PASS_WITH_BOUNDARY
物理 Android：NOT_RUN
物理 iOS：NOT_RUN
状态：BLOCKED_FOR_DEVICE_VALIDATION
```

## 19. Git diff --stat

release commit 相对 `3f89327a58c6d5ded7efc0031676aa08733d149d`：69 files changed，5,154 insertions(+)，671 deletions(-)。其中包含开始时已存在并按用户要求保留的审计/历史文档改动。
