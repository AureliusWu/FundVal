# M3 刷新图、模块化与性能：阶段检查点

> 日期：2026-10-01（Asia/Shanghai）。状态：`IN PROGRESS / NOT RELEASED`。
> 基于受保护 main `154139d78b0e226fd99ec9a3009c1e63c06925ca`；分支 `codex/v16.0.0-refresh-plan`。
> 版本仍为 15.0.2。下列本地工作树证据不是 immutable main candidate、生产发布或真机证据。

## 1. 已实现的刷新边界

```text
活动持仓快照 + 已验证的原始缓存元数据
  → createRefreshPlan（显式 now / generation / 固定资源与 TTL）
  → 当前 generation 的 resource scope（同 key 同 Promise；实际 dispatch 计数）
      ├─ 主源估值：每批至多 50 基金；可用主结果先显示
      ├─ 指数 / 黄金：独立显示，不相互阻塞
      ├─ NAV / 元数据：共享官方数据端点，分别尊重各自 TTL
      └─ 重仓披露：至多 2 个并发稳定资源请求
          → 合格披露 + 实际选中的模型腿
          → qualified security identity union
          → 东方财富 50 一批 → 只为缺失项请求腾讯（50 / 64 一批）
          → 重仓详情与模型消费者共用同一组实际行情
  → 完整等待 NAV、晚追加的元数据、市场及 enrichment
  → 当前代最多一次聚合缓存实际写入
```

关键实现：

| 文件 | 职责 / 不变量 |
| --- | --- |
| `js/runtime/refresh-plan.js` | 纯计划；活动 code 裁剪；普通手动刷新只强刷易变资源；只有 diagnostic 可明确强刷某个稳定 key |
| `js/runtime/generation-resource-scope.js` | 代际 gate；失败 Promise 同样去重；缓存消费时重新检查 expiry；私有复制与验证后 stage；只拥有固定聚合 key 的同步写入 |
| `js/runtime/refresh-resource-cache.js` | 可选 `refreshResources` 资源 envelope；固定 source/tier/TTL/identity；严格验证金融数值及别名；读取不续期；旧 NAV key 只读适配 |
| `js/runtime/security-quote-batch.js` | 证券与模型共享请求；东方财富必须用 f13+f12，不能凭裸代码匹配；真实 f124 和腾讯交易所时区；null 不补 0 |
| `js/runtime/refresh-execution.js` | 一代编排、先主结果后 enrichment、源健康、统一最终提交、所有后台 Promise 的取消与等待 |
| `js/app.js` | 注入只读数据客户端及 UI 回调；移除旧全局模型抓取、重复 NAV 包装器和独立指数刷新计时链 |

- NAV 10 分钟、重仓 12 小时、元数据 7 天的稳定 TTL 保持 `js/config.js` 原策略。暖刷新不重新抓这些未过期资源。
- 元数据强制诊断或缺失时可单独获取官方端点，但不会改变暖 NAV 原 envelope 的获取/写入/到期时间。
- 缓存命中、过期旧数据回退、被取消代、全基金刷新失败不制造新 fund acquisition。只更新指数/黄金/元数据也不续期已有基金投影。
- 指数合法子集必须明确 `status: partial`；保持固定 requested codes、原实际时间和质量，只存实际返回的合法行。缺项不补 0、不拿旧行合并成新完整批次。
- `quarterly-holdings-model` 与 `market-model` 只在真实网络边界 claim。冷却只阻止模型专属请求，不阻止共享的境内证券需求；半开只放行一个实际探针，取消释放本代自己的 probe。
- 模型健康按实际 requested/acquired 身份记录 success / partial / failure；暖指数/黄金 seed 不伪造一次新成功或失败。
- 所有资源结果、UI 回调和唯一最终 cache flush 都检查 current + AbortSignal。慢元数据必须等名单封闭后等待，创建 Promise 时立即观察取消异常。
- Schema 3、tombstone、device shard、legacy 文件保留、Web Lock、OCR 引擎/隐私与 Bridge allowlist 未改。未新增服务器或实际云写入。

## 2. 回归与先红证据

