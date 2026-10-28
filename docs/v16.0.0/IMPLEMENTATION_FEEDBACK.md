# 蜉蝣基金（FundVal）v16.0.0 实施反馈

本文件冻结于 16.0.0 候选提交前，冻结时发布状态：`RELEASE_PENDING`。后续最终提交、CI、部署与风险接受结果以 [GitHub Release v16.0.0](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.0) 正文/附件及其 Actions 链接为准；源码文档保留这份发布前快照，不因回填证据再新增 PR。本文是已实现范围与证据边界摘要；风险接受见 [RELEASE_RISK_ACCEPTANCE_20261028.md](RELEASE_RISK_ACCEPTANCE_20261028.md)，不重新制定迭代计划。

## 已实现的业务变化

| 范围 | 已实现 | 不包含的承诺 |
| --- | --- | --- |
| 数据语义 | Quote→ValuationPeriod→展示契约；基期/目标、正式净值/估值/模型/旧缓存分开，缺失保持 null；缓存保留原来源与时间 | 不凭抓取日期制造“今日”，不承诺上游始终提供盘中/模型数据 |
| 刷新与模块化 | 按资源 TTL/来源批量规划、代际取消/去重/缓存持久化；高风险职责分离和诊断 | 历史 M3 有限签收不是所有后续代码的性能、CI 或生产签收 |
| HTTP 兼容 | 独立 HTTP-only 固定 2000 ms 顶层获取/生成元信息兼容；保留 strict 入口与原 raw 时间，仅偏差分支使用本机 receipt | 不校准系统时间、不依赖 Date/CORS header、不放宽行情/日期/模型或缓存校验 |
| Gist | 档案选择、七态同步、退避/未知写先读、会话凭证与显式记住、读回判定、跨配置 scope、未知创建持久屏障 | 真实 Gist 写为 0；mock relay 不是完成的真实云 driver/durable/双端证明 |
| OCR | 解码前有界预检、本地预处理 Worker、fail-closed importable/身份授权、取消/finally 资源归属、canonical 锁内写入 | 未完成的 WASM/资源峰值/立即重试等软件及真机项继续记录，不称全移动端通过 |
| PWA / 导航 | 身份/scope、Apple icon、可见离线提示、脏状态更新保护、相对子路径 preload、行情/持仓 history 与重复 back 防重入 | 无专用 maskable 验收；同版本场景不是两版已安装升级；页面/设备兼容不外推 |
| 发布证据 | 成功合成 E2E JSON 精确白名单留存配置，候选图/绑定/资源指纹验证路径 | 本地配置通过不等于最终 SHA 已远端上传或部署 |

## 已有证据：按来源分开

- 最新升版前本地冻结见 [LOCAL_QA_20261028.md §6](LOCAL_QA_20261028.md#6-追加延迟返回防重入与最终本地复验)：永久 test/ 集 **2139 pass / 0 fail / 3 skip**；281 syntax；74/74 E2E；两次 site 字节一致。默认宽发现含 Temp，不能拿其 2158 pass 作永久库数量。
- 同一检查点 source 清单 SHA=`1168f85c71e13752e4e290898cdbfccb56dabd02a65a2e4f424c5950d6199b65`，site=`b54490bf84d02d5a8f14f01825fee27631fb62c1daf0c000bd6eac5ca5422218`。这不是发布 commit 或最终 v16 candidate 的新验收。
- 已测 cold **51,283/52,241 B PASS**；all **95,884 B NOT_ENFORCED**，较 10-26 总量增加661 B，不称减包/更快。23 OCR 资产88,197,828 B与非 OCR 总包分开；[PERFORMANCE.json](PERFORMANCE.json) 只记观察与豁免，不伪造配对性能。
- 真实公共读取：四代码的 Worker 正式净值与独立直连正式净值 API 对照；HTTP client 五次 + stage2 一次有原生记录。另一次实际 built-App DOM 使用 `LOCAL_CANDIDATE_VIRTUAL_PRODUCTION_ORIGIN`、仅一批真实 GET，其四行值/日期/来源/fallback 相符；它绑定较早 site `e9e6…`，**不是部署页面，也不继承到随后 b544… 或最终发布产物**。
- 539002 的该次缓存名称为代码、market=cn；本次未验名称、基金类型、市场分类。真实成功 primary/model 样本和完整重仓能力未由上述检查证明。
- 历史精确 CI/产物及配对性能仅属于 M3 既定 SHA；当前发布的 CI、PR/main、tag、不可变候选、生产部署及 smoke 都为 `PENDING`，由主任务实际执行后回填。生产目标为 [GitHub Pages](https://aureliuswu.github.io/FundVal/)，链接不是本轮已验证证明。

## 本次风险接受的结果

用户要求先跳过已列缺口并推进发布，因此专用账号登录/实云双端、两版 PWA 升级、最终配对性能、剩余 M5 软件验收及既有真机矩阵按 `USER_WAIVED` 处理前置关系，实际结果仍 `NOT_RUN/NOT_COMPLETED`。不要求用户登录，不用主账号做 Gist 测试，不做真实 Gist 写入。

旧 RED、skip、总包 FAIL、命令/环境失败与修正收据保留。物理设备、内存/驱动、maskable、WASM、云执行器和资源证明不会因发布标签自动补齐。

## 最终结果归档

冻结时版本目标：16.0.0；release commit/tag、CI run/artifact/hash、部署及真实生产结果均 `PENDING`。版本面同步、最后本地回归、精确 CI 和同产物部署由主任务完成；只有这些保留项有证据后，才在固定 tag Release 中记录 `RELEASED WITH WARNINGS`。这里的 PENDING 不是永久的“当前未发布”产品说明。见 [发布执行账](RELEASE_CHECKLIST.md)。
