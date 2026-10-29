# M3 未采用的结构减包试验

试验日期：2026-10-13；最终整理与本地门禁复核跨至2026-10-14（Asia/Shanghai）。源检查点为 `17bb8b8dbaacfdf91bccf30b0d89a2c3e33fb9c1`，业务内容仍为 `06aa5daaf6bfcfe21f8360c5426813f6d43262b9`。所有候选未实施。汇总、检查结果和本目录每个文件的 LF bytes/SHA256 见 [机器报告](../m3-rejected-structural-probes-20261013.json)，阶段结论见 [M3_STATUS.md 第28节](../../M3_STATUS.md)。

## 文件用途

| 目录 | 内容 |
| --- | --- |
| `ui/` | 18处 HTML 拼接链重写、5处 stat-cell helper 的三轮实测和精确 patch；两次真实输出的导出/模块库存 |
| `storage/` | migration/scalar/journal/cloud 同步解析的三轮实测；组合收益不可按单项相加 |
| `projection/` | quote 身份与 cached market 投影的三轮实测、精确 patch、定向 getter/Date/异常对照 |
| `cache/` | payload/index 字段表的三轮实测、完整虚拟源、独立只读交叉审查与来源限制 |

15份源报告/脚本与仓库外原文件的 LF 文本逐字一致。`ui/exports-summary.json` 是特意递归删除 `code` 字段、另加顶层 `projectionNote` 说明的库存投影，其余原 metadata 保留；完整 rendered code 仍留在仓库外。不要将此投影的 hash 当作原报告 hash。

`projection/market-probe.mjs.txt` 有原始脚本的末尾空行；为保持精确 LF 证据没有删去。因此本轮 `git diff --cached --check` 唯一告警为该归档的 EOF 空行（exit 1），不是业务代码空白错误；其余变更无 whitespace 告警。Windows Git 的 LF→CRLF 提示只涉及 checkout 换行，哈希核对统一使用 LF。

## 证据和重放边界

- `.mjs.txt` 是原测量脚本的归档文本，不属于 package scripts、业务入口或新自动化门禁。历史绝对路径、HEAD断言和输出名均保留，便于核查原行为。
- 如需重放，先准备新的仓库外输出目录及记录的冻结源码/锁文件/运行时，将归档脚本复制为 `.mjs` 后调整仅环境路径；保存调整后的脚本及新来源身份。不要直接在本目录执行，不要覆盖任何旧报告，也不要把新结果归入旧三轮。
- 使用实际 `scripts/build-site.mjs` 的 AST 配置，只添加精确模块的内存 `plugin.transform`，保持 `write:false`、Vite8.2.2、oxc、es2022和原 groups。没有修改预算、依赖或生产配方。
- 每个预定候选及各自基线三轮一致；动态导出库存是两次只读 baseline 构建，不是候选三轮或时延样本。
- graph SHA 的序列化算法在两个探针族之间不同，不能横向比较；只覆盖模块/边/冷启动角色，不覆盖代码、导出、getter、Date、DOM或行为。
- cache原报告的 `sourceCommit:null` 保留。cross-review依据LF哈希补充17bb Git blob绑定；缺失的探针专属全树前后库存不能追认。
- targeted native/Proxy/throw对照不是通用JS等价证明。没有候选被用于完整app E2E、paired latency、真实Gist、物理Android/iOS或生产。
- 本轮root后来执行的正式build/E2E会正常重建忽略的 `site`；与此前虚拟探针的“未写site”是不同时间窗口。新epoch只改变OCR manifest生成时间；E2E的45 B结果文件在后续正式build中移除。

没有可实施的新收益；这批证据不表示M3退出、v16发布或当前版本升级。
