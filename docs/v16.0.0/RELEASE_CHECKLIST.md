# v16.0.0 发布执行账

本文件冻结于 16.0.0 候选提交前，冻结时状态：`RELEASE_PENDING`；目标：`RELEASED WITH WARNINGS`。后续最终提交、CI、部署与风险接受结果以 [GitHub Release v16.0.0](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.0) 正文/附件及其 Actions 链接为准，不为回填证据新增源码 PR。风险接受依据为 [用户决定与逐项账目](RELEASE_RISK_ACCEPTANCE_20261028.md)；这是发布前执行快照，不是所有原方案门禁已经通过。

## 保留的发布检查

| 检查 | 冻结时证据 / 状态 | 最终应记录于 Release 的证据 |
| --- | --- | --- |
| package/runtime/页面/manifest/SW/缓存桶/文档统一16.0.0 | `PENDING`；旧本地冻结为15.0.2检查点 | 版本面结果=`PENDING` |
| 最终版本本地 test/check/build/E2E/audit | 旧本地：2139 pass/3 skip、281 syntax、74 E2E、确定性构建及 audit0；不能直接继承 | 最终 source/site/hash 与原生结果=`PENDING` |
| cold硬限与图/来源/资源/兼容 | 保留52,241 B、原分组/OXC/ES2022、OCR不进冷图/CORE、archive安全限制 | 最终 cold及图/绑定/资产检查=`PENDING` |
| 数据与持仓保护 | Schema3、备份/事务/锁、null/0、源日期/旧身份、凭证/OCR隐私不得放宽 | 最终候选相关回归=`PENDING` |
| 精确提交与PR/CI | 历史M3 CI不继承；本次目标16.0.0 | branch/PR/commit/merge/CI run=`PENDING` |
| 同一已验证候选部署 | 不把本地build、push或CI绿当部署完成 | artifact ID/source SHA/产物SHA/部署run=`PENDING` |
| 真实生产只读smoke | 旧虚拟origin不是部署证据；生产来源、值/基期/目标/状态继续诚实 | URL/版本/资源/console/代表数据/时间=`PENDING` |
| 回滚准备 | 保留向前补丁策略，不降回旧SW/cache，不清空用户仓储 | 恢复点/责任人/步骤证据=`PENDING` |

只有主任务取得本次候选的实际证据后，才在 Release 结果账中将对应项记为 PASS；发现新的安全、数据丢失、cold或候选血缘失败仍须处置，不能借用豁免改判。表内 PENDING 保留为冻结值，不表示发布后仍处于同一状态。

## 明确跳过、但不记通过

| 项目 | 实际状态 | 发布决策 |
| --- | --- | --- |
| 专用 Gist 登录、真实云双端/往返/冲突/恢复 | `NOT_RUN`；真实写0 | `USER_WAIVED`；不要求登录、不借用主账号测试 |
| 完整 live driver/唯一relay封存/真实durability | `NOT_COMPLETED`；READY=false | `USER_WAIVED`；mock通过不改为实云完成 |
| 两版已安装PWA升级/旧缓存/持仓哈希 | `NOT_RUN` | `USER_WAIVED`；同版本guard不替代 |
| 最终候选配对性能 | `NOT_RUN` | `USER_WAIVED`；[PERFORMANCE.json](PERFORMANCE.json) pass=null |
| 剩余M5软件范围 | `NOT_COMPLETED` | `USER_WAIVED`；maskable/WASM/生命周期/重叠/后台/峰值等缺口保留 |
| 物理Android/iOS矩阵 | `NOT_RUN` | `USER_WAIVED`；不是模拟器或桌面PASS |
| 全部非OCR合计体积 | 实际记录；`NOT_ENFORCED` | 当前总量政策，非性能优化PASS；cold不变 |

详细实现与证据入口：[IMPLEMENTATION_FEEDBACK.md](IMPLEMENTATION_FEEDBACK.md)、[LOCAL_QA_20261028.md](LOCAL_QA_20261028.md)、[M4_STATUS.md](M4_STATUS.md)、[M5_STATUS.md](M5_STATUS.md)。旧文件的未完成/未豁免描述保留其历史身份，本次前置豁免只按新风险接受账执行。

## 发布前冻结值与最终结果入口

- release version：`16.0.0`（目标）；commit/tag：`PENDING`。
- CI/candidate：`PENDING`；部署run/产物：`PENDING`。
- 生产目标：[https://aureliuswu.github.io/FundVal/](https://aureliuswu.github.io/FundVal/)；实际验证：`PENDING`。
- 生产数据/console/资源与版本一致性：`PENDING`。
- 冻结时状态：`RELEASE_PENDING`。不得仅因新增文档、升版或推送写 `RELEASED WITH WARNINGS`；实际终态由固定 tag Release 记载，不以这份冻结文档判定发布后的状态。
- 回滚原则：按方案使用统一新版本的向前补丁（例如16.0.1），保存Schema3；不force reset、不单独替换index/SW、不删除用户持仓。实际回滚演练：`PENDING`，不是既有PASS。
