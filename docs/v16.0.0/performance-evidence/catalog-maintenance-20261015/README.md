# 基金目录维护器：有界摄取与失败不覆盖

本报告保留10月15日的验证窗口；**最新实现与10月18日复验见末尾增补**，不得把旧hash/native.json当作新固定缓冲区的证明。

父提交 `2a9f83090a4620ba86c8037f8c83bfdf077bfb4a`；本轮仅修改 `scripts/refresh-fund-catalog.mjs`，新增 `test/refresh-fund-catalog-limits-v16.test.js`，另补证据文档。不是 M4，不改变页面、金融字段、Schema 3、依赖、版本、构建配方或原性能预算；没有更新项目 `data/fund-catalog.json`。

## 发现、修复和边界

既存 CodeQL #5（HTTP 数据写文件）本身不能证明任意文件写入：URL 与精确本地目标原本就固定，`JSON.parse` 不执行上游 JS，生成身份 JSON 是维护器的预期功能。实际静态风险是无界下载/解析、无界字段，以及直接 `writeFile(target)` 在失败时可能留下截断文件。此前仅有两项 parser 测试，未覆盖下载与文件发布。

现在：

- `FUND_CATALOG_LIMITS` 固定为：下载/输入 **16 MiB UTF8 bytes**、原始 JSON 行 **100,000**、接纳身份的 trim 后名称 **128 UTF16 code units**、实际选用拼音 **512 UTF16 code units**、序列化输出 **16 MiB UTF8 bytes**。原始行数在过滤前检查，输入字节在 trim 前检查；超限不截断字段/目录。
- 保留原合法数据规则：首个有效 code 胜出、原顺序、坏 code/空名称跳过、数字 code 的既有转换、`fullPinyin || shortPinyin` 在 trim 前选择，合法 `* / +` 不被错误白名单删除。字段长度预算不检查被原规则跳过的坏行/重复行及未选用拼音；原始总字节/行预算仍约束它们。
- 原生 body 按实际解压后分片计数，不能用缺失/偏小 Content-Length 绕过；偏大长度提前拒绝，畸形/非安全整数长度 fail closed。分片复制、完整 UTF8 fatal decode；reader 失败不再尝试 `response.text`。注入的无 stream text-only 响应仅事后限额，不能阻止该自定义函数内部先分配大内存。
- 下载维持 **20 s**：Promise deadline + AbortController，并在读取入口、每次 read 前后、text 后及成功出口复查单调 `performance.now()`。晚结果无法进入 parse/write；不依赖本机 Date 或校时。不能强制抢占永不返回的单个同步注入回调；这不是任意 JavaScript 的硬抢占承诺。
- 下载成功才开始文件阶段；固定目标校验在 fetch 前。同目录随机 `wx` 独占文件，通过同一 descriptor 写入/sync/close，最后一次 rename 为唯一提交点。失败只清理本次成功打开的临时文件，不删除旧目标，不回退直接截断。清理失败以 AggregateError 保留错误。没有声称父目录 fsync/断电持久性、恶意本地文件系统隔离或多进程新旧版本排序；rename 已提交后不能用超时回滚。

新增拒绝集合（超预算/畸形长度/无效 UTF8/超时）属于有意的 fail-closed 改动，不能描述为所有旧输入接受集合完全不变。

## 先红后绿，不混淆测试窗口

1. 原源码 raw SHA `b9d54a7fae0ee6a9102e3de40b8f76bd9ced30d01e4e11519006c92d99fb7dea`，最初新测试 SHA `42312e568b3a29ae1bee01e85cb379290afaba08ad6511c5419d8204a67a997b`：实际 **23 项 /8 PASS /15 FAIL，753.9744 ms**。[完整 RED](old-source-red.tap.txt)。不只是缺 export：越界、晚 fetch/text 覆盖合成旧文件、忽略 stream 都有真实失败。
2. 调整两处夹具（真实 Windows path、有效 JSON 内嵌非法 UTF8）并补 pending stream，曾 **26/26 GREEN**；这个历史窗口不等于最终测试全跑过原始旧源。
3. 独立审查发现仅靠 timer 的同步迟到漏洞；新增永久单调时钟测试先真实 **1 FAIL**（Missing expected rejection），再修出口检查：[完整负控](deadline-red.tap.txt)。
4. 进一步补 ready 空分片对定时器饥饿的负控：出口-only 候选实际 **pulls5/cancel0，1 FAIL**，修后读取中复查应为 **pulls2/cancel1**：[完整负控](ready-stream-red.tap.txt)。两项均只模拟单调 clock，不改 Date/系统时间。
5. 最终新增 **27** 项，连同原两项，定向 **29/29 GREEN，713.0319 ms**。全量另有记录，不能将重叠执行相加。

