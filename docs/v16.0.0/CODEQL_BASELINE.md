# M0 CodeQL 首次真实扫描基线

记录日期：2026-09-30。扫描工具：CodeQL，JavaScript/TypeScript `security-extended`，103条规则。扫描执行成功与没有安全告警是不同结论。本文件不包含凭证或用户数据。

## 扫描与候选证据

| 项目 | 实际证据 |
| --- | --- |
| 首次M0源码 | `ba3346c977f5ec29a15785ee517dbe89291dbce7` |
| 分支push CI | [36685686499](https://github.com/AureliusWu/FundVal/actions/runs/36685686499)，completed/success；candidate、codeql均成功 |
| PR #10 CI | [36685696104](https://github.com/AureliusWu/FundVal/actions/runs/36685696104)，completed/success；candidate、codeql均成功 |
| 分支analysis | ID `1864942572`，ref `refs/heads/codex/v16.0.0-implementation`，commit `ba3346c977f5ec29a15785ee517dbe89291dbce7`，error为空，7个findings |
| PR analysis | ID `1864942616`，ref `refs/pull/10/merge`，实际merge SHA `027efb3b4b4aab4c30d75baaf112cee2f548b902`，error为空，2个新增findings |
| 分支候选 | artifact ID `11083383860`，`fundval-candidate-ba3346c977f5ec29a15785ee517dbe89291dbce7-1`，92,456,652 B，digest `sha256:65b103bd2c927ac2e903f9d5e9bd7da300cec235b47e4a078508311f612e1054` |
| PR审查候选 | artifact ID `11083299438`，`fundval-candidate-027efb3b4b4aab4c30d75baaf112cee2f548b902-1`，92,456,660 B，digest `sha256:03d061768fa03cb3619c23b9edb92f925e4ea13426ca0dbb732aaf5e671376cc` |

PR workflow API的 `headSha` 指向PR源提交，实际checkout/artifact/CodeQL使用merge SHA，以上分别记录，不能混为同一SHA。两份都是审查候选，事件/分支不满足生产发布要求，不能部署。产物摘要来自Actions API；不是生产产物验证。

默认 main 尚无首次扫描结果时，默认 ref 的 alerts API 可能返回 404 “no analysis found”；因此必须显式查询 feature 和 PR ref。未扫描 main 不能描述为“main 零告警”。首轮 PR 的独立 **CodeQL analysis** 检查失败；后续已复扫成功，见本文件修复记录。不能凭 candidate/codeql job 成功直接判断安全扫描通过。

## M0新增告警：必须先闭环

| 告警 | 规则/扫描等级 | 首次位置 | 静态审计与处理 |
| --- | --- | --- | --- |
| [#4](https://github.com/AureliusWu/FundVal/security/code-scanning/4) | `js/file-system-race` / high | `scripts/release-candidate.mjs:132` | 原实现先lstat/校验，再按文件路径读取/执行tar；路径可在验证与使用之间改变。已改为打开descriptor、按同一descriptor验证regular/大小/身份并读取；tar摘要、条目列表、类型和解包全部使用同一个Buffer stdin，不重新打开archive路径。等待新SHA真实CodeQL复扫确认。 |
| [#6](https://github.com/AureliusWu/FundVal/security/code-scanning/6) | `js/http-to-file-access` / medium | `scripts/resolve-release-candidate.mjs:52` | API的run_attempt流入GITHUB_OUTPUT。原实现已有整数检查但仍直接携带response属性；已改为显式Number归一化、安全整数及1～1,000,000边界，输出只携带归一化数字，拒绝字符串/换行/NaN/Infinity。等待真实CodeQL复扫确认；没有通过排除规则消警。 |

本地定向候选测试：5通过、0失败、1跳过；跳过项为Windows账号无法创建文件symlink，Linux CI必须实际执行该用例。已覆盖同一archive快照被三次tar stdin消费、原字节往返、篡改摘要/来源、PR候选不可部署以及恶意attempt。语法检查和diff检查通过。

上表是首次处置记录，当时的“已修复”仅指工作树实现与本地测试。后续真实复扫证据与 GitHub fixed 状态见下方记录；不得把这个过程描述为首次扫描即通过。

## 首次扫描中的5项已有代码告警

这些位置在v15基线已有，并非M0新增。扫描等级不能直接等同于项目P0/P1；下表保留影响分析与下一阶段处理方向，没有关闭或dismiss告警。

| 告警 | 规则/扫描等级 | 首次位置 | 初步判断与处理方向 |
| --- | --- | --- | --- |
| [#1](https://github.com/AureliusWu/FundVal/security/code-scanning/1) | `js/incomplete-sanitization` / high | `js/runtime/quote-normalizer.js:50` | Number转换前只移除首个`%`；多余`%`会形成NaN并返回null，暂未证明能导致注入。应在M1/M2用明确数值语法拒绝重复百分号/非法字符，不能仅全局移除后把畸形值变合法。 |
| [#2](https://github.com/AureliusWu/FundVal/security/code-scanning/2) | `js/incomplete-sanitization` / high | `js/runtime/quote-contract.js:46` | 与#1同类，纯数值入口应统一接受范围和格式；保持null/0 semantics并补反例。 |
| [#3](https://github.com/AureliusWu/FundVal/security/code-scanning/3) | `js/file-system-race` / high | `scripts/build-paddle-ocr.mjs:545` | access检查后再读取emitted worker，理论上存在生成目录的并发替换窗口；构建进程通常隔离，但应改为一次descriptor读取并验证内容，去掉无意义的access-then-read。 |
| [#5](https://github.com/AureliusWu/FundVal/security/code-scanning/5) | `js/http-to-file-access` / medium | `scripts/refresh-fund-catalog.mjs:65` | 本功能本来就把公开HTTP目录转换成静态JSON；代码已限定写入目标为data/fund-catalog.json并解析6位code。需核对字段长度/总行数/输出大小与目录路径约束，以结构化输出证据评估，不以“写HTTP结果”为由直接禁用目录维护。 |
| [#7](https://github.com/AureliusWu/FundVal/security/code-scanning/7) | `js/missing-origin-check` / medium | `sw.js:68` | message handler可触发SKIP_WAITING和通知，缺少显式origin/client校验。浏览器已有同源注册边界，但应复核所有消息调用者，并添加同源且受scope约束的client/source校验，保留脏输入更新保护。 |

## 修复与复扫记录

- 修复提交：`f514f4c9ba05fa28aa2a08225a2c6bcfe53be130`；push run `36686511009` 的完整 candidate/CodeQL 成功，analysis `1864983327`（分支）/`1864982756`（PR）分别为五项既有/零项新增。告警 #4/#6 状态为 fixed，没有手工 dismiss 或扫描排除。
- 最新提交：`f4a71c8e89dbb0d16c6b5a57c6ff78e39b71e4dc`；push run `36687586037`、PR run `36687592688` 及独立 CodeQL 检查全部 success。
- 最新分支 analysis `1865035626`：五项既有，error 为空；最新 PR analysis `1865035398`：零项新增，error 为空，103 条规则。PR 实际 merge SHA 为 `8ba58f9d28845e5e80b5b0530cb444014c891d03`。
- push artifact `11084167560`、PR artifact `11084661788` 均真实存在。两者仍是 feature/PR 审查候选，不满足部署 main 条件。

## M0退出判断

- 新流水线确实执行了完整candidate与CodeQL，产物真实存在且可溯源：已证实。
- PR 新增两项 CodeQL finding：实现、本地回归和真实复扫均已闭环；已有五项必须进入后续工程问题清单。
- 安全扫描门禁满足。M0 仍需完成 collector 跨平台审阅修复、受保护合并和 main 候选字节验证。
- 生产部署、main候选原样发布、设备/PWA验收不属于本次CI成功证据；未执行。