迁移前真实页面的 6 项共享刷新用例有 5 项失败：同基金 NAV 请求 2 次；暖刷新仍获取重仓；两基金冷刷新聚合缓存多次实际写入；重叠证券请求分开；全源失败仍写入/续期。旧晚响应防覆盖用例当时已经通过，不能算本次新修复。

本次定向 RED → GREEN 还覆盖：

- 暖元数据未命中时实际官方端点获取，暖 NAV envelope 不变；失败 NAV 不触发第二次元数据重试。
- 超过 50 只基金按 50+1 批次保留完整请求集合，不扩大上游契约。
- 持仓缓存排队期间过期，在实际 loader 执行时领取健康探针，而不是计划时提前领取。
- 黄金 ISO 时间不能直接交给现有海外计算器；改为从原时间转换为其既有中国时间格式，真实 0 保留。
- 黄金慢请求不得阻塞指数、境内证券或不依赖黄金的模型；最终持久化仍等待全部分支。
- 模型冷却、半开成功/部分/失败/空值/null/取消；稳定或共享行情不伪造探针请求。
- 部分指数不整组丢弃；unknown / duplicate / future identity 仍 fail closed。
- 晚追加慢元数据会使旧实现提前完成；取消会产生未处理 AbortError。新实现等待全部 NAV 再捕获 metadata task 列表并观察全部分支。

新增浏览器用例运行真正的 bootstrap、app、opaque Bridge、HTTP/JSONP 与 Storage；只 mock 外部响应，不复制刷新业务。腾讯 US fixture 使用交易所当地真实收盘时间（9/28 16:00 EDT → 中国 9/29 04:00），不会用请求的中国 14:30 伪造美股时间。晚响应测试仅忽略已经脱离文档的旧 Bridge iframe 请求等待，不降低请求超时或取消 UI/cache 断言。

## 3. 此前刷新图检查点的本地验证（最新结果见第 7 节）

