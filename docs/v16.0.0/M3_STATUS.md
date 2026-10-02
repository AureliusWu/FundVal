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

1. **M3 不退出、不合并为完成阶段**：最新本地工作树 all 非 OCR gzip 为 82,481 B，至少还需减少 5,254 B（第 9 节）；继续用等价策略/纯函数复用压缩，不放松金融数值、缓存来源、scope 复制/二次验证或 Worker zoned timestamp guards。
2. 同机性能与 p95 相对门禁证据尚不完整。桌面 3 秒绝对交互预算通过不等于 v16 相对性能门禁通过。
3. 旧手动详情行情路径、裸 f12 映射与 US 模型专属重复获取已在第 7 节修复。**P2 暖详情时间陈旧风险已在第 9 节本地修复并验证**：详情现在按身份、源时间和实际市场时钟评估，旧行情标明原时点，只补查需要更新的证券；合法历史值在失败时保留，非法/未来值不显示。此处不是生产已修复声明，也没有放宽昨日行情参与今日模型的规则。
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

## 9. 2026-10-02：暖详情可靠性、等价序列化与实测工具检查点

本节初始证据绑定 base HEAD `ac4920d0158722861a3ef14acba03b1e7c57515f` 的未提交工作树，SOURCE_DATE_EPOCH 为 `1790870129`。第 6 / 8 节历史 CI 不作为本节检查的结果。版本仍为 15.0.2，M3 仍 `IN PROGRESS`；不 merge、不 deploy、不跳到 M4。

### 已实施与行为保护

- `js/storage/holdings-schema.js`：指纹直接序列化规范化结果，不再重建同样字段或对每行做 JSON parse/stringify round-trip。新增 `test/holdings-canonical-v16.test.js` 对照精确 UTF-8 JSON、字段顺序、Unicode、null/0/-0、时间规范化、排序、tombstone/revision/device/note、错误顺序和不修改输入；原/新实现 characterization 均 24/24。3 行 canonical 的 JSON.parse 次数 3→0，JSON.stringify 4→1，Date.parse 25→13；这是调用计数，不是页面延迟证明。
- `js/runtime/source-registry.js`：合并 success/partial 的共同健康更新与 failure 的共同字段。保留 unavailable 短路、单调 availableAt、partial=degraded、精确 cooldown、单半开探针、取消与不可变快照。新增 `test/source-health-equivalence-v16.test.js` 22 项；原/新实现加原有用例均 31/31，包含 getter 访问/抛错顺序。没有合并可尝试谓词或移除输入校验。
- `js/runtime/security-quote-batch.js` + `js/app.js`：新增纯详情评估器，拒绝错误证券身份、缺失、未来/非法源时间；0% 保留。按交易所当地日期与真实 MarketClock 判断最近/历史和补查需求，境内假日的合法前收盘不清空，未知日历明确标注。暖详情只请求需要更新的证券，不重抓有效披露/元数据；获取失败只保留同身份的合法旧值，显示原来源时点。单调合并比较原始毫秒时间，避免较旧秒级返回覆盖较新毫秒缓存。显示历史不授予今日模型权限，模型既有覆盖/报告期/36 小时/NAV 区间不变。
- `test/detail-quote-freshness-v16.test.js` 使用真实 app 函数、批次执行器与 RefreshCoordinator。最初 9 项中 7 fail（其中 2 为新入口不存在），随后对毫秒保留和非法行补 RED→GREEN，最终 11/11。`e2e/v16-refresh.spec.js` 新增真实页面旧源时间、真实零涨跌和缺失 `--` 断言，未复制业务算法。
- `js/runtime/business-features.js` 只重导出 18 个已有 lazy 业务 API；app 的 11 个动态入口复用这个窄表面，避免重复动态 facade/preload 表。各入口自己的 promise/初始化/失败策略保留，云/Gist、诊断与 OCR 不进入冷启动。构建分组、oxc/es2022、依赖与 cold hard budget 均未改；SW 源清单加入该同源模块，构建仍生成完整 chunk 图。

### 本地业务验证（首轮配对前）

| 检查 | 实际结果 |
| --- | --- |
| `npm test` | 793 项；792 pass、0 fail、1 Windows symlink skip |
| `npm run check` | 180 个 JS 源码/测试语法通过 |
| 两次确定性 build / 官方 app 校验 | 16 chunks / 243,481 B raw；关键发布集指纹相同 |
| 关键发布集指纹 | `4cf839747afdb7ea51abd6ad7180d1803d9657c669bfac449ff147ccf4ee8472`（未提交工作树/上述 epoch，不是 CI 或生产指纹） |
| cold gzip | 43,845 / 52,241 B：PASS |
| all 非 OCR gzip | **82,481 / 77,227.7 B：FAIL**；较第 7 节净减少 849 B，含暖详情修复成本 |
| `npm run test:e2e`，FundVal 自有 12437 | 23/23，42.1 秒；桌面合成数据，不是真机验收 |
| official registry audit | 0 vulnerabilities；未改 npm 配置/依赖 |
| OCR 官方校验 | 23 assets / 88,196,906 B；资源/引擎未变 |