所有文件系统用例将模块逐字 copy 到独立 mkdtemp 项目镜像，实际固定目标仍受原 guard 约束，只写镜像的 data。测试清理先验证所属 Temp 子目录；没有真实持仓、截图、Token 或账户写入。真实 Temp 成功替换/rename 到已有目录失败已覆盖；**未独立注入 open/write/sync/close/unlink 每个故障点**，不把一项 rename 测试冒充所有磁盘/掉电场景。

## 实际目录兼容与一次原生公开网络集成

原/最终 parser 均以当前本地 **27,487 行 /2,822,600 B** 身份数据构造等价上游数组，输出与现有 JSON **byte-for-byte 相同**；最大名称/拼音为 33/86 UTF16 code units。本地目录 SHA 始终为 `f18f3a34d8425ffffd3bc9d9cbbe95fe564bcf01e1605278a38b685313e6304d`。

随后一次明确的原生网络集成：`node --use-env-proxy <Temp>/native-read.mjs`，复制最终模块的独立镜像使用真实 fetch、真实 stream/文件系统，GET 固定公开 `https://fund.eastmoney.com/js/fundcode_search.js`，**200 / Content-Length 3,194,062 / application/javascript**，无内容编码头。实际成功生成镜像 **28,065 行 /2,885,045 B**，含 005844 与 012920 名称，输出 SHA `b32aff3edafba40975c40577a16741475c9ba5fb698d3360c7ede0fa4dba84f8`。项目旧目录仍完全未变；没有把新下载结果偷偷同步进产品。

这是**单次功能集成，不是五样本时延基准**。HTTP Date 为 `Wed, 14 Oct 2026 16:25:48 GMT`，不能当最新目录生成时间、今天净值或源完整性证明。精确 [记录](native.json) / [脚本](native-read.mjs.txt)。可信判定 **CONDITIONALLY TRUSTED**，仅针对有界非执行摄取和失败发布保护；上游身份真实性、是否缺漏及更新时间未独立对账，不推广到行情/金融数据可信。原 Worker 接受门禁仍受未同步主机证据限制，本轮未再校时或重采那五次报价。

## 10月15日实现窗口的本地门禁与产品字节

完整机器记录：[checks.json](checks.json)，确切 [驱动脚本](verify.mjs.txt)。最终源码与新测试在整套检查前后不变；机器记录的 sourceHead 是父提交，不是把未提交实现伪装成该父提交内容。

- `npm test -- --test-reporter=tap`：**1057 /1054 PASS /0 FAIL /3 Windows 条件 skip**；命令总时长 5201.8773 ms。
- `npm run check`：**205** 个 JS；`npm run test:e2e`：**30/30，50.0 s**。E2E 后自有 12437 已无监听；没有操作其他服务。不是物理设备、真实云或版本迁移证明。
- 一次 E2E 前 build，加 E2E 后固定 **3 次** build；都用原配方/epoch `1792046773`。后三次 critical 均 `e6f89a3d534040d6bef8a98555dda95d45978e64f43a741f2bb16dd6fd726725`；whole-site 均 **127 文件 /92,507,487 B / `01b76d4781c3c1e1fefd2a529874feaa4ba555a5f94dbfd41b0d00224a631f93`**，与前一产品构建相同。whole 算法为 localeCompare 排序的 `{path,bytes,sha256}` JSON SHA；source inventory 使用另一明确脚本排序，不混比。
- 原预算 CLI仍 exit1：**all80477/77227.7 FAIL，cold42992/52241 PASS，缺3250整数字节**。维护器从来不在页面产物内，没有移动业务代码逃预算、改变 groups/compiler 或取得减包收益。无新 latency pair，旧200组仍 INCONCLUSIVE。
- `npm audit --registry=https://registry.npmjs.org --audit-level=high`：**0 vulnerabilities**，未改 npm 配置/依赖。OCR资产由真实 build校验；本轮未执行OCR识别。

10月15日窗口 raw 文件绑定：维护器 **8632 B / `72d3ea195c64dbd06b7d4dd528db8755ff4b73b62886d9d229c2da777a1c837c`**；新测试 **16690 B / `a6cf5cf3795f2f1d843b8f356d006b7c841f3d45259f86ca7a3ae6d599928363`**。Git 可按 CRLF/LF 归一化文本；不要把未来 checkout 换行差异误报为测试被篡改。

此目录归档了机器摘要、网络集成脚本/记录、最初 RED 与两个单项负控；全量本地 stdout 仍在 `C:/Users/84046/AppData/Local/Temp/fundval-catalog-bounds-20261015-e07f26d191b4423b804131f5480c103d/final/`，不是所有原件完整归档。前一出口-only 检查窗口亦保留在父 Temp，不覆盖成最终 PASS。

