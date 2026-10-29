# M3：独立 ESM 闭包 / 静态绑定门禁（2026-10-20）

结论：补齐了压缩产物的独立验证能力；未修改业务 JS、构建配方、依赖、预算或版本。当前产品仍是 15.0.2 / M3 IN PROGRESS，**不是 v16 发布**。

## 为什么增加此门禁

原 `release-fingerprint.mjs` 验证清单完整性、文件安全、字节、SHA、gzip 和清单内 cold/lazy 分区。一个“导入不存在的 named export，但重新计算清单 SHA”的合成产物仍可通过旧字节核验。这是原工具明确声明的覆盖边界，并非发现当前产品有断裂绑定。`build-site.mjs` 另有 Rolldown 元数据存在性及阶段隔离检查，但没有独立解析最终命名绑定。

新增实现：

- `scripts/app-module-graph.mjs`：对最终 JS 做 AST 字面依赖分析；受限 Node 子进程只调用原生 `SourceTextModule.link`，不调用 `evaluate`。
- `scripts/release-fingerprint.mjs`：安全读取、验证 SHA/gzip 后，直接复用同一批内存字节，不按 import 再读磁盘。
- `test/app-module-graph-v16.test.js`：37 项新增测试。
- CI 新增完整图门禁；部署准入和生产 smoke 新增 native-only 静态绑定门禁。

## 两种命令的不同证明范围

```powershell
# 有项目锁定依赖的 CI / 本地：AST 闭包 + 原生静态绑定
node scripts/release-fingerprint.mjs --verify-app-module-graph site

# 零依赖、禁止重建的部署 job：只做原生静态绑定
node scripts/release-fingerprint.mjs --verify-app-static-bindings site
```

| 项目 | 完整图命令 | native-only 命令 |
| --- | --- | --- |
| 复用已通过文件 / SHA / gzip 核验的字节 | 是 | 是 |
| AST 检查静态和字面动态 import | 是 | 否 |
| 实际 cold 闭包精确等于清单 | 是 | 否 |
| 清单中所有 chunk 从入口可达 | 是 | 否 |
| 全部 chunk 的原生命名静态绑定，包括 lazy 内部静态依赖 | 是 | 是 |
| 执行应用、证明启动顺序 / TDZ 安全 | 否 | 否 |
| 验证 `import(...).then(ns => ns.foo)` 中的 foo 存在 | 否 | 否 |

完整图命令只接受字符串或无插值模板动态 import，拒绝计算式、外部 URL、裸包、query/hash、编码路径、双斜杠、越界或未列文件、import attributes/options。cold 的定义与现有构建一致：入口及其直接动态根的静态闭包；不从此推断 await/微任务顺序。

子进程预建所有模块，以一个合成根一次链接，覆盖循环、星号和间接导出。输入 JSON 上限 16 MiB，stdout+stderr 上限 64 KiB，默认 10 秒截止；这些是链接子任务限额，不是整个父工具堆/RSS的上限。Node 24.14.0 的 VM module API 仍属实验接口，必须显式开启 flag；缺失时失败，不静默 skip。方法依据见 [Node 24.14.0 官方 VM 文档](https://github.com/nodejs/node/blob/v24.14.0/doc/api/vm.md)。

部署原有“不安装依赖、不重建候选”测试保持原样。AST 解析器仅按需导入；native-only 使用 Node 内置模块。已将 release CLI、helper、asset-manifest 三文件复制到无 node_modules 的独立临时目录，实测正控和缺失 export 负控。部署不把 native-only 的 `literalImportClosureVerified:false` 改成 true；完整图证据来自 CI，部署仍需验证同一候选的字节和来源。

## 测试和复核

新增 37 项包括：alias/default/string-named export、namespace/star/菱形同 binding、合法循环；缺失 default/named/间接导出、星号不透传 default、歧义星号、无底层 binding 循环；仅动态可达 lazy 内的坏静态绑定；字面模板、冷分区误报、不可达 chunk、非法 UTF-8、篡改后 SHA 不符；超时、输入/错误输出上限、无 flag 和无依赖环境。

专门保留两个“链接可通过、运行仍可能出错”的边界：`ns.missing()` 和真正的循环顶层 TDZ。包含 DOM、throw、TLA 的正控同样能链接，证明工具没有执行它们，而不是证明它们执行安全。

首轮新工具尚不存在时 29 项 RED；这是新增能力缺失，不是原版有 29 处运行 bug。首轮完整 stdout 未归档，不能声称完整 RED 原件已保存。中间独立审查发现初稿的部署解析器依赖和双斜杠规范化误判，均在最终回归前修正。早期 `node:vm` 命名导入在无 flag 父进程不可用的探针失败后改为 namespace 访问。最终复核未发现新的阻断。

## 实际本机完整回归

业务基点 `170fd3eadc6da02750882f8a542904ee2358d0d9`，新验证工具/测试/workflow 为未提交工作树。不是 clean checkout，也没有把旧 CI 授予这份修改。

| 检查 | 实测 |
| --- | --- |
| `npm test` | 1101 项：1098 PASS / 0 FAIL / 3 既有 Windows 条件 skip，5948.1245 ms |
| `npm run check` | 207 文件 PASS |
| `npm run build` | E2E 前 1 次，之后连续 2 次 PASS；SOURCE_DATE_EPOCH=1792046773 |
| `npm run test:e2e` | 原安装 Chrome，31/31，53.9 秒；端口 12437 前后无监听 |
| `npm audit --registry=https://registry.npmjs.org --json` | exit 0，0 vulnerabilities |
| 实际新图命令 | 16 chunks / 18 static edges / 10 literal dynamic edges / 6 cold chunks，PASS，未 evaluate |
| native-only 命令 | 16 chunks 静态绑定 PASS，字面闭包明确 false |
| app / OCR 字节核验 | 16 / 235647 B；23 / 88196906 B，PASS；未运行 OCR 引擎 |
| 原预算命令 | exit 1：cold 42985/52241 PASS；all 80494/77227.7 **FAIL** |

采集窗口 2026-10-20 07:08:27.604 UTC 起，实际进程结束时间在 `qa-receipt.json`。213 个选择的 source/tool/workflow/test 文件，前后 LF 规范化库存 hash 均为 `0f45a4fff641976b19ef1d27559d17cccc395dbe7cc29200a8e3bbde3f12b343`；完整路径列表在收据中，不把该选择集称为全仓库存。

整个 site 前后及最后两次构建均为 127 文件 / 92507677 B；排序 `(path,bytes,sha256)` JSON 库存 SHA 为 `7d4d8c1e0828f09164bf10b8ef64e8be6f06ccb8cdca61ed7dc2f031c0e68e37`。两次 release-critical 指纹均为 `4bda36bc3ed361fcbf69d44d96f30af47fc1fff3b75eefd8728a341a45680948`。构建输出字节与此前产品相同，未重新采样性能，不将 800 组结果重写或混入新样本。

`qa-receipt.json` 保存命令、退出码、source 库存、产品库存和预算结果；`logs/` 完整归档本次 14 条命令的 stdout/stderr，`archive-audit.json` 实核复制后字节/SHA，采集器以 `.mjs.txt` 保存，不是可执行项目入口。没有新 GitHub CI、真实账户/Gist、金融源、设备或生产验证；未提交、推送、部署或变更版本。**M3 仍需解决至少 3267 B 包体积缺口。**