barrel 的独立虚拟试验曾相对“已经包含本轮修复”的 83,911 B 减少 1,430 B；不能把该独立差值与上表净 849 B 再相加。

### 配对性能证据和未通过项

新增 `scripts/measure-performance-pair.mjs`，同机交错 AB/BA、新 context、隔离旧 `40e68ed` 源码/服务、严格依赖图匹配、固定合成时钟、无外部数据/Gist 请求、真实 DOM readiness/保存交互、只读网络/主线程分解、前后源码与全部产物指纹及自有资源清理。测试工具不改业务或用户数据，端口 4173 保留给其他项目。

首轮 [原始 60-pair 报告](performance-evidence/m3-pair-60.json) 保持不可覆盖：4 warm-up + 60 retained，AB/BA 各 30，5000 次分层 paired bootstrap，seed 160003，所有 retained 样本保留。SHA256 为 `88b927752e589553cea18dba88e3d2233c780f208beeb1ea77a1de6902a4611d`。

| 指标 | 旧版 median / p95 (ms) | 当前 median / p95 (ms) | 95% median ratio / p95 ratio CI |
| --- | --- | --- | --- |
| cold | 152.00 / 193.60 | 139.80 / 217.00 | [0.8905, 0.9591] / [0.9386, 1.2818] |
| warm | 103.90 / 137.90 | 93.30 / 146.50 | [0.8336, 1.0031] / [0.8427, 1.3841] |
| save | 42.64 / 56.45 | 46.12 / 70.58 | [0.9822, 1.1594] / [0.6616, 1.4068] |

结论仍 **INCONCLUSIVE**，不能称 p95 门禁通过。cold/warm 的点估计更快不代表稳定尾延迟改善；save median +8.16% 但上界尚不能证明 ≤15%。原方案只将保存中位数列为相对硬门禁；工具还观察保存 p95，属于额外诊断/保守工具条件，不后改首轮统计来制造通过。

首轮同时暴露两处 harness 问题：Playwright 1.62.1 内置 `serviceWorkers: block` 脚本访问 opaque Bridge 的 `navigator.serviceWorker`，独立正反对照复现 SecurityError；采集器在请求记录完成前 reload/close，使部分同源静态请求 timing/size 不完整。源码/产物前后完整性与自有清理均 PASS，但 health FAIL、instrumentation INCOMPLETE，所以原始报告更不能作为完整门禁证据。只修测试环境/采集生命周期，不以广泛忽略 pageerror 或请求失败处理；后续新采样另存，不覆盖这一轮。

只读候选试验中，通用 HTTP 抽取仅省约 20 gzip B，规则行模板 helper 约 53–66 B，海外 prepared-legs 抽取反而变大且会改变 getter/错误顺序，均未采纳。所有预算、校验与发布边界不变；下一步仍是 M3 包体积与可靠尾延迟证据。

### 修正 harness 后的 200 组预设采样

工具修正不触及业务：改为 guarded registration denial，精确处理 opaque iframe 的原生 SW getter 拒绝，同时拦截 SW script/header、启用 CDP bypass，并在 cold/warm/save 各阶段断言 worker/controller/registrations 为 0。**没有忽略任何 pageerror**。请求在重载/关闭前进行独立、计时窗口外的收尾；仅明确的自有 reload/close + 已知 optional Bridge + 实际 ERR_ABORTED 可记为预期取消，关键/未知请求失败仍使证据 INCOMPLETE。关闭之后的异常计数也读回，不能因先 return 漏记。工具/collector 定向 24/24，最新完整 Node 为 **796 tests / 795 pass / 0 fail / 1 Windows skip**，syntax 180，official audit 0。

第二轮 [原始 200-pair 报告](performance-evidence/m3-pair-200.json) 在运行前固定 200 retained +4 warm-up、5000 bootstrap、seed 160003；AB/BA 各 100，不剔除/替换样本，也未与首轮合并。采样期间无并发 test/build/源码编辑，2026-10-02 02:37:38–02:46:48 UTC。报告 SHA256：`b7abe1b6f9409a8ebf5543b0b380acbb252bc2db60676db5ead7d75491813ad9`。

