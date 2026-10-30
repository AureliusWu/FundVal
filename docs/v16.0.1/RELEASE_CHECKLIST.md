# v16.0.1 发布前快照

目标状态：RELEASED WITH WARNINGS。本文件是提交前计划/范围快照，不是部署成功证明；最终精确提交、CI、原候选、部署、生产核对及未解决项以 [GitHub Release v16.0.1](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.1) 正文和附件为准，不为回填结果再造源码PR。

## 范围

- 提交用户指定的maskable图标、构建校验、测试/升级/性能工具和小型原始压缩证据；更新package/lock/runtime/HTML/manifest/SW/协作指南至16.0.1。
- 保护原图、Schema3、备份/锁/事务、旧分片/tombstone、null/0、日期/来源、沙箱及OCR本地隐私。不修改金融计算、运行依赖或个人持仓/Gist。
- 两个新maskable PNG进入release-critical指纹与完整inventory；站点不得丢资源。CI制品ZIP压缩只是传输优化，不改变被发布站点内容或预算。
- Temp、旧大JSON/旧original-evidence.tar.gz、项目外旧版隔离依赖不提交。原证据和未跟踪文件保留，禁止git add .和破坏性清理。

## 执行门禁

1. v16.0.1本地test/check/两次build/E2E、图/绑定/18关键资产/23OCR资产、官方依赖审计、版本面一致，记录原生退出与原始失败。
2. 单一发布PR正常受保护合并，不使用admin绕过；仅成功main-push精确CI候选可部署，不重建替换候选，不继承旧head/main结果。
3. 下载并校验原候选ZIP/inner tar/完整文件清单、18关键指纹、chunks及图标；部署原候选并在真实生产核对版本、图标、页面操作及代表数据。
4. 如可执行，另验证原16.0.0→16.0.1的缓存与合成持仓保护；旧15→16报告不改写为本补丁PASS。
5. 发布精确tag v16.0.1及Release，公开小证据/摘要并核对附件digest和tag指向；保留前向补丁恢复方案，不强制清用户仓储或倒写旧Schema。

## 证据与警告边界

- [10-30补充工作](../v16.0.0/FOLLOWUP_20261030.md)、PWA native3/installed1和60对性能均绑定15.0.2→原16.0.0；其历史raw失败、整体INCONCLUSIVE和阶段字节增长不改写。本补丁只有新候选的实际结果才可记PASS。
- 物理Android/iOS、手机桌面裁切、可见OS快捷方式/进程重启恢复仍未测；真实Gist双端仍未执行，不借用主账号写测试。
- 原生OCR predict取消2秒目标曾NOT_PASSED；新CI继续实际记录，close-before-retry等功能边界不放宽。CodeQL9当前仍OPEN，不能把job成功当零告警。
- 完整生产数据源/字段核对如不可取得，必须记录具体缺口而非冒充实时；新发现实质数据/安全/版本错误不能用历史豁免改为PASS。
- 全非OCR合计无硬上限，实际字节继续记录；cold52,241 B硬限及其他原门禁不变。