前一文档 SHA 2a9f 的[精确 CI38707517995](https://github.com/AureliusWu/FundVal/actions/runs/38707517995)唯一失败 step15 原预算；CodeQL analysis1958051698/103rules/1result。它不验证本次维护器实现。本实现需新精确 SHA CI/CodeQL；**不关闭/suppress #5，不预称告警清零**。

## 10月18日恢复、固定缓冲区与最终新验证

中断后确认上述改动仍未提交、分支/远端仍2a9f、没有残留检查进程。先对原72d3源码完成一次复验（日志在新Temp父目录），未覆盖旧报告；新审查进一步找到独立资源风险：`chunks.push(Buffer.from(...))` 虽有总字节上限，空/极小分片仍能积累大量 Buffer/数组槽，deadline不是峰值内存上限。

实际新增负控在旧72d3实现上 **1 FAIL，168.8137 ms**：[完整负控](fragment-retention-red-20261018.tap.txt)。输入4096空片再逐字节有效内容，原生流/HWM0，透明旁观 `Buffer.concat` 的列表长度；正常内容输出先核对，再拒绝按分片数增长的聚合列表。此为已知资源实现护栏，不是heap/GC/p95基准或通用内存证明。

现改为一次 **16MiB连续Buffer.alloc**，每片先检查nextBytes再set私有复制，仅decode已写的subarray；不再保留各分片对象。另有decoder输入长度护栏及恰好16MiB合法padding流测试。新增两项后，新测试29+旧2=**31/31 GREEN，1867.2364ms**。16MiB仅维护器保留正文缓冲区的容量，**不是整个JS堆/RSS、解码字符串/JSON/输出或上游队列的上限**；text-only fallback局限不变。不强制抢占永不返回的同步回调。

最终新全量/精确驱动见 [checks-20261018.json](checks-20261018.json) / [verify-20261018.mjs.txt](verify-20261018.mjs.txt)：

- **1059 tests /1056 PASS /0 FAIL /3 Windows条件skip**，命令总时长7946.3597ms；syntax205；E2E **30/30，57.8s**。
- E2E前一次build，之后固定三次build；原epoch/配方未改，后三次critical与whole-site均与10/15窗口相同（127文件/92507487B）。原all80477/77227.7仍FAIL/缺3250B，cold42992/52241 PASS，官方registry audit0。没有新pair/新相对时延结论，没有OCR执行或设备/云/生产验收。
- 214输入/脚本/测试的同算法检查前后不变：4948865B / SHA `3a44cb407c2049411d701125f1c891bfd07c2c5921821964f5934e518e6ccd59`。当前维护器 **8858B / `1a9cf4974a892410e495fe5dc789fef8b9a1badec905cf3f93a52546bfd65ee5`**，新测试 **18937B / `552c94027f2f3299d7b36592bcde4c6206ac3ebc3daddcd97dbb49a2c0b5799c`**；不能继承旧hash作绑定。
- 当前parser再次对27487本地身份进行逐字输出核对通过；项目目录仍f18f3a34、2822600B，未更新。

最终源码还重新做了**一次**真实公开GET+Temp原子发布，见 [native-20261018.json](native-20261018.json) / [脚本](native-read-20261018.mjs.txt)：HTTP200，Content-Length3199055，固定模块复制hash匹配1a9c；生成 **28104行/2889244B**，SHA `cfe7519480916bb750488f42ead1ce29661883524374c9f28829e19dbeb79e97`。仅写独立镜像，不覆盖项目目录。HTTP Date为10/17 04:03:31 GMT，不被转成最新生成时间；这不是独立身份/完整性对账或五样本网络基准，可信判定仍仅 **CONDITIONALLY TRUSTED**。

新完整stdout仅在 `C:/Users/84046/AppData/Local/Temp/fundval-catalog-revalidate-20261018-72166824f10b45f5a1b5976f180bd4c9/final/`；归档只含机器摘要/精确驱动/本次负控与网络集成。旧三阶段与旧失败保留，不混样、不重写为新PASS。源代码变化后确已重新执行完整门禁。

另一次只读系统检查显示W32Time已Stopped/Manual，`w32tm /query /status`返回0x80070426（服务未启动）；固定3个NTP只读样本分别为timeout、+2.4010562s、timeout。保留失败，不由一个成功样本宣称稳定钟差或重复10/15的3.75s为当前值；未执行新的resync/启动服务/改配置，也未重采Worker报价。该外部校时条件没有被本工具修复冒充解决。

提交前完整staged whitespace检查实际报告 **24处 trailing whitespace**：22处在原始`old-source-red.tap.txt`，2处在`ready-stream-red.tap.txt`，均为原TAP格式的缩进空行。保留冻结日志原字节，作为非业务格式warning记录；只排除这两份日志的独立检查用于核对其余文件，**不称整个staged whitespace PASS**，也没有改Git/CI配置或测试断言。

**M3 IN PROGRESS，版本15.0.2；M4/M5/M6、main、正式v16发布未推进。** 后续仍须原包预算、可信主源/独立对账、有效配对时延及后续里程碑；本工具加固不能替代这些退出条件。
