# M3 刷新计数诊断与代际观察链（2026-10-20）

原计划6.3及M3工作包要求请求、缓存、去重和取消诊断。此前执行器返回结构化 scope counters，但 App 不保留、诊断中心不展示；完成日志只有四个计数字符串。该 P2 可观测性交付缺口已补充为有界内存观察链。没有发现或宣称修复新的报价计算错误。

**版本仍15.0.2，M3 IN PROGRESS。** 新功能增加总包2590 B；当前 all **83084 B > 77227.7 B**，至少还差 **5857 个整数 B**。原预算不变，未进入M4、提交推送、合并或部署。

## 1. 实现与数据流

```text
真实 Refresh Plan 的 kind/action → 固定聚合计划和可确证的 skip 原因
真实 generation scope.snapshot → 实际请求/命中/去重/中止/写入计数
               ↓ 独立 onDiagnostics（不 await，异常隔离）
started → resources_settled（包括晚追加 metadata 已收敛）→ final
               ↓
createRefreshDiagnosticsStore + 同步 coordinator onStateChange
               ↓ 最多 current / lastSettled / lastCancelled 三个记录引用
诊断中心展示及用户主动复制摘要（纯读，无持久化）
```

关键文件：

- `js/runtime/refresh-execution.js:48`：可选 observer，只读取现有私有 plan 字段与 scope 计数；没有 observer 时立即返回。所有分支/NAV/late metadata 收敛后才发 settled；flush 后报告实际写入计数。取消摘要不调用旧代 coordinator 日志或基金 UI/cache。
- `js/runtime/refresh-generation.js:50`：只追加纯 Store 导出，旧1575 B代码前缀逐字未改。固定字段、枚举和安全非负整数；只读取自有 data descriptor，不执行 getter，不枚举私有字段；深拷贝冻结，不保留输入引用。
- `js/app.js:75`：通过原同步 onStateChange 接入；executor 使用独立 observer；诊断中心通过 getter 读取。原 `refresh()` 仍直接返回 coordinator 原 Promise，未包装或改变 coalescing。
- `js/runtime/diagnostics-ui.js:94`：新增刷新代、计划、请求、跳过原因、来源和最近取消代；最终 Quote 指向既有“基金详情→数据说明”，不复制 Quote/金额。

| 字段 | 权威来源 | 准确含义 |
| --- | --- | --- |
| plan | 本次实际 private plan 的 kind/action | 计划数量，不等于实际网络次数；按8种kind聚合，不保留基金code/name |
| requests/providers | scope.dispatch | 进入该刷新资源 provider 边界的实际调用；不含页面静态资源、OCR或Gist全部HTTP |
| cacheHits/deduped | scope.acquire | 实际命中/共享次数；不是仅凭计划推断 |
| abortedRequests | scope.dispatch 结算 | 已进入请求边界后中止的次数，不包含尚未获slot的所有排队任务 |
| cancelledResources | scope.acquire 拒绝/取消路径 | 现有调用/拒绝累计，不是唯一资源数 |
| writeAttempts/cacheWrites | scope.flushCache | 实际尝试/成功；写入被拒仍可正确显示尝试1、成功0 |
| observed / null | Store观察阶段 | 触达scope不等于PASS。未开始/未收敛的终态计数保持null，UI显示“未观测”；真实0才显示0 |

skip 原因仅输出能由现有计划确证的 `market_ineligible` / `no_active_holdings`。TTL、缓存质量、force、冷却等更细原因没有被新链记录时明确写“未记录”，不从结果反推。此记录不声称所有逐资源原因覆盖均已完成。逐基金最终选中 Quote 继续以既有数据说明的来源、等级、日期区间为准，不以全局聚合替代它。

## 2. 代际、异常与隐私边界

