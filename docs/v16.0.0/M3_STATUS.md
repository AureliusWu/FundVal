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

## 3. 本地验证

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

1. **M3 不退出、不合并为完成阶段**：all 非 OCR gzip 至少还需减少 6,144 B；继续用等价策略/纯函数复用压缩，不放松金融数值、缓存来源、scope 复制/二次验证或 Worker zoned timestamp guards。
2. 同机性能与 p95 相对门禁证据尚不完整。桌面 3 秒绝对交互预算通过不等于 v16 相对性能门禁通过。
3. 手动详情仍存在旧独立行情获取路径，与刷新 generation union 不完全统一；旧东方财富详情映射未使用新 f13+f12 全集合分配，应在后续行为测试下复用新批次层，不直接大改 UI/事务。
4. 较旧的 US 指数虽然本代刚获取，因真实 observedAt 与 seed freshness 严格检查，模型仍可能另取一次兼容行情；必须保留旧时间与模型区间保护后再优化，不能把新请求时间当观察时间。
5. GitHub protected CI、immutable candidate 下载验证、CodeQL 本阶段证据尚未完成；仅本地绿不能代表它们通过。draft PR 可保存检查点，但不意味着允许 M3 EXIT 或生产部署。
6. M4 多档案同步合同、M5 OCR 导入/解码/取消/PWA 合同、M6 三类物理设备与同一产物发布继续按原顺序，未跳过。外部 fund-compass Worker 未修改，v2 服务未协同上线。

任何历史 M0/M2 生产、候选、真机与实际 durable write 证据边界仍保持。此检查点不改变生产版本，也不声明 v16 完成。