| 检查 | 实际结果 |
| --- | --- |
| `npm test` | 673 项；672 pass、0 fail、1 skip |
| skip | Windows 账户无法创建测试 symlink；Linux candidate 必须另查 0 skip，不能算本地通过 |
| `npm run check` | 167 个 JavaScript 源码 / 测试语法通过 |
| 共享执行行为 | `refresh-execution-v16.test.js` 35/35 |
| 证券批次行为 | `security-quote-batch-v16.test.js` 29/29 |
| 资源缓存行为 | `refresh-resource-cache-v16.test.js` 19/19 |
| `npm run build` | 通过；24 app chunks / 246,489 B raw |
| cold gzip | 44,311 / 52,241 B，既有 hard budget 未提高 |
| all 非 OCR gzip | **83,371 B > 77,227 B：FAIL**；比 v15 70,207 B 增加约 18.75% |
| `npm run test:e2e`，12437 | 19/19；29.3 秒；合成数据 / 桌面 Chrome，不是手机真机 |
| `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 0 vulnerabilities |
| 默认 mirror audit | registry.npmmirror.com audit API 返回 404/NOT_IMPLEMENTED；不是 0 风险结果。官方 registry 只用于本次命令，没有修改 npm 配置 |
| OCR 资源校验 | 23 assets / 88,196,906 B；引擎/模型版本未更换 |

两次连续主构建关键发布指纹相同：`e04fbba687d0c3588657748a7811ed811cee03ab990e6b554dfd2cf18852e986`。两轮均为同一工作树、未提交业务状态与 HEAD `ebd463c` 的 SOURCE_DATE_EPOCH；官方脚本验证全部 app chunk 和 OCR manifest 的路径/大小/SHA。此处是本地确定性与关键发布集的指纹证据，不冒充 GitHub candidate 或整个目录逐字节清单。

## 4. 构建与性能调整

- `scripts/build-site.mjs` 使用当前已安装 Vite/Rolldown 的阶段分组与 oxc minifier，没有升级依赖。startup-pure 最高优先级保护迁移/仓储/preload-helper；post-integrity 与业务 lazy、云/Gist、诊断分组保持阶段隔离。
- 新构建 gate 检查 bootstrap 静态图及 app 之前的迁移图不能包含 post-integrity app 模块；必须保留恰好一个动态 app 阶段；cold 图不允许 OCR、云/Gist、诊断。
- dynamic facade 可能没有自身实现模块，因此 on-demand gate 检查其 lazy 静态闭包，而非误判 export-only facade 无功能。
- 独立试验的 6 类违规依赖图均拒绝；正常空持仓、legacy→Schema 3、Web Lock 不可用启动检查通过。构建分组不能以 cold→app 静态边绕过迁移顺序。
- 完整 M2 基线 all 86,310 B；本次 all 83,371 B 有下降，但仍不满足相对于 v15 的绝对目标。单文件/递归错误分组会把 app 提前执行或把云/诊断入 cold，已排除；不会以改预算、弱化输入校验或伪造加载图过门禁。
- MarketClock 已验证的内置日历只验证/复制/冻结一次，调用者可变 override 仍逐次验证；复用 exchange-local parts 与 Intl formatter。7 项行为/计数测试保护 DST、节假日/提前收市、黄金夜盘、过期日历与可变 override。

桌面性能为 no-store、本地 hermetic、390×844 readiness/save 耗时，不含生产服务等待。与 npm test 同时运行时的早期样本有 CPU 干扰，不能用作最终改善证据。方案中的历史示例、M0 实际 BASELINE.json 和本次同机重测分开记录；不挑选较慢基线来宣称通过。少量样本不足以证明稳定 p95。

原始采样与环境见 [M3_PERFORMANCE.json](M3_PERFORMANCE.json)。Chrome 154.0.8037.93 / Node 24.14.0 / npm 11.9.0，当前 3 独立轮共 9 组；同机旧 `40e68ed` 隔离源码重测 2 轮共 6 组。旧源码 161 个 tracked 文件的 normalized hash 与 Git blob 相同，3 个仅 transport/服务隔离文件逐字核对，没有业务、断言或 fixture 改动；主产物指纹不变。

| 指标 | 同机旧基线中位数 / 最大值（ms） | 当前中位数 / 最大值（ms） | 观察 |
| --- | --- | --- | --- |
| cold readiness | 226.65 / 306.50 | 183.80 / 231.10 | 中位数 -18.91%，方向性，没有稳定因果结论 |
| warm readiness | 143.80 / 190.80 | 106.90 / 120.60 | 中位数 -25.66%，方向性 |
| save UI | 95.58 / 110.66 | 70.31 / 82.57 | 中位数 -26.43%，方向性 |
| p95 | 未验证 | 未验证 | 保持 null，不把最大值当 p95 |

3 秒本地绝对交互门禁通过；当前样本未观察到中位数回归。网络/服务端/主线程详细分解和稳定尾延迟证据仍待补，**全部非 OCR 包体积仍 FAIL，所以整体 M3 性能退出不成立**。

## 5. 未完成与下一步

1. **M3 不退出、不合并为完成阶段**：最新 all 非 OCR gzip 为 83,330 B，至少还需减少 6,103 B；继续用等价策略/纯函数复用压缩，不放松金融数值、缓存来源、scope 复制/二次验证或 Worker zoned timestamp guards。
2. 同机性能与 p95 相对门禁证据尚不完整。桌面 3 秒绝对交互预算通过不等于 v16 相对性能门禁通过。
3. 旧手动详情行情路径、裸 f12 映射与 US 模型专属重复获取已在第 7 节修复。仍有 **P2 暖详情时间陈旧风险**：`js/app.js:1274` 的 `fetchFundDetails` 对已有有限 change / 非空 quoteTime 的缓存只检查字段存在，未按时间解析与年龄判断；独立复核用实际函数合成复现了 28.5 小时旧涨跌仍保留、详情行情请求 0 次。长驻 PWA 跨日且主刷新失败时，可能继续展示旧重仓涨跌，详情表也未单独标记行情日期；昨日行情仍被重仓估值计算器排除，不扩大为“昨日值参与今日估值”的结论。后续应先以真实时间 / 跨日失败场景建立行为测试，再给旧行情明确状态或重新获取；不得把请求时间改写成行情时间。
4. 共享资源策略与缓存边界已复用，但总包体积仍 FAIL；不同构建参数的尝试没有作为已证明的性能优化采纳。Intl 计数测试证明的是 formatter 构造复用，不是生产页面 p95 改善。
5. 此前业务 SHA 的 GitHub 分支 / PR CI 与分支产物内容核对通过，见第 6 节；第 7 节新业务已独立检查对应 SHA 的 CI，见第 8 节，没有继承旧结果。正式主线 candidate 验证仍未满足。draft PR 可保存检查点，但不意味着允许 M3 EXIT 或生产部署。
6. M4 多档案同步合同、M5 OCR 导入/解码/取消/PWA 合同、M6 三类物理设备与同一产物发布继续按原顺序，未跳过。外部 fund-compass Worker 未修改，v2 服务未协同上线。

任何历史 M0/M2 生产、候选、真机与实际 durable write 证据边界仍保持。此检查点不改变生产版本，也不声明 v16 完成。

## 6. 业务检查点的 GitHub 与分支产物证据

- 业务提交 `83d1c7084ae4ddd1d7aaf7d205e5bea59dd4252b` 已推送；[PR #12](https://github.com/AureliusWu/FundVal/pull/12) 保持 draft，不 merge、不 deploy。后续仅证据文档提交不改变此处绑定的业务 SHA。
- [push CI 36882454412](https://github.com/AureliusWu/FundVal/actions/runs/36882454412)，attempt 1，candidate/codeql success；[PR CI 36882516199](https://github.com/AureliusWu/FundVal/actions/runs/36882516199) 亦 success。push Linux：673/673、0 skip/fail、syntax 167、E2E 19/19（33.4 s）、audit 0；cold 44,311 / 52,241 B、all 83,371 B。
- 独立 CodeQL check success。分支 analysis 1874954365 对应业务 SHA，103 rules、3 results，error/warning 为空；workflow green 不代表这 3 个既有 finding 已修复。main 保护的 candidate/codeql/CodeQL App 检查、strict 要求不变。
- open findings 仍为 #7（SW origin）、#5（catalog HTTP→file）、#3（Paddle 文件系统 race），与 M2 记录相同。CI 另有 Ubuntu runner 即将迁移、锁定 upload-artifact action 的 Node 20→24 强制运行提示；不是测试失败，也未在 M3 临时升级 Actions。
- 下载 push artifact 11171094845，原名 `fundval-candidate-83d1c7084ae4ddd1d7aaf7d205e5bea59dd4252b-1`。官方 `release-candidate.mjs verify` **exit 1**：`Candidate provenance or manifest is invalid.` 因为 branch 不是 main；这是正确拒绝，不改 manifest / 脚本 / gate，不描述为正式候选通过，也不能部署。
- 在另一个安全 Temp 目录对原 tar 做只读内容审查：提取前检查全路径 / regular files / 禁止 links，使用同一组已算 hash 的 tar 字节；127 文件 / 92,496,895 B 的路径、字节与 SHA 逐项与原清单一致。官方 inventory、app/OCR 模块函数核对内容，不替代 main-only provenance gate。
- 内层 tar 92,600,320 B，SHA256 `b3da8bef4eea32da7e2db0f029f1161e376329093b1d0f4d3857614a182b8553`；site inventory FP `0ded93bc9bd6f42decf7f37227b2866e8b4d31645554023a608f0d211d60026a`；关键 release FP `4ec488fca67a2412e14c8b8609b0b99ba3ce1c99a03c521109024892e62dba25`。
- 24 app chunks / 246,489 B、23 OCR assets / 88,196,906 B 校验通过，逐 chunk 实算 gzip 与 manifest 一致。此 release FP 与前述 ebd463c 工作树本地 FP 不同（构建绑定提交日期不同），不是声称同一 main candidate。
- 外 ZIP size 92,623,491 B / digest `3303bf4e4b3629563d845b2429748c4f4f14edd137c1180931f05f821d05c221` 仅为 API 声明，没有独立验证外 ZIP 摘要。

完整机器证据见 [M3_FEATURE_CANDIDATE.json](M3_FEATURE_CANDIDATE.json)。**分支内容完整 ≠ 主线 provenance 通过 ≠ all gzip 门禁通过 ≠ M3 EXIT ≠ 发布**。

## 7. 2026-10-01：详情 / 模型复用与时区热路径细化检查点

本节绑定本地已测试工作树：base HEAD `07271f7ed1d6f6ab58ac6c27dc2d4c507369aaf2`，测试时包含未提交业务修改。第 3 / 4 / 6 节保留为历史快照，不将旧 SHA 的 CI、指纹或性能样本替换为本次证据。机器结果与 10 个修改业务模块的 LF-normalized hash 见 [M3_REFINEMENTS.json](M3_REFINEMENTS.json)。版本仍为 15.0.2。

### 已完成的等价修复

- **手动详情复用实际批次层**：`js/app.js` 删除旧独立东方财富 / 腾讯解析路径，统一调用 `executeDetailSecurityQuotes`。冷详情使用真实 `RefreshCoordinator` 与只读 generation scope；外部取消、切换 / 关闭详情、新刷新都阻止晚结果与旧缓存写入。活动刷新期间的详情等待其完成并消费该代已获取的重仓 / 行情，不再独立获取相同 union。东方财富严格匹配 f13+f12，腾讯保留交易所当地时间转换；错误 / 未识别 / future / null 不补 0。缓存有披露但没有完整行情字段时，也会补取行情。新增详情行为测试 24 项、真实页面回归 1 项。
- **新获取指数与真实行情时间分离**：`security-quote-batch.js` 消费完整、严格校验且 acquisition TTL 未过期的指数 envelope；只有实际选中的 US 模型专属腿可以复用至多 36 小时的真实前收盘。共享证券需求 / 默认裸 seed 仍保留 60 秒与状态限制；不会把旧值标成今日实时，也不会制造新健康 probe。实际海外计算器继续校验 NAV base / target / exchange session / 36 小时范围。新增 16 项测试涵盖 envelope 篡改、source/tier/identity、空值与真实 0、精确 TTL / 36 小时边界、取消及共享证券不放宽。
- **复用时区 formatter**：`holdings-estimate.js` 与 `overseas-model.js` 使用已有 `zonedTimeParts` 缓存，保留原三轮 UTC 求解与美日韩市场日期规则，没有改成固定时差。10 项测试覆盖美股冬夏 / DST 邻近日、日韩跨日跨年、真实模型区间、未来时间及精确年龄边界。旧两轮每轮 420 次 formatter 构造的计数用例先 RED；新暖轮为 0 次，冷轮每个所需时区至多一次。
- **诊断与真实 MarketClock 一致**：`diagnostics-ui.js` 使用真实 `marketClock`、同一显式 now；10/1 境内假日不显示交易中，过期 / 不可用日历不猜测开市。保留旧 `marketSession` 导出兼容契约，不改诊断隐私、健康数据与写入规则。新增 6 项定向测试：先 1 pass / 5 fail，修复后 6/6。
- **资源策略单一来源**：新增 lazy `refresh-resource-policy.js`，计划、缓存与执行复用固定 identity/source/tier/TTL，不减少 payload 二次验证。5 项新测试保护完整策略、不可变数组、sorted/unique 50+1 边界及拒绝未知 key。其首次缺少模块导致 RED 仅是新契约的入口证据，不描述为修复 5 个已有业务 Bug。

### 本地验证结果

| 检查 | 实际结果 |
| --- | --- |
| `npm test` | 734 项；733 pass、0 fail、1 Windows symlink skip；不把 skip 算通过 |
| `npm run check` | 173 个 JavaScript 源码 / 测试语法通过 |
| `npm run build`（连续两次） | 均通过；25 app chunks / 244,782 B raw |
| cold gzip | 44,012 / 52,241 B：PASS；较第 3 节减少 299 B |
| all 非 OCR gzip | **83,330 B > 77,227.7 B：FAIL**；较第 3 节仅减少 41 B，至少仍需减少 6,103 B |
| `npm run test:e2e`，12437 | 20/20；30.3 秒；桌面 Chrome、合成数据，无用户档案云写入 |
| `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 0 vulnerabilities；未改 registry 配置 / 依赖 |
| app / OCR 官方内容校验 | 25 chunks / 244,782 B；23 assets / 88,196,906 B；均通过 |
| 独立只读复核 | 69 项针对性测试通过，0 skip / fail；未发现本轮新增可复现 P0/P1；上述 P2 仍开放 |
| Git diff 空白检查 | 通过；CRLF 提示不是源码差异或 build 失败 |