- 新 start 提升 high-water；旧报告不能覆盖新 current；历史按 generation 而非抵达时间挑选。每个槽位只保留一个阶段序数，无持续增长的事件Map。
- 已终态且未观测的同代可以在 late drain 后补真实计数，但不能重新变成running或把较早阶段覆盖final。
- 只有started的0不能充当最终实际计数；终态若无真实drain/final数据则 counters=null。无效final计数同样不继承started0。
- 同步 `onError` 重入下一次request时，先处理快照中的显式上一代failed，再推断新start，避免把失败误标为cancelled。真实新负控先RED再GREEN。
- Store消费现有同步onStateChange序列。无generation/sequence的null-active stop快照不支持异步乱序重放；没有改coordinator协议来伪造这种能力。
- observer同步throw、rejected Promise、throwing then getter均隔离，不await、不重试，不改变刷新结果。原金融校验、scope持久化所有权、取消规则和公共/私有coordinator方法未改。
- DTO不含基金代码、名称、份额、成本、持有金额、URL、Token、错误文本、上游原文或完整Quote；不写localStorage/云。UI继续转义，复制仅由用户主动操作触发。
- 私有plan投影未改；AST护栏仅允许新增受约束的forEach字段聚合，保留reason读取、对象别名/传播/回调逃逸负控。

## 3. 先红后绿与实际验证

| 检查 | 本轮实际结果 |
| --- | --- |
| executor新7项 | 旧源3PASS/4RED（缺观察报告）；新源7PASS。3项原PASS因旧源根本未调用observer，不能算3个旧bug |
| Store | 旧源缺导出RED；后补invalid-final负控RED；主代理再补onError重入22项中的1项RED→GREEN |
| 诊断view | 旧源2/2RED；新增2项及旧6项合计8PASS |
| 真实App旧site | 初次locator写错单独保留；修正测试入口后，旧site确实缺“刷新诊断”行而RED，不混为一次业务失败 |
| late metadata | GREEN补覆盖：provider忽略abort挂起时不发终结报告；释放后核真实取消计数，旧UI/cache/coordinator日志不增长；未伪造RED |
| 定向组合 | 122/122 PASS |
| `npm test` | 1133项，1130PASS、0FAIL、3既有Windows条件skip；6780.9319ms |
| `npm run check` | 210 JavaScript文件通过 |
| `npm run test:e2e` | native Chrome32/32 PASS（1.1m）；完整stdout/stderr已捕获 |
| 官方registry audit | 0 vulnerabilities |
| E2E后3次连续build | 固定epoch1792046773；全127文件bytes/SHA与critical相同 |
| 实际字面图/native binding | 每次16chunks /18静态边/10动态边/6cold PASS；不evaluate，不证明任意TDZ/运行顺序 |
| OCR清单 | 23assets /88196906 B实核；没有执行OCR引擎或真机 |
| 原budget CLI | native exit1，cold PASS/all FAIL；wrapper的expected-exit匹配不代表预算通过 |

新增真实浏览器用例核对冷/暖 actual provider 请求数与合成network记录一致，暖NAV/holdings不请求；原稳定资源acquisition envelope、持仓hash和诊断前后整缓存字节不变。诊断不加载OCR或发Gist请求，摘要无code/name/金额等敏感字段。该新用例只覆盖完成代UI；取消显示由Store/view单元测试及真实executor取消测试分别覆盖，不冒充取消浏览器/真机验收。

E2E内的3个绝对交互样本均低于3秒，但**不是新的相对时延资格**。第37节800组PASS属于此前4bda产品，不自动授予本次新增代码；未重新采样800/1000，也未声明当前相对性能PASS。

## 4. 体积、指纹及未过门禁

| 指标 | 改前原OXC产品 | 当前三次一致 | 差值 |
| --- | ---: | ---: | ---: |
| all gzip B | 80494 | **83084** | +2590 |
| cold gzip B | 42985 | **44386** | +1401 |
| app raw B | 235647 | 242222 | +6575 |
| whole site B | 92507677 | 92528422 | +20745 |

改前值是同日已验证的既有产物窗口，不是新配对时延基线。当前冷启动44386/52241 PASS；总包83084/77227.7 FAIL，缺口5856.3 B，至少需减少5857个整数B。没有调预算、换压缩器、改变原五组、ES2022、依赖或版本来消除失败。全站增量包含可发布原源文件等，不能只用minified raw变化代表全部产物增长。