- 200/200 complete，0 failed pairs；源码/全部产物前后指纹 PASS，自有浏览器/两个服务/验证过的 Temp snapshot 清理 PASS。
- reference/current pageErrors 均 0，instrumentation failures 均 0，SW events 均 0；每侧 612 次 untimed drain 全部 SETTLED（含 warm-up）。
- 所有请求均有完整分类。reference/current 各 1836/2652 个故意阻止的第三方请求伴随同数量 console error；这是 hermetic policy 阻断的观察，不声称 console errors=0，也不说明生产第三方可用。

| 指标 | 旧版 median / p95 (ms) | 当前 median / p95 (ms) | 95% median ratio / p95 ratio CI |
| --- | --- | --- | --- |
| cold | 139.20 / 179.20 | 124.05 / 158.30 | [0.8709, 0.9105] / [0.7563, 0.9902] |
| warm | 76.30 / 104.60 | 66.60 / 91.90 | [0.8518, 0.8966] / [0.7334, 0.9622] |
| save | 39.55 / 47.43 | 38.43 / 63.95 | [0.9535, 0.9969] / [1.0696, 1.6649] |

冷/暖中位数点估计 -10.88%/-12.71%，保存中位数 -2.84%；各中位数 CI 上界在原方案 ≤15% 目标内，冷/暖 p95 ratio CI 上界也在 ≤20% 内。但工具预先设定的 p95 区间宽度要求尚未满足：旧版 cold/warm 宽度为 26.23%/24.09%，不是稳定基线；保存额外 p95 观察为 +34.85% 且区间宽。**仍为 INCONCLUSIVE / exit 2**，不后调宽度阈值、不把点估计改称全面门禁通过、不用追加样本直到绿的方法替换失败记录。

分解仅支持有限归因：本地 cold TTFB median 1.90→1.70 ms，warm 1.60→1.50 ms；cold CDP Task median 97.77→90.79 ms，Script 8.79→9.01 ms、Layout 40.45→39.97 ms。保存 click→DOM median 12.60→10.70 ms、p95 16.10→12.20 ms，与 runner wall 的尾部变化不同，后者包含自动化调度/等待，不据此断言纯业务回归原因。warm CDP counter 跨导航重置，差值为 null，**该阶段主线程分解不可确认**；不能将 null 当成 0。上述指标均非生产公网、实际手机或 PWA 升级验收。

最新业务包体积仍为 **82,481 B > 77,227.7 B**。无论原方案的相对时延 CI 观察还是工具保守条件如何解释，都不能覆盖这个独立 FAIL。M3 继续，M4/M5/M6 未开始。

采样后最终本地复核：Node 796/795 pass/0 fail/1 Windows skip，syntax 180，E2E **23/23（37.3 秒）**；再连续两次 build 的关键发布集仍为上述 `4cf839...`，官方 app/OCR 校验仍为 16/243,481 B 和 23/88,196,906 B。这两次 build 在浏览器 E2E 服务结束后执行，不在测量或 E2E 中途替换 site。此节新工作树/新提交的远端 CI 必须另查，不继承 ac4920d 或 1c23d2f 的历史结果。

## 10. 暖详情与等价精简检查点的远端证据