两次同一未提交工作树 / SOURCE_DATE_EPOCH `1790868176` 的关键发布集指纹均为 `4648acf3fb53619cf1f1cfbd28eead9b58668c1f413b2b4e49792ca191429ea6`。它不是提交后 CI artifact 指纹、正式 main candidate 或生产完整目录证明。

本次完整浏览器套件附带 3 组 cold / warm / save 样本，仅用于本地 3 秒绝对断言；没有与旧版隔离配对采样，不据此替换第 4 节的历史同机样本，也不宣称生产 p95 / 因果改善。**all-gzip RED，relative p95 未验证，M3 仍 IN PROGRESS**。只提交 / 推送 draft PR 检查点，不 merge、不 dispatch deploy、不提前启动 M4/M5/M6，也不更新版本号。

## 8. 细化业务提交的独立 CI 结果

- 业务 SHA `1c23d2f3765d8802e0acf4b65d5b9938533e2ca6` 已推送；[push 36887153653](https://github.com/AureliusWu/FundVal/actions/runs/36887153653) / [PR 36887162411](https://github.com/AureliusWu/FundVal/actions/runs/36887162411) 均 `completed / success`，attempt 1。读回 PR #12 head 与该 SHA 一致，仍 OPEN / draft；两个 candidate、两个 codeql 与独立 CodeQL 共 5 项检查均 SUCCESS。
- push Linux 的实际日志：734 tests / 734 pass / 0 fail / 0 skip；syntax 173；E2E 20/20（35.3 秒）；official audit 0。app 25 chunks / 244,782 B、OCR 23 assets / 88,196,906 B 的官方内容检查通过；cold 44,012 / 52,241 B、all 83,330 B，与第 7 节本地产物大小一致。
- push 上传 artifact `11174589521`，名称 `fundval-candidate-1c23d2f3765d8802e0acf4b65d5b9938533e2ca6-1`，API 声明外 ZIP size 92,623,860 B、digest `sha256:9ab2eeeb1bcff119395fc61eed3a5f3b7d79106a148a564d6c2c807863651f55`。本次没有下载 / 独立 hash 该 ZIP 或运行 main-only admission，不把 API 声明或 CI job 名称写成正式 main candidate 已验证。
- CI 没有自动执行本计划的 all-gzip 相对门禁与稳定 p95 门禁；green 不能覆盖 `83,330 > 77,227.7`。CodeQL 检查通过也不代表第 6 节既有 finding 已解决。未改 main 保护、未 merge、未部署。
- 后续证据文档提交只绑定上述业务 SHA；不把本地 `07271f7` SOURCE_DATE_EPOCH 的指纹冒充该 SHA 的 CI artifact 指纹，也不继承为后续 docs HEAD 的检查结果。

### 下一小批候选（只读分析，尚未实施）

1. `js/storage/holdings-schema.js:139`：已规范化 record / document 的重复构造与 JSON round-trip。只读 18 组 record + 18 组 document 逐字节对照一致，但正式改动仍需精确 JSON / 字段顺序、null/0、tombstone、revision/device、排序、错误代码与无 mutation 的 characterization；canonical 字节是 CAS / 云同步契约，不能只比较解析后的对象。
2. `js/runtime/source-registry.js:315`：来源健康 success/partial/failure 的重复更新与可尝试谓词。保留单调 availableAt、partial=degraded、unavailable 保护、精确 cooldown、单探针、取消不计失败和不可变快照；不能删掉不同信任边界的缓存 / Worker 校验。
3. `quote-presentation.js` / `security-quote-batch.js` / `holdings-estimate.js` 的北京时间 epoch 文本格式化。保留秒 / 毫秒、date-only、null/非法值与历史解析包装；共享 helper 进入 cold 后可能抵消节省，必须按同配置产物实测净值，不用源码行数推断收益。

三项均没有隔离 gzip 收益证据，不能承诺填补 6,103 B。现有正确行为应先 characterization GREEN，再等价优化；真正的性能 RED 是 all 门禁，不将缺少新 helper 的 RED 宣传为旧业务缺陷。暖详情修复另需区分历史显示、是否补查与是否参与今日估值：境内假期的合法最近收盘、US 跨中国午夜但同当地日都不能简单清空；future / 不可解析时点不得冒充有效行情。新请求失败保留旧合法值时必须标明原 source time / 旧状态，不续期、不改模型 36 小时 / NAV 区间规则。
