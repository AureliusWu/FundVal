# v16 物理设备验收：待执行

状态：`NOT_RUN / USER_WAIVED / NO_RC / NOT_RELEASED`。更新：2026-10-28。依据：[总方案 §7、§8、§10.3、M5/M6](UPGRADE_PLAN.md)。当前仍为 15.0.2 未提交开发树；没有可宣布通过的 v16 RC。本文建立执行/记录入口，不是设备测试结果。

2026-10-28用户明确要求跳过三类物理手机验收，范围与风险见[DEVICE_WAIVER_20261028.md](DEVICE_WAIVER_20261028.md)。下表和原步骤作为未执行的标准/未来补验入口保留；所有NOT_RUN均附此USER_WAIVED，而不是PASS。自动化、数据/安全、预算/性能、真实云及生产验收不在豁免范围。

## 环境矩阵

| 目标 | 真实设备/内存 | 系统/浏览器/PWA | 第1轮 | 第2轮 | 第3轮 |
| --- | --- | --- | --- | --- | --- |
| 4 GB Android + Chrome | 待确认 | 待确认 | NOT_RUN | NOT_RUN | NOT_RUN |
| ≥8 GB 主流 Android + Chrome / 已安装 PWA | 待确认 | 待确认 | NOT_RUN | NOT_RUN | NOT_RUN |
| 当前受支持 iOS + Safari / 主屏幕 PWA | 待确认 | 待确认 | NOT_RUN | NOT_RUN | NOT_RUN |

桌面 Chrome、移动 viewport、MuMu/其他模拟器都只能列入预检，不能填进上表。历史 Android 日志和旧版本测试也不能冒充当前 RC 的三轮证据。设备序列号、个人账号及真实相册不进入公开报告。

## 执行前提

1. 冻结唯一 RC：记录真实 Git SHA、版本、构建 epoch、完整产物清单和 release-critical 指纹；当前 M4 总包及其他未通过门禁必须先闭合。运行项目真实命令 `npm test`、`npm run check`、`npm run build`、`npm run test:e2e`，以及两次确定性构建/图/依赖/性能门禁，不能只凭包生成成功开始发布。
2. 使用独立测试配置和纯合成持仓；先保存其 canonical 哈希。不得清除/覆盖用户真实网站存储，也不读取、上传或提交用户真实截图。Gist 真实写入只针对已明确批准账号中新建的独立合成档案。
3. 已有事先固定标注的安全参考长图 **1440×9317、15 行**：`test/fixtures/ocr/synthetic-alipay-1440x9317.png`，SHA256 `487ec86fc114732a3350e02b53c99aa7dfbd7f7e85d9299bda3144d986a0b314`；同目录expected JSON SHA `f5fd86504bab0972d97542d924d3e5da364b9137c544b28781b1452d4c54aaea`。三类设备使用相同文件SHA和原标注，包含真0、null、负收益、A/C歧义及跨片边界；不得从新OCR结果反写真值。它只含公开基金身份和人工合成数值，不使用用户原截图。来源见同目录README；完整可识别图不等于头信息/空白几何夹具。
4. 使用批准的 HTTPS RC 环境，保留真实手机浏览器的网络/控制台/资源证据。独立测试站不得静默变成生产部署；PWA 版本升级必须在同一测试 origin、路径和安装身份内进行，另行记录生产安装验证边界。
5. 记录设备型号/内存、系统和浏览器版本、可用存储、网络、屏幕尺寸、OCR backend/fallback、首次资源下载与缓存状态。不要把首次静态资源下载时长混为纯识别耗时，也不要只报告最快一次。

## 每台设备三轮的固定步骤

1. 打开 RC，验证行情壳、版本、日期/旧值标识、持仓哈希；再从相册选取固定合成长图。
2. 核对本地处理提示、下载/预处理/识别/匹配进度、全部 15 行、所有数字的同行归属、未知字段保持缺失。
3. 核对自动匹配数量及 A/C 身份。不可导入布局/歧义行默认跳过；改代码、候选或 action 不能自动成为逐行授权；必须逐项核对和填写真实份额。
4. 测试取消与安全重试，覆盖预处理、初始化、识别中、切后台/恢复、再次选同一文件。记录“操作取消”到后台真正停止/资源释放的墙钟证据；仅 UI 返回或忽略晚结果不算停止证明。
5. 320/360/390px 等价布局、横竖屏、键盘、safe area：字段可见、无横滚、触点至少44×44、表单至少16px、确认栏不遮末行；相册取消、Android返回、页面关闭和未保存确认都实际操作。
6. 确认一个受控批次，核对写后 canonical 内容、未选行/截图外持仓/notes/tombstone/顺序不变；另测并发编辑拒绝，不以估值反推份额。保存用户确认前后差异的哈希与结果，不公开持仓正文。
7. 离线打开已缓存壳，测到可用交互的耗时并检查“离线/可能过期”；不得呈现缓存为实时。OCR 离线资源能力必须按实际策略记录，不能从资产存在推断。
8. 已安装 v15.0.2→v16：同一测试 origin/path/身份先安装原 v15，再提供精确 v16 产物。带脏表单与未保存 OCR 候选时只能提示更新；清洁后完成更新，检查持仓哈希、waiting 状态和缓存桶。不能用卸载重装替代升级。

## 硬指标及记录字段

| 指标 | 原方案通过标准 | 当前结果 |
| --- | --- | --- |
| 长图覆盖 | 15/15候选；错误自动匹配0；A/C错配0；至少12/15自动匹配，其余可人工完成 | NOT_RUN |
| 主流 Android 耗时 | 三轮中位数≤35s、每轮≤60s | NOT_RUN |
| 4 GB Android 耗时 | 每轮≤90s | NOT_RUN |
| iOS 耗时 | 每轮≤75s | NOT_RUN |
| 稳定性 | 3/3无崩溃/永久卡死；取消≤2s；失败可重试 | NOT_RUN |
| 隐私 | OCR网络仅同源静态GET；图片/OCR正文上传0 | NOT_RUN |
| 离线壳 | ≤3s可用，旧数据/离线身份明确 | NOT_RUN |
| PWA升级 | 脏数据保护、哈希不变、无永久waiting、缓存桶符合预期 | NOT_RUN |

每轮收据至少包含：`rcSha/artifactFingerprint/corpusSha/deviceClass/osVersion/browserVersion/runIndex/backend/fallback/resourceCacheState/totalMs/cancelStopMs/candidateCount/automaticMatched/wrongIdentity/acClassMismatch/crash/retryResult/holdingsBeforeHash/holdingsAfterHash/privacyNetworkVerdict/evidencePaths`。未知数字写 null，未跑写 NOT_RUN，不填0或PASS；截图/日志仅含明确合成数据并审查后保存。

## 收口规则

- 三类真机缺任何一类/任何轮，仍无通过证据；桌面、模拟器、纯函数和header spy不代验。本次用户已明确豁免其发布前执行要求，状态仍NOT_RUN/USER_WAIVED，不改成PASS。
- 任一错误身份、数据丢失、不可恢复写入或截图上传即停止该 RC 验收，保留原失败，不通过重跑冲掉。
- 修复后记录新 SHA/新产物及哪些证据必须重跑；不能把旧 RC 成绩嫁接到新包。
- 正式发布还需 M4 真实双端、最终性能、同一候选部署、生产只读 smoke、回滚和观察。本文未执行上述任何操作。