- 业务提交 `f0858e4ed16315ba1ce2627ae847c93d21ecbb64` 的 [push 36957490040](https://github.com/AureliusWu/FundVal/actions/runs/36957490040) 与 [PR 36957493813](https://github.com/AureliusWu/FundVal/actions/runs/36957493813) 均 `completed / success`，attempt 1；各自 candidate / codeql 成功。PR #12 保持 OPEN / draft，未进入 main。
- push Linux 日志实际为 796 tests / 796 pass / 0 fail / 0 skip，syntax 180，E2E 23/23（43.9 秒），official audit 0。实际构建为 16 app chunks / 243,481 B raw，cold gzip 43,845 B，all 非 OCR gzip 82,481 B；OCR 23 assets / 88,196,906 B。与第 9 节本地业务构建大小一致，不将本地旧 SOURCE_DATE_EPOCH 指纹冒充 CI 指纹。
- push artifact `11206502294`，名称 `fundval-candidate-f0858e4ed16315ba1ce2627ae847c93d21ecbb64-1`。GitHub API 声明 ZIP size 92,612,146 B、digest `sha256:1aac756ed5e1a41804584835e6fcb137862b36654764a2a92b79689fb37ceedd`，未独立下载/hash；它是 feature-branch review artifact，不是 production admission 已通过。
- 该提交的 green CI 仍未自动阻断 all-gzip；`82,481 > 77,227.7` 不因 CI 成功而变成 PASS。下一批将补齐独立实际字节/gzip门禁，不回填或改写本节历史结论。
- 此节证据只绑定上述业务 SHA；后续脚本/流水线/文档提交的 CI 要重新读取。main / 生产版本均未改为 v16。

## 11. 实际体积准入与同文档计数器（2026-10-02）

本批不改业务 JS / CSS / 数据 / 版本，不调整预算、编译目标、minifier 或 chunk grouping。

### 自动准入

`scripts/release-fingerprint.mjs` 对同次 descriptor 读取的 app manifest 验证、枚举完整 `js/chunks/` 文件集，并从各文件实际 bytes 重新计算 SHA / gzip。拒绝假 gzip、重复 cold/lazy、entry 非 cold、遗漏/额外文件、目录 symlink 和不可精确表示的整数。保持返回 `chunkCount/totalBytes`，另加 actual cold/all gzip。预算固定来自 v15.0.2 `40e68ed...`：cold 52,241 B、all `70,207 × 11 / 10`，以整数乘法比较，77,227 PASS、77,228 FAIL，不能向上取整放宽。

- `verifyAppChunkReleaseDirectory` 负责结构/字节核验，不自动给 WIP 发准入许可；`analyzeAppChunkBudgets` / `assertAppBundleBudget` 区分测量与阻断。
- CI 仍先跑 unit/check/build/artifact verification/E2E、seal/upload review bytes，然后 `--assert-app-bundle-budget site`；超预算直接使必需 `candidate` job FAIL，没有 continue-on-error。
- `verifyAndExtractCandidate` 在 archive/inventory 匹配后另核对实际 release-critical fingerprint 并实算预算；deploy 在上传 Pages artifact 前重复执行同一门禁。历史 green 产物也不能绕过新政策，feature/PR 仍不允许 main-only admission。
- 不声明完成独立 JS import parser：实际 import/cold closure、pre-integrity 隔离与 OCR/cloud/diagnostics 冷图保护仍由既有 `build-site` verifier 执行。新报告明确 `importClosureVerified:false`，不能把完整文件计量误称为独立静态依赖闭包验证。
- 针对性测试先 RED：预算/manifest 10 项 3 pass / 7 fail；standalone admission 两项均因旧 verifier 未拒绝而失败。实现后 6 个相关测试文件共 53 tests / 52 pass / 0 fail / 1 Windows symlink skip。canonical schema / 金融语义测试未放宽。

### 计数器采集修正

`measure-performance-pair.mjs` 改为 `paired-readiness-v2-same-document-counters`：导航 commit 后采集 baseline，记录 Timestamp / NavigationStart、主 frame/loader identity、原生 performance.timeOrigin / 相对时钟和四个 duration。仅同一文档且时钟/计数不倒退时相减；缺失/跨文档/晚于 ready 的 baseline 保持 null 和有界原因。`Timestamp` 是单调时钟，不是文档归零标志；不以 disable/enable 假设清零。

ready MutationObserver、migration/skeleton 条件、save wall timer、原有统计阈值不变。新增 RPC 有观察开销：cold/warm 只描述 post-commit 至 collection 的 PARTIAL timeTicks 活动，不是全启动、精确 ready 边界或隔离 OS CPU；未来必须两侧使用相同新协议，不能与旧 60/200 原始报告混样，也不能追认旧 cold/warm 为完整 CPU 分解。

独立 [counter probe](performance-evidence/m3-counter-probe.json) 为 3 次 **current-only** fresh-context 实际桌面 Chrome：9 个 cold/warm/save 阶段均同 epoch，4 counters 有限、invalid reasons 为空；cold/warm PARTIAL、save MEASURED。pageErrors、SW events/control/registrations、network instrumentation failures 均 0；drain SETTLED，自有 port 5503 / browser 清理 PASS，site 全树指纹前后相同。每 context 有 13 个已计数的外部阻断 console error，不能声称 console 零。此 probe 只证明新采集协议兼容，**不是相对性能/p95/M3 EXIT**。LF SHA256 `94f658237181e97021f64881bd550522e7f05796842aa324fe05bb975448e707`；未覆盖旧两份报告。

### 本地最终门禁

机器可读证据：[m3-bundle-gate.json](performance-evidence/m3-bundle-gate.json)。811 tests / 810 pass / 0 fail / 1 Windows skip，syntax 181，official audit 0，E2E 23/23（35.8 秒）。E2E 结束后连续两次本地 build 同为 16 chunks / 243,481 B；SOURCE_DATE_EPOCH `1790909431`、关键发布集指纹 `85690c3ef2b045dc5a6ef3dd8585903ac1ccbc498549aaff852e0368a86edd81`。app 与 OCR 官方校验通过（23 OCR assets / 88,196,906 B），未执行 OCR。

新准入 CLI 实际输出 cold **43,845 / 52,241 PASS**、all **82,481 / 77,227.7 FAIL**，exit 1；至少还需减少 5,254 B。仍不进入 M4/M5/M6、不 merge、不 deploy、不更新版本号。后续 CI 预期因这个真实预算失败；测试/build green 与准入 FAIL 必须分开报告。
