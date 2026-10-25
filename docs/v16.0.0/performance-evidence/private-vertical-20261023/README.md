# M3 完整私有路由原型：体积筛查失败，未采用

2026-10-23。原五加载组、OXC、ES2022、预算和当前正确性规则不变。在独立 Temp 建立精确当前 A 和唯一 B，完成获取、资源缓存、模型投影、App 与详情接线后冻结。**这不是纯 canonical 表示全退役**：旧无 Quote/no-slot 导入器、严格资源 codec、wire/source 别名与二次验证继续承担必要规则，未把搬迁代码算净删。

## 实际结果

| 原配方构建 | A：当前基线 | B：私有原型 | B−A |
| --- | ---: | ---: | ---: |
| app chunks | 16 | 17 | +1 |
| app raw B | 252,331 | 256,307 | +3,976 |
| all gzip B | 85,969 | 87,338 | **+1,369** |
| cold gzip B | 46,149 | 46,005 | −144 |
| 原 all 预算 | 77,227.7 | 77,227.7 | 不变 |
| 原 cold 预算 | 52,241 | 52,241 | 不变 |
| budget CLI native | 1 / FAIL | 1 / FAIL | 不采用 |

A 完整 127 产物逐路径/字节/SHA 精确复现当前 root，行 SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`。B 完整 136 产物行 SHA `e6bf67db938858368ed22c6ba13fffe76d50320a0229fcd4abb3499109d7f647`。两次 build 各 native0/stderr0；均固定 `SOURCE_DATE_EPOCH=1792046773`，同 Node24.14.0/npm11.9.0、同已验证安装依赖，无安装/升级。A/B 各仅一次实际产品构建；不声称 B 三次确定性或性能改善。

两侧 app 字节/SHA、关键集指纹与图 CLI 均 native0。B 图为 17 chunks、19 static/11 dynamic edges、6 cold chunks；它只证明 literal import closure/static bindings，仍 `evaluated:false/startupOrderVerified:false/dynamicNamespaceMembersVerified:false`。预算 CLI 实算全部 app chunks gzip，`importClosureVerified:false` 保留，不与图工具的有限证明混用。B cold 减少不抵消 all 失败；不将 facade/codec 排除在预算外。

## 源与实际改动

A 249 份实际非历史输入与 root 当前 §52/54、accuracy-lifecycle archive 的 final-source 原件逐项相同，行 SHA `82532f847b3cd71eaba06703b0609e75520780ecf26b9c23e9fc3d01e301795e`。B 257 份，行 SHA `558cc1a46b1f3b47efdaefed122eb31b18e5a34dda358c77bd7d334bc362072b`。仅改 `js/app.js` 与 `scripts/build-site.mjs`，新增八个 private 模块；build 脚本差异被逐文字核对为原 business 组内四行 membership，五组、flags 和预算未变。全部原测试、公开 APIs、数据/依赖/配置/版本和 accuracy scheduler 原字节保留。

实际移除私有路径的额外 transport 包装、第三次 source 行 spread、compose/apply 中间 fund 物化；局部 holding/market 结果经有序 Map 编码一次兼容行。必要模型算法、独立证据/过期校验、来源时钟、cache acquisition/use/stage/flush 各验证、两个不同外层 writer、旧 cache/render/secondary/accuracy 路径仍保留。新 facade、Map、局部结果对象和搬迁 K 都有成本；没有足够收益填平原 8,742 整数 B 缺口，B 反而需压减至少 10,111 B。

后续对既有实际 chunks 做有限 AST/import/export 只读复盘：未发现整套旧 HTTP/parser/cache/model 与新体意外双份保留；旧业务 facade 实际只剩 accuracy。business-runtime 实测 +1,457 gzip B，post-integrity −144，两业务 facade 合计净 +54，其余合计 +2。大多数算法只是搬迁且仍有兼容表示成本，没有已证实的大块额外死实现可直接删。未运行 ablation，不能把 +1,457 全归因 Map 或按 raw 字节分摊；没有 sourcemap/module membership，静态 signatures 也不是形式化去重或语义等价证明。

## 范围、失败与后续停止线

完整协议在任何 candidate 执行前写定。先 A 精确复现，再 B 唯一 materiality；所有原生 stdout/stderr/receipt 保存，`RESULT` 区分真实预算 native1 与工具异常。冻结时/构建前后核对源、root 完整273输入/127 site/指定68安装/HEAD/branch/index，A 不可变、B 不续写；同一真实 node_modules junction 只读复用。未覆盖 root site，未改系统时钟或原编译器。

独立静态审查只覆盖其所列读取快照，未见明确 P0/P1 不是语义等价或金融 TRUSTED。实现期间与父级只读 diff 的 native1 是预期 source 差异，另有可选文件名读取错误 native1，不能称产品测试失败。controller 首次执行前修复了静态发现的异常退出分类、前置失败保存、超时进程树边界与工具/协议冻结问题；保留版本和口径于独立报告，不将未执行的工具版本称成功运行。

**B 没有进入后续完整 unit/check/E2E、公私有边界独立对照、三轮确定性、配对时延、CI、真实金融源、真机或生产验证。** 原公开 API 测试即便通过，也不能代替私有生产链的回归；本批根本没有跑该候选完整测试。旧 §52 QA、旧 800 不继承到 B。B 未采用，原 root 产品仍 all85,969/cold46,149，原 all 预算 FAIL。15.0.2 / M3 IN_PROGRESS / NOT_RELEASED；无业务提交、推送、合并、升版或部署，未进 M4/M5/M6。

原件 Temp：`C:\Users\84046\AppData\Local\Temp\FundVal-private-vertical-20261023-a1`。归档将收录 A/B 完整实际源、协议/ledger/冻结/本次原生收据、各自实际 app chunks 和完整 site 库存；不重复 OCR 生成二进制或 node_modules。实际归档范围、数量、字节/SHA及新解压核验以 `inventory.json` / `archive-audit.json` 为准；审计及其事后收据为包外 addendum，库存不冒称被排除大文件的 payload。

### 归档后 addendum

已实际完成：669 成员 / 25,920,452 B，压缩归档 15,194,623 B，SHA256 `93dde2ffa959fbeb9ec00b0ff584d0c347b444109ca2191ed8c522f1e82b5d0d`；inventory rows SHA `c2ca2b247124edce69c06462f2338bd5c2e8672df0d56b3cba5edb7ee243f02b`。全新 Temp 解压全部路径/字节/SHA 一致，13 项归档检查 native0。状态是 `ARCHIVE_AUDIT_PASS_NOT_CANDIDATE_PASS`，不是原型通过或完整 QA。归档前后 root/源/实际产物未变；git diff-check native0，原有 1,822 B LF→CRLF 告警保留。此 addendum 在归档之后新增，不能说归档内 README 已包含它。