- 当前critical：`168ae0c7659a187ce175c5d1b519fd7ffe0d5694be4239754b5be5f4a9b976f6`
- whole JSON库存：`b11fd93fcde8dd7a5c143cbd45fd1bb1db89d596e5dc76ff70ec6cf60f6325eb`
- 228份选定source/tool/test/config在三构建前后相同，库存SHA：`1dd4d4dd00413719785499052c2e9ddd6715e50f8b2789c2739b830cafdea6ac`

`qa-summary.json`及归档内`main/build-verification.json`给出完整清单。前者不是整个仓库所有文件的库存；docs和忽略目录不在228分母。

## 5. 原件、失败与时间边界

`original-evidence.tar.gz`：**56文件 /1340210 B**，压缩后655259 B，SHA256：

`e21975f7f57c1812ae163213cc0e9d7e54af226769d7016cae3bda227b9081f5`

`archive-audit.json`逐文件列长度/SHA；在新Temp实际解压并逐项比对通过。含捕获的完整命令JSON/stdout/stderr、工具、当前10份源/测试副本、tracked diff、Store RED/GREEN窗口、合成E2E缺行RED/错误locator/最终附件。没有真实用户图片、持仓或node_modules。

主代理第一次executor RED只有工具历史，之后在未改executor时第二次捕获RED原件；不冒称首次完整终端日志归档。Store子任务的after.js是随后onError修正前的53项窗口，最终源码为`main/sources`，最终1133项不授予旧副本。最初Store测试后来增加invalid-final用例，初始测试版未另存，该限制保留在原README。

临时构建核验器v1误把site传给OCR目录检查，导致ENOENT；第一轮build本身成功，不能称产品缺OCR资源。保留v1脚本和失败事实（完整原stderr未另存）；v2只纠正root、保留已复制的E2E附件、改用新receipt标签防覆盖，再从头完成3次完整构建资格。

E2E全量进程和临时服务已结束，12437核验ECONNREFUSED。没有新CI、真实金融源对账、Gist写入、物理设备、部署或发布。

最终独立只读复核再次重算archive SHA、56份解压文件长度/哈希、现有228源码及127site逐文件清单、16chunk默认gzip和critical的NUL/length/hash配方，全部与收据一致；确认两份coordinator及旧snapshot代码未改。该复核没有重跑测试/build或写文件，不包装成另一套新的运行资格。

## 6. 另外排除的Closure方向（未安装、未压缩）

官方当前源码把顶层await列入不支持的特性集合，而本应用启动阶段实际使用它；无法确认保持既有ES2022/ESM加载的直接命令，因此未做候选或声称尺寸结果。[官方FeatureSet](https://raw.githubusercontent.com/google/closure-compiler/master/src/com/google/javascript/jscomp/parsing/parser/FeatureSet.java)、[官方CLI语言限制](https://raw.githubusercontent.com/google/closure-compiler/master/src/com/google/javascript/jscomp/CommandLineRunner.java)。

ES_MODULES选项还会启用额外wrapped-output全局优化，不能视为既有chunk绑定和API不变的简单后压缩。[官方优化配置](https://raw.githubusercontent.com/google/closure-compiler/master/src/com/google/javascript/jscomp/CompilationLevel.java)。普通SIMPLE的属性重命名默认关闭，不泛称所有SIMPLE都会破坏arity。官方master是当日只读依据，不是不可变版本资格；完整人工结论归档在`main/closure-prerequisite-audit.md`。没有安装Java/Closure或改包装器绕过条件。

## 7. 可靠性判定及剩余工作

**CONDITIONALLY TRUSTED，仅限已测合成资源计数链**：scope计数可追溯，未观测不补0，缓存读取不续期，诊断不持久化/泄漏。该判定不覆盖真实基金实时行情，不授予全站金融数据新的TRUSTED标签。

M3仍须处理原all体积、当前源码的新相对时延资格、可观测性更细原因覆盖及精确提交CI；M4/M5/M6仍未开始。原范围完整保留，不以本功能测试通过替代M3退出或v16完成。
