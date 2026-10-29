# v16.0.0 发布风险接受（2026-10-28）

本文件冻结于 16.0.0 候选提交前，冻结时状态：`RELEASE_PENDING`。目标发布状态为 `RELEASED WITH WARNINGS`；本文件不是发布成功证明。后续最终提交、CI、部署与风险接受结果以 [GitHub Release v16.0.0](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.0) 正文/附件及其 Actions 链接为准，不为回填证据再改源码文档或追加 PR。

## 用户决定

用户最新明确要求：**“先跳过这些，推送v16发布v16更新v16”**。

本次据此允许在下列已知证据缺口未先闭合的情况下推进 v16 发布，不再要求用户登录专用 Gist 账号。先前“跳过此项验收”的物理手机豁免，以及“这是安装包大小还是什么 不设上限”的非 OCR 总量政策继续有效。

这是发布顺序与风险接受决定，不是测试结果。旧方案、M4/M5 状态和历史失败按原时点保留；其中“其他项未豁免”的旧发布前置范围，在本次明确列出的项目上由本决定更新，但不改写历史为 PASS。

## 风险账

| 项目 | 实际证据状态 | 本次发布处理 / 剩余风险 |
| --- | --- | --- |
| 专用 Gist 账号登录、凭证与真实双端云验收 | `NOT_RUN`；真实 Gist 写入 **0** | `USER_WAIVED`；不借用主账号做 Gist 测试、不要求登录。远端落盘、冲突/离线恢复及双端一致性未获实证 |
| built-App 真实云 driver、scope→relay 封存交接、真实 durable journal | `NOT_COMPLETED`；driver READY=false；mock relay/独立负控已测 | `USER_WAIVED`；不因纯组件通过宣布真实执行器完成，不接入 transport 偷跑验收 |
| 真正 v15.0.2→v16.0.0 两版已安装 PWA 升级 | `NOT_RUN` | `USER_WAIVED`；现有同版本更新 guard、离线壳和旧 manifest 回放不替代升级/缓存/持仓保持证明 |
| 最终 v16 候选冷/暖/保存等配对性能 | `NOT_RUN` | `USER_WAIVED`；不继承历史 M3 PASS，不宣称变快或满足全部相对时延门槛 |
| 剩余 M5 软件验收 | `NOT_COMPLETED` | `USER_WAIVED`；专用 maskable、WASM、动态加载取消、立即重试重叠、超时/后台、资源峰值等仍未闭合，不自动实现或伪装通过 |
| 三类物理手机各三轮矩阵 | `NOT_RUN` | `USER_WAIVED`；见 [原豁免](DEVICE_WAIVER_20261028.md)，不能以桌面/模拟器替代 |
| 全部非 OCR JavaScript 合计硬限 | `NOT_ENFORCED`，不是 PASS | 依 [总量政策](BUNDLE_BUDGET_POLICY_20261028.md) 继续记录字节；旧 90 KiB FAIL 保留，不等于安装包或磁盘空间无限制 |

## 没有放宽的边界

- cold gzip **52,241 B** 硬限；合法度量、分组/图/绑定、OCR 不进冷图/CORE、发布 archive 安全限制。
- 日期/来源/缓存身份、null 与 0、Schema 3、备份/事务/锁、跨代隔离、legacy/device shard/tombstone 与持仓保护。
- OCR 本地处理、禁止上传截图/原文、逐行授权、真实份额及 A/C 身份门禁；Token/私人内容不得进入日志、仓库或发布产物。
- 最终版本面统一、相关本地检查、精确提交 CI、已验证候选与部署同产物、真实生产只读验证及可追溯回滚准备。新安全/数据保护/cold 失败不能用本豁免改判。
- 不承诺无可信源时仍有实时估值。现有实源证据只覆盖明确日期的正式净值 fallback；名称/类型/市场等未验字段仍须如实披露。

## 证据与发布表述

[LOCAL_QA_20261028.md §6](LOCAL_QA_20261028.md#6-追加延迟返回防重入与最终本地复验) 是升版前最新本地冻结，不是最终 v16 提交/CI/生产证明。其永久测试为 2139 pass / 3 skip、281 syntax、74/74 E2E，两次构建一致；cold51,283 B、all95,884 B。前一次实际候选 DOM/真实 Worker 检查只绑定旧 site `e9e6…`，不追认后续 site `b544…` 或未来发布产物。

最终发布说明必须带上述 warnings，保留 `NOT_RUN/NOT_COMPLETED/USER_WAIVED`，不得写“M4/M5 全部验收完成”。本次授权不产生真实 Gist 写入，也不授权清空用户数据。

冻结时记录：release commit=`PENDING`；tag=`PENDING`；CI/候选 artifact/hash=`PENDING`；部署/生产 smoke=`PENDING`；发布状态=`RELEASE_PENDING`。这些不是发布后的动态状态；主任务将真实结果写入上述固定 tag Release，执行账见 [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)。
