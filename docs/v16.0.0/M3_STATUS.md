# M3 刷新图、模块化与性能：阶段检查点
> 更新：2026-10-25（Asia/Shanghai）；§57仅all上限按用户批准改90KiB（92,160B），cold52,241及其他门禁不变。§60已完成9.1两controller接线和自动补名cache/旧代状态竞态修复；最终本地1409PASS/3skip、Chrome35/35、两次完整129产物一致，all86,850/cold47,014。§61最终281源的新固定800+4性能及两路复核已通过，不继承§58旧样本；精确提交CI和候选下载核验仍未完成。M3仍`IN PROGRESS / NOT RELEASED`，不进入M4/发布。
> M3 原始基点为 `154139d78b0e226fd99ec9a3009c1e63c06925ca`；归并后的 main 为 `abfb6313f12efb66b9096b60472b6dd457094485`。后续分支为 `codex/v16.0.0-m3-continuation`（第 19 节）。
> 版本仍为 15.0.2。下列本地工作树证据不是 immutable main candidate、生产发布或真机证据。
> 历史第55节：完整私有路由不等于generic Quote/cache表示全部退休；A249/B257冻结，build只加原business组membership。A精确当前127/16chunks，B136/17chunks；all+1,369 B，未运行候选完整QA/三轮确定性/新时延，未采用/发布。root273/site127/安装68和Git前后同。新政策不追溯提升该原型为合格。
> 历史第54节：同版Compiler共同packaging重定位及唯一2022桥接修复只获有限前提PASS；唯一B1运行F01原版0→Java2，诊断OPTIMIZER_INTERNAL_EXCEPTION，无转换代码/余7组或产品收益。第53/54节失败与当时原预算FAIL保持历史事实，不继续修compiler/扫flags。最新政策和当前验收见第57节，旧800不继承为新正确性修复后的时延资格。

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

## 12. 实际远端阻断与额外安全发现

