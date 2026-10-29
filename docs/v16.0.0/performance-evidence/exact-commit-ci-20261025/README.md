# M3 精确提交 / CI / 候选下载证据归档

> v16 发布打包说明（2026-10-28）：本目录提交小型历史索引、脱敏摘要和原生命令收据。`original-evidence.tar.gz`（38,378,799 B）仍在原本机路径保存，**未随本次源码提交或 Release 附件发布**；其历史 SHA/采集过程保留，不因缺少公开原件改判旧结果。新克隆不能仅凭本目录复核该本地归档全量字节，公开 CI 链接与本次 v16 的新发布证据分开使用。

日期：2026-10-25。状态：`M3_LOCAL_CI_ARTIFACT_GATES_PASS_WITH_RECORDED_LIMITATIONS / NOT_RELEASED`。这是父级阶段签收的有界证据归档，不是新一轮 QA、生产准入、main 合并或正式发布。应用仍为 15.0.2，v16 的 M4–M6 尚未完成。

## 精确身份与已观察结果

- Commit：`f67675746276173fd3b84b770287e1ab5bea27fb`；tree：`8819c39c3f67d4635c368a42720667f2ae92c391`；epoch：1792914554；branch：`codex/v16.0.0-m3-continuation`。
- [CI run 40174354009](https://github.com/AureliusWu/FundVal/actions/runs/40174354009)，attempt 1、push、workflow `.github/workflows/ci.yml`；candidate job `121111717016` 与 CodeQL job `121111716884` 实际 completed/success。预期的失败诊断上传 step 为 skipped，未冒称执行。
- Linux Node 单测 1412/1412，0 skip；syntax 223；Chromium E2E 35/35；官方 registry audit 0 vulnerability。Ubuntu 24.04.5，Node 24.14.0、npm 11.9.0、Chrome 156.0.8078.47。CI 没有复跑本地 Windows/Chrome 155 的 800+4 性能实验。
- 精确 SHA/ref 的 CodeQL analysis `2021545949`：103 rules、0 results、error/warning 空；该 ref 的 open-alerts API 返回 `[]`。这不表示全仓、main 或所有漏洞均为零。
- [候选 artifact 12590908982](https://github.com/AureliusWu/FundVal/actions/runs/40174354009/artifacts/12590908982)：完整 ZIP 92,695,480B，SHA256 `c1e9cdb2fa4ecdb8c5312c01485910a3015457084556cac2fda9fd2f9256828b`，在归档内只保存一次。
- 实际 V2 artifact auditor native 0 / 9 checks；全部 129 文件与 exact-commit V3 构建逐字节一致。release-critical fingerprint `5290a46055255c8c80123948f4fc6b732d103a9693aba338c6499201345feab1`；完整库存 fingerprint `25c4cd7526bedca483d662fb44279072082a17cf3bc102303057857becbd7091`。二者定义不同，不得混用。CI 日志没有回显的 critical 值在原 CI 报告里仍为 null，后来的下载核验不倒填原观察。
- 原预算不放宽：all 86,850/92,160B；cold 47,014/52,241B。最终矩阵认为证据支持有限 M3 退出；离线早期 owner 仍在 bootstrap/resilience 的架构限定必须保留，不能声称所有离线职责都移进 PWA controller。

## 归档内容与完整性

`original-evidence.tar.gz` 包含明确选定的 20 个原工作区顶层 regular files，以及逐项明确列出的 artifact 工具/实际运行子目录顶层记录。来源包括：原 CI 原生 stdout/stderr/receipt 与 API 响应；commit-control 的拒绝/修正/重提链；final-stage/scope；exact V1、257 source-map probe、causal、V2/V3；下载 a1/a2/a3；原 V1 与最终 V2 auditor；最终 M3 matrix 和独立 offline-boundary 报告。详细来源、原始字节数/SHA 和 payload 去留以 `archive-plan.json` 为准。

执行使用 fresh stage → native tar create → fresh extract → 每个成员字节数与 SHA256 全量相等；并复查所有选定工作区顶层文件 inventory 与 HEAD/branch/index/其他 tracked diff 未变。`archive-audit.json` 保存真实 TAR 大小/摘要、成员逐项库存与原生 TAR 收据；`archive-native/execute-driver.*` 是打包完成后追加的实际外层原生记录，不冒称它们是内部 TAR 成员。

只保留一份完整成功 ZIP（含真实 candidate.json、内部 site.tar 与全部模型）。source TAR、诊断小 TAR、72,712,192B 失败 partial、重复 site.tar 均只留库存/hash 与记录中的 commit 绑定；snapshot、extracted site、junction 不递归复制。它们不是归档中第二份 payload，也不能声称被重新读取或完整存储。内部完整 site.tar 已在唯一成功 ZIP 内，未改写重封。

## 隐私与明确缺口

对拟公开文本按原字节筛查高置信 token/private-key、非 noreply 邮箱、签名/凭证 URL 形状；当前 Git `user.email` 仅在内存取值比较，不持久化原地址。公开 noreply 可保留。保守命中可能包含依赖/测试文本形状；不为了保留 raw 而泛化豁免。命中文件的原件仅留私有 Temp，归档只保存原字节数/SHA 与开头明确标记 `DERIVED REDACTED COPY — NOT ORIGINAL NATIVE BYTES` 的派生稿；不得用其 hash 代替原 native hash，receipt 仍绑定原件。

257 source-probe 的 Git batch stdout 已按原 request、257 blob 边界/长度/OID/SHA 与 `SOURCE_MAP_PROBE.json` 逐项绑定。仅 `test/integrity.test.js` 中两处既有假 Token 的精确已审核 match hash 获准保留，未按整个文件/目录或 token 前缀放宽。batch 中另有邮箱/带 token 参数 URL 形状，故完整原 batch 仅库存，公开为标注的脱敏派生稿；这是明确的 raw payload 缺口，可由其记录的历史 commit `299a92b064b7f77824069eb04db382cf161942d6` 重新读取，不能冒称最终 f676 的原始 source batch。准确受影响文件与 offset/hash 清单见 plan/audit。

这不是综合 secret certification，也不声称扫描了模型/ZIP 的二进制秘密。未读取/收录用户截图、真实 userStorage、真实凭证或私人邮箱配置文件。

## 保留的失败与告警

- GH007 推送拒绝及后续公开 noreply 修正保留原生记录，不覆盖为成功。
- a1 实际 180 秒 SIGTERM，partial 不完整；a2 完整下载成功但 ZIP stdin/libarchive reader 不兼容导致严格两文件检查 STOP；seekable 只读诊断随后成功。没有第三次 artifact GET，也没有拼接 partial。
- a3 的原 V1 auditor 实际 native 1：human `tar -tvf` 本地月份字节被 fatal UTF8 误读。原失败、原工具和诊断均保留。V2 只改变 human type listing 的 Latin1 保字节解码，文件名/JSON/源码严格 UTF8、内部 TAR 校验、来源/129 库存与预算均未放宽；40 原纯控 + 4 本地编码控制实际 44/44。
- CI 的 punycode、url.parse、upload-action Node20→24 弃用告警保留；实际 direct-native-static-link 173B Node ExperimentalWarning 保留。顶层 stderr0 不代表每个内部进程都无告警。
- 历史 staged diff-check native2、格式告警、V1/export EOL 及 epoch 因果修正均按原记录保留，不追改失败或缺失收据。

## 边界

归档未重跑 test/check/build/E2E/800+4，未请求外网、提交/推送、改预算/版本/配置或部署。不构成真实金融源/Gist 双端、OCR 长图、物理 Android/iOS、已安装 PWA 升级或生产 smoke 的通过证据。M4–M6 与最终发布门禁仍由后续阶段独立完成。压缩产物若达到 50 MiB 以上，以 audit 的真实数值交父级评估，不能通过静默丢弃 raw 来缩小。