提交 `724f8d62cbd5cb61112eec059fc4773bafc5441e` 的 [push 36958652073](https://github.com/AureliusWu/FundVal/actions/runs/36958652073) / [PR 36958655663](https://github.com/AureliusWu/FundVal/actions/runs/36958655663) 实际均 FAIL，candidate 只在最后的 `Enforce actual M3 app bundle budget` 步骤失败：此前 Linux Node 811/811、syntax 181、E2E push 23/23（50.4 秒）/ PR 23/23（38.7 秒）、audit 0、结构/字节核验、seal/upload 均成功。两个 workflow 的 codeql 扫描执行作业均 SUCCESS，但这不等于独立 `CodeQL` 安全检查通过。

新政策在两条真实 runner 上实算了 cold 43,845 PASS / all 82,481 FAIL，没有放宽预算、忽略失败或把 WIP artifact 当可部署候选。push review artifact `11207211480`，API 声明 ZIP 92,612,146 B、digest `sha256:560d18bb42225881fda297a0be132637a8ae839af2c839f30f31774af6e409ae`；未独立下载/hash，不满足 main-only / successful-run 准入。PR #12 仍 OPEN / draft，main 未改。

独立 CodeQL 新增 [alert #8](https://github.com/AureliusWu/FundVal/security/code-scanning/8)，`js/file-system-race` / high：性能报告先 `stat(reportPath)` 检查，再在长时间采样后按路径 `writeFile(..., {flag:'wx'})`。API created_at 为 2026-10-02 02:51:27 UTC（已经在 f0858e4 时被检测），本轮复核才追查其独立阻断；第 10 节的 workflow 作业 SUCCESS 不能替代这一检查。原 wx 已拒绝既有文件覆盖，但仍应去掉冗余的 check-then-path-use：采样前原子独占创建/保留 descriptor，最终仅通过同一 descriptor 写入/关闭。此处不 dismiss、不加入扫描排除，关闭状态须由后续真实复扫证实。

另外做了不写产物的压缩器可行性比较：同源码/grouping/es2022，`write:false`，仅 oxc→已锁定 esbuild 0.28.2；三对输出均重复，16 chunks、模块/静动态图和启动隔离相同。esbuild cold 44,766（+921 B）、all 84,810（+2,329 B），更大，已排除，**未实施**。这不是运行时等价/时延验收，也不能消除 5,254 B 缺口。

## 13. 报告文件 reservation 修复与本地复核

本批仅修改 `scripts/measure-performance-pair.mjs` / `test/performance-pair-v16.test.js` 和本状态文档，不触及业务、预算、统计阈值、依赖或历史原始证据。

- 采样前以 `open(O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600)` 原子保留报告 descriptor，删除先 stat 再按路径写的冗余判断。既有文件/符号链接不能被覆盖，竞争创建只有一个胜者。
- 最终只对同一 descriptor 写入一次；写后 `lstat(path)` 与 descriptor stat 的 ordinary-file / dev / ino 身份比较，路径被替换时报告失败，不误称已保存、不删除或覆写替换者。序列化、写入、身份检查、close 失败返回有界类别、CLI exit 2，不保存原始错误/凭据。
- 最接近已存在 real parent 的检查兼容尚未创建的日期目录；拒绝解析到 deployable site 的既有 alias/junction。不是针对恶意并发祖先改名的绝对隔离。Windows 没有 O_NOFOLLOW 时仍由 O_EXCL 拒绝既有链接；0600 仅为 POSIX mode 请求，不声称 Windows ACL 私密。
- setup/measurement 失败仍保存 INCONCLUSIVE；新 all-zero synthetic reference 用例在 referenceIdentity 即失败，0 pair、无 snapshot/browser，报告成功读回；其他 writer 用例用 EBADF 验证最终关闭。预先成功 reservation 后若进程被强杀，可能留空文件，需要使用新的报告路径，不能覆写。
- 12 个新回归用例；起始 reservation/finalizer RED 后 GREEN。最终两个相关测试文件 42 tests / 40 pass / 0 fail / 2 Windows file-symlink EPERM skip，junction / pathname rename-replacement 实际通过。独立代码复核无阻断。

2026-10-02 本地 full gates：823 tests / 820 pass / 0 fail / 3 Windows symlink skip，syntax 181，official registry audit 0，桌面合成 E2E 23/23（39.2 秒，自有 port 12437）。E2E 服务结束后连续两次 build：SOURCE_DATE_EPOCH `1790910360`（父提交 724f8d6），关键发布集指纹均为 `bcd7cf6307c7a656de7e841eb674a586b251a1ebaf8bb94083a6556481e66587`；这是未提交工具修复的本地构建，不是远端/生产指纹。官方 app/OCR bytes 核验为 16 chunks / 243,481 B 与 23 assets / 88,196,906 B；未执行 OCR。

实际预算仍 cold 43,845 PASS、all 82,481 FAIL / exit 1；差距至少 5,254 B。原 60/200 报告与 counter probe 未覆盖，新协议相对采样 NOT_RUN，统计仍 INCONCLUSIVE。CodeQL #8 是否关闭必须待本批 push 后的真实独立复扫，不 dismiss；M3 继续，不进入 M4/M5/M6，不 merge/deploy/bump。

## 14. Reservation 检查点的实际复扫

第 13 节实现已提交并推送 `2ec7a8a25d9e8f39dc1909d9b367ab033bfb2713`。其 [push 36959583129](https://github.com/AureliusWu/FundVal/actions/runs/36959583129) / [PR 36959586571](https://github.com/AureliusWu/FundVal/actions/runs/36959586571) 均 completed / failure、attempt 1，candidate 仅在最后 `Enforce actual M3 app bundle budget` 失败。两侧 Linux 实际为 823 tests / 823 pass / 0 fail / 0 skip、syntax 181；E2E push 23/23（42.5 秒）、PR 23/23（45.2 秒）。audit 0、app/OCR 实际字节核验、seal/upload 成功；all 82,481 > 77,227.7 不变。

独立 `CodeQL` check `110690241225` 为 completed / success、0 annotations，标题为 No new alerts in code changed by this pull request。实际分支 analysis `1878756267` 绑定 2ec7a8a，2026-10-02 03:19:10 UTC，结果从 4 降至 3；PR analysis `1878756390` 绑定合成 merge SHA `44798968a7163b6efe073018f02763812764cff6`，03:19:12 UTC，0 结果。alert #8 的分支与 PR merge 两个 instance 状态均 fixed，没有 dismissal。alert 顶层 API 的 state / fixed_at 为 null，故只报告已确认的实例 fixed 和独立检查 success，不编造全局 closed 状态。既有其他告警仍需后续阶段审查，不能写成整个仓库零安全问题。

push review artifact `11207337192`，API 声明 ZIP 92,612,146 B、digest `sha256:6b52d8b157bbe89e8e60e1062106cdd662dca77a7135562abed91782a00d5159`；未独立下载/hash，失败 run / feature branch 产物不是 production admission。PR #12 仍 OPEN / draft，远端 main 仍 `154139d78b0e226fd99ec9a3009c1e63c06925ca`；这些证据仅绑定 2ec7a8a，不继承给后续文档提交或生产。

## 15. 保阶段构建选项的只读排除实验

同源码 / oxc / es2022 / `write:false`，未落地改动。16 个分组/选项候选均未填平 5,254 B 缺口：business façade 入组无差异，resilience 入 startup 仅 -70 B，取消 business 分组 +179 B，app 与 post-pure 拆开 +986 B，取消 cloud/diagnostics 分组 +394 B；不同 maxSize 拆分均增加体积。post entriesAware +2,746 B 且产生含 `~` 的输出路径，违反既有安全路径契约。

全 lazy 并组最好 all 81,562 B（-919 B），仍差至少 4,335 B，并扩大 business 首次下载到 cloud/diagnostics、改变加载失败隔离，不采纳。`optimization.inlineConst:false` 三次同为 raw 242,579 / cold 43,806 / all 82,447 B（仅 -34 B）；显式安全 chunk cleanup 和关闭负控均无差异，符合 bootstrap 顶层 await 下该优化自动停用的已安装 Rolldown 文档。未采用 unsafe treeshake / purity 断言、属性字段混淆、编译目标或依赖变化。

这些是内存构建及模块/依赖图检查，不是浏览器运行时等价或相对时延证据；没有修改业务/构建配置/旧原始报告。新工具提交后 root 再核对工作树干净，三份历史 raw evidence 的 LF SHA 均未变。当前没有可提交的安全体积候选，下一步应针对真实重复业务块做 characterization 后单变量验证；不把 gate-only 修复当作 M3 EXIT，也不反复追加采样直到绿。M4/M5/M6 尚未开始，版本维持 15.0.2。

仅本证据文档增补后再次本地复核：823 tests / 820 pass / 0 fail / 3 Windows skip、syntax 181、E2E 23/23（37.6 秒）。自有 E2E 服务结束后两次 build 指纹均 `71ee91e916a3fe70ef581d95d15d14f504c076bcdc2842e16646b2aa39a77e40`，SOURCE_DATE_EPOCH `1790911097`（2ec7a8a），实算 all 仍 82,481 / exit 1；不将这份本地指纹当作 CI 或生产指纹。

## 16. 模块增长归因与函数排序排除

业务代码保持 3a19c40 的状态。只读 `write:false` 控制构建实际复现：

| 源码 / 构建 recipe | all gzip B | cold gzip B |
| --- | ---: | ---: |
| v15 / 原 recipe | 70,207 | 51,941 |
| v15 / 当前 recipe（仅归因控制） | 65,275 | 47,984 |
| 当前 / 当前 recipe | 82,481 | 43,845 |

相同当前 recipe 下源码使 all +17,206 B / cold -4,139 B；布局已抵消 4,932 B，不能把控制组 65,275 重新用作门禁基线。business-runtime 9,239→28,063（+18,824），post-integrity 36,932→33,003（-3,929），cloud 4,379→6,488（+2,109）。主要新增模块的 rendered standalone gzip 为 resource-cache 4,639、refresh-execution 4,439、worker-contract 4,351、security batch 3,552 B；它们不可相加、不是可回收收益。remote-schema 与 v15 source 完全相同，不是主要增长源。

不能删除兼容 alias 或共用一个过宽 validator 来填预算：Worker 接受数字字符串、精确 alias 冲突并抛 reason；cache 要求 number、允许 null/NaN 占位及 `1e-7` 容差、失败返回 null。投影 `...row` 不是嵌套存两份原始行。重复 normalize 仍在不同信任边界重新校验来源/日期/状态，不是可直接缓存一次的冗余；复用可能改变 getter、reason 与回退。目前没有可证实 ≥1 KB gzip 的安全结构候选。

另按测量前确定的 3 种函数排序规则各运行 3 次内存对照（长度升序、AST 结构、固定词频近邻）；仅在 FunctionDeclaration 原槽位替换完整源子串，全部非函数语句、imports/exports、间隔 trivia 和函数 binding/AST 不变，raw 均 243,481 B。all 分别 83,283（+802）、84,050（+1,569）、83,315（+834），均排除，未改 build config / site。after-output 内存排列未重算 filename hash，不是可发布产物；函数顺序还影响 error.stack 的源码位置，不能只凭去 location AST 宣称完整运行时等价。

本次实测 source 集 73 files / 3,576,505 B，before/after SHA `2a5f311b9965ea80d49c86d07d1d2e0e87d48fb111f9d83567369922e1cd2ae0` 一致。现有 site 发布 inventory 121 files / 92,496,807 B，before/after `0597795409f403cbeae56fe2c26c9bc1e98ae1e58fc4ca6d86362d84109b4849` 一致，沿用 inventory 排除根 `.playwright-results` 的规则，不冒充完全包括诊断目录的全树 hash。

下一轮只执行一次新协议 relative measurement，事前参数见 [v2-200 预声明](performance-evidence/m3-pair-v2-200-protocol.md)；目的补齐同文档 warm 分解，不追加旧样本、不调统计阈值、不覆盖 60/200/probe。包体积独立 FAIL 仍在，M3 IN PROGRESS。

## 17. 预声明 v2 配对测量的实际结果

第 16 节后的文档检查点 `d9fdabc5127f8d8d3c5315898b829d4371317112` 已在采样前推送，含固定参数 [protocol](performance-evidence/m3-pair-v2-200-protocol.md)。随后仅执行这一轮新协议；没有改源码/产物、并发本地测试/构建、重试 pair、筛掉慢值或追加样本。reference 为 immutable `40e68edab9cb3fba0b17338dc3672a82d13ad17e`，current source before/after 均为 clean d9fdabc。两侧使用相同 `paired-readiness-v2-same-document-counters`、Chrome 154.0.8037.93 / Node 24.14.0、390×844、固定合成时钟与合成持仓，HTTP cache disabled/no-store，SW 被阻断。

原始报告：[m3-pair-v2-200.json](performance-evidence/m3-pair-v2-200.json)。2026-10-02 **03:37:54.453 → 03:46:49.484 UTC**；200 retained +4 warm-up 全部 complete，failed 0，retained AB/BA 各 100。LF **22,398,799 B**，SHA256 **`323ff4087da0a1a836fe8147ef305cd8f315e3e0d10e706cbc4d25abfba74236`**。工具实际 **PASS / exit 0**；5000 次固定 seed 160003 的分层 paired bootstrap、nearest-rank p95 和预声明政策不变。

| 耗时（ms） | v15 median / p95 | current median / p95 | median / p95 变化 | median ratio 95% CI | p95 ratio 95% CI |
| --- | ---: | ---: | ---: | --- | --- |
| cold ready | 131.50 / 151.80 | 122.60 / 139.60 | -6.77% / -8.04% | 0.92383–0.94262 | 0.87799–0.97716 |
| warm ready | 72.80 / 85.90 | 64.90 / 76.40 | -10.85% / -11.06% | 0.88396–0.89993 | 0.83535–0.97969 |
| save runner wall | 39.12 / 44.11 | 37.14 / 49.22 | -5.06% / **+11.60%** | 0.93395–0.96232 | 0.96466–1.15344 |

原方案硬门禁是 cold/warm median ≤+15%、p95 ≤+20%，save median ≤+15%；本轮均满足。保存 p95 是额外保守工具观察，不能隐去上涨或把它变成新方案预算；本轮它的上界也低于工具 1.20。p95 CI width（reference/current）cold 9.55%/4.94%、warm 9.90%/10.60%、save 5.95%/16.15%，均满足工具预设 20%。bootstrap pass fraction 为 cold/warm 1.000、save 0.988，不是总体通过的概率。该结果仅为这一次桌面本地协议的证据，不是生产、公网、物理手机、PWA 离线或实际 Gist 验收，也不归因为某个单独业务改动。

### 完整性、健康与归因范围

- health / instrumentation / integrity 均 PASS；两侧 source identity 与完整 artifact inventory 前后相同。reference inventory 110 files / 92,344,588 B，SHA `29641fb2e9ad927871a2485f07cbdd0d78e9707a6e999ea5160e5822b6471402`；current 121 files / 92,496,807 B，SHA `0b02caf15d5f9bd077fad299e0c8f39982fd69be247d1cd51e9b09576b163c4d`。这是 sampler 的发布文件 inventory，沿用其排除诊断目录的规则。
- pageErrors、network instrumentation failures、SW event/controller/registration 均 0；每侧 612 drains 全 SETTLED。reference/current consoleErrors **1,836 / 2,652** 为原样记录的外部阻断观察，不能声称 console 零。主 Worker 由相同合成 fixture 响应，其他 provider 及全部 Gist 请求阻断，没有截图/OCR 上传或真实持仓写入。
- browser、自有 10445/10448 两个 server、验证过的临时 reference snapshot cleanup 全 PASS；未使用、终止或修改其他项目的 4173 服务。reference 隔离快照只修改报告所列 3 个 transport/test-server 文件，不改其业务/fixture。
- 两侧各阶段含 warm-up 的 **204** 份 renderer 均同文档 epoch、四个 duration 有限、invalidReasons 空；cold/warm 全 **PARTIAL**、save 全 **MEASURED**，UNAVAILABLE 0。无缺失值被补零。

| retained renderer / 辅助计时中位数（ms） | v15 cold / warm / save | current cold / warm / save |
| --- | ---: | ---: |
| Task timeTicks activity | 87.62 / 28.48 / 43.78 | 82.33 / 27.23 / 27.22 |
| Script timeTicks activity | 8.13 / 2.00 / 3.57 | 8.86 / 2.34 / 2.49 |
| Layout timeTicks activity | 40.01 / 0.70 / 6.12 | 39.91 / 0.70 / 5.24 |
| RecalcStyle timeTicks activity | 2.39 / 1.73 / 2.19 | 2.26 / 1.63 / 2.01 |
| post-HTTP bootstrap/DOM residual | 124.30 / 66.60 / 不适用 | 115.75 / 58.50 / 不适用 |
| navigation TTFB wall | 1.80 / 1.50 / 不适用 | 1.70 / 1.50 / 不适用 |
| click→visible DOM | 不适用 / 不适用 / 12.25 | 不适用 / 不适用 / 10.70 |

这些 counter 不是完整启动 CPU、精确 ready 瞬间或隔离 OS CPU；cold/warm 从 commit 后 baseline 到 collection，漏掉早期工作并包含采集/harness 开销，四项不能相加当互斥 CPU。save 的 collection 活动与 runner wall / click→DOM 也不是同一窗口。辅助中位数为描述性统计，没有另做显著性或因果推断；不能把 Script activity 上升隐去。新 RPC 协议的观察开销使本轮不能与旧 60/200 报告拼接，旧 INCONCLUSIVE 不追认为 PASS。

### 本地门禁与仍然阻断

采样前本地 full gates 为 823 tests / 820 pass / 0 fail / 3 Windows symlink skip、syntax 181、official audit 0、E2E 23/23（39.5 秒，自有 12437）。两次连续 build 同 SOURCE_DATE_EPOCH `1790912052`（d9fdabc），关键发布指纹均 **`91634a6154f1f1a1f7391553a74696940d23d0e35af04fa5d38c021efc711d13`**；app 16 chunks / 243,481 B、OCR 23 assets / 88,196,906 B 实际字节/SHA 校验通过，未执行 OCR。这个本地指纹不是 CI 或生产指纹。

实际独立预算 CLI 仍为 cold **43,845 / 52,241 PASS**、all **82,481 / 77,227.7 FAIL**，exit 1。尚差至少 **5,254 B**；relative PASS 不覆盖这个门禁，M3 **IN PROGRESS**，不进入 M4/M5/M6，不 merge/deploy/bump，版本仍 15.0.2。

报告/索引补齐后再次本地复核：823 tests / 820 pass / 0 fail / 3 Windows symlink skip、syntax 181、official audit 0、E2E 23/23（41.7 秒）。E2E 服务退出后两次 build 同 d9fdabc epoch / `91634a61...` 指纹，app/OCR 实际核验通过、预算 exit 1；新旧四份 raw evidence 与采样器 LF hash 均未变。独立审查固定参数重算 entire summary 与原值 deepEqual，204 组精确 AB/BA 顺序及 1,224 阶段共 4,896 个有限非负 delta 核对通过；没有重采样。

## 18. 预声明提交的实际远端检查

精确绑定 d9fdabc 的 [push 36961013836](https://github.com/AureliusWu/FundVal/actions/runs/36961013836) / [PR 36961017820](https://github.com/AureliusWu/FundVal/actions/runs/36961017820) 均 completed / failure；唯一失败步骤是 `Enforce actual M3 app bundle budget`。两侧实际 unit 823/823、syntax 181、official audit 0、E2E push 23/23（39.5 秒）/ PR 23/23（45.8 秒）；build、app/OCR artifact verify、seal/upload 均成功。真实 runner 日志为 cold 43,845 PASS、all 82,481 > 77,227.7 FAIL / exit 1，不继承前一个 SHA 的结果。

同 SHA 独立 [CodeQL check 110694662679](https://github.com/AureliusWu/FundVal/runs/110694662679) SUCCESS；analysis 1878812636 绑定 d9fdabc、结果 3，error/warning 为空。当前仍有 3 条 open alerts：#3 high（`scripts/build-paddle-ocr.mjs:545`）、#5 medium（`scripts/refresh-fund-catalog.mjs:65`）、#7 medium（`sw.js:76`）；均为此前既有告警，不能宣称仓库零安全问题，也不能未经 immutable 基线分析就称 v15 baseline。#8 旧实例 fixed 且未出现这个 SHA 的新实例，没有 dismissal。

PR #12 为 OPEN / draft，head d9fdabc；main/base 仍 `154139d78b0e226fd99ec9a3009c1e63c06925ca`，mergeable_state blocked。上述远端证据只绑定预声明提交，不自动继承给后续 raw report / 文档提交或生产。

## 19. 2026-10-03 远端归并后的状态核对

上节是 d9fdabc 当时的远端快照，不是当前状态。继续执行时重新读取 refs / PR API，确认 `main` 与原 `codex/v16.0.0-refresh-plan` 都已指向 **`abfb6313f12efb66b9096b60472b6dd457094485`**；PR #12 已于 **2026-10-03 01:55:12 UTC CLOSED**，`mergedAt:null`，并非 M3 合并或退出。

fetch 实际显示原功能 ref 被归并更新，远端 `backup/wip-v16-refresh-plan-20261003` 完整保留 **d9fdabc**；`backup/pre-consolidation-20261003` 保留 154139d。新 main 只比原基点多一条 README 文档提交，明确线上/源码仍为 15.0.2、V16 尚未达到正式发布条件，以及 pan 为历史/维护产品；没有新增业务代码。这里不把远端归并解释为 M3 已完成，也不以旧 OPEN PR / CI 快照说明当前可合并性。

为保留归并结果及既有 M3 业务/测量，后续工作使用新的 **`codex/v16.0.0-m3-continuation`**。不 force-push 原 ref，不恢复已关闭 PR，不修改 main；纳入 main 的 README 更新后重新绑定后续提交的检查。四份原始报告保持不可覆盖，v2 证据仍只绑定其实际采样 HEAD d9fdabc 和 epoch，不改写为新分支 HEAD。

实际本地保存报告提交为 `8e6886a9c195a914477102d4776402c45220930e`，随后以正常 merge 纳入 abfb631，得到 **`1340b7ad8924afe578c51d14d083039e3ec66d56`**；merge 只新增 README 的 3 行更新，不改业务。这个新检查点的 full gates 为 823 tests / 820 pass / 0 fail / 3 Windows symlink skip、syntax 181、official audit 0、E2E 23/23（48.0 秒）。E2E 退出后两次 build 同 SOURCE_DATE_EPOCH **1791000583**，关键发布集指纹均 **`345193e9c6bad5428fda2a603698ac39958e6d0aa4a03389e3fa7a9eb6e92d92`**；app 16 chunks / 243,481 B、OCR 23 assets / 88,196,906 B 校验通过，未运行 OCR。all 82,481 / budget CLI exit 1 不变；没有把旧 d9 的 91634a61 指纹冒充新 HEAD、CI 或生产。

额外只读审查未找到四个刷新/缓存模块中可证明 ≥1 KB gzip 的安全结构候选，未修改/量化或宣称收益。cache 的全部 own 检查→getter 读取顺序、严格持久化验证与写入投影、NAV 异步调度边界、模型健康 reason / probe 记账仍需保留；不以删校验或合并宽 validator 来消除 5,254 B 缺口。后续实现仍应针对明确变换做 characterization 与实际单变量构建，不重复已经排除的 minifier/分组/函数排序实验。

新分支检查点 **afd472c715b6d579b836fd00a5d4e91ca831f228** 已正常推送；[CI 37095774528](https://github.com/AureliusWu/FundVal/actions/runs/37095774528) 实际 completed / failure，candidate 唯一失败步骤为 all-gzip 门禁。Linux unit **823/823、0 skip/fail**、syntax 181、official audit 0、E2E **23/23（36.2 秒）**、build/app/OCR bytes verification、seal/upload 均成功；预算仍为 cold 43,845 PASS / all 82,481 FAIL。codeql workflow job 111125271172 SUCCESS；同 SHA analysis 1884931741 于 04:13:33 UTC 生成，results 3、error/warning 空。check-runs API 仅观察到 candidate/codeql 两个 workflow checks，未观察到独立 CodeQL check，不能继承旧 PR 的独立扫描结论或称零告警。机器可读摘要：[m3-continuation-ci.json](performance-evidence/m3-continuation-ci.json)。未新开 PR、未下载验证 review ZIP、未 merge/deploy/bump；后续文档提交不继承本 SHA 的检查结果。

## 20. 有行为保护的小步源码去重

本批以 clean **93b6182925c9f56742f1f37ca28e0f1869497b87** 为父检查点，开始实际修改业务中的重复结构；不再以“单项至少减少 1 KB”筛除可证明的小正收益。总体预算仍严格保持原方案。证据：[m3-safe-compaction-20261003.json](performance-evidence/m3-safe-compaction-20261003.json)。

- `js/runtime/quote-normalizer.js`：两张私有诊断 identity-object 改为 frozen 字符串列表，以成员检查返回原 normalized code。两个白名单仍独立；未知/原型名仍为 unclassified；不转换非字符串，不保留上游任意文本。新增 6 个长期表征测试先在旧代码通过，另有 1,855 个合成差分用例（含 215 个逐次 getter 异常注入），核对完整 envelope、读取/own/prototype 顺序及 error name/message/code。
- `js/app.js`：11 个基金信息/费率 HTML 行复用私有 `ruleRow`，原 guard、标签、字段重复读取、managerWorkTime 拼接和 `esc` 不变。测试保留独立旧 literal reference，2,226 个分支/读取/异常对照完整 HTML；3 个长期测试在旧、新实现均通过。
- `js/runtime/cache-envelope.js` / `security-quote-batch.js`：复用既有纯 policyEpoch/Record/Own，未合并 payload/envelope validator，也未改变 own→get 顺序或异步边界。新增 8 个长期测试，包含 primitive、null-prototype、继承、shadowed own、epoch 上下界及逐读异常；相关 96 项在改动前后均通过。独立子代理复核三组 diff 未发现阻断问题；不代表整个仓库零风险。

固定现有 Vite 8.2.2 / oxc / es2022 / grouping，`write:false` 单变量与组合各 3 次：

| 变体 | all gzip B | cold gzip B |
| --- | ---: | ---: |
| immutable 93b6182 | 82,481 | 43,845 |
| 仅 quote 列表 | 82,405 | 43,764 |
| quote + ruleRow | 82,346 | 43,706 |
| 仅 cache/security 复用（对原父提交） | 82,433 | 43,846 |
| 本轮全部 | **82,286** | **43,702** |

全部重复一致，仍为 16 chunks，模块分组与静态/动态依赖及 cold/lazy 角色不变。组合相对父提交 raw **243,481→242,075（−1,406）**、all **−195 B**、cold **−143 B**。单项收益不可相加；cache/security 在当前组合中的实际边际为 all −60 / cold −4，而非其隔离测量 −48 / +1。未采用扩大 lazy 下载范围、属性混淆、去除校验、依赖/配置/预算变化。worker bool、remote-schema 位置参数和其他未落地微候选不算已实现收益。

### 本地完整门禁和证据范围

840 tests / 837 pass / 0 fail / 3 Windows symlink 条件 skip；syntax **183**；official registry audit **0**；自有 port 12437 的合成桌面 E2E **23/23（38.5 秒）**，服务已退出。E2E 内 3 个性能样本只为其既有绝对阈值/描述性观察，不是新的 v15 配对时延结论；没有把它们与旧协议混样。

E2E 退出后连续两次 build 的 SOURCE_DATE_EPOCH 为父提交 **1791000968**，关键发布集指纹均 **`fdd0196ac0528bece5e10f67693c5af5fb3953ad65a4fad8978fd78916c1a489`**。这是待提交业务改写的本地构建，不是新提交的 CI/生产指纹。官方 app/OCR 实际 bytes/SHA 校验通过（16 chunks / 242,075 B，23 OCR assets / 88,196,906 B），未执行 OCR。4 个业务文件的按报告指定顺序、path+NUL+LF-source+NUL SHA256 为 `4783f00de7559f2452c33536786d03d2bafd81ad978a92caf63ba1cf67d6463a`。

实际预算 CLI cold **43,702 / 52,241 PASS**、all **82,286 / 77,227.7 FAIL**、exit **1**；至少还需 **5,059 B**。原始 60/200/probe/v2-200 报告 LF SHA 未变，旧 v2 PASS 仅是其实际采样版本证据；本次源码变化后的 paired latency 为 NOT_RUN。仍为 M3 IN PROGRESS，版本 15.0.2，未进入 M4/M5/M6、未 merge/deploy/bump。

### 当前只读现场检查的限制

另外固定读取 005844 / 012920 的公开 Worker 响应 5 次，HTTP 均 200，但 `fetched_at` 比本机响应处理时钟超前 **2,428 / 2,295 / 2,165 / 2,034 / 1,903 ms**，现有严格解析均返回 `WORKER_METADATA_INVALID`，故本批实际数据等价抽查记 **NOT_VERIFIED**，不把 HTTP 200 当行情可信。没有改系统时钟、放宽 future guard、修改外部 Worker 或生产设置。这是本机与这批响应的现场时钟差观察，不能据此断言所有浏览器/生产环境均失败；后续数据/发布门禁需单独核对生产时钟和来源，不能挑后来成功请求替代这 5 个失败观察。

父检查点 93b6182 的 [CI 37095982665](https://github.com/AureliusWu/FundVal/actions/runs/37095982665) 已 completed / failure；candidate 仅最后实际 all-gzip 门禁失败，audit/test/check/build/E2E/资源核验/seal/upload 步骤成功，codeql workflow 作业 SUCCESS。该远端结果只绑定父提交，不继承给本轮业务改写。

## 21. 私有参数和 latestSource 去重：保留旧信任边界

本轮父检查点为 **f625062afcab1e88ccb54d50d558d59d96a99542**，版本仍为 15.0.2。证据：[m3-private-compaction-20261003.json](performance-evidence/m3-private-compaction-20261003.json)。采用性能检查、数据可靠性检查和发布检查流程，区分实际源码、待提交本地构建、远端 CI、只读诊断与发布；没有修改原预算或提前进入 M4。

### 实际变更与先红后绿

- `js/runtime/worker-contract.js`：私有 `chooseNumber` 的两个固定 scalar option 改位置参数，函数内复用由不可变 `valueKind` 得出的 `official`。不删除或合并别名、日期、来源、coverage、accounting 和 reason 校验；对外字段和错误不变。
- `js/runtime/remote-schema.js`：私有 `finiteNumber` 的三个固定 scalar option 改位置参数。metadata 最终保留旧 `Object.freeze` 字面量，不采用表驱动动态属性赋值。
- `js/overseas-model.js`：`calculateOverseasEstimate` 的内部最新行情时间由 push + sort 改单遍选择；严格 `>` 保持并列时第一项。未改权重、费用、基期/目标日期、36h、季度、future/stale 或输出降级规则。

新增 **10 个**永久表征测试：`test/wire-compaction-characterization-v16.test.js` 的 8 个和 `test/overseas-model.test.js` 的 2 个。旧 f625062 两模块/私有片段在内存中运行最终新 wire 8/8；旧海外模块运行包含新测试的 11/11；均未回滚磁盘业务文件。最终 root 相关测试 63/63，独立审查 76/76；另有 1,530 个公开 Worker、308 个公开 Bridge、4,059 个海外组合对照。新私有测试覆盖 1,784 个 alias 案例、8,826 个逐步异常、170 个 meta 案例、763 个逐步异常、重复 getter 和 186 个 finite-number 配置值。

调查中不采用的 metadata `meta[key] = value` 表格虽然测到小收益，但独立审查发现它会触发继承 setter，旧字面量不会。新公开 API 回归测试在该候选上真实 RED（两安装时机均丢 5 个 own 字段、调用 setter 5 次），在旧源和最终保留 literal 的代码上 GREEN（6 own 字段、0 setter）。没有发布该候选，也不把它说成原生产 Bug。测试自身共享 VM 全局造成的 2 项失败亦保留说明；最终用独立 context 修正后重跑旧/新实现，不绕过断言。

### 固定构建和本地门禁

按现有 Vite 8.2.2 / oxc / es2022 / 原分组，基准和最终源各 `write:false` **3 次**：

| 指标 | f625062 | 最终本地源码 | 变化 |
| --- | ---: | ---: | ---: |
| 非 OCR raw JS | 242,075 | 241,635 | −440 B |
| all gzip | 82,286 | **82,202** | **−84 B** |
| cold gzip | 43,702 | **43,699** | −3 B |
| chunks | 16 | 16 | 不变 |

完整 normalized module/static/dynamic/cold 角色图一致，hash `732c1409f7cca62d3711143a8bdbc77c9977d910b2ffe8173eba06d8d7ff1495`。没有属性混淆、外移数据逃离 JS 预算、合并 cloud/diagnostics 到首个业务请求、配置/依赖变化或删校验。较大的 cache/payload、云同步和 app UI 去重多数增加实际 gzip，未落地；已经天然压缩的重复模板不能凭 raw 行数宣称收益。

本地全量：**850 tests / 847 pass / 0 fail / 3 Windows symlink 条件 skip**；syntax **184**；官方注册表 audit **0**；自有 12437 port 合成桌面 E2E **23/23（40.7 秒）**，监听服务已退出。3 个 readiness 样本完整保留，仅为绝对阈值/描述性观察；不能与历史配对样本拼接，也不能据此宣称新源码的相对时延 PASS。

E2E 后两次实际构建，父提交 SOURCE_DATE_EPOCH **1791002003**，关键发布集指纹均 `12fb81227fb07404304e0a7d85866d954f610bb7e59be765c02c6a8ef1cb748f`。app/OCR bytes + SHA 实核通过：16 app chunks / 241,635 B，23 OCR assets / 88,196,906 B；未执行 OCR。该指纹绑定待提交本地源码，不是下一提交、CI 或生产产物。3 文件的 path+NUL+LF-source+NUL SHA256 为 `409b8a54852c058bb9221d9081836065f44394bb953742013d7725e2fea711d6`。

预算 CLI cold **43,699 / 52,241 PASS**、all **82,202 / 77,227.7 FAIL**、exit **1**，至少仍需 **4,975 B**。所有历史 raw report LF SHA 未变；最新源码的 paired latency 为 **NOT_RUN**。原 200 配对报告不能继承到本次改动。M3 **不能 EXIT**，未开始 M4/M5/M6、未 merge/deploy/bump。

### 公开数据与本机时钟：只读诊断，不是摄取通过

预声明并保留 5 次公开 005844 / 012920 顺序 GET；20s 诊断 timeout（不是应用默认 10s transport），每次按 JSON 完成的真实本机 `Date.now()` 调用现有严格 parser。HTTP 全 200，但完整 envelope **0/5**，`fetched_at` 超前 **2,485 / 2,379 / 2,279 / 2,178 / 2,079 ms**，均 `WORKER_METADATA_INVALID`。5 次数据只绑定采样时的 discarded-table 库存，不冒绑定最终整应用；Worker 模块 LF hash 与最终相同。这不追认第 20 节失败为 PASS，也不排除所有失败后挑一次成功。

独立公开东方财富 NAV 首次严格文本提取失败保持 NOT_VERIFIED。单独新增一次只读诊断，以本地静态 AST 定位 initializer + JSON.parse、**不执行第三方 JS**，核对 005844 **2026-09-30 / 3.1282** 和基准 **2026-09-29 / 3.2259** 与 5 个 Worker 诊断行四字段精确相同：仅 **MATCH_DIAGNOSTIC_ONLY**，不能救回失败 envelope 或冒充页面摄取。未核对 012920 的独立源，不泛化两基金均验证。

只读 `w32tm /query /status` 显示 Leap 3 未同步、Stratum 0、Local CMOS Clock、无上次成功同步；本机授时未同步已确认，准确偏差及服务端责任仍待确认。独立 NAV HTTP Date 可能被缓存，不能拿它直接校时。没有调整系统/服务/时钟、放宽 future 校验、修改 Worker 或生产配置。该本机探针存在 **P1 主源可用性**问题，而非已证明错误金融数据作为实时展示；数据结论 **CONDITIONALLY TRUSTED**，生产 UI/设备接受和完整主源摄取仍未验证。

## 22. 窄运行入口和闭合私有状态的死代码裁剪

父检查点为 **54fc3a0f52ea20ec20e3a21407835128c78237c3**。其 [CI 37098377118](https://github.com/AureliusWu/FundVal/actions/runs/37098377118) 已 completed / failure：仅实际 all-gzip 门禁失败；Linux unit 850/850、syntax 184、audit 0、E2E 23/23（35.3 秒）、build/资源核验/seal/upload 通过。CodeQL workflow job success，analysis 1885026688 同 SHA、results 3、error/warning 空；不是零告警或生产证据，也不继承到本轮源码。

本轮采用性能回归、数据可靠性和发布检查流程，实际读取 rendered 模块而非按源码行数猜收益。证据：[m3-runtime-surface-20261003.json](performance-evidence/m3-runtime-surface-20261003.json)。

- 新增 `js/storage/cloud-runtime.js`、`gist-runtime.js`、`startup-repository.js` 和 `js/startup-migrations.js` 四个纯 re-export 入口。12 个导出与原函数 `Object.is` 相同；原 cloud/Gist/repository/migrations API 保留。只改变 app/bootstrap 的动态 import 目标，不改变 Promise 缓存、失败缓存、catch/retry、迁移顺序或原静态消费者。cloud archive 所需的 4 个辅助导出没有遗漏。
- 原源码 SW CORE 加入四入口；正式 build 仍由生成 chunk 图替换 CORE，未把 OCR 加入首屏或 CORE。未修改构建配置、依赖、预算或原模块实现。
- `js/app.js` 私有 `sortBy` 经 AST 和实际 UI 路由证实只有 desc/asc 两个估值涨跌状态。移除 8 个无入口、无赋值路径的历史金额排序 case；quality、period、两个可达分支和 default 不变。这不是删除已提供的金额排序功能；未来新增模式必须同时更新闭合状态测试。

新增 **12 项**长期测试：facade 8 项、sort 4 项。排序先在保留旧 10 case 的实际源码上 root/子代理分别 4/4 GREEN，再裁剪并重跑；独立旧 reference 与两个可达模式做 **4,920 对**结果/getter/coercion/异常/null/±0 对照。facade 测试检查精确 API、fulfilled/rejected 同 Promise 不重试、独立旧 bootstrap 的 15 个 phase 场景，以及调用真实 `withHoldingsLock`、只注入内存 locks 的 7 个错误转换场景。它们是合成验证，不是物理设备/Web Locks 验收；无真实 storage/Gist 写入。独立审查的 88 项组和最终 21 项真实包装器组分别通过（有重叠，不相加）。

### 固定计量与完整本地门禁

| 变体（各 3 次一致） | raw JS B | all gzip B | cold gzip B |
| --- | ---: | ---: | ---: |
| immutable 54fc3a0 | 241,635 | 82,202 | 43,699 |
| 仅 4 facade | 240,852 | 81,889 | 43,634 |
| facade + 私有死 case 裁剪 | **240,235** | **81,735** | **43,486** |

固定 Vite 8.2.2/oxc/es2022/原 grouping，仍 16 chunks；组合 raw −1,400 B、all −467 B、cold −213 B。完整图 hash 从 `732c1409...` 变为 `2a744874...`，这是四个 0 renderedLength facade 和动态 stub 名称的有意变化，**不声称图完全相同**。剔除 facade 后，原 cold/before-app/business/all 模块集合及阶段归属不变；首个业务闭包 module SHA 为 `09a602b8...`，无 cloud/diagnostics/OCR，实际 build 启动隔离通过。

共享 legacy Intl/date 大块会重新引入已 tree-shaken 兼容路径；描述元组/时间 helper 多数增大 gzip，均未采用。通用 coordinator 未用附加 API 的仅诊断删除下界也只省 443 B，没有删除 API 或引入会改变原型布局的 core/subclass。没有以弱化校验、外移数据、改协议或改预算换取 PASS。

完整本地 **862 tests / 859 pass / 0 fail / 3 Windows symlink 条件 skip**；syntax **190**；官方注册表 audit **0**；自有 port 12437 的合成桌面 E2E **23/23（42.5 秒）**，服务确认退出。3 个 readiness 样本均保留，仅为既有绝对门限/描述性检查，不是新的配对时延结论。

E2E 后两轮实际 build 同父 epoch **1791003593**，关键发布集指纹均 **`f24892449259f77cb34f926091144aead9c4297ef89ebcb1373c69e5e3803777`**；app 16 chunks / 240,235 B、OCR 23 assets / 88,196,906 B bytes/SHA 核验通过，未执行 OCR。此指纹绑定待提交本地源码，不是新提交/CI/生产指纹。7 个变更运行源的 path+NUL+LF-source+NUL hash 为 `1f13cf3b13acec2dda2a668bdb1b4d67722d509848ad00615b769af9ba285aca`。

预算 CLI cold **43,486 / 52,241 PASS**、all **81,735 / 77,227.7 FAIL**、exit **1**，尚差至少 **4,508 B**。四份历史 raw LF hash 未变；新源码 paired latency **NOT_RUN**，也未重新探测/追认此前本机授时失败。仍为 M3 **IN PROGRESS**、版本 15.0.2；没有跳过到 M4/M5/M6、没有 merge/deploy/bump。

## 23. 固定内部刷新入口：保留公开 API 的实际减包（2026-10-11）

证据：[m3-private-runtime-20261011.json](performance-evidence/m3-private-runtime-20261011.json)。本节绑定父检查点 **c303c7a5a75ee4a388886e7a2bc7af5f60da4d28** 上的待提交源码，不继承历史 CI 或 paired latency。

### 实现与兼容边界

- 新 `js/runtime/refresh-runtime.js` 仅供 app 与重仓详情两个已闭合的生产消费者。原 `refresh-coordinator.js` 未改，generic `runFund` / `commitPartial`、自定义 descriptor / policy 等公开接口全部保留；不是把新增内部 constructor 当作通用 drop-in 替换。
- 8 个固定源声明在模块初始化时调用既有完整 `freezeDescriptor`；不是绕过校验。新 `createBuiltinSourceRegistry` 仅接受严格 boolean，选择固定源或空 registry，并独立复制/冻结每实例 descriptor、数组、health 和 policy。原 registry 43 个函数逐字未改。
- 新运行入口除明确白名单外，整程序 AST 与原类一致；只窄化 factory seam、两个未使用 class method 和两个 context member。app/detail import 和固定 true 选择相应改变；Promise、微任务、取消、代际提交、breaker、诊断与异常顺序不变。
- 标准 intrinsics 与私有已验证字面量是本次边界；主动篡改同 realm `Array.prototype.map` / iterator 的敌对环境并非完全等价，不作该承诺。闭合调用 AST 检查也不是任意未来 alias/反射的全程序证明；新增消费者必须先扩充契约。
- SW 原源码 CORE 增加内部模块，正式构建仍按实际 chunks 生成 CORE。构建配置、分组、依赖和预算未改；无 cloud/diagnostics/OCR 提前加载。

### 固定计量与测试

| 变体（两侧各 3 次一致） | chunks | raw JS B | all gzip B | cold gzip B |
| --- | ---: | ---: | ---: | ---: |
| immutable c303c7a | 16 | 240,235 | 81,735 | 43,486 |
| 完整验证 + 固定内部入口 | 16 | **237,853** | **81,195** | **42,944** |
| 实际差值 | 0 | −2,382 | **−540** | **−542** |

固定 Vite 8.2.2 / oxc / es2022 / 原 chunk groups、write:false。图 hash `2a744874...` → `4e3c2a7c...`，不声称图完全相同：bootstrap 9 / before-app 11 模块完全不变；cold 30 / business 48 / all 59 仅原 coordinator 替换成内部 runtime。实际构建的启动隔离检查通过。无完整声明验证的负控、仅少量收益但迭代观察不等价的深冻结候选未采用。

新增 **30 项**长期测试：先在原实际类与旧 integration 上跑 14/14，再引入真实 runtime；最终新文件 30/30、root 相关组 72/72、子代理扩展组 119/119（有重叠，不相加）。11 个字面量行为场景分别执行两套真实类；覆盖整程序 AST 白名单及 3 个负控、固定消费者、独立旧 8 源 JSON/key 顺序、冻结和引用隔离、严格 boolean、真实 scope/detail wrapper、公开 generic API 保留。最终独立只读复核无阻断项。

全量本地 **892 tests / 889 pass / 0 fail / 3 Windows symlink 条件 skip**，syntax **192**，合成桌面 E2E **23/23（47.2 秒）**，自有 12437 服务已退出。3 个 readiness 样本完整保留，仅为既有绝对阈值/描述性观察，不是新 paired 结论。E2E 后连续两次 build，同父 SOURCE_DATE_EPOCH **1791004826**，关键发布集指纹均 **`0accb71ddedabda3f6ec8d379871b423efd04448967b60ad558f4777f7d13d5f`**；官方实核 app 16 chunks / 237,853 B、OCR 23 assets / 88,196,906 B，未执行 OCR。首次 OCR 核验误传 site 根目录，纠正为 site/assets/ocr 后两轮资产核验通过；不是构建或资产内容失败。

官方 `npm audit --audit-level=high` 本轮 **FAIL / exit 1**：锁定 `vite@8.2.2 → postcss@8.5.26 → source-map-js@1.2.1` 新检出 **GHSA-68fv-2mgg-jv7q** 高危公告。不能把 10-03 的 audit 0 当作 10-11 的结果。安全修复作为独立依赖补丁，不能混入上述固定依赖减包比较；本节未修改依赖。

预算 CLI cold **42,944 / 52,241 PASS**、all **81,195 / 77,227.7 FAIL**、exit **1**，尚差至少 **3,968 B**。四份历史 LF raw hash freshly rechecked 未变；当前 paired latency / 新公开数据探测 **NOT_RUN**，不追认旧时钟偏差失败。M3 **IN PROGRESS**，版本仍 15.0.2；未进入 M4/M5/M6、未 merge/deploy/bump。

### 父检查点实际 CI / 下载产物复核（不继承至新源码）

精确 c303 的 [CI 37099521564](https://github.com/AureliusWu/FundVal/actions/runs/37099521564) completed / failure，只在最后 all-gzip 81,735 门禁失败。Linux unit 862/862、syntax 190、E2E 23/23（42.1 秒）、当时 audit 0、build/资源核验/seal/upload 成功。CodeQL workflow job success；同 SHA analysis 1885066007、results **3**，不是零告警。

本轮实际下载 artifact **11265368334** 后，独立按真实 tar bytes 核验路径/类型/header/inventory 和逐文件大小/SHA：125 文件、92,489,751 B；archive SHA `72d0d9c2...`、site inventory `f5274843...`，16 app chunks 的实际 gzip / SHA 全部匹配，23 OCR assets 的 bytes / SHA 全匹配，未解包执行代码或运行 OCR。关键发布集实算 `c88147c0...` 与 manifest 声明匹配；与父提交本地 raw 指纹 `b91b033a...` 不相等，差异仅 index.html / manifest.json / sw.js 的 CRLF，LF 归一后相同，另外 13 个关键文件 raw 相同。

原 candidate verifier 对这个继续开发分支的 review 包仍 **exit 1 / Candidate provenance or manifest is invalid**，未创建提取目标；不修改 manifest 绕过 main-only admission，红预算也是独立阻断。这是父候选字节完整性证据，不是发布准入、生产或新源码 CI。

第 23 节已提交推送为 **411f49dd3385c0a466fd7b92b3a72abdee8f41f2**。提交后两次 build，同本提交 epoch **1791689435**，关键发布集指纹均 **`fc15bbea5b692a9c52aa99e4c2d01d407e0f238dd61607b27b26c4b90a5aba64`**；16 app chunks / 237,853 B 与 23 OCR assets / 88,196,906 B 实核通过。其 [CI 38108623940](https://github.com/AureliusWu/FundVal/actions/runs/38108623940) 实际 completed / failure，candidate 在 **Audit dependencies** 因上述新公告失败；远端 test/check/build/E2E/seal/upload/budget 全部 **SKIPPED**，不能把本地通过冒充新 CI 通过。codeql workflow job success，同 SHA analysis 1930472038、results 3、error/warning 空，不是零告警。

## 24. 独立 source-map-js 高危安全补丁（2026-10-11）

证据：[m3-source-map-security-20261011.json](performance-evidence/m3-source-map-security-20261011.json)。按升级方案第 12 节隔离到 `codex/v16.0.0-source-map-js-security`，基点 411f49d，PR 目标仅为继续开发分支，不是 main。

实际仅更新 package-lock.json 中 `source-map-js` 的 version / resolved / integrity 三字段：**1.2.1 → 1.2.2**。109 个锁文件 entry 的 inventory 和其他全部 entry 不变；满足现有 PostCSS `^1.2.1`，无需升 Vite/PostCSS、添加 overrides 或修改 package.json。原 5 项安装脚本 allowlist 不变；官方 npm 冻结 `ci --ignore-scripts`、再次 policy 核验，仅执行既有 esbuild installer。

[官方 GHSA](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) / [上游修复 PR](https://github.com/7rulnik/source-map-js/pull/79) 指向恶意 indexed source map 的同步资源耗尽；修复版本为 1.2.2。实际链均为 dev：Vite 8.2.2 → PostCSS 8.5.26 → source-map-js。未发现持仓、行情或 OCR 图片输入到该解析器的生产路径，build-site CSS 直接复制、OCR esbuild sourcemap:false；但不以生产 omit-dev 0 为由豁免全量审计。

补丁后全量 **892 tests / 889 pass / 0 fail / 3 Windows 条件 skip**，syntax **192**，官方 audit **0 vulnerabilities / exit 0**；桌面合成 E2E **23/23（54.4 秒）**，自有 12437 服务退出。3 个绝对 readiness 样本完整保留，不形成 paired latency 结论。E2E 后两次同父 411 epoch **1791689435** build，关键发布集均为上述 **fc15bbea...**，与补丁前同 epoch 完全一致；app/OCR bytes/SHA 全核验通过，未执行 OCR。原 5 个运行源码绑定 hash 未变；不声称未来 patch SHA / Linux raw 指纹或整个 site inventory 与该本地值相同。

实际预算仍 cold **42,944 PASS**、all **81,195 FAIL / exit 1**；补丁没有以依赖升级改善或隐藏包体积。回滚点为 411f49d，若需回滚只 revert 独立补丁提交；回退会重新引入已知漏洞，不能成为可发布状态。当前安全 PR 尚待精确提交 CI / 集成；M3 仍未退出，不进入 M4，不 merge main / deploy / bump。

独立实际 API 有界探针 **exit 0**（64 MiB child heap、5 秒 timeout，实际 9.922 ms）：合法双 section 查询/遍历/flatten/basic roundtrip/SourceNode、4 层 2 叶、小 gap 与短 code 路径通过；21 个非法/越界/累计越界/乱序场景拒绝，非法和单上限在读取 map getter 前拒绝。首次使用 `SourceMapGenerator.fromSourceMap(indexed consumer)` 因 undefined sourceRoot 出现 TypeError；上游 tag diff 证实该便捷方法/constructor 未改，是原有限制，不混同补丁回归。没有执行旧版本资源耗尽 payload；此探针未新增永久项目测试。

### 安全 PR 的实际集成与精确 CI（上述“待 PR”是实现时历史状态）

证据：[m3-security-integration-20261011.json](performance-evidence/m3-security-integration-20261011.json)。[PR #17](https://github.com/AureliusWu/FundVal/pull/17) 的安全提交为 **f6265dac0d63bdbbffa5f1726f95a852b9bdc32d**；[CI 38108937985](https://github.com/AureliusWu/FundVal/actions/runs/38108937985) 实际 completed / failure，仅最后预算步骤失败。Linux **892/892、0 skip/fail**、syntax **192**、audit **0**、E2E **23/23（39.5 秒）**、build/app/OCR/封包上传全部成功。CodeQL workflow 与该 PR 独立 CodeQL check success，同 SHA analysis 1930483304、results 3，不是零告警。

经独立只读审查与精确 head CAS，使用普通 PR merge（无 admin/bypass、未删除分支），仅合入 `codex/v16.0.0-m3-continuation`，得到 **501a4eb5af9ebd46659158c5a20f85abd73c7472**。合并 commit 与 f6265da 的 Git tree 精确相同（`d5a96495...`），不是绕过红线发布；部署仍仅允许指定 successful main-push 候选。main 保持 **abfb6313f12efb66b9096b60472b6dd457094485**。

新合并 SHA 的 [CI 38109110899](https://github.com/AureliusWu/FundVal/actions/runs/38109110899) 亦实际 completed / failure，独立复核日志为 **Linux 892/892、syntax 192、audit 0、E2E 23/23（35.7 秒）**、build/app/OCR/封包上传成功；唯一失败是 **all 81,195 > 77,227.7**，cold 42,944 PASS。codeql workflow success，同 SHA analysis 1930488134、results 3；commit check-runs 只观察到 candidate/codeql，不继承 PR 的独立 CodeQL check。没有把前一个 SHA 的日志当作新合并验证。

合并后两次本地 build 同 epoch **1791689991**，关键发布集指纹均 **`f68fe3bce16d7266eea51edd155740c5745335dcbeeed0389564cc83103e1d28`**，app/OCR 实核通过，budget CLI exit 1。它不是 Linux raw/生产指纹；远端上传包未另行下载实核，不声称新包获得发布准入。后续仅文档提交不继承此 CI。安全补丁已集成，剩余包体积与新源码配对时延等 M3 门禁继续推进；版本仍 15.0.2 / NOT RELEASED。

## 25. 聚合缓存基金身份隔离：P1 先红后绿（2026-10-11）

证据：[m3-cache-identity-20261011.json](performance-evidence/m3-cache-identity-20261011.json)。本轮父检查点为 **414958bbcbf75a87fa9fc97837cadc803abc9944**，业务改动只有 `js/app.js` 的 9 行增加 / 3 行删除；版本仍 15.0.2，没有修改预算、依赖、配置或公开校验器。

### 根因与实际修复

`loadCache` / 启动 reconciliation 检查了聚合行外层 code、持仓集合与时间，但旧 `tryShowCache` 未要求内层 `quote` / `source_quote` 的 fundCode 与该行相同。异常 JSON 缓存因此可能把另一基金 NAV、涨跌和旧金融说明用于当前持仓金额。这里是合成持久化缓存可复现的 **P1 金融身份错误**，不是声称已在用户真实持仓中观察到该事故。

- 同时核对两个存在的 quote 身份；不同、缺失或类型不符均不借用其数值。即使主 quote 正确、内层 source_quote 错误也隔离。
- 坏行只重建 `code + 当前持仓名称`，随后构造 unavailable Quote；整行金融/模型/legacy/secondary 字段丢弃，不依靠容易漏掉未来字段的 blacklist，不保留旧基准或错误净值说明。
- 只有内存 map 的当前行替换；原 cache、Schema 3 和当前持仓均不修改，不自动修复持久化数据或续期。其他合法行继续显示，正常网络获取可按原刷新链更新。
- matching canonical cache 与没有两个 quote 的 raw legacy 行保持原适配链；当前份额/成本、null 和真实 0 保持。公开 Quote/Worker/HTTP 校验器、原 coordinator、Bridge、迁移与时间策略未改。
- 等价性限定于 `loadCache` 读出的真实 native JSON；前移 holding lookup 和新增 guard 可能调整敌对 getter/Proxy 的读取轨迹，不宣称整个私有函数在任意可执行对象上等价。

### 真正 RED → GREEN 与独立审查

新增 `test/cache-fund-identity-v16.test.js` 23 项：通过 AST 执行实际 `tryShowCache`，使用真实 normalizer、身份分类、金额与时间算法。旧源 **6 个合法控制 PASS / 17 个异常 FAIL**；修复后 **23/23 GREEN**。包含两个嵌套身份、5 种不合法身份、混合好坏行、金融残留字段、零份额和 null 成本，且输入不被 mutation。

新增 `e2e/v16-cache-identity.spec.js` 4 项，真实 bootstrap / renderer / opaque Bridge，固定合成时钟及 Schema 3，所有外源阻断、本地代理 503。旧实际构建的 3 个坏例 **RED（999.1234 而非 --）**、1 个合法控制 **GREEN**，总 33.9 秒 / exit 1；原失败诊断在仓库外保留，没有把失败 trace 当原始截图提交。修复后 4 项均通过：坏行主值/基准/涨跌/展开金额均 --，错误说明不残留；另两行仍为 2.2000；匹配及 raw legacy 控制行显示基于当前份额成本的 +7.00。坏例 cache / Schema 3 原字节不变，无外部非 GET/HEAD 请求。

另新增 `test/estimate-http-characterization-v16.test.js` **28 项**，旧实际 HTTP 源和最终源均 GREEN；HTTP 业务没有改动。完整 literal row / quote、字段及 JSON 顺序、冻结/引用、official interval、null/NaN/0、模型/QDII、错误/超时/取消/late fetch、getter 与变化时钟负控均保留。root 最终相关组 **51/51**。独立只读审查分别 23/23、相关 cache/amount/edge 63/63，另 20 组合法 native JSON 新旧全输出 / Date 轨迹一致、51 个任意未来字段被坏行隔离；这些组有重叠，不相加。未发现阻断项。

### 不采用的减包试验

- quote-first HTTP 不能消除仍服务旧聚合缓存的 generic normalizer；wire 与 cache alias/信任边界不能合并为宽松 validator。
- 私有 HTTP helper 的父 414 固定三轮虚拟比较 all 81,195→81,067（−128 B）、cold −3 B，但真实 Date 负控改变第二次验证：旧路径安全 resolve unavailable/error，候选 reject `WORKER_ROW_INVALID`。已否决，未改业务；最初 Windows 路径探针没有应用替换，排除不算收益。
- 固定私有 health 路径三轮仅 all −57 B / cold −59 B，外部 registry/getter/error 等价与双维护风险未证明，未采用。UI 已压缩模板仅有 raw 重复不代表包 gzip 收益，没有本轮新实测或声称可省 1 KB。

### 全量本地门禁与实际产物

全量 **943 tests / 940 pass / 0 fail / 3 Windows symlink 条件 skip（6,181.0861 ms）**；syntax **195**；官方 npm registry audit **0**；自有 12437 的合成桌面 E2E **27/27（48.1 秒）**，监听服务已退出。3 个 readiness 样本完整保留在报告，只是当前绝对交互阈值 / 描述性结果，不是新 paired latency 或真机验收。

E2E 结束后两次连续实际 build，同父 epoch **1791690151**，关键发布集指纹均 **`e7f2f6483d640fb64e1e4282f78e45bc9ea9844cf380f8eb9acd8ef3104f249c`**。官方脚本两轮均按 bytes / SHA 实核 app **16 chunks / 238,020 B**、OCR **23 assets / 88,196,906 B**，未运行 OCR；启动/按需隔离 gate 通过。固定 Vite 8.2.2 / oxc / es2022 / 原分组，相对父 414 raw +167 B / all +68 B / cold +71 B，这是正确性成本，不是减包成果。指纹只绑定待提交本地源码与该 epoch，不冒充未来 commit、Linux raw、whole-site inventory 或生产。

实际预算 CLI **cold 43,015 / 52,241 PASS，all 81,263 / 77,227.7 FAIL / exit 1**，至少仍需减 **4,036 B**。四份历史 raw 报告 LF SHA freshly rechecked 不变，原 public coordinator LF SHA 亦未变。当前源码 paired latency、公开主源完整摄取、手机真机和生产验收均 **NOT_RUN**；不把旧配对 PASS 或此前本机时钟探针失败重新归类。M3 **IN PROGRESS**，没有进入 M4/M5/M6，没有 merge main / deploy / bump。

### 父 414 的精确 CI，不继承至本轮源码

本轮实际读取父 **414958b** 的 [CI 38109263679](https://github.com/AureliusWu/FundVal/actions/runs/38109263679)：completed / failure，唯一失败仍旧 all 81,195 预算；Linux **892/892、0 skip/fail**、syntax **192**、audit **0**、E2E **23/23（42.6 秒）**、build/app/OCR/seal/upload 全成功。CodeQL workflow success，同 SHA analysis **1930493220** / results **3**；commit checks 未观察到独立 CodeQL check，不说零告警。review artifact **11691287219** 仅记录日志声明的清单/上传 digest，本轮没有下载独立核验，不声称其获得 main-only 发布准入。main live ref 保持 **abfb6313f12efb66b9096b60472b6dd457094485**，此父 CI 不代替新源码/新提交验证。

### 修复提交已推送；新 SHA 独立 CI 已实核

上述修复和测试已提交并推送为 **fa4922411db5139ebf0cfa0bfce66b06773dbdb8**，业务及新测试的 LF bytes 与该 Git blob 精确相同。补充证据：[m3-cache-identity-ci-20261011.json](performance-evidence/m3-cache-identity-ci-20261011.json)。提交后同新 epoch **1791691567** 两轮实际 build，关键发布集均 **`36c5c89f6cc8021c08c54ec40b663b7ab3c428690941483c8df89a421bffdf6a`**；app/OCR bytes/SHA 实核通过。该本地指纹不当作远端/Linux raw 或完整 site 清单。

新 [CI 38110531850](https://github.com/AureliusWu/FundVal/actions/runs/38110531850) 实际 completed / failure，**唯一失败**为最后 all **81,263 > 77,227.7**；精确日志是 **Linux 943/943、0 skip/fail（5,713.660194 ms）**、syntax **195**、audit **0**、E2E **27/27（46.2 秒）**，build/app/OCR/seal/upload 均成功。CodeQL workflow success，同 SHA analysis **1930537778**、results **3**、error/warning 空；commit checks 仅 candidate/codeql，未观察到独立 check，不称零告警。

review artifact **11691194411** 上传 ZIP **92,623,258 B** / digest `cd4405ffcf368c857e51018aeb0d828a375d56a0c627bb05e164a8fa9b2bd156`，日志声明 126 site files / inventory `2b8e681d...`；本轮没有下载独立核验。红预算和 continuation ref 均仍阻止 production admission。main 未动、版本仍 15.0.2、M3 未退出；后续文档提交不继承这次精确源 SHA 的 CI，下一轮改源码还需重新门禁。

## 26. 私有持仓指纹裁剪与 OCR 构建单次读取（2026-10-11）

证据：[m3-private-hash-build-read-20261011.json](performance-evidence/m3-private-hash-build-read-20261011.json)。父检查点 **2f7e77f21c55b73508503a07c0aa859183aedcb5**。仅修改 app 的私有指纹函数与 build-paddle-ocr 的 emitted Worker 读取；没有改配置、依赖、预算、分组、公开校验器、SW 或版本。

### 已采用的改动与边界

- `holdingsHash(h)` 的 4 个私有调用均传 `holdings`；当前所有直接状态写入只有初始化、load/install。无文档时是 null + []，有文档时走原 canonical V3 全语义序列化。因此移除不可达 generic legacy 分支，保留函数名、单参数和调用表达式。名称、null/0、note、revision、device、tombstone、UTF-8 字段顺序、合法空文档及失败 reload 均保持；不是公开任意输入 serializer 或通用 JS 别名证明。
- emitted Worker 不再 `access → readFile`：私有 helper 单次读 Buffer，用原 10 MB 下限及 3 个协议标记检查同一 Buffer，再用于 workerBytes。5 个缺失/权限类 code 保持原 missing 字符串、plain Error / 无 cause；其他错误包括 EISDIR/EIO/EMFILE 保持原对象。错误触发点改变为 read，不宣称所有文件系统错误轨迹等价。符合 [Node 原生 I/O 指南](https://nodejs.org/download/release/v24.14.0/docs/api/fs.html#fspromisesaccesspath-mode)，仅消除该冗余预检查窗口，不保证全部文件替换/TOCTOU 风险消失；manifest 仍按路径重读。

新增 private-hash 测试旧实际源 **9/9 PASS**，覆盖真实仓储/WebLock 的成功、初始、阻断、损坏 reload、完整 canonical 字节和 72 组 native 状态矩阵。新增 Worker-read 测试旧实际源 **13 PASS / 1 RED**（唯一 RED 为仍调用 access），新源 **14/14 GREEN**；体积及三个 marker 校验块与父源 LF 字节完全相同。root 最终相关组 **25/25**；独立审查存储 45/45、构建 16/16，无阻断，组有重叠不相加。AST 保护当前直接写法，不声称对未来解构、别名或同名 shadow 提供通用证明；fs mock 不是实际 OS ACL/竞态验收。

### 实际全量门禁与性能

**966 tests / 963 pass / 0 fail / 3 Windows symlink 条件 skip（5,655.8974 ms）**；syntax **197**；官方 registry audit **0**。自有 12437 上桌面合成 E2E **27/27（47.7 秒）**，服务已退出。报告完整保留 3 个绝对 readiness/save 样本，不能由此宣称新相对时延通过。

实际 build 共 3 次，E2E 后两次连续 build 同父 epoch **1791691843**，关键发布集均 **`0b2949b3744cd97ae0166866b96331ed0c5cb8dac914d7aaf3fc149991ddc4be`**。实核 app **16 chunks / 237,665 B**、OCR **23 assets / 88,196,906 B** 的 bytes/SHA；未执行 OCR。Vite 8.2.2 / oxc / es2022 / 原组固定；三轮 write:false 亲自运行真实配置的父/候选比较与实际候选产物一致：raw −355 B、all **81,263→81,158（−105 B）**、cold **43,015→42,907（−108 B）**。这个收益小，不夸大为 1 KB；build-only I/O 变更不是 OCR 速度优化。

实际 budget CLI **cold 42,907 / 52,241 PASS、all 81,158 / 77,227.7 FAIL / exit 1**，至少仍需减 **3,931 B**。真实依赖图隔离由 build-site 验证；budget CLI 的 `importClosureVerified:false` 不冒充图证明。上述本地指纹不识别未来提交、Linux raw 或 whole-site inventory。历史四份 raw 报告及 public coordinator 的 LF hash 重新核对不变。

私有 canonical UI/summary formatter 三轮仅 all −72 B / cold −74 B，1,152 组真实 presentation 的 22 own keys 比较相同，但 getter/Date/消费端证明与双维护风险未收敛，**未采用**。没有以删公共 validator 或调分组/预算换取过线。

### 精确父 CI、安全告警与数据探针

父 2f 的 [CI 38110763789](https://github.com/AureliusWu/FundVal/actions/runs/38110763789) 实际 completed / failure，唯一失败是 all 81,263 预算。精确日志为 Linux **943/943、0 skip/fail（6,303.371443 ms）**、syntax195、audit0、E2E27/27（49.8 秒），build/app/OCR/seal/upload 成功。同 SHA CodeQL analysis **1930544520** / results **3**，不是零告警；这次父 CI 不验证当前未提交源码。artifact 11690793455 只记录上传 digest/bytes，未下载独立实核。

本轮实际 GitHub API 已确认 continuation 上三条告警均有 **2f 当前实例**：#3 high 为本次 selected check/use 修复，新 SHA 扫描仍待验证；#7 medium 是 SW 消息无 origin/client/scope 授权，未修改，后续修复不能只检查同源；#5 medium 是网络目录内容落盘，不是上游可控制 pathname，当前精确固定目标检查及 JSON 投影不能消除所有内容污染风险。没有 dismiss、放宽规则或修改远端安全设置。

公开只读 `/estimates` 的固定 5 次 GET 全部保留：直接 Node transport（未启用 env-proxy）均 TypeError，未观察到 HTTP payload。这是本机直接网络探针失败，不能推断生产浏览器或上游必然不可用。应用超时、来源时间 guard、Worker 和系统时钟均未修改；Windows 仍 Leap3 / Stratum0 / Local CMOS Clock。不能把此次失败当作主源完整摄取已验收。

当前 paired 还发现可复现前置阻断：固定 40e 与当前 normalized lock 仅 source-map-js 安全补丁三字段不同，但现采样器严格同依赖 gate 会在 sourceAndDependencyIdentity 拒绝，external 模式同样不能绕过。应先声明并证明仅含安全补丁、原业务不变的不可变本地参考，再运行新独占报告；不能降级依赖、忽略 lock 字段或继承旧 PASS。当前仍 **NOT_RUN / M3 IN PROGRESS / NOT RELEASED**，不进入 M4/M5/M6，不 merge main / deploy / bump。

### 新配对测量的参考身份与预声明

[m3-security-aligned-reference-20261011.json](performance-evidence/m3-security-aligned-reference-20261011.json) 记录本地固定参考 **c2980265d3c89f960517ced1527ba9cb85bf7c2b**，唯一父原40e。164 tree entries仅lock变，另外163全同；109 lock entries仅source-map-js version/resolved/integrity三字段采用已集成的1.2.2安全补丁。原业务和构建代码不变，实际原 `normalizedLock` 与当前一致，仍仅忽略原算法允许的root.engines。独立临时index创建本地Git对象/ref，真实index、当前业务工作树和普通分支均不改变；参考ref不推送。这不是原40e raw构建重跑，也不证明任何新时延PASS。

运行前预声明：现有采样器与v2协议不改，**200 retained / 4 warm-up / bootstrap5000 / seed160003**，独占新输出 `performance-evidence/m3-pair-security-v15-200-20261011.json`。两侧相同依赖、原冷/暖/保存定义、原中位数15%/p95 20%与置信/稳定性政策；保留全部样本、失败不重试、不混入旧报告。预算原锚仍40e的70,207及77,227.7，不由参考补丁重算。先提交当前源码检查点、以该SHA构建后冻结源码/产物再测。此处是预声明，实测结果需另附；真机、真实Gist、公开网络和生产仍不由桌面合成时延证明。

## 27. 精确源码CI与安全对齐参考的200组新配对（实测2026-10-11，复核2026-10-13）

证据：[m3-private-hash-pair-ci-20261011.json](performance-evidence/m3-private-hash-pair-ci-20261011.json)；完整原始数据：[m3-pair-security-v15-200-20261011.json](performance-evidence/m3-pair-security-v15-200-20261011.json)。第26节的NOT_RUN与预声明是当时状态，不是本节之后的当前结论。实施源码已提交并推送为 **06aa5daaf6bfcfe21f8360c5426813f6d43262b9**；复核4个源/测试的LF字节与该Git blob及实施报告一致。后续纯证据文档提交不继承为精确SHA的CI证明。

### 提交后的确定性构建与精确CI

06aa epoch **1791693368** 的两次实际build，关键发布集指纹均 **`b299394a48447ad4232f949cf51a070615a970c8774714bbc0e27ed15147bfca`**；app **16 chunks / 237,665 raw B**，OCR **23 assets / 88,196,906 B**，bytes/SHA核验通过，未执行OCR。cold **42,907 / 52,241 PASS**，all **81,158 / 77,227.7 FAIL**；预算CLI exit1。这个关键文件集指纹与下文完整site inventory是不同算法，不互相替代，也不冒充未来提交或Linux产物。

精确06aa的 [CI 38112117242](https://github.com/AureliusWu/FundVal/actions/runs/38112117242) completed / failure：Linux **966/966、0 skip/fail（6,559.787069 ms）**、syntax **197**、audit **0**、E2E **27/27（48.8秒）**，build/app/OCR/seal/upload全成功；唯一失败步骤为all预算。CodeQL workflow success，同SHA analysis **1930591681** / results **2**、error/warning空，不代表零安全告警。commit check-runs复核只见candidate/codeql，没有独立CodeQL check。

#3 emitted Worker的检查/使用告警在continuation实例为fixed，last finding仍绑定父2f；main实例仍open、绑定abfb，不能宣称整个仓库或生产已修复。continuation的#5目录内容落盘、#7 SW消息授权仍open；未dismiss。review artifact **11691772731** 的ZIP **92,623,258 B** /上传digest `bae55ce0f291a504a9df3a67e327b58eacc0a27a8261eeb081e09716924f8814`仅记录API元数据，未下载独立核验，且红预算/非main ref没有production admission。

### 新采样身份、方法与完整结果

参考为仅安全补丁对齐的v15业务SHA **c2980265d3c89f960517ced1527ba9cb85bf7c2b**，不是原40e raw构建重跑；来源与严格lock相等证明见第26节。固定预算锚仍是原40e的70,207 B，未重新定预算。本轮没有继承d9fdabc的旧PASS。

预声明的 **200 retained +4 warm-up、bootstrap5000、seed160003** 实际一次完成：204组原始pair全部保留，失败0，保留组AB/BA各100；没有剔除outlier、混样、改seed/阈值或失败重试。源码/依赖和两侧产物采样前后不变。独立调用真实`summarizePairs`后全summary deepEqual通过。

| 指标（ms） | 参考中位数 / p95 | 06aa中位数 / p95 | 中位数 / p95变化 | 判定 |
| --- | --- | --- | --- | --- |
| 冷启动 | 141.40 / 183.40 | 133.10 / 169.20 | −5.87% / −7.74% | PASS |
| 暖启动 | 77.00 / 118.10 | 67.75 / 105.90 | −12.01% / −10.33% | INCONCLUSIVE |
| 保存 | 79.71 / 90.89 | 66.82 / 74.39 | −16.17% / −18.15% | PASS；保存p95为附加工具观察 |

暖启动唯一未满足的是当前p95置信区间宽度 **24.457% > 原20%稳定性限制**；当前p95 95% CI **[93.20,119.10] ms**。相对p95 ratio CI **[0.80776,1.02865]**及中位数ratio CI **[0.85256,0.90122]**均满足原回归限制，但尾部稳定性不足，因此总体 **INCONCLUSIVE**，不是PASS，也没有建立置信回归。不能用点估计更快或99.98%的bootstrap pass fraction代替稳定性规则。旧结果保留，不立即重跑直到PASS。

原始文件LF/raw **22,410,202 B**，SHA256 **`5e4199a9268ecb8761dc3f91725daba3f1b63adedd7b86ef2a9b820f940b3ddd`**；开始 **2026-10-11T04:36:33.506Z**，结束 **04:46:03.453Z**。初始PowerShell命令未单独捕获native LASTEXITCODE，终端wrapper观察exit1；采样器实现对INCONCLUSIVE声明exit2。保留二者及边界，以raw结论为准，不重跑替换日志。

### 完整性、观测边界与下一步

- integrity/health/instrumentation/cleanup均PASS，pageerror0、network instrumentation failures0；每侧612 drains全SETTLED，SW event/controller/registrations0。自有2029/2038/12437监听均已退出，未动其他项目4173。
- 独立重算1,224个renderer对象、4,896个counter全一致且有限非负；每侧冷/暖各204 PARTIAL，保存204 MEASURED。启动counter只覆盖同文档commit后到collection，不是完整bootstrap或隔离OS CPU。
- console error参考/当前 **1,836 / 2,652**，分别与明确阻断请求数量相等；仅保留数量而无逐条消息/关联，不能证明每条错误的根因都是provider阻断，更不是console-zero。完整request分类与计数保留，不冒充公网/生产结果。
- reference记录的whole-site inventory前后均 `a18ee3fc...` /110 files/92,344,588 B；current均 `624e1caf...` /126 files/92,499,248 B。当前site实盘独立重算匹配；参考快照清理后只能再核对所记录inventory内部指纹，未声称重新读取已删除字节。
- 这是同机桌面Chrome、390×844、无HTTP/SW缓存、外源阻断的合成单基金工作流；不能归因于105 B私有hash裁剪，不能替代多基金/公网/物理Android/iOS/Gist/生产验收。观测不到current启动long task也不能排除未覆盖调度或I/O，更不能断言暖启动噪声根因。

M3仍 **IN PROGRESS**：all预算还差 **3,931 B**，新总体时延门禁证据不足，M4/M5/M6未开始。下一步优先做有实测收益、行为可证明的源码减包；材料性候选改变后另行预声明完整新配对，或先给独立合理的大样本方案，保留本轮INCONCLUSIVE，不进行即时挑PASS重试。版本保持15.0.2；main live ref复核仍abfb，未merge main / deploy / bump，目标继续保持active。

### 2026-10-13公开主源真实只读摄取补充

证据：[m3-public-source-readonly-20261013.json](performance-evidence/m3-public-source-readonly-20261013.json)。采用项目真实`fetchEstimateRows`、固定公开代码005844/012920、Node `--use-env-proxy`、原10秒timeout及完整校验器；没有改Worker/来源时间guard/系统时钟或发送云写入。第一组按app相同的缺省时钟处理不传`options.now`，但也不传force，不能代表完整默认refresh请求：固定5次順序GET **5/5 accepted**，中位数 **126.45 ms**、nearest-rank p95/最大 **9,892.81 ms**。另预先固定5次`force:true` / 不传now，匹配app默认估值HTTP的强刷与时钟选项，亦 **5/5 accepted**，中位数 **108.56 ms**、p95/最大 **9,073.48 ms**；未覆盖generation取消。两组首个慢样本全保留、接近默认超时，不挑最快或声称公网时延已稳定。每组内sourceFetchedAt相同只是一项上游观察，不能据此断言其缓存策略。未收集DNS/TLS/proxy/Worker/upstream各段时间，不能归因具体慢环节。

- 005844：正式净值 **2026-10-12 /3.0167 → 2026-10-13 /3.0590，+1.40%**。
- 012920：正式净值 **2026-10-09 /3.6843 → 2026-10-12 /3.5827，−2.76%**，不是10月13日行情或单日盘中估值。
- 两条均为official/official_nav、eastmoney-official-nav，并保留上游空结果与date-only等降级原因；没有被当成实时估算。可信结论仅限这些已校验的正式净值区间；本探针未另读独立权威上游或验收生产浏览器渲染。

此前额外5次诊断显式把请求开始时钟传入`options.now`，结果1 rejected（WORKER_METADATA_INVALID）/4 accepted，全部另列保留；它不是生产app的调用形状。validator要求generated_at/fetched_at不晚于传入now，因此请求开始时间可能早于新生成响应；首个拒绝payload未保留，不能断言其确切字段/上游时钟错误或报成已观察到的app Bug。随后预先固定的未强刷/默认强刷各5次是不同诊断协议，不替换该失败或第26节Oct11直接transport失败，也不是重采样配对挑PASS。

独立只读减包调查未找到新材料性候选：9个核心模块/129个FunctionDeclaration去位置AST比较没有完全相同函数体；wire与persisted-cache的typed/alias/null/错误/provenance/freshness语义不同，不能合并删除校验；public coordinator不在实际生产消费者图，不能把源码重复当成当前gzip双份代码。6个没有生产writer的fundType/fundFee展示行仅441 B raw，未测gzip且已有Proxy/getter轨迹保护，不作为高收益实现。尚不能承诺一轮填平3,931 B；本轮未改业务来凑预算。

固定更大1000组系列有尾部精度理由（200组p95约10个上尾样本、1000约50），但这是观察本轮之后的后置方案，不是原预计划，也不保证PASS或多次测试总体95%置信。当前优先材料性减包，尚未声明/启动新1000组；若后续采用，须另提交固定协议/独占输出、保留旧结果、不混样/早停/换seed/增样/失败后重试。

## 28. 结构减包候选的实际排除与保留导出筛查（2026-10-13～14）

机器汇总：[m3-rejected-structural-probes-20261013.json](performance-evidence/m3-rejected-structural-probes-20261013.json)；完整精确变体、三轮数据和原测量脚本：[归档目录](performance-evidence/rejected-probes-20261013/README.md)。

这轮按既定M3顺序继续处理体积缺口，不进入M4。测量源检查点 **17bb8b8dbaacfdf91bccf30b0d89a2c3e33fb9c1**，与06aa相比只有第27节的五份证据文档变化，业务内容、配置、预算、依赖和版本未变。没有实施下面的任何候选。保存否决证据的目的是限制下一轮重复探索，不把源码缩短或定向对照PASS当作包体积收益。

### 真实配方、固定三轮与结果

全部采用真实 `scripts/build-site.mjs` 的AST配置：**Vite8.2.2 / oxc / es2022 / 原groups / write:false**；只通过内存plugin替换精确模块。每个各自在脚本中预设的变体及基线各三轮，数值完全一致，都是16 chunks；并非12项统一事前注册。没有运行时延试验、改依赖或重分组。基线 **raw237,665 / all81,158 / cold42,907 B**。native template仅为coercion负控，组合项不是额外可相加的收益。

| 候选 | all gzip变化 | cold gzip变化 | 处理 |
| --- | ---: | ---: | --- |
| 18处严格template拼接 | +15 B | +15 B | 增大，拒绝 |
| native template负控 | +7 B | +5 B | 增大且不保留任意对象coercion，拒绝 |
| 5处stat-cell HTML helper | +5 B | +1 B | 增大，拒绝 |
| migration成功返回工厂 | +13 B | +9 B | 增大，拒绝 |
| schema私有参数scalar | −4 B | −5 B | 收益不足，未完成行为资格验证，不实施 |
| journal membership复用 | −3 B | −4 B | 收益不足，未完成行为资格验证，不实施 |
| 上述三个存储变体组合 | −14 B | −9 B | 收益不足，不实施；不是单项gzip相加 |
| cloud同步解析检查工厂 | +17 B | −1 B | 总包增大，拒绝 |
| buildFundData身份工厂 | +8 B | +5 B | 总包增大，拒绝 |
| cached market投影工厂 | −12 B | −7 B | 收益不足，不实施 |
| cache payload字段表 | +25 B | +3 B | 增大，拒绝 |
| cache payload+index字段表 | +33 B | 0 B | 增大，拒绝 |

身份工厂定向 **192 native /192 getter /192 throw** 对照通过；market工厂 **1,944 native /1,944 Proxy /8 throw** 对照通过。保留字段/descriptor、spread与getter顺序、Date轨迹和同一sentinel；可选模型或DOM被注入，不能称完整app、任意JS异常栈、E2E或真机等价。其他候选已被包体积/收益检查排除，未继续投入完整行为证明。

### 实际保留导出与较大重复检查

另做两次原配方baseline库存，均raw237,665 / all81,158 B。10个dynamic entry已窄化或只有单一必需导出：business-features的18个、cloud-runtime的6个、gist-runtime的3个均有真实页面消费者；startup recovery/lock与migration保持先于app。独立accuracy动态产物仅 `loadAccuracy`（77 raw /92 gzip），其实现保留另六函数是 `updateFundAccuracy` 的内部调用链，不是未用namespace泄漏。证据含各模块AST声明导出和实际renderedExports；当前Rolldown没有提供removedExports，不能猜测。模块的renderedExports也不等于chunk对外exports。

8个聚合函数的56个对象表达式没有找到≥200 raw B的精确结构重复；这个窄AST检查不排除语义/alpha-renaming优化。cloud push/pull较大重复跨越不同backup、await、readback、pending窗口，不合并异步引擎。旧integrity修复导出已经tree-shaken，删除raw源码不计作产物收益。

cache独立交叉审查重建了两份完整虚拟源并检查原AST配置、三轮值与source/recipe的17bb Git blob LF hash。原报告 `sourceCommit:null` 没有改写成预先记录的SHA；缺少专属全树前后库存的限制仍保留。各探针graph SHA是不同序列化的有界拓扑指示，不是行为/导出/产物指纹证明。

### 当前未改业务源的独立本地复核

新运行 **966 tests /963 PASS /0 fail /3 Windows symlink条件skip（5,370.104 ms）**；syntax **197**；桌面合成E2E **27/27（41.9秒）**，自有12437已退出。三个readiness/save描述性样本全保留于机器报告，只属于原绝对交互smoke，不是新的relative/p95、真实设备或真实云同步。没有重新运行200组配对，第27节总体INCONCLUSIVE保持。

实际build共4次；E2E后最后两次同17bb epoch **1791905438**，关键发布集均 **`c42ea9458cf28dd8e4c51306da6a86f46f1602dd947ad562006a380ce23267ae`**，whole-site均 **`20986cc3ead54ccf19733225097e8b4b908feb898fff8790df88fff634a1173d` /126 files/92,499,248 B**。两种算法不互相替代。官方核验app **16 chunks/237,665 B**、OCR **23 assets/88,196,906 B** 的bytes/SHA通过，没有执行OCR。fresh build只将OCR manifest生成时间改为新epoch；E2E曾产生45 B的忽略结果文件，后续正常build清除，所以不能将“虚拟探针未写site”扩展为整轮site始终没变。

两次实际budget CLI仍 **cold42,907 /52,241 PASS，all81,158 /77,227.7 FAIL /exit1**，至少差 **3,931 B**。CLI的importClosureVerified仍false，启动图校验由真实build输出负责。以上是17bb内容和该epoch的本地结果，不验证未来文档提交SHA、Linux或生产。依赖审计未重跑、未安装或修改依赖；不继承为本轮新audit结果。

两次只读GitHub run查询发生API EOF，未据此改变既有CI结论或制造新CI证明。新的 `git ls-remote` 读回continuation17bb、main仍abfb。归档前15份文件逐字LF核对，库存报告只删rendered code、另加顶层投影说明，其余metadata不变；归档读取截断、PowerShell quoting、CLI参数/root误用及末尾空行修正等诊断也保留。

### 下一步范围

这轮没有新的业务收益，不升级版本或发布。后续优先研究真实post-integrity（32,129 B gzip）和business-runtime（27,929 B gzip）的可达调用链与较大闭合职责，而不是继续为个位字节增加工厂；这只是筛查方向，不承诺已经找到减包方案。任何共享必须保留wire/cache不同边界、source/date/null/0、Schema3、取消与写入时序，先实测再资格验证。材料性源码变化后，按原协议预声明完整新配对，保留旧INCONCLUSIVE。

**M3 IN PROGRESS / NOT RELEASED**。业务源码、公开校验器、配置、依赖、预算、版本、main与生产均未改；M4/M5/M6未开始。

## 29. 较大职责、函数排布与 HTTP 私有边界排除（2026-10-15）

机器汇总：[m3-larger-boundary-probes-20261015.json](performance-evidence/m3-larger-boundary-probes-20261015.json)；精确原脚本、完整虚拟源、逐轮记录和失败TAP见 [压缩归档说明](performance-evidence/rejected-probes-20261015.md)。本轮承接中断的20份暂存证据，没有覆盖旧数据。测量时HEAD仍17bb、业务仍06aa，业务/配置/依赖/预算/版本未改。

### 7个独立脚本族、22个候选

每个脚本各自先定义变体，再运行固定三轮；不是22项统一事前注册。仍用真实build-site AST配置、write:false、Vite8.2.2/oxc/es2022及原5groups。基线均 **raw237,665 / all81,158 / cold42,907 B、16chunks**；下列每项三轮稳定。组合行不是单项压缩收益相加。

| 候选 | all变化 | cold变化 | 结论 |
| --- | ---: | ---: | --- |
| app共同cloud编排 | −30 B | −26 B | 无材料性收益，且有getter/微任务风险 |
| app Map事件分派 | +21 B | +23 B | 拒绝 |
| 上两项组合 | +2 B | +3 B | 拒绝 |
| 函数保持源序后集中排布 | −19 B | −20 B | 不实施 |
| 函数字母序 | +221 B | +226 B | 拒绝 |
| 函数反向源序 | +125 B | +126 B | 拒绝 |
| 函数长度升序 | −17 B | −17 B | 不实施 |
| 直接调用名称启发式DFS | +181 B | +186 B | 拒绝 |
| 模型envelope条件装配 | +8 B | +9 B | 拒绝 |
| 模型envelope前缀装配 | −9 B | −8 B | 不实施 |
| descriptor tuple且保留验证 | +9 B | +11 B | 拒绝 |
| period复用enum | −3 B | −6 B | 不实施 |
| 上述模型/tuple/enum组合 | −18 B | −17 B | 不实施 |
| quote/wire共用最终parse尾部 | −9 B | −4 B | 不实施 |
| 再含overseas的parse尾部 | 0 B | −3 B | 不实施 |
| 完整Worker HTTP transport收敛 | −22 B | −2 B | 不实施 |
| Bridge私有错误helper | +9 B | +4 B | 拒绝 |
| transport/Bridge组合 | −16 B | 0 B | 不实施 |
| HTTP canonical私有投影且保留二次validator | −120 B | +3 B | **行为回归，拒绝** |
| 43处静态DOM ID查找门面 | −34 B | −30 B | 不实施 |
| 18项action switch | 0 B | +3 B | 不实施 |
| DOM/action switch组合 | −30 B | −28 B | 不实施 |

原28项HTTP表征：基线 **28/28 PASS**，私有投影 **27 PASS/1 FAIL**。具体反例是 `test/estimate-http-characterization-v16.test.js:243`：ChangingDate第一次时钟允许envelope，第二次时钟回拨触发ROW_INVALID。原实现应保留legacy safe rescue并返回不可用行，候选却拒绝整次请求。候选虽保留第二次wire validator，仍不能称等价；不得借“已校验canonical”删去二次校验或rescue，也没有修改测试期望。完整TAP确认对另存，原spec观察和工具启动错误没有替换成PASS。

函数排布通过独立重建确认138个函数声明文本逐字不变、104个非函数语句文本及相对顺序不变；没有运行行为等价或采用这些排布。DFS只是直接标识符调用名启发式，不是解析了词法绑定/动态调用的完整调用图。初次工具的Windows斜杠替换错误导致三轮baseline后首个候选touched=0失败；修正仓库外工具后固定完整6×3系列，最终18条，不把此前3条拼成21条。失败来自root已观察的工具输出，没有虚构独立失败文件。

orchestration记录230个tracked/126个site文件的专属前后库存；layout仅验证app前后相同，不借前者追认其全树窗口。UI有独立91源文件/126site库存。graph SHA两个算法族不同，不横比、不证明行为。共享时间解析没有统一各自语法：wire严格文本/offset边界、quote日期语法、overseas斜杠日期、Tencent当地时区均继续保持区别。

### 本轮新本地检查与范围

以下命令结果由root实际执行观察；归档交叉审查只核验数据与边界，没有再次运行这些门禁。

- `npm test`：**966 /963 PASS /0 FAIL /3 Windows条件skip，5,757.9025 ms**。
- `npm run check`：**197**个JS文件。
- `npm run test:e2e`：**27/27，40.6秒**，自有12437监听已退出，未动4173。三个绝对readiness/save样本完整保留，不是新relative/p95或真机/云/生产证据。
- `npm run build`：**三次成功**；E2E后最后两次同17bb epoch1791905438，关键发布集均 **c42ea9458cf28dd8e4c51306da6a86f46f1602dd947ad562006a380ce23267ae**；本轮whole-site采用明确的path/bytes/sha256排序JSON算法，均 **a10e39af54a2429f405e03a92ccadced75a9d2abb226960c3b1af7cf8773ec10 /126文件/92,499,248 B**。与第28节不同键名算法的whole hash不能直接横比。
- 独立官方CLI核验：app **16 chunks/237,665 B**、OCR **23 assets/88,196,906 B** bytes/SHA通过；没有执行OCR。
- 原budget CLI **exit1**：cold42,907/52,241 PASS，all **81,158/77,227.7 FAIL，至少差3,931 B**。importClosureVerified=false仍不冒充真实build图校验。
- 未重新audit依赖、未重新采集200组pair、未进行本轮CI/生产验收；旧pair仍INCONCLUSIVE，不重跑挑PASS。

19份精确LF原文件以gzip+base64归档，解码后JSON **999,622 B** /SHA256 **2b7115730a163c2476edab5b3a9e7debcfedcd65f83c6c89a477f5bb37e7a40c**，gzip **203,381 B** /SHA256 **236faa2aa36a8e99750bb9eb32e3b07477f7ed9f84f3d5fc6964b1091afb0af1**；19份逐字LF、8个JSON解析与逐文件hash已实核。仅是文档归档，不进入app、SW CORE、资源预算或OCR资产。

额外的只读字段活性追溯排除了直接删除primary_change/primary_nav/display写入：当前`app.js:587`与`refresh-resource-cache.js:260`是黑名单式持久化，不能拿resource ROW_FIELDS白名单套用aggregate；worker-contract的`...row`→eastmoney-estimate的`...wire`→app的`...r`允许未知同名字段到达。`test/cache-fund-identity-v16.test.js:130`附近明确要求可信quote覆盖这些派生值。原40e旧app在hydrate时会重建这些字段，primary_nav计算reader属于它自己的新网络build；不能宣称“v15会因新缓存缺少这些字段而不能打开”。真正未闭合的是当前opaque同名覆盖、共享v1缓存输出和身份隔离契约；仅凭当前UI没有直接reader就删写，会使同名值不再被可信quote覆盖，不能称等价减包。没有为这个不闭合方向运行字节试验或改断言。

**没有合入新候选，没有取得新业务减包收益。M3仍IN PROGRESS，版本15.0.2，M4/M5/M6与正式发布均未开始。** 后续须找真正闭合的私有路径或以完整兼容设计消除重复投影，不再重复这22项helper/布局试验；不能仅凭文本搜索没命中就删字段。本轮结论不证明更大重构不存在，也不保证能填平预算。

## 30. 闭合运行投影与 SW 消息认证的实际实施（2026-10-15）

第29节是此前无业务改动的历史检查点。本节实际父提交为`e750daebb0219ef17b227fdd9a6ceca3ae5b6382`，在同一continuation分支实施以下独立改动；版本/依赖/构建配置/原预算不变。

### 私有执行投影，保留完整公开契约

- `notification-policy-runtime.js`只面向控制器的布尔判断，保留原全部guard、读取/短路/异常顺序；原公开`notification-policy.js`整文件原字节未变。真正磁盘alias阶段49/49 GREEN（无候选AST test）→实源50/50 GREEN，新增12项永久表征；不是Bug修复RED。7542 native、32 Proxy、192 sentinel、时钟/选项/控制器矩阵与AST三负控保持，生产目录全部静态消费者被护栏锁定。
- `refresh-plan.js`新增闭合运行计划，公开完整factory原文不变。共享`cacheDecisionCore`保留原完整验证及Math.min/getter顺序，仅分离返回表示；生产不再生成未逃逸的reason/phase/provider等元数据。采用共享validator的253 B独立候选，而非收益304 B但复制validator的变体。
- `refresh-execution.js`和`security-quote-batch.js`仅切换factory import alias；私有refresh1处、security2处均封闭literal调用，不接受任意spread/indexCodes。结果和嵌套resource只能进入已审执行消费者，追加alias/escape/字段读取负控。
- 真实旧包装170/170→实源170/170→最终171/171 GREEN。12项永久测试有独立旧reason/字段顺序/冻结/16次getter期望，以及真实executor/detail/cache/取消路径，不把public注入harness当私有集成资格。新增TTL fixture最初时间倒置，原校验正确拒绝；修正fixture而非业务预期，后来失败复核另存。独立12/12审查与前组重叠，不累计。

### 独立 SW 纵深加固

`sw.js`先严格检查event.origin，再用clients.get复核当前app WindowClient的id/type/绝对URL；只允许项目根/index，拒绝其他页面、credentials、非同协议HTTP(S)目标。等待worker不要求已控制发起页面，异步校验和动作统一由同步登记的waitUntil保活；activate重查发起者，notify及点击独立约束安全目标和app窗口。缓存版本/CORE、网络缓存函数、app dirty/drain和旧兼容入口未改，不navigate旧页面、不额外全局claim。

真正旧源首批18项为1 PASS/17 FAIL；最终旧源负控22项1 PASS/21 FAIL；新定向35/35 GREEN。新增原生Chrome用例执行实际worker source，以合成同源页面/CORE服务器验证真实origin/Client、拒绝兄弟/OCR页面、旧worker控制的合法waiting请求和ACK来源，2.7s通过。它不是生产UI、真实通知权限、完整恶意同源JS隔离、正式v15→v16升级或真机证明。反向ACK消息入口认证、真实app双tab dirty/drain动态验收仍待后续；#5目录导入告警未改、不suppress，不能预先宣称#7关闭。

### root 完整检查与真实组合构建

| 检查 | 当前实测 |
| --- | --- |
| npm test | 1012项/1009 PASS/0 FAIL/3 Windows条件skip，6269.7289ms |
| syntax / audit | 202文件通过；0 vulnerabilities |
| 浏览器E2E | 28/28，44.6s；自有12437退出，4173未动；合成桌面数据 |
| 固定3次实际build | 16chunks/raw235415/all80394/cold42907，每轮一致；后两轮在E2E之后 |
| app/OCR字节核验 | 16 chunks/235415 B；23 OCR assets/88196906 B；没有执行OCR |
| 原budget CLI | exit1；cold42907/52241 PASS，all80394/77227.7 FAIL，至少差3167 B |

固定epoch1792046773；214份生产输入/测试/脚本的检查前后逐字相同，独立复核亦与实盘一致。关键发布集为`74c4a504c27c2b48fe8d91e981fef79d945d6e54c965da055e1b3154f81094a8`；whole-site127文件/92506072 B/hash`3032ccdf6c57a945491bb44b00e7169e722977d81e2103934694fcb7bec5e07b`。

对e750冻结基线：实际app raw−2250 B、all gzip−764 B、cold0，不能把单候选收益相加推算。whole-site因保留新source/SW明文反而+6824 B/+1文件，不能称全站减包。Vite8.2.2/oxc/es2022/五分组/依赖/原预算不改，原启动阶段图校验通过。三次确定性和静态包体积不是新启动/保存时延结论；旧200-pair总体INCONCLUSIVE未重跑、不继承PASS。

### 父精确 CI 与当前真实源失败边界

已实核父e750 CI[38694431660](https://github.com/AureliusWu/FundVal/actions/runs/38694431660)：Linux966/966、syntax197、audit0、E2E27/27，唯一失败步骤为all81158原预算；CodeQL成功扫描但仍2个既存medium（#5/#7），不能写成无告警。上传artifact11953392758仅核元数据、未下载；seal的site fingerprint不是关键发布指纹。此父结果不继承到新实现SHA。

当前实际HTTP客户端、force:true且now缺省，固定5次公开GET为0接受：2 REQUEST_TIMEOUT、3 WORKER_METADATA_INVALID。另一次独立raw诊断也超时，无response metadata，所以尚不能定位generated/fetched/capabilities、时钟或transport具体原因。原件的allRowsPredicatesEqual:true是空集合every，条件可信标签也是脚本无条件赋值，均**不能作为PASS**：比较行数0、等价结论null，正确验收状态SOURCE_INGESTION_NOT_VERIFIED / POLICY_COMPARISON_NOT_EVALUATED。所有失败保留，未改时钟、Worker或放宽契约，不声称实时行情恢复、独立净值对账或生产数据通过。

机器摘要、三阶段完整证据和71份原件见[运行投影证据说明](performance-evidence/m3-runtime-projections-20261015.md)，父CI见`m3-e750-ci-20261015.json`。压缩归档只保存文档证据，不进产品预算/SW/OCR；有限行为与AST护栏不是全程序证明。

提交时补充：先前tracked diff检查未包括新未跟踪文件；staged检查额外报告4份新测试文件的EOF空行（notification/runtime-plan/SW-message/native SW E2E）。保留已冻结/测量字节并记录为非阻断格式warning，不称完整whitespace PASS；源码语法/行为/E2E结果不因此改变。

后续独立有界诊断（不替换上述五失败）：2026-10-15 07:27:54～07:28:01 UTC，真实HTTP客户端固定3次，native response.json仅旁观顶层metadata并返回原payload，未传now。三次均HTTP200、缺schema_version按代码为v1、source=eastmoney_official_nav/status=degraded；fetched_at均为07:28:05.171Z，比本机捕获时钟分别未来3545/3400/3262ms，HTTP Date亦未来3374/3229/3091ms，三次WORKER_METADATA_INVALID。由v1控制流可定位**本批三次**到`worker-contract.js:179-180`的未来fetched_at拒绝；不能单凭同origin两个时间断言哪端钟错，不能倒推此前三条无payload的metadata错误。旁观有轻微开销、不构成完全无观测扰动；没有修改payload、系统时钟、Worker或校验，也没有新接受数据/净值核对。完整独立记录与精确脚本见`m3-public-metadata-skew-20261015.{json,mjs.txt}`；它们不在此前已冻结的71份归档内。

### 已推送业务内容的精确新 CI（不继承到本节后续文档 SHA）

性能实现提交`3f6698c`、独立SW修复`952d822`，证据/格式warning说明合并后实际推送`1a02e3c88ece09ef2620c638b61bf7ed30b28112`。[精确run38698735715](https://github.com/AureliusWu/FundVal/actions/runs/38698735715)已实核completed/failure，唯一失败step15为all80394/77227.7原预算；不是测试或构建失败。Linux1012/1012（0 skip）、syntax202、audit0、E2E28/28（51.8s），app16/raw235415、OCR23/88196906均通过。

新CodeQL analysis1957643413（103rules）仅1个结果：既存medium #5，实例确为1a02；#7在新分析中fixed，保留的last-instance仍e750只是历史行，不能误称新SHA告警，也不宣称main/生产已修复。没有关闭/suppress #5。artifact11954259001/92633686B已上传但未下载；seal日志`3a036fef79323c4b546356595700121b8e435d4317e5f46e9770683d3c511fcb`是site inventory，不是critical发布指纹，不能同本地固定epoch指纹混比。单次Getrun EOF后对同一run只读重查成功，未rerun/dispatch。完整信息见`m3-1a02-ci-20261015.json`；其后新增的文档与独立诊断记录不自动继承此精确SHA CI。

**M3仍IN PROGRESS，版本15.0.2；M4/M5/M6和正式发布尚未开始。** 下一步仍须消除原all-gzip缺口、定位真实主源拒绝并取得可重复时延证据，不以降低预算口径或跳过门禁进入下一里程碑。

## 31. 真实双标签页更新误重载 P1（2026-10-15）

父fb559上的真实构建app/native SW测试首次暴露peer自动重载，旧源两次独立负控均1 FAIL/1 PASS。浏览器原生更换peer controller正常；app无条件reload才是问题。现在显式请求worker身份+同源ACK认证、非请求页只提示手动重载；所有主动重载先排空并复查dirty，包含排空中别页激活、并行点击、失败重试和null防御。

最终18项定向GREEN（旧17项5/12 RED、额外null反例17/1 RED），全量1030/1027 PASS/3 Windows skip，syntax204、官方registry audit0、E2E30/30。三次最终真实build raw235665/all80477/cold42992，bytes/SHA与确定性通过。修复成本all+83/cold+85 B，原all预算仍FAIL/exit1，缺口至少**3250 B**。旧pair INCONCLUSIVE，未重新采样。不是正式版本迁移/真机/真实云或发布，main/生产未改。

完整范围与不继承边界见[修复说明](performance-evidence/m3-page-update-guards-20261015.md)及[机器摘要](performance-evidence/m3-page-update-guards-20261015.json)。较大职责审查未发现新合格减包候选；40e当前配方65275仅归因诊断，不替代原70207锚。M3继续，不能跳过原门禁进入M4。

提交b9da的真实CI38704643538在Linux E2E路径负控失败（28PASS/2FAIL），budget步骤skipped，不能称只有budget红。已仅修测试helper跨平台root判断；双平台纯path矩阵58/58，新本地1030/1027PASS/3skip、syntax204、E2E30/30（54.4s）、三build/产品指纹不变。原失败保留，细节见[后续兼容证据](performance-evidence/m3-page-update-portable-harness-20261015.json)。后续SHA需新CI，M3依旧未退出。

## 32. 本机未同步时钟的独立证据与较大职责审查（2026-10-15）

本轮基于f926，仅文档归档，不改产品。独立只读NTP三样本显示本机约慢3.75秒，Windows状态为未同步/CMOS。用户明确允许仅一次校时，实际一次`w32tm /resync`被`0x80070005`拒绝（exit -2147024891），未成功校时，未再次尝试或修改服务配置。后续两个NTP样本仍约+3.751秒，第三个超时保留。该步需管理员完成，不是项目文件访问权限问题，也不应放宽项目时间校验。

校时失败后事前固定5次真实客户端GET：均200/v1/正式NAV降级，但fetched_at比本机未来3689/3513/3387/3270/3151ms，5次WORKER_METADATA_INVALID、0接受。本批可定位未来fetched_at拒绝，独立NTP支持本机偏移有贡献，不倒推所有历史原因或宣称Worker绝对正确。完整原JSON/脚本byte-for-byte归档，无成功样本替换失败。

新增渲染/启动恢复/较大估值DTO三个只读职责审查，均未找到可证明安全的大幅删码切面，没有新变体/build或收益数字。完整人工报告已归档，附属Temp脚本/JSON未全量打包。不能复用跨锁旧持仓快照，不能把资源缓存白名单套用旧聚合，也不能通过移动HTML到data规避预算。

原CLI对现有产物新实核all80477/77227.7 FAIL、cold42992/52241 PASS，缺口至少3250 B；不是新构建。f926精确CI38705211689已确认Linux1030/1030、E2E30/30等通过，唯一失败step15原all预算；CodeQL仍既存#5，不等于零告警，不继承后续文档SHA。本轮未重跑完整测试/build/E2E/pair，旧pair仍INCONCLUSIVE。

详见[校时与职责证据](performance-evidence/m3-clock-and-boundaries-20261015.md)。**M3仍IN PROGRESS / 15.0.2，未进入M4，未部署或发布v16。**

## 33. 目录维护器有界输入与失败不覆盖（2026-10-15）

在M3预算仍失败期间，独立处理既存#5相关的实际健壮性缺口：维护器增加16MiB输入/输出、100000原始行、接纳name128/pinyin512 UTF16预算，native stream按实际字节限流及严格UTF8；保持合法身份/顺序/去重和固定目标。20秒下载deadline同时使用Promise/abort/单调clock，在读取前后及出口检查，异步晚回与ready空分片不能进入发布。成功下载后独占同目录temp，通过descriptor写/sync/close后rename，失败不回退截断旧目标。不是M4或业务减包。

原源真实23项8PASS/15RED；后补两个单调deadline单项均先RED，再最终29/29GREEN。新全量1057/1054PASS/0FAIL/3Windows条件skip，syntax205、E2E30/30（50.0s）、官方audit0。E2E后3次原配方build critical/127文件whole-site均与此前产品相同，all80477/cold42992；原预算仍FAIL/差3250 B，未重跑pair。

现有27487行/2822600B目录逐字兼容且未改。一次真实公开GET在独立Temp镜像成功生成28065行/2885045B，证明native stream+原子替换正常，不是源完整性、最新身份或金融行情可信证明；无真实用户数据写入，也未再次校时。最初RED、两个负控、机器摘要与网络脚本已归档，全量stdout仅Temp，不夸大全部原件归档。

完整证据及局限见[目录维护器说明](performance-evidence/catalog-maintenance-20261015/README.md)。尚未逐点注入所有FS故障，不保证掉电durability/并发版本排序；#5需新精确CI/CodeQL，不关闭或suppress。**M3仍IN PROGRESS / 15.0.2，未推进main/部署/v16正式发布。**

## 34. 中断恢复后的固定流缓冲与新验证（2026-10-18）

33节改动中断后仍未提交，按现状恢复，未覆盖旧证据。独立审查发现按片保存Buffer会因空/极小片产生大量对象，16MiB字节cap不限制片数；新增负控先真实1FAIL，再改一次固定16MiB缓冲逐片set+仅decode有效段。该容量只约束保留正文，不冒充整个堆/RSS上限。新增decoder长度与恰好16MiB流测试，最终31/31定向通过。

当前1a9c维护器与552c新测试，完整新门禁1059/1056PASS/0FAIL/3Windows条件skip、syntax205、E2E30/30（57.8s）、官方audit0；E2E后3次build产品指纹与原窗口相同。原all80477/77227.7仍FAIL、缺3250B；未重跑pair，不能退出M3。当前本地27487目录逐字兼容未改，最终模块一次真实GET在Temp成功生成28104行，不是独立完整性/实时估值或生产证明。

新机器记录/脚本/负控/实际网络集成均见[维护器报告最新增补](performance-evidence/catalog-maintenance-20261015/README.md)。旧29/1057与72d3/native.json保留为10/15窗口，不继承给新源码。Windows只读状态现为时间服务未启动（0x80070426），固定三NTP样本两超时、一+2.4010562s，不继续声称旧3.75s为当前钟差；未再次校时或更改服务。

**版本仍15.0.2，M3 IN PROGRESS；main、M4/M5/M6及正式发布均未推进。** 本实现仍需精确提交CI/CodeQL复扫，不预先关闭/suppress #5。

## 35. 大持仓正式净值排队失败的真实复现与调度修复（2026-10-18）

基于5186回到M3刷新图：105只基金同时需要NAV fallback时，getNav无界fanout撞上真实Bridge等待队列100上限。Node真实request/pump＋合成dispatch旧源101/105（4个busy）；原生Chrome实际app/opaque iframe/路由合成JSONP旧产物100/105（5个--）。不是同一环境计数，不互相外推。新增独立2-slot官方lane，fallback/metadata两处都在获slot后进入原scope.dispatch，不与披露limiter共用；Bridge容量、期限、sandbox/schema、缓存TTL/日期/来源和版本不变。

最终5项新测试对冻结旧源0/5、对新源5/5，涵盖105 fallback/metadata、取消排空、前2次失败释放slot和披露挂起时先显示fallback；后两项旧源基本流程可完成，失败点为新有界需求断言，不能全部说成原源丢数据。新executor40/40、最终全量1064/1061PASS/0FAIL/3Windows skip（6476.4943ms）、syntax205、Chrome31/31（1.0m）、官方audit0。初次全量唯一旧源码正则失配已保留，改为同时要求两入口、独立lane和唯一NAV调用点，未放宽行为测试。

两侧各3次原配方真实build：raw235665→235647（−18 B）、all80477→80494（**+17 B**）、cold42992→42985（−7 B），最终critical均4bda36bc、whole均7d4d8c1e/127files/92507677B。这是可靠性修复，不是减包优化；原budget CLI仍exit1/all FAIL，至少还差**3267 B**。无新pair，旧200组INCONCLUSIVE保留；没有真实金融源/真机/云写入/生产验收。

较大重复职责与固定全图函数扫描没有发现新材料性删码机会；不证明未来优化不存在，不修改编译器/组/原预算。详见[调度证据与明确局限](performance-evidence/nav-scheduler-20261018/README.md)及机器summary。**M3仍IN PROGRESS /15.0.2，未进入M4/M5/M6，未merge/deploy/bump。** 本次工作树需要新的精确CI，不继承5186结果。

## 36. 新授权下的压缩器独立比较：未采用（2026-10-18）

用户明确允许在Temp独立验证新的JS压缩策略，合格后才采用；与第35节固定压缩器的范围区分，不再把换压缩器称作未授权。冻结170fd源码，取真实build-site AST配方，原5groups/es2022/write:false不变；每系列固定三轮OXC→候选/候选→OXC/OXC→候选，共18次构建。所有16chunks，模块到组/阶段归属hash相同、原阶段隔离与最终AST import路径/metadata一致性通过（未验证named-export绑定或执行ESM），各配方三次chunk指纹重复。

OXC仍all80494/cold42985/raw235647；Terser5.51.2保守p2为80916/43192/237249（all+422），完整esbuild0.28.2为82871/43934/238490（+2377），SWC1.16.18保守p2为80328/42956/233930（−166，仅0.21%）。均未采用：前两者更大，SWC微小收益仍不能填平缺口，不足以启动新工具链采用。Terser/SWC仅装Temp且ignore-scripts，项目package/lock/白名单未动。四配方逐chunk最小值简单相加80288仅是算术筛选、不是hybrid真实构建或形式下界，仍至少差3061整数B；没有继续试混合或扫参数。

原site整个测量期间whole hash7d4d8c1e/127files/92507677B不变；原工作树与Git archive JS原始EOL不同，73文件LF规范化inventory一致，不把raw hash不同隐去。初版审计工具因静态TemplateLiteral误判而未完成有效系列，工具与失败保留，v2只纠正该字面量分类。全部测量完成后仅新增[独立试验报告及原始选项/工具](performance-evidence/minifier-qualification-20261018/README.md)，未采纳源码/构建修改。

当前预算CLI仍exit1：cold42985/52241 PASS、all80494/77227.7 FAIL，至少差3267B。没有候选压缩公开API镜像测试、E2E、新相对时延、OCR真机或生产验收；不可把三次确定性当完整兼容/性能通过。较大Worker投影/cache读写/展示选择与private property审查没有新的合格材料性候选，不代表所有未来优化不存在。**M3 IN PROGRESS /15.0.2，未进入M4/M5/M6，未merge/deploy/bump。** 本轮不因文档归档触发远端CI或继承旧CI。

另对未换压缩器的原配方做完整新回归：1064/1061PASS/3Windows条件skip、syntax205、Chrome31/31（1.1m）、官方audit0，两个真实build同epoch且日志逐字相同；最终whole仍7d4d8c1e/127files/92507677B、critical4bda36bc，app16/OCR23实核通过但未运行OCR。错误传OCR核验根目录的一次调用保留并正确重验。这里只证明现有原产物，不把原配方结果授予候选压缩器；机器收据见报告的baseline-regression.json。

## 37. 当前源码800组独立配对：时延通过，all包门禁仍失败（2026-10-18）

第27节允许先有独立合理的大样本方案再测。本轮三个源码结构方向（registry健康转换、cloud push/pull共同前缀、Quote/期间/收益）未得到值得实施的大闭合减包候选；保留全部既有兼容和声明验证，不凭小段相似改大引擎。随后先写入[800预声明](performance-evidence/m3-pair-security-v15-800-20261018-protocol.md)，经独立只读复核才启动一次测量；未试N选PASS，不追加1000。

固定800 retained/4 warm-up/bootstrap5000/seed160003，原阈值/采样器/fixture不动，804组全部完整、失败0、AB/BA各400。2026-10-18 06:23:05.871→06:57:58.157 UTC一次完成，native exit0；两次独立summarizePairs与raw summary严格deepEqual。参考仍c298安全对齐v15业务，当前170fd原OXC业务（采样窗仅M3证据doc dirty）；Chrome155.0.8059.80，两侧同browser实例。

| 指标ms | 参考median/p95 | 当前median/p95 | median/p95变化 | 判定 |
| --- | ---: | ---: | ---: | --- |
| cold | 126.35/154.50 | 117.10/143.50 | −7.321%/−7.120% | PASS |
| warm | 65.70/90.90 | 57.35/77.70 | −12.709%/−14.521% | PASS |
| save | 75.3595/85.8120 | 62.8659/71.9219 | −16.579%/−16.187% | PASS |

current p95区间宽度4.390%/7.722%/1.081%，双侧均低于20%；三指标pass fraction1不等于总体通过概率100%。旧200仍INCONCLUSIVE；源码、日期和Chrome均变化，不把本轮稳定性改善全部归因于N，或把速度改善归因于某一小改动。

source Before/After完全相同，原diff bd23762e已在更新本节前归档；两侧库存前后完整数组同、current127文件现场逐项复核，sampler库存739c0fdc、JSON库存7d4d8c1e、critical4bda36bc分别标明算法。reference已清理，只核报告内部库存a18ee3fc，不声称重读已删实体。4824renderer/19296counter重算一致、pageerror/instrumentation/SW0、每侧2412drain全SETTLED；导航counter是PARTIAL，warm部分Script中位数反增10.46%只作描述性WARN，不能说所有CPU都更好。console error全804侧7236/10452非零，数量对应block但无逐条文本因果证据。

完整[结果与局限](performance-evidence/pair-800-20261018/README.md)、机器summary、实际diff/日志/校验工具均已归档；[原raw](performance-evidence/m3-pair-security-v15-800-20261018.json)88029371B、SHA65bfd348cb04b46826b811a521e5acea03086fa2c43b924efdced83459b00d8c。cleanup全PASS，2114/2121及原进程已退出；临时校验器的一次Windows ESM路径错误保留，v2只改file URL并exit0，不是重跑采样。

实际budget仍exit1：cold42985/52241 PASS、all80494/77227.7 FAIL，至少差3267B。**新当前源码桌面合成时延证据已补齐，但M3仍IN PROGRESS /15.0.2；未进入M4/M5/M6、未改预算/依赖/源码/版本、未merge main或部署发布。** 没有新正式CI、真实金融源/真机/Gist/OCR或生产验收；本轮只新增本地证据，不重跑800/1000挑PASS。

采样结束后另跑完整原配方回归：1064/1061PASS/0FAIL/3Windows skip、syntax205、Chrome31/31（1.0m）、官方audit0。E2E后两个连续build同epoch1792046773，critical4bda36bc、whole sampler739c0fdc/JSON7d4d8c1e全同；app16/OCR23实核通过，未运行OCR，budget仍FAIL。详细命令/原日志hash见结果目录post-pair-regression.json；不把这些事后测试混入采样窗口，也不授予未来SHA的正式CI。

## 38. 独立实际ESM闭包及原生静态绑定门禁（2026-10-20）

中断后确认170fd和文档dirty未变，无遗留FundVal Node任务。独立检查确认原字节/SHA/gzip工具的importClosureVerified:false范围真实，build-site元数据检查也没有独立验证最终named bindings；不是发现产品断裂绑定。新增app-module-graph工具及37项测试，先复用同批已核验字节，再由AST检查真实字面依赖、cold精确分区/全部可达，用合成root对全部chunk作原生link，不evaluate。缺失default/named/间接导出、star冲突、循环、仅lazy内的坏绑定与路径/属性/UTF8/限额等正负控均覆盖；TDZ和动态namespace成员反例明确不在证明范围。

初稿review发现部署无解析器依赖与双斜杠规范化误判，均在最终QA前修正。保留原部署不npm install/ci/build的约束：CI用完整AST命令，部署准入与smoke用纯Node native-only命令并返回literalImportClosureVerified:false。无node_modules临时三文件副本真实正/负控通过；未改变旧预算工具false声明，不绕预算。初始29项因新API/命令尚不存在而RED，不是29处旧运行bug；完整RED stdout未归档，不夸大原件。

最终完整1101项/1098PASS/0FAIL/3Windows skip（5948.1245ms）、syntax207、Chrome31/31（53.9s）、audit0。E2E后连续两build同epoch，critical4bda36bc、whole JSON7d4d8c1e/127files/92507677B与原产品完全相同。新实际图16chunks/18静态边/10字面动态边/6cold PASS，native-only亦PASS；app16/OCR23字节通过但未运行OCR。14条完整stdout/stderr、命令/退出码、选择source库存、采集脚本和归档审计见[ESM报告](performance-evidence/esm-link-20261020/README.md)。原all80494/cold42985不变，预算CLI仍exit1、至少差3267B；未重跑性能或继承精确CI。**M3 IN PROGRESS /15.0.2，本轮工具/工作流仍本地未提交，未推送/merge/deploy/bump。**

## 39. 入口默认排除与UTF8/ASCII打印有限探针（2026-10-20）

本地Vite8.2.2普通客户端默认已preserveEntrySignatures:false，项目未覆盖，因此没有重测显式false的no-op。既有façade分组探针保留，不把十个小stub的1340gzip本体当可兑现收益或严格上界。

完整QA结束后，用既存Temp Terser5.51.2作固定三轮离线打印预筛：compress:false/mangle:false/ecma2022/moduletrue，UTF8→ASCII/ASCII→UTF8/UTF8→ASCII，未新装依赖/改产品。原OXC80494/42985/235647（all/cold/raw）；同打印器UTF880465/42980/235622；ASCII80224/42887/244683，三次各自指纹相同。重打印all−29，ASCII相对同打印器再−241，最终仅−270B（约0.34%），raw反增9036B，仍不能填3267B缺口，未采用或继续扫参数。

六次实际字面闭包及原生staticlink通过，但两个打印配方相对原OXC都有同样5chunk规范化AST hash不同；ASCII相对UTF8仅post-integrity一份不同。未掩盖差异或声称完整语义资格。原文件名仅内存标识，不是新Vite content-hash产物；没有实际构建/namespace身份/运行时/E2E/时延资格。输入16chunk和manifest前后实核不变，候选完整JS未落盘；[探针报告、确切脚本/协议/工具锁及归档审计](performance-evidence/format-only-20261020/README.md)明确此边界。**保留产品仍all80494/77227.7 FAIL；M3未退出，未推进M4/M5/M6或发布。**

## 40. Uglify与严格scalar共享的固定有限排除（2026-10-20）

对未窄化dynamic namespace的具体再审没有新死导出，accuracy等已由10/13库存排除，不重复套facade。新的Uglify3.19.3仅在Temp ignore-scripts安装，锁/安装元数据归档；原5组/es2022/write:false配方固定OXC/候选三轮共6次，接收421864B原renderChunk输入，不是OXC二次压缩。原80494/42985/235647；候选80355/42724/229359（all/cold/raw），lazy反增122B，总收益仅139B（约0.17%），未采用。输入/最终96+96文件实核一致，三轮各自指纹重复；Acorn显式ES2022语法、原阶段隔离、最终真实字面闭包/native绑定通过，不授予完整API/时序/E2E/性能资格。

再固定baseline/clock/HMS/combined四变体×三轮真实构建，不改源码：将相同coercing finite clock和三处HMS上界短路分别共享，保留wrapper、getter次数、原regex/日期/时区/异常边界。clock最优仅all80461/cold42982（−33/−3）；HMS80482/43007（−12/+22），合并80472/43007（−22/+22），不可相加，均未采用。16chunk及记录拓扑digest同，各自三轮指纹同，12次实际图/绑定通过；拓扑完整preimage未单独保存，不夸大独立重建。

124clock+4806HMS的4930逐case原/候选trace全保存，primitive输出、访问/调用/coercion、短路与sentinel/name/message相同，不比stack。trace完整归档instrumentation在12次build后补入，再跑一次trace-only产生原件，0次新build；不隐去脚本时间边界、不称完整API等价。全部439原件/8544431B压缩归档已新Temp解压逐文件实核，含18次完整产物、输入、各轮报告、变换源码和工具/锁/4930对trace；没有另存完整原stdout。详见[完整排除证据与局限](performance-evidence/bounded-minifier-scalars-20261020/README.md)。

现73业务JS LF规范化逐字同冻结源（690165B），原site127/92507677B、critical4bda36bc不变。新实际图命令PASS、原预算命令仍exit1/all80494>77227.7，至少差3267B。未重跑全量测试/build/E2E/时延，不把第38节原回归伪称本轮新执行；未修改业务/项目依赖/构建配方/预算/版本，未提交推送/merge/deploy。**M3 IN PROGRESS /15.0.2**；有限失败集不是全程序优化不可能性证明。

## 41. 私有纯字符串池固定离线预筛：gzip反增，未采用（2026-10-20）

原16份OXC chunk实际静态图为DAG/18边、无direct eval/with，固定只合并重复纯字符串值，避开directive/import/export/key/tagged/插值/regex。原v1先预声明，但首次候选重解析因keyword相邻模板值缺少token分隔而失败，0个有效gzip/link样本；保留工具/协议/失败事实，不当作产品故障。获批v2只统一(alias)、每次估算+2B、声明换行分隔，不调scope/阈值/别名顺序。继承stateAtCreation仅表示原v1预声明，不伪称v2也早于首次扫描。

固定baseline/pool、pool/baseline、baseline/pool六次离线核验：原all80494/cold42985/raw235647；唯一池化81135/43337/228068，raw−7579但all **+641**、cold **+352**，各侧三次指纹相同。153组/1117处逐位置AST值/回填与导出名检查、六轮实际字面闭包/native静态绑定通过，不evaluate；独立审查实读96chunk及16对AST复核，无新试验。旧hash路径只作离线标识，不是六次Vite构建或完整运行/时延资格。停止、不采用、不再调参。

全部129原件/2978941B已归档，新Temp解压逐项实核；保留完整候选/轮次字节和测量后精确复制且输入SHA一致的manifest。v1失败候选与单独终端日志没有保存，明确不冒称完整捕获。详见[结果、时间边界及原件](performance-evidence/string-pooling-20261020/README.md)。当前73JS/127file产品site/recipe/graph工具前后相同；新现产物graph命令PASS、原budget仍exit1/all FAIL。未重跑完整test/build/E2E/时延，未改业务/构建/依赖/预算/版本，未提交推送/合并/部署。**M3 IN PROGRESS /15.0.2；原缺口至少3267B，未进入M4或发布。**

## 42. 原计划刷新计数诊断、有界内存Store与代际观察链（2026-10-20）

按计划6.3/M3工作包审查，发现scope已有计数但App未保留/诊断中心未展示的P2交付缺口；不是新报价错误。新增独立observer及最多current/lastSettled/lastCancelled三个内存记录，严格字段/枚举/数值白名单，不含code/name/金额/Token/原文/Quote，不写Storage/云。原coordinator方法/Promise身份/取消日志规则、金融校验和私有plan投影未改，AST护栏只新增闭合forEach聚合并保留逃逸负控。UI显示计划与实际请求、cache hit、dedupe、已进入请求中止、资源取消拒绝、写尝试/成功；未观测null不补0，细粒度fetch原因未记录时明确说明，最终Quote指向原逐基金数据说明。

旧executor7项3PASS/4RED、view2RED、Store缺导出及invalid-final RED、真实旧site缺诊断行RED均保留。3项旧PASS原本未调用observer，不当作旧bug；最初E2E错误locator另存。补late metadata真实挂起取消GREEN，所有任务收敛前不发终结报告，不追加旧UI/cache/coordinator日志；Store同步onError重入另负控1RED再最小调序GREEN。最终定向122/122，全量1133/1130PASS/0FAIL/3既有Windows skip（6780.9319ms）、syntax210、Chrome32/32（1.1m）、官方audit0。

E2E后固定epoch1792046773三次真实build全127file/92528422B相同：critical168ae0c7659a187ce175c5d1b519fd7ffe0d5694be4239754b5be5f4a9b976f6，whole JSON b11fd93f。app16/242222 raw，cold44386/52241 PASS、all83084/77227.7 **FAIL**，相对改前all+2590/cold+1401，至少差5857整数B；这是原功能交付成本，不是减包收益。228选定source/tool/test/config在构建前后同，实际图16/18静态/10动态/6cold及native绑定通过；OCR23/88196906B只核字节、未运行引擎。旧800时延PASS不授予新源码，本轮没有新相对时延/真机/真实金融源或CI。

56原件/1340210B压缩归档后新Temp解压逐项验证，含完整捕获命令、源/测试副本、diff、RED/GREEN和合成浏览器附件。初始executor RED/临时核验器wrong OCR root失败的完整原终端只在工具历史，不冒称全部捕获；核验器修正后重新完整三轮，不把工具错误当产品缺资产。另对Closure作官方源码前提审查，顶层await/ESM条件不合，未安装或压缩。详见[完整实现、口径、失败与证据](performance-evidence/refresh-observability-20261020/README.md)。**M3仍IN PROGRESS /15.0.2，未改原预算/版本，未提交推送/合并/部署，未进入M4/M5/M6。**

## 43. 原决策单次聚合的十项计划原因与AST解构负控（2026-10-20）

私有planner新增显式可选第二参数，原七项input getter顺序/公共plan/core/default投影不变，在原force/skip/同一次cache core上累计十种原因，成功冻结后一次固定DTO通知。executor仅闭合局部赋值，原三个外部报告时点增加planReasons；Store复制白名单/自有描述符/安全整数/null与0/冻结且保持旧记录形状，不增三槽或持久化。UI十标签明确“仅表示计划时决策；实际执行gate细因未记录”，不由source当前health伪造cooldown。原fresh计划消费时过期、三种claim拒绝均由真实scope/coordinator测试，计划原因不回写成实际请求。

新DTO缺失5RED、planner/AST新增契约9RED、浏览器真实旧site缺行RED后均GREEN；独立审查另找到AST解构binding未验证Identifier的测试护栏空白，6真实负控RED后仅修测试三处检查。不是生产已有泄露。新增境内/QDII活动基金冷暖observe开/关的provider/UI/finance/cache逐字相同样本，连同空组合与消费门控两例属于GREEN补覆盖，不冒称原RED或全输入域证明。

最终全量1159/1156PASS/0FAIL/3既有Windows skip（8044.4173ms）、syntax211、原生Chrome32/32（1.1m）、官方audit0。E2E后固定epoch1792046773三次原配方build全127file/92532345B同，229选定source/tool/test/config前后同；critical581f8068961daccbe5afbb60368c87412075e00692e2969ec1176eba333c85e2，whole JSON86d3e5fe。app16/raw243660，图16/18静态/10动态/6cold及native绑定通过；OCR23仅核字节，未运行引擎。

本轮功能all+563/cold+128/raw+1438/whole+3923：cold44514/52241 PASS、all83647/77227.7 **FAIL**，至少还差6420整数B。无新相对时延，旧800不继承；没有新CI/金融源/真机/云写入/生产验收。Store adapter减包想法止于只读前提否决，无可信材料性假设，未写变体或跑参数/构建预筛，不伪称实测收益。

105原件/2208839B归档后新Temp解压逐文件实核，包含完整日志、精确最终源码/测试和16chunks，保留夹具/调用错误边界。详见[实现、口径、原件与限制](performance-evidence/plan-reasons-20261020/README.md)。**M3 IN PROGRESS /15.0.2；未改变预算/分组/目标/依赖/版本，未提交推送/合并/部署，未进入M4/M5/M6。**

## 44. 实际执行拒绝事实、同步估值观察与新Vite告警（2026-10-22）

原6.3需要“为何跳过”，不要求新增全面执行审计系统。本轮只在估值/重仓/模型原拒绝点聚合五键executionSkips，区分claim拒绝与半开本代额度已用；不从当前health反推cooldown，不改registry/两个coordinator/scope/security batch/金融规则。估值私有第五bool seam仅同步首次合法、所有实际client调用均观测才给数值，否则null；默认arity4、原业务参数与claim.allowed单次读取不变。Store严格白名单/复制冻结、started-only终态null及晚drain真实补数；UI说明次数不是唯一资源/请求，原三槽无持久化。

Store/view真实缺实现11RED→39/39（含中断前9项测试，非全本轮新创）；旧真实site缺行RED。新48项AST/VM/collector契约仅GREEN与独立旧函数/call负控，无live实施前App/executor业务RED。真实registry/coordinator六例覆盖三类claim拒绝、两类本代半开额度及混合共享证券仍请求。新非零Chrome例三次失败后公开online第四代，估值请求0/拒绝1、官方1.19→1.2/+0.84%及9-28日期/稳定缓存保持，无私有hook。首次全E2E32/1失败是新夹具标签错写“正式净值”，仅改为既有“最新净值涨跌”，保留原件后全33/33。

最终全量1224/1221PASS/0FAIL/3既有Windows skip（8005.9732ms）、syntax212、Chrome33/33（1.1m）。E2E后三次固定epoch原配方build全127file/92537133B同，230选定输入前后同；critical3103251a7107ebb76d61c0a7131430ccf221e204e6aac931a319649c7608bf55，whole JSON5b946d23。app16/raw245170，图16/18静态/10动态/6cold及native绑定通过；OCR23仅核字节未运行。all84187/cold44699，分别+540/+185；总包预算native1，至少差6960整数B；无新相对时延，不继承旧800。

本轮audit先bulk端点network timeout退出1，限时单次重查收到**1个high依赖项vite@8.2.2（6条GHSA）**再退出1；旧audit0仅历史事实。官方列8.2.4修复，未force升级/安装/改锁，需后续隔离资格。Vite是build工具，serve是自写Node；未证明线上静态PWA已可被利用，也不把依赖告警忽略。本轮另对固定schema共享只读否决：极乐观可替代池约822B minified raw（不是gzip收益），无可信材料性候选，未新变体/扫参数。

93原件/2411303B归档新Temp解压逐项验证；[完整口径、验证、审计与原件](performance-evidence/execution-skips-20261022/README.md)。**15.0.2 /M3 IN PROGRESS；未提交推送/合并/部署/升版，未进M4。** 原M3仍需预算/最终候选性能/精确CI与安全审计；精确gate细因历史并非另加硬门禁，M4云与M6真机不提前扩大M3范围。

## 45. Vite同minor最小安全补丁：隔离资格通过，root审计服务仍UNKNOWN（2026-10-22）

先冻结协议，再复制当前dirty源A8.2.2/B8.2.4，只允许两个依赖文件五标量，其他107锁entry不变；两个独立clean install保持ignore-scripts和原五项白名单，仅显式批准esbuild安装器。全copy270/214510943B含24个.codex-tmp历史输出202403286B，非230所选源范围；A首轮必须复现原root全site锚。57实际装包仅Vite不同，其余56个manifest及三个native文件同；B内联launch-editor/middleware2.14.2实装拒绝newline/%/UNC。

六次实际build顺序A1,B1;B2,A2;A3,B3全127/92537133B字节同，whole JSON5b946d23/critical3103251a，source/lock前后同；A/B各完整1224/1221PASS/3skip、syntax212、Chrome33/33，候选audit一次timeout后唯一限时重查JSON总0含dev。A1工具误读string.sha256有notes，certify只读核原保存报告，无替换build；没有独立捕获原assertion完整堆栈，不夸大归档。

独立最终screen通过后仅回写root package/lock五标量。root再clean install、完整1224/1221PASS/0FAIL/3skip（7234.0174ms）、syntax212、Chrome33/33（1.1m）、三次build全同，actual graph/static binding/OCR23字节通过，未跑OCR引擎。原all84187/cold44699/raw245170不变，预算native1，仍至少差6960整数B；字节身份不是时延实测或旧800资格，原依赖锁比较仍严格不同，没有waiver。

**root官方audit首次503、唯一限时重查timeout，均nativeexit1；本轮已到两次上限，不再试到0。root审计UNKNOWN_REMOTE_SERVICE，补丁已回写保留但最终安全资格未闭合；不继承B0或继续报旧Vite1high为最新root结果。** 503中的短效bot cookie仅公开归档遮盖该header，原件SHA及遮盖范围可审计，本机原件保留。完整[预声明/结果/原件范围](performance-evidence/vite824-security-20261022/README.md)与机器报告区分隔离screen和root状态。

484份成员/16264236B归档后新Temp解压逐项实核，包含246份非历史A输入、B两依赖文件、九轮app字节/全库存及独立root最终审查；24个非构建旧输出仅保留完整库存，不混称原270副本全归档。root独立只读审查确认已回写行为/字节PASS、审计待服务恢复，M3仍FAIL；未重跑测试或网络。

**15.0.2 /M3 IN PROGRESS，未提交推送/合并/部署/升版，未进M4。** 新patch不是新压缩策略，未改变ES2022/五组/安全/金融/缓存/兼容约束。仍需服务恢复后的独立root安全审计，以及最终候选预算/性能/精确CI；无真机/云写/真实金融或生产新资格。

## 46. 独立单次root审计闭合与当前重复职责有界复核（2026-10-22）

前回合完成patch回写/全量QA/归档，属实际进展。本回合先声明独立probe只一次官方audit、不重试，03:20:06.210→03:20:07.814 UTC实际native0，完整JSON vulnerabilities{}、全部severity/total0含dev71，原6GHSA absent。新请求前后270输入和127全site行同上轮B/root3，68安装manifest/native/hidden-lock库存SHA2da11b47及20旧收据SHA全同；独立只读复核也重新hash确认，不用B0替代root。Vite8.2.4本地资格最后缺口现闭合，旧503/timeout/UNKNOWN不覆写，旧全tests/33Chrome/9build不是本轮新执行。

另三路只读审查没有新材料性候选：实际16chunk/1137函数及418大block/8完整常量跨组定位仅既有100B clock；三槽cell只约20行框架，新诊断完整状态机/strict复制仍需保留；storage normalizer多调用不是多副本、migration/getters/notes/tombstone/backup晚枚举不同，公开兼容路径不少已tree-shake。无新源码变体/build/压缩探针，不把raw或整组体积冒充收益，有限否决不证明全程序不可能。详见[完整证据及方法边界](performance-evidence/audit-closure-20261022/README.md)。

原预算CLI新实际native1，all84187/cold44699，仍差6960整数B；无新相对时延/精确CI/设备/金融/云写/生产资格。**应用15.0.2，M3 IN PROGRESS，未进M4或发布**；后续合法新时延对照也不能覆盖all FAIL，不改变ES2022/五组/预算/启动/安全/兼容规则。

## 47. 当前诊断/Vite8.2.4同依赖新参考与一次时延预声明（2026-10-22）

第37节旧800针对诊断前源码/Vite8.2.2/Chrome155.0.8059.80，不能继承给当前源码。先写[新独立协议](performance-evidence/pair-vite824-diagnostics-800-20261022/README.md)，再用单独Temp index建立仅本地新参考057042963a33579c624a41404a6d533dfda29768，父c298，树仅package/lock五个Vite8.2.4字段；所有v15业务对象不动，原预算锚40e/70207B不改。root HEAD/branch/index/工作树未因创建参考而改变；新ref不推送，保留parentepoch是明确的测试元数据，不冒称产品发布日期。

严格normalizedLock同db907972/declared同，原唯一root.engines忽略不变；270输入/127输出/68安装身份新前检同，sampler2ca7545/collector8a98f57不改。固定800/4/5000/seed160003一次，不重试/续补/混样/试N；原managed snapshot、独占loopback和安全cleanup不改。此节仅准备/预声明，不是采样结果；后续以唯一活进程及最终新JSON为准，tracked文档在采样期间冻结。

无论新时延结果如何，**原all84187/77227.7仍FAIL，至少差6960B，M3 IN PROGRESS，不能进入M4/发布**。这是补独立门禁，不是把成功定义缩到时延；仍须最终候选总包/性能/精确CI全部通过。未将旧全量QA称本轮新跑，未提交业务/推送/合并/部署/升版。

## 48. 当前诊断候选800配对通过、精确独立复核与参考构建重现（2026-10-22）

唯一采样2026-10-22T03:41:39.305Z→04:16:50.991Z完成，native0/PASS，完整800retained+4warmup、AB/BA各400，失败/不完整0，无重试/剔样/混样/改参数。原sampler/collector与5000/160003/30000ms不变；strict同依赖参考0570429只在两个package文件补五个Vite8.2.4标量，原40e/70207B预算锚不动。新raw88,032,041B / SHA256 46aeb7a3ad8908bf256ffe4b17e706e59fddd282e5bdcbed994780222a9bf49f。不是旧800的继承结果。

cold median/p95 129.35/167.80→119.85/156.80ms（−7.344%/−6.555%）；warm67.15/96.50→60/86.10（−10.648%/−10.777%）；save75.30155/86.98140→64.54230/72.944（−14.288%/−16.138%）。原ratio及95%上界、p95区间稳定性、<3000ms与bootstrap fraction门禁全通过；current max420.6/196.9/91.0366保留。独立v2共9,663检查0失败，原summarizePairs整个对象精确重算一致，原rendererDelta全部4,824条重算一致；fraction1不是总体100%通过概率。

pageErrors0/instrumentation0、每侧2412drains全SETTLED、原四清理PASS；**consoleErrors17,687**（reference7235/current10452），没有console文本关联，不能由阻断数量相同证明根因。SW event/controller/registration/script0，但registrationAttempts4824是三边界重复观测；导航3216条PARTIAL/save1608条MEASURED，不是完整startup/OS CPU。桌面390×844/Chrome155.0.8059.86、no-store同context暖重载、合成UI保存，不是暖HTTP缓存/真机/生产源/Gist写入/OCR引擎或新CI。

结束后先保留118929B测量窗口tracked patch（SHA c90f6da5），再改本报告；raw前后source/HEAD/branch/index同，独立完整重新枚举270输入无额外/缺失，127当前site/68安装字节同。原reference110成员前后同且已清理，不冒称重读原payload；另先声明新快照重建，原helper/依赖/epoch/命令连续三次native0，全110文件精确等于原before/after库存，完整stdout/stderr/native收据保留，root/site未重建。独立v1唯一错误为跨合法时间阶段强比diff，native3原件保留；v2只删该错误断言，不放宽任何同阶段/source/statistics检查。

详见[完整结果/区间/原件范围/失败口径](performance-evidence/pair-vite824-diagnostics-800-20261022/RESULTS.md)。488原件/23974262B归档（compressed10239633B/SHA133d4326）另新Temp解压逐项验证，246非历史输入及两侧非OCR输出实字节保存，270全库存含24历史Android输出，不能混称全payload；raw在上一级独立保留。本次未重跑旧全量tests/check/E2E/audit；新主postflight7项通过和预算CLI **native1** 单独记录。**all84187>77227.7仍FAIL/至少差6960B，15.0.2/M3 IN PROGRESS，未进M4、未产品提交/推送/合并/部署/发布。**

## 49. Worker同文件边界有限资格通过，但单独拆分增包、不采用（2026-10-22）

先实读实际source-health/Bridge/renderer排除旧通用factory或整个函数的虚假收益池；另真实coordinator/executor/Store双合成案例证明producer稀疏provider键和计划顺序还需Store唯一严格规范化，未写跳过validator候选。更大EvidenceBook设计纠正“公共API保留就必须留在默认bundle”的错误前提，但没有合格≥6960B净gzip预测；旧持久化codec、独立模型证据及不同写入时钟仍要保留。

只在Temp从冻结246输入准备一个三文件候选：Worker同文件header/items/tail+两个固定endpoint入口，原Error/normalizer前缀及public签名/default不变，两客户端仅import/callee切换。主代理648项静态库存/完整源码重构检查通过。旧实现固定64案原root/冻结源全同；候选generic64对stored/fresh旧全同、fixed52对独立旧bound完整全同，235调用和3负控，无候选trace过滤；真/伪class rescue、late sentinel/key/symbol/null/NaN/-0与ChangingDate三钟保留。主代理178项原件独立重算通过，有限合成资格不是全API/输入域证明。

两侧各一次固定六文件接口/HTTP/request-signal测试97/97、native0，0fail/cancel/skip/todo。原生输出实际为spec，虽文件名stdout.tap，不冒称TAP/改reporter重跑。随后原配方/五组/ES2022/epoch1792046773唯一A1 B1 B2 A2 A3 B3六轮全native0；A三轮全127原锚4e8dddb5精确复现，B三轮全127同83ffa409。A all84187/cold44699/raw245170，B **84257/44702/245505**，即all+70/cold+3，候选至少差7030整数B。固定四后检graph两侧native0，budget两侧真实native1/FAIL，不把记录器完成0包装成预算PASS。

主代理再139项逐个重读六份127完整payload、两最终site及root/site，重算每chunk gzip、完整native输出SHA、97项spec footer/成功行及后检收据；通过。每窗口A/B246、root270/127、68安装及Git身份同，最终只读capture05:27:17.303Z后才改root文档。未修改产品源码/依赖/配方/site/版本，**该单独候选不采用、不继续扫参数**。详见[完整方法、原件与限制](performance-evidence/worker-seam-20261022/README.md)；归档审计明确完整本机site与归档selected-site的范围差别。

684成员/88898119B归档为12304770B（SHA2c58de67），新Temp解压全量逐项核验同。完整六份site本机保留，归档只保每轮chunks/manifest/index/SW加全127库存、246baseline源/三文件overlay与完整行为/原生记录，不冒称六份完整payload均在包内。主包后另保存[完整下一HTTP纵切面规格](performance-evidence/worker-seam-20261022/next-http-boundary/README.md)，明确opaque先用后剪、二钟rescue、双Quote/模型碰撞和两writer的topunknown/时钟差异；没有实现或收益承诺。最终独立23项/native0确认270源/127site/68安装和HEAD/branch/index未变，9项规格源码SHA匹配、归档684成员不变，diff-check0；文档有意变化。

root仍all84187/cold44699、原预算FAIL/至少差6960B；第48节800与第46节audit为旧同身份结果，不称本轮新QA或继承给B。无新完整tests/check/E2E/时延/CI/真机/真实金融/OCR引擎/Gist/生产资格，未提交业务/推送/合并/部署。**15.0.2 /M3 IN_PROGRESS，未进M4/M5/M6或发布**；后续只对完整估值管线建立兼容字段/净删图，再独立验证一个有限整边界候选，不把本次功能前置资格冒充减包完成。

## 50. 完整管线前置边界、独立OLD记录与双模型来源缺陷（2026-10-22）

本轮按原升级目标继续推进，属于PROGRESS，不是M3完成或阻塞。先从实际冻结246输入建立一个新Temp候选，仅把Worker原validation与late-spread legacy finisher分开；原公开签名/default、校验读序不变。唯一一次公开边界对照64案stored OLD/fresh OLD/candidate完整同，3负控匹配，共131调用/native0/stderr0，denied网络与真实Storage均0。尚未实现私有HTTP/resource/aggregate importer/模型/App纵切面，**不声明任何默认构造器退役或净gzip收益**。

独立代理另外执行真实OLD→独立frozen OLD：R01/R03/S01/S03固定234/234完整同，native0，599资源子操作/侧；最初冻结缺calendar JSON的native1/completed0原件保留，单独纠正冻结closure而不改case/runner。A08/M04/C01固定34/34实际OLD记录同，但原forecast仅33/34对，HK预计entry而真实rejected，baseline native1保留；后验季度candidate kind推断另native1保留。后续只读核验成功不是洗掉旧失败或候选PASS。HK未来acceptance correction只绑定实际OLD完整rejected，不修改旧case/validator。

主代理完整读两份报告并由独立代理复核：234未测真正inherited顶层五键，scope不是cache-hit/cancel完整矩阵，异常不是全prototype契约；App使用真实AST原文但不启动DOM。M04显式调用accuracy入口，不证明真实App enriched路径已有hook。有限原始控制不替代任意输入/全生命周期/真实金融源或设备测试。

真实沪深300配置使境内cn-index同时合格于重仓和市场模型。重仓先写1.2%/coverage60，市场后写3%/coverage100且遗留双flag，季度wrapper读取后写数值并继承est_model，产出quarterly来源的model_estimate候选。这是可达的候选provenance **P1-M04-PROVENANCE**，不是必须永久兼容的正确行为；本批最终selected是market-model、主Quote/金额与3%一致，未证明线上发生或金额损失。正常缓存已有selected Quote优先，无Quote旧缓存路径未在本批跑。后续来源修复需单独定义两模型独立证据/旧cache缺证据策略，不能只强改kind、悄改旧oracle或以压缩为由改变业务覆盖政策。本轮仅向Temp协议追加纠正说明，**未实现该修复，也未改root业务**。

完整默认图复核发现fresh/旧cache仍回到通用候选器，详情holdings仍回到generic parser，freshness在resource/cache/render仍活；只迁移HTTP不能闭合退役。完整切面还包括静态namespace、第二钟和真类rescue、opaque先消费后剪、presence codec、三路旧aggregate、官方与独立模型投影及两个不同outer writer；新codec本身有成本，不能把搬迁原始字节相加当6960B收益。

详见[完整检查点及覆盖界限](performance-evidence/pipeline-boundaries-20261022/README.md)。四个完整冻结Temp工作区加父级工具/原身份库存共916文件、128278491B，归档13253373B/SHA256 `28d433c676c4fbf33a222ef1a8cd5bf1cfabd698309463dd2f308e7882345960`；新Temp解压全部成员字节/SHA同。主23项原件/库存/root270/site127/安装68/Git复核native0/stderr0；git diff-check0，9条旧LF→CRLF告警原样保留。archive-audit/原生收据等为包外addendum，原root完整site/依赖payload不在包内，库存不能冒称payload。

本轮无build/新完整tests/check/E2E/audit/时延/CI、真机/生产/Gist/OCR。rootall84187/cold44699未变，原all预算仍FAIL/至少差6960整数B；旧800不继承给Temp改源。候选未采用、无业务提交/推送/合并/部署/升版；**15.0.2/M3 IN_PROGRESS，未进M4/M5/M6**。

## 51. 双模型独立来源P1本地修复、消费者回归和新构建身份（2026-10-22）

前回合完成旧控制和可达缺陷定位，属PROGRESS；本回合先写独立正确性协议再修复，不把共享est_*错配当必须兼容oracle，也不冒充压缩等价候选。真实OLD13唯一执行全部完成，7金融来源RED/6控制PASS/native1；固定案例和测试字节不变，早期GREEN与最终green-02均13/13/native0。逐case网络/Storage守卫不覆盖imports，原13没有完整selected生命周期断言，这些有限边界明确保留。

只改五业务文件：holdings-estimate与fund-model-enrichment成功安装时分别冻结独立模型证据；quote-normalizer拒绝新槽换基金/损坏/计算或时钟周期不符、保留unknown/0及旧单模型适配、旧双flag无证据双向不可usable；app传入真实安装采集时间、保留已有selected优先但对绑定/到期失败降stale、说明绑定同源Quote；accuracy入口不再跨源或用旧共享值补未知版本/置信。保留两模型功能和原quality排序，不删除资源验证。旧记录selected市场值正确，未由此证明线上主金额损坏。

最终同源码新门禁：1304 tests中1301 PASS/0 FAIL/3原Windows skip，语法214，Chrome34/34；原配方/五组/oxc/ES2022/固定epoch1792046773三轮build完整127文件逐字节/SHA同（行SHA4182f49e）。新60+20测试覆盖独立槽/identity/accessor/null/0/JSON/时钟/有效期/旧cache/说明及accuracy入口；新增真实App E2E沿bootstrap/Bridge/refresh/render/cache reload，基值1.2、重仓1.2192/1.6%/80%、市场1.236/3%/100%，选择市场、金额123.6/3.6且说明不串源。全部外源合成、固定日期、桌面Chrome/SW blocked，无真实用户Storage/Gist/金融源。

原生失败保留：test-01旧集成源码正则未含新fetchedAt参数，native1；e2e-01新fixture混用股票与指数涨幅，33/1/native1；e2e-02新fixture的??1把显式null变1，32/2/native1。只纠正夹具/对应显式参数文字，未删旧缺值断言；e2e-03为最终34/34，stderr两条NO_COLOR/FORCE_COLOR告警。三轮生成目录在构建前recoverable move到本次Temp，失败trace/screenshot原件全保留。list reporter未落盘成功用例内存attachment，不声称该JSON原件存在。OLD事后postflight因三份源在采样后被修复而native1也原样保留，不篡改为窗口漂移或PASS。

当前16chunks raw252257、**all85956/cold46129**，相对旧84187/44699正确性成本**+1769/+1430 B**。原预算CLI实际native1/FAIL，all上限77227.7，至少还需压减**8729整数B**；cold<52241不能代替all。新graph静态bindings/literal closure通过，evaluated/startupOrder/dynamicNamespace仍未由该CLI证明。第48节修复前800不能继承，未新跑统计时延/精确SHA CI或网络审计；依赖安装/锁身份同只证明本次未变，不冒称新audit。

独立只读终审未确认新的实际App可达P0/P1，但**accuracy自动生命周期未闭合**：现有hook仍在primary publish且只筛海外，enriched仅更新投影；单测显式调用入口，新E2E没有accuracy ledger断言。可称入口归因、0/unknown和过期规则已回归，不能称异步模型预测及正式净值结算全流程已验证。数据判定CONDITIONALLY_TRUSTED仅限本地有限provenance，非全应用/生产TRUSTED。

详见[方法、完整结果和范围](performance-evidence/model-provenance-fix-20261022/README.md)。两完整Temp工作区、最终248份非历史输入payload、selected构建文件及全部272源/127site/68安装库存共**791成员/33481328B**，归档**11490572B / SHA256 0c127a5bb5fec6ab518a4308c9a59d4f6337fd631cf15553f42d4f3cfb75fde1**。全新解压逐项字节/SHA同；主30项native0/stderr0。24历史Android输出和非selected site/安装payload仅保库存；审计结果及事后收据为包外addendum。最终272输入只比前270有预定8文件修改+2新测试，Git HEAD/branch/index及68安装同，既有脏修改保留。

应用仍**15.0.2 / M3 IN_PROGRESS / NOT_RELEASED**，未进M4/M5/M6，未业务提交/推送/合并/部署/升版。后续先把未闭合压缩原型对齐本次正确性基线，完整行为边界和净gzip合格后再谈采用；全v16预算/新性能/精确CI、Gist/OCR/PWA/真机/生产门禁不缩小、不跳过。

## 52. 海外accuracy异步enriched自动预测与正式净值结算的有限闭合（2026-10-22）

第51节的accuracy缺口作为独立正确性修复处理，不混入压缩等价性实验。先保留旧App/E2E字节和协议，再用真实App/Bridge/render/cache的合成US交易日场景定位：OLD `red-04`已满足模型来源/有效期/显示/独立证据断言，Quote为market-model、value1.212/change1/base1.2/Sep25→Sep28、status model，但自动ledger仍0，native1。原accepted-session案例47197B/SHA256 `ad8f19e09deecc4bfaf039b89cbf72336a1d62cb94b6cd02fbf66e1eda7320cb`完全不改，独立重建修复产品后的`green-01`真实1/1/native0；不是两个新wrapper互比，也没有显式调用accuracy入口。

本轮相对第51节只改`js/app.js`、既有`e2e/v16-refresh.spec.js`并新增`test/accuracy-lifecycle-v16.test.js`。primary与enriched共用`updateCurrentFundAccuracy`：仍只筛海外类别，异步import完成后经原generation `context.commit`，并要求该code当前fund对象仍与传入投影同一，防旧代或同代已替换对象写ledger；成功更新后安排原去重渲染，加载/更新异常维持静默降级。enriched不重新走带自动改名/持仓事务的完整primary publication。两模型计算/排序/独立槽与Quote规则、accuracy核心算法/持久化格式/时钟/去重/结算不变，没有新增云写或金融源。

新增12项单测执行实际App scheduler函数体，仅将ESM import换成受控延迟loader，覆盖当前对象、非海外、取消、同代替换/删除、其他基金变化、两个import完成顺序、load/update/render异常，以及两发布路径接线；这不是完整ESM/DOM证明。正式E2E另走真实模块自动链：合成中国Sep29 14:30、最新US close对应Sep28，尚未公布的**目标NAV是Sep28**，不是中国Sep29当日收益。以Sep25正式NAV1.2预测1%/1.212，ledger保留prediction_date Sep29、target_nav_date Sep28、rule-v1/confidence0.35。暖刷新后整条ledger及recorded_at相同，只证明结果幂等/不续时间，不声称零Storage写入。下一中国日公布Sep28 NAV1.224，原预测结算为predicted_change1、actual_change约2、error约−1个百分点、方向正确；selected转为official_nav，旧US行情不得虚构Sep29新目标。以上全部为合成数据，不是实际金融源/生产结算。

原生失败全部保留：`red-01`的CJS fileURL import、`red-02`的完整标题grep均未执行有效测试；`red-03`真实执行但模型交易日PRECONDITION错误，被产品正确拒绝，不能当accuracy RED或改判PASS。另立accepted-session声明后才跑`red-04`，其ledger 0为有效RED。原stdout/stderr/JSON/trace/screenshot和后续GREEN独立输出不覆盖、不筛除。正式`gates/e2e-01`的成功用例另保存`actual-accuracy-lifecycle.json`，不是把旧未落盘attachment补称原件存在。

最终本地门禁已实际执行：`gates/test-01`为1316 total、1313 PASS/0 FAIL/3既有Windows skip/native0；`check-01`语法215/native0；`e2e-01`为桌面Chrome35/35/native0，stderr保留两条NO_COLOR/FORCE_COLOR告警。原配方、五加载组、OXC/ES2022与epoch1792046773不变，`build-02/03/04`各native0，完整127行产物库存相同，行SHA256均为`0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`；16chunks raw252331、all85969/cold46149。相对第51节正确性成本all+13/cold+20 B。`budget-01`真实native1：all85969>77227.7，至少还需**8742整数B**；cold<52241不替代all。`graph-01`native0只证明literal import closure/static bindings，仍`evaluated:false/startupOrderVerified:false/dynamicNamespaceMembersVerified:false`；预算CLI仍`importClosureVerified:false`。

身份范围明确：各gate收据before/after为272个noDocs输入；加固定`docs/v15.0.2/IMPLEMENTATION_FEEDBACK.md`是273完整输入。`current-control.mjs/CURRENT_CONTROL.json`将其与第51节272完整输入比较，精确为App/E2E两文件修改加一新单测；其余原输入保留。当前raw值以实际chunks/build求和252331为准，不把control继承的旧raw scalar252257当新结果。此前A/B重基线公开64案stored OLD/fresh OLD/candidate三路全同、3 controls/131调用及2×97定向测试，只绑定第51节旧272身份，不是当前273候选资格；其首次filename错误/native1与v2独立原件保留。Closure Java API/metadata报告同样只是旧身份只读前提审查，没有下载Java/JAR、运行压缩器、产出hybrid或采用任何压缩策略。后续完整候选必须重新对齐当前正确性基线。

详见[独立协议、实际原件与覆盖边界](performance-evidence/accuracy-lifecycle-fix-20261022/README.md)。归档后addendum：1196成员/62962286B，压缩25355843B/SHA256 `893e5a0128bdd4af995744c0ef658c1d228d9632a47060a1e2270093b011fbc3`，新解压全部字节/SHA同；主28项PASS/native0。273完整源行SHA `d0d9554fef7d2ef4b75f67a7db4fef558e03bb03f0897f2305617c6361090a3e`、127site/68安装与Git窗口前后同。diff-check native0的既有1822B换行警告保留。第51节来源证据和旧失败保留历史原文；本轮只把上述自动预测/暖结果幂等/一次后续公布结算的本地有限链闭合，数据判定仍为**CONDITIONALLY_TRUSTED（合成、本地有限范围）**，不扩为全应用/真实金融源/生产TRUSTED。

当前仍**15.0.2 / M3 IN_PROGRESS / NOT_RELEASED**，无新统计时延、精确SHA CI、网络安全审计、真实金融源对账、Gist/OCR/PWA/真机/生产资格；第48节旧800不继承，未进M4/M5/M6，未业务提交/推送/合并/部署/升版。总包预算、最终候选新性能及后续v16门禁不缩小、不跳过。

## 53. 固定Closure前置实际执行：输入解析桥接异常停止，不采用（2026-10-22）

在用户允许独立验证新压缩策略的范围内，于Temp单独获取固定Temurin JDK21和Closure v20261020，不安装到系统、不改PATH/JAVA_HOME或root依赖。首个JDK请求180秒超时/native1，留下109600832 B partial；另行预声明一次同源HTTP206范围续传，复制到新文件追加、原prefix前后同，完整205073461 B/SHA `f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e`实校验；JAR14997454 B/SHA `7dfedc111cb06024d3aa132443cd4952da415635c59342d84d96883083df853c`实校验，Java/javac/Closure版本native0。这只是工具资格，不冒称策略可用。

冻结唯一Java API SIMPLE配置：in/out ECMASCRIPT_2022、NONE+moduleRewriting false、LOCAL/property OFF、getter/property假设false、无runtime/polyfill注入、dependency none/no alias、不optimizeCalls/ADVANCED/wholegraph/extern猜测。8个固定ESM/副作用/arity/error/Proxy/clock夹具和4个真实support，original/transformed各全新Node进程并分别对固定期望；只编译一个实际source，support不交编译器。执行前review修正合法export declaration布局支持、Symbol/descriptor覆盖和manifest后验绑定；混合原生stderr只能待人工审查，不自动8/8。manifest2085B/SHA `4e8d73bfadf03c5d6fd4cd6477b95cbc0ec99a101d5d315dd92624d0bf73d6d1`，共16准备文件/53798B；没有运行后改源或期望。

唯一run-01在08:19 UTC实际：Java版本0，F01原版sanity0，keys/arity/值/身份和fetch/Storage guard均符合固定期望。随后Java2：IllegalStateException `Unexpected language mode: ECMASCRIPT_2022`，位于Compiler.getParserConfigLanguageMode:3392，结构化SETUP_OR_DRIVER_FAILURE。controller2；PowerShell外层工具1分别记账。F01无compiledCode/转换执行，F02–F08全部NOT_RUN；无AST转换结果、候选产品、收益、性能或采用资格。按固定停止线没有改参/重跑。原异常不是FundVal业务RED，也不能推断所有Closure策略不可行。

随后同tag只读诊断确认CompilerOptions和parser.Config两端2022 enum都存在，但Compiler:3377–3393输入桥接switch漏了该项；setLanguageOut独立toFeatureSet路径已声明2022。它足以解释原栈，不证明输出目标成功/失败；没有降低ES2022目标或把native2抹为PASS。详见[完整方法、实际原件、范围及诊断](performance-evidence/closure-fixed-probe-20261022/README.md)。106成员/301040 B归档压缩86645B/SHA `4d70f02b306e45914976fd526b5e25105edf07d030081adbd37f5319cbf650f5`，新解压全同、14项归档审计native0，明确**不是策略PASS**。首个归档工具缺stage/parent目录而ENOENT/native1，旧工具/plan/stage保留，独立v2只修归档目录不执行probe；git diff-check0的1822B既有换行警告保留。JDK/JAR二进制及临时签名HTTP headers仅留Temp，VCS只归档明确脱敏派生传输摘要/原生版本与probe证据，不冒称原始HTTP或binary payload全收录。

第52节273完整source/127site/68安装、HEAD/branch/index和所有受冻probe输入在窗口前后同。现有产物仍all85969/cold46149，原预算仍FAIL/至少差8742整数B；本节没有新build/全QA/相对时延，保留第52节1313PASS/3skip、35/35及三轮完整构建身份而非冒称重跑。旧800不继承，15.0.2/M3 IN_PROGRESS/NOT_RELEASED，未业务提交/推送/合并/部署/升版。后续任何不同输入适配须另立有官方因果依据的固定前提，保留本失败，不能扫参数；完整v16门禁不缩小、不跳过。

## 54. 独立parser overlay有限资格与optimizer内部异常停止（2026-10-23）

保留第53节原JAR的ECMASCRIPT_2022桥接异常/native2，不改判、覆盖或把它当本轮PASS。本轮先写独立Temp协议，只针对同tag v20261020已定位的输入桥接缺项建立本地工具overlay，不改产品、原JAR、系统PATH/JAVA_HOME或root依赖。准备阶段Node fetch failed原件保留；随后原生获取固定源码/同tag rules.jarjar/LICENSE，准备器又因规则行多空格未匹配而FAIL，原件保留。独立relocate仅纠正该packaging识别：两侧共同重定位21条外部import和唯一FQ Supplier，未补依赖或改变JS选项。

B0为共同重定位但未修bridge的Compiler.java（172927 B/SHA `1a8ec1893f2979ba8f344a850447a908e6428e88748c9f5724900e07859f5f41`）；B1只增加2022→parser2022的switch case（172987 B/SHA `7974acca148ffea2650f57a632372e60b68aa1f93092abef4c25e016c005485a`），不是未修改的官方编译器。两侧javac各native0、完整13个Compiler及inner类名集合与JAR同；各211 B GBK stderr是使用/覆盖deprecated API的两条note，原件保留，不冒称stderr空。CodeSource证明加载对应overlay；全部16个LanguageMode结果B0与原JAR完全同，B1仅2022从异常变parser2022。另对原JAR/B0/B1完整13类执行javap -p -s，均native0/stderr0，公私成员/descriptor的LF文本各63868 B/SHA `3e550c2227f3d4733696e7cf3ed31f642b0a6736abfbebff06993e91edd69b3d`完全同。上述仅为编译/映射/ABI文本有限核对，不证明optimizer等价或JS策略合格。

新probe逐字保留旧DRIVER及8主夹具/4support，共13文件；controller只适配严格overlay路径/收据/完整class库存guard和classes-first classpath，原CONFIG/CASES/EXPECTED/observe及SIMPLE、in/out ES2022、NONE、LOCAL/OFF等固定options不变。新manifest SHA `4f76d1e40fca4f57df6441348413d21ba4039857857e7f40c48fdf5a4bb54d5f`。唯一run-01于01:57 UTC实际：Java版本0，F01 original sanity native0/stderr0、keys/arity/数值/身份和denied fetch/Storage0符合固定期望；随后B1 Java native2，stdout保留原通用`SETUP_OR_DRIVER_FAILURE`标签，stderr2789 B为`NullPointerException: NAME publicFn 5:21`，栈中首个优化pass为`RemoveUnusedCode.getVarForNameNode:826`，经PhaseOptimizer/performTranspilationAndOptimizations。controller真实native2、外层执行收据为`PREREQUISITE_STOP`。

准确诊断阶段是**OPTIMIZER_INTERNAL_EXCEPTION**：本次已经越过原parser bridge失败，但optimizer内部异常仍使固定前提不合格；不是FundVal业务RED，不是转换后wrong-result证据，也不是可把原标签直接洗成PASS的setup小问题。没有compiledCode、转换执行或转换后AST surface结果，F02–F08全部NOT_RUN。按停止线不继续修compiler、不改flags/案例/预期、不实施hybrid、不做产品构建或收益测量。详见[协议、实际回执及原件范围](performance-evidence/closure-overlay-20261023/README.md)；归档后实核241成员/2224809B，压缩481029B/SHA `836d704a1b8519593c6d2102a98bb7697fbdf9839fa3c3999d0d95b54c2c888e`，全新解压逐项同、17项归档检查native0（不是策略PASS）。首次归档入口Windows file URL错误/native1原源码保留，独立v2仅修工具入口未重跑案例。diff-check0的1822B既有换行告警保留；事后诊断为包外addendum，不推断未采集的前序pass中间AST。

另对当前Vite8.2.4/Rolldown1.2.5及实际16块做有限只读接入复核：正常renderChunk在内建OXC和最终hash前，保留现有minify:'oxc'时实际顺序是Closure→OXC，不是对既有OXC文件后置改写。当前两块TLA不交Closure、保留原OXC路径/程序正文约束，但依赖hash及Vite preload链接重写可合法改变最终字节/SHA；旧standalone“两TLA逐byte不变”不能机械继承。未来若前提真正合格，须由原linker统一完成最终hash/import/preload，再让既有app-chunks/指纹/完整SW CORE基于同一最终产物生成；不得后置改已命名site字节却沿用旧hash。该复核不是实现、行为或性能资格。

实际execution RESULT前后均为273完整输入行SHA `d0d9554fef7d2ef4b75f67a7db4fef558e03bb03f0897f2305617c6361090a3e`、127site行SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`、68安装及HEAD/branch/index同；受冻源、JAR、overlay类/收据和probe manifest未变。本轮没有新产品build/gzip、全QA/E2E、统计时延、精确CI、真实金融源/设备/生产验证，不把第52节旧1313PASS/3skip、Chrome35/35或第48节800继承为新策略PASS。现有all85969/cold46149与原预算77227.7/52241不变，all仍FAIL/至少差8742整数B。**15.0.2 / M3 IN_PROGRESS / NOT_RELEASED**；未业务提交/推送/合并/部署/升版，未进M4/M5/M6，既有数据校验及完整v16门禁不缩小、不跳过。

## 55. 完整私有路由原型与一次实际体积筛查失败（2026-10-23）

编译器前提不合格后不继续修fork或扫参数。本轮另在唯一Temp按当前§52/54正确性基线实现完整获取→资源/cache→模型证据→App兼容投影及详情路由，先写协议再落地代码并冻结。A249源逐项对root当前和§52归档final-source相同，rows SHA `82532f847b3cd71eaba06703b0609e75520780ecf26b9c23e9fc3d01e301795e`；B257 rows SHA `558cc1a46b1f3b47efdaefed122eb31b18e5a34dda358c77bd7d334bc362072b`，精确改App/build两旧文件、新增8个private模块，无删除/测试/配置/数据/依赖/版本改动。build差异仅原business组4行membership，五组、OXC、ES2022与budget不变；全部原公开API和accuracy scheduler原字节保留。

实际退休是私有额外transport壳、一次source行spread和compose/apply中间fund物化；一次有序Map投影保留最终别名。**不是canonical表示全部退役**：Q2/Q3 generic importer、无Quote/旧single-model导入、R1/R2严格codec、二次wire校验、缓存各时钟/所有权边界、两种外层writer和全部金融规则仍K。新facade/Map/局部结果对象必须计成本；源码迁移和旧符号退出不等于净gzip节省。

父级controller先经独立静态修正异常exit分类、失败保存、只限本次live子进程树的超时清理与协议/工具冻结，再首次执行。相同Node24.14.0/npm11.9.0、只读同源依赖junction、epoch1792046773：A唯一build native0/stderr0，**完整127逐路径/字节/SHA精确复现当前root**，rows SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`，16chunks/raw252331/all85969/cold46149；B唯一build native0/stderr0，完整136 rows SHA `e6bf67db938858368ed22c6ba13fffe76d50320a0229fcd4abb3499109d7f647`，17chunks/raw256307/**all87338/cold46005**。B all **+1369 B**、cold −144 B，budget真实native1/FAIL，上限仍77227.7/52241，B至少还差10111整数B。

两侧chunk字节/SHA、关键指纹与graph CLI native0；B实际17chunks/19static/11dynamic/6cold，但graph仍evaluated/startupOrder/dynamicNamespace false，预算仍importClosureVerified false，不能混用证明范围。A精确复现排除此次隔离构建偏差，不是B三次确定性、等价性或性能证据。B因早期材料性失败停止、不采用；**未跑该候选完整unit/check/E2E、公私有边界对照、三轮构建、新配对时延、CI、真机/真实金融/生产**，旧§52 QA与800不继承。中间六文件静态差异无可证P0/P1仅绑定其读取SHA，最终Worker/source优化不同SHA没有继承全面语义PASS。

详见[完整协议、实现C/K/Z账、实际原件与覆盖边界](performance-evidence/private-vertical-20261023/README.md)。源码/原生收据及actual app产物、完整site库存按独立归档inventory保存；669成员/25920452 B，压缩15194623 B/SHA `93dde2ffa959fbeb9ec00b0ff584d0c347b444109ca2191ed8c522f1e82b5d0d`，全新解压逐项同，13项归档检查native0（不是candidate PASS）。大OCR生成payload和node_modules仅保库存/原依赖身份，不假称已收录；git diff-check0的1822 B既有换行告警保留。root273完整输入/127site/指定68安装、HEAD/branch/index在冻结与A/B窗口前后同；没有覆盖root site或采用B。**root仍all85969/cold46149，原总包预算FAIL/至少差8742整数B；15.0.2 / M3 IN_PROGRESS / NOT_RELEASED**。未业务提交/推送/合并/部署/升版，未进M4/M5/M6，完整v16门禁不缩小、不跳过。

## 56. 原配方真实模块归属与三路有限结构审查（2026-10-23，政策修改前）

从冻结A249的真实build-site AST提取原配置和helper，唯一Vite write:false capture native0/stderr0。16个真实chunk路径/字节/SHA/gzip/cold集全部等于当前完整127产物；实际59模块归属，originalLength不可用保持null，renderedLength仅打包器预压缩归属，不当作逐模块gzip/可删除收益。App81135、normalizer23234、repository21823等大模块仍有实际消费者，不能靠删源码行数证明8,742B净节省。

UI、契约/日期、仓储/Gist三路只读报告均未提出新的大型闭合退休池：旧UI helper已tree-shake；Quote/wire/resource/evidence/盈亏的接受集不同，时钟安全核心已共享；storage10文件与先前逐字节同、仓储单份，push/pull/事务/恢复/迁移是不同协议。有限否决不等于全程序不可优化证明，不免除金融/旧cache校验，不复活已拒绝候选。没有新variant/完整QA/性能/真实金融或生产验证。

原273源/127site/68安装及Git在窗口前后同。详见[归属与原件](performance-evidence/module-attribution-20261023/README.md)：108成员/1,066,174B，压缩298,751B/SHA `6e71198d7057c274364c191a203a99613dead4c0bce09a0a5edd84e2f2d363d4`，全新解压逐项同、14项检查0。收录59份实际源payload/原builder、16块/协议/原生收据与3报告，完整库存保留，不冒称全249源/依赖安装包。原capture在77,227.7预算下FAIL保留；用户随后新授权另记第57节。

## 57. 用户仅批准90KiB总包政策与重新本地验收（2026-10-23）

用户明确答复“同意仅调整总包上限，继续验收”。[独立政策记录](BUNDLE_BUDGET_POLICY_20261023.md)将全部非OCR app gzip从77,227.7B改为**92,160B（90KiB）**；冷启动52,241B、原v15基点70,207B/40e、数据/兼容/性能/CI/真机/生产门禁不变。不是压缩优化、不直接发布、不追溯提升§53–56候选或旧失败为PASS。

先保存旧工具/测试及真实旧CLI1，再以新增7项测试实际6RED/1PASS，修改政策常量和报告后定向13GREEN。首次完整V1真实1323total/1319PASS/1FAIL/3原Windows skip：90K raw负例已不超新gzip阈值。保留失败/冻结源码，先声明V2再仅把该夹具改100K，并断言实算gzip>92,160后保留原拒绝断言，admission代码未改。独立只读两次审阅通过，不能删掉旧失败或仅把测试期望改为接受。

最终V2全量**1323total/1320PASS/0FAIL/3既有Windows skip**、syntax216、真实App Chrome**35/35/0flaky/skip**、官方registry npm audit0/found0；4次原配方固定epoch1792046773完整127逐项字节/SHA同§52产品。浏览器stderr352B两条NO_COLOR/FORCE_COLOR告警保留；2份实际成功原件含accuracy生命周期JSON在构建前recoverable move并收录。只合成桌面，不是真实金融/设备或云写证明。

当前16chunks/raw252331、**all85,969/cold46,149**；新CLI native0/PASS、原旧CLI对同一最终site仍native1/77,227.7 FAIL。预算及路径/字节/SHA/完整分区仍由工具实算，不接受manifest覆盖。graph仅静态bindings/literal closure，evaluated/startupOrder/dynamicNamespace未由CLI证明。274完整源行SHA `89bdfff42618da6b1743a61e96bf4177ba34329ea716acb73c49e3ee920cc80f`（原273仅3旧文件修改+1新测试），site127行SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`，68安装与HEAD/branch/index不变；业务runtime/build/依赖/版本未改。

详见[完整本地证据与限制](performance-evidence/budget-policy-20261023/README.md)。归档702成员/19,960,502B，压缩9,663,880B/SHA `0e5614192ef63cdf7f943d5159f93fa6e2d0d3053a45fc002ec8fc82b5c74011`，全新解压逐项同；含最终250非历史源payload、所有本轮收据/失败/原件，24旧Android、生成OCR/安装大payload只库存。第48节800不能继承到§51/52后的新正确性产品；**新配对性能、精确CI/review及M4–M6仍待完成**。15.0.2 / M3 IN_PROGRESS / NOT_RELEASED；本轮未业务提交/推送/合并/升版/部署，未进入M4。

## 58. 当前正确性修复后独立800配对时延闭合（2026-10-23）

§57之后先冻结新协议/274源/127site/68安装与完整dirty身份，独立审阅参数/同锁参考/工具/无冲突进程后唯一执行；不继承§48旧PASS。既有参考0570429/原sampler与collector完全不改，strict normalizedLock精确同；原800retained+4warmups、ABBA400/400、bootstrap5000/seed160003/timeout30000及全部统计门禁不变。2026-10-23T06:43:09.455→07:20:41.812Z真实native0/PASS、stderr0、0failed/incomplete/replacement、无重试/剔样/补样。新raw88,033,360B/SHA `7a72633783011c112ee8661ab079a93f1c61c9db8a5e9554c7b5bd65f9c7dd42`完整保存。

cold median/p95 141.70/187→130.40/177.80ms（−7.975%/−4.920%）；warm75.55/117.40→66.30/104.90（−12.244%/−10.647%）；save79.46955/90.81360→65.65980/75.10660（−17.377%/−17.296%）。原95%上界、p95区间宽≤20%、pass fraction≥0.95、current任一关键样本<3000ms均通过；工具保守save-p95也通过。save最大317.8952高于参考122.8539，保留且不宣称每样本都快；fraction1不是总体通过概率。

启动前预写independent audit真实native0/12,883检查0失败，整个原bootstrap对象一致；另一只读终审直接解析真实raw、slice(4)独立重算summary及4,824 renderer对象，native0/一致。804完整、4824drains SETTLED、SW/script/Gist写0、pageerror0、instrumentation/integrity/4项owned cleanup PASS。console17,687与blocked17,687同数不作逐条根因推断；导航3216项PARTIAL、save1608窗口MEASURED，不当完整startup/OS CPU。Windows/Chrome155.0.8059.86/390×844/固定合成日期和provider、暖no-store reload、无真实金融/云写/设备/生产证据。

结束和终审物理274/行SHA89bdfff...、当前127/行SHA0641039...、指定68安装和HEAD/branch/index/同阶段tracked diff/工具/协议全同。sampler整树当前127/92,557,057B/SHA2037640c...、参考110/92,344,588B/SHAa18ee3fc...前后同；不把此hash与sorted-JSON混用。原安全清理的reference副本未重读，不冒称保留内部build日志。独立OS事后点观测采样PID已无、两owned端口无监听。

详见[协议、统计完整表、原件与边界](performance-evidence/pair-correctness-800-20261023/README.md)。432成员/106,616,981B，压缩14,555,822B/SHA `c4fc4fdee76c9f32708fc69f9cde7487618daf64d67d7ba25020ce16bf53751e`，新Temp全量解压逐项核对，88MB raw完整round-trip同；原workspace/预审/收据/12883checks/终审/最终250源payload及选定当前产物收录，24旧Android、生成OCR/安装/已删参考大payload仅库存。后续README/归档audit是包外addendum。

这是新本地时延PASS，独立于all85,969/92,160与cold46,149/52,241包政策PASS；旧失败仍原样保留。**精确提交CI/阶段完整性review未完成，M3仍IN_PROGRESS / NOT_RELEASED**；未业务提交/推送/合并/升版/部署，M4–M6完整目标不缩小、不跳过。

## 59. 完整M3审阅发现9.1剩余职责拆分，继续实施（2026-10-23）

独立review逐条核对原M3/9.1/9.2和真实代码：核心刷新/稳定TTL/批量/代际/唯一flush/计数诊断已形成边界，§57/58本地数值门禁有证据；但sync-status与PWA-controller不仅缺文件名，其状态/UI/计时器/guard/channel/listener仍集中App。原M3引用9.1没有第4/5项豁免，M4/M5后续最终功能归属不能代替拆分本身完成，也不应在M3提前要求后续全部真实云/设备验收。

因此保持完整原计划，按[剩余拆分记录](M3_CONTROLLER_EXTRACTION.md)继续：先锁定旧App及characterization，再真实迁移两模块，由父级统一App/build接线，保留Schema3/旧cache/完整性顺序/原更新guard与lazy cloud。不是加代理壳、不是M4/M5新功能，不改版本/依赖/阈值。

独立报告15,242B/SHA8d2b426b9de042aba23c5c87b6960e125eee40535af9fc400e011aeb86effa09；当前仅启动实施，不预报新QA或等价PASS。§58完整raw/native0仍是有效迁移前证据，但新runtime字节必须重新完整QA/构建/图/体积/性能和review，再绑定精确不可变CI。**M3 IN_PROGRESS / NOT_RELEASED**，没有业务提交/推送/合并/升版/部署或进入M4，完整M4–M6目标保留。

## 60. 两controller与补名竞态修复的最终本地QA（2026-10-25）

`sync-status.js`和`pwa-update-controller.js`现已实际接管状态/计时器、云同步UI与SW更新编排，App动态委托并在原位置start；不是只有文件名的facade。迁移前旧App保存为oracle，既有安全测试保留，新增41项同步表征、PWA新旧对照、5项App/构建接线及4项真实controller互锁测试。完整9.1范围复核另外定位自动补名事务晚于flush失效cache和旧代结果安装的竞态：原5项行为测试真实RED；修复每代跟踪/settle补名、唯一flush前等待、保存前后signal gate及补名reconcile不二次写cache，6项最终测试加相关共71/71。第6项接线测试不是修复前RED；Web Lock外部无限持有时的有界drain不在本轮证明范围。

最终QA V3冻结281源行SHA `8b93b2e2476757a381e3788f3f82428b54cfa26fae7fe6f3339a0896f8a71653`，实际**1412total/1409PASS/0FAIL/3既有Windows skip**、syntax223、Chrome**35/35**、official npm audit0/found0；原配方/ES2022/OXC/五组与epoch1792046773不变。两次完整129产物逐项byte/SHA同，行SHA `94bd2839eb13c06ae0000c98264587936d494eea3e3562786864f812bf5bf5ce`。16chunks/raw254560B，**all86,850/cold47,014**，相对§57+881/+865B，仍分别低于92,160/52,241；图静态bindings/literal closure与23项OCR资产核验通过，不外推图的运行时/evaluation证明。

真实失败不隐藏：首次集成两条源码位置断言；V1浏览器34/35（105持仓即时读发生在请求完成前）；V2全量1407/2fail/3skip（两处旧参数结构断言）。V1只将该测试改为对相同105值的自动重试完成断言和一次cache写等待，8秒默认超时、业务数据/日期/请求/写次数原断言不放宽，无sleep/重跑机制；V2仅迁移真实显式参数与settlement断言。原失败、trace/截图、各次冻结source和child0/外层wrapper1的区分均保留。V3 stderr352B颜色告警保留。

详见[实现与证明范围](M3_CONTROLLER_EXTRACTION.md)、[原件归档](performance-evidence/controller-extraction-20261025/README.md)及[新固定性能协议](performance-evidence/pair-controllers-800-20261025/PROTOCOL.md)。归档844成员/21,026,354B，压缩10,284,125B/SHA `63ef139c550aa71f2d9e755ba77deb01e0b9351bfe6463a8d6add70e7caaa971`，全新解压逐项同，9原workspace/两browser原件目录与281源/129site/68安装及HEAD/branch/index前后同。含257非历史源/105非OCR目录产物payload；24历史Android、生成OCR及安装大payload仅库存。归档计数和合成Token筛查两次工具失败及从未保存的部分独立收据缺口如实记录，不补造。

全部是本地合成Chrome/仓储测试，不是真实金融源、Gist、OCR真机、PWA版本迁移或生产。§58性能属于迁移前旧字节，不能继承；新固定800+4及精确不可变CI仍待完成。15.0.2 / **M3 IN_PROGRESS / NOT_RELEASED**，未业务提交/推送/合并/部署/升版，完整M4–M6保留。

## 61. 最终controller候选的新800配对与完整复核（2026-10-25）

§60完整QA之后先冻结281源/129site/选定68安装、协议/runner/原sampler/collector/辅助脚本/完整QA树和Git身份；独立预审14检查0失败后唯一执行新测量。参考仍是安全对齐v15 `057042963a33579c624a41404a6d533dfda29768`，严格normalizedLock完全同；不是§58提取前候选，不作controller提取的单项因果归因。原800retained+4warmup、AB400/BA400、bootstrap5000/seed160003/timeout30000和所有门禁不变。

实际窗口06:27:33.374→07:03:05.051Z，native0/PASS、stderr0、postflightError null；804完整，0 failed/incomplete/replacement，无重试/剔样/补样。新raw88,027,817B/SHA `c0586a69852c8415090f46384ca1e1483ad41371adae4af3306bff85fdf1b4e7`。全部800的cold median/p95 128.20/161.60→119.80/154.90ms（−6.552%/−4.146%）；warm67.75/92.20→60.20/80.20（−11.144%/−13.015%）；save79.10315/85.4128→66.06475/72.4896（−16.483%/−15.130%）。原95%上界、p95相对区间宽≤20%、bootstrap达标比例≥0.95、当前关键样本<3000ms全部符合；额外save-p95检查也通过。current cold最大327.8高于参考237.7，原样保留，不声称每个样本都更快；达标比例1不是总体通过概率。

预冻结审计单次native0/stderr0、12,883检查0失败，重新调用未改原helper，整个bootstrap summary和renderer对象一致；它不是第二套独立统计实现。另一只读终审native0/stderr0、7,253检查0失败，独立解析`slice(4)`并计算median/nearest-rank p95/max/ratio，全同；核对4,824 renderer及19,296直接counter差值，但没有独立重跑bootstrap。1608 sides/4824 drains全SETTLED、pageerror0、instrumentation/SW/Gist写及四项owned cleanup符合原条件。console17,688与blocked17,688同数保留，不按总数推断逐条因果。导航3216窗口PARTIAL、保存1608窗口MEASURED；Windows/Chrome155.0.8059.86/390×844/合成fixture和暖no-store reload，不是完整启动OS CPU或真实金融/云/手机体验。事后07:06:25Z实际点观测owned端口9232/9235无监听、sampler30520 absent。

测量/复核/归档窗口281源行SHA `8b93b2e2476757a381e3788f3f82428b54cfa26fae7fe6f3339a0896f8a71653`、129site行SHA `94bd2839eb13c06ae0000c98264587936d494eea3e3562786864f812bf5bf5ce`与指定安装/Git/protocol/tools前后同；当前sampler整树fingerprint `bc9173dc63b1b2f8f3f1ca0e810799b1483559b8a8796fd6367c4759929c74a7`，不要与sorted-JSON行SHA混用。现有site仍all86,850/cold47,014；本节没有新构建或改产品字节。后续本状态更新是窗口外addendum，不反写已冻diff。

详见[独立协议、完整统计表与实际原件](performance-evidence/pair-controllers-800-20261025/README.md)。归档509成员/108,670,719B，压缩14,955,988B/SHA `38bfa2efa4ac7bde5cc82654dfe4ac13a270d0e6b82024bec99eee0aba1c72d7`，全新解压逐项byte/SHA同；完整88MB raw仅`parent/PAIR.json`一次，含预审、原helper审计、第二路终审、257非历史源及105非OCR目录产物payload。24旧Android、生成OCR/安装及工具已清理的参考大payload仅库存；内部参考build日志未由原工具保存，不冒称存在。控制器QA原包只绑定hash，不重复打包。包外原生归档回执及6项工具指纹复核native0，无新失败。

本地QA/预算/新时延和范围复核现已闭合，**精确不可变业务提交CI、下载候选的完整性与构建身份衔接仍需完成**。只读提交范围核对46个变更源均在最终QA闭包，Temp/历史输出和3份88MB重复raw不加入提交；package/lock仅Vite8.2.2→8.2.4原安全窗口改动，Git文本换行和新提交epoch必须分别验证。远端只读查询仍continuation170fd3e、main abfb631；尚未新提交/推送/合并/升版/部署。15.0.2 / M3_IN_PROGRESS / NOT_RELEASED，M4–M6完整目标不缩小、不跳过。
