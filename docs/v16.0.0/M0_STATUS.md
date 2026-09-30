# v16.0.0 M0 治理与基线状态

> 更新日期：2026-09-30（Asia/Shanghai）
> 业务基线：v15.0.2 / `40e68edab9cb3fba0b17338dc3672a82d13ad17e`
> 当前阶段：M0 本地与 PR CI 已通过；基线脚本跨平台审阅修复、合并及 main 候选验证进行中
> v16 生产发布：未执行

## 已执行的 GitHub 设置

2026-09-30 通过 GitHub API 读回复核：

| 设置 | 当前读回结果 |
| --- | --- |
| `main` 必需状态检查 | `candidate`、`codeql` |
| 必须基于最新主线 | `required_status_checks.strict=true` |
| 管理员同样受保护 | `enforce_admins.enabled=true` |
| PR 路径 | 已启用；单人仓库批准数为 0，保留自主 PR 合并路径 |
| 线性历史 | `required_linear_history.enabled=true` |
| 讨论解决要求 | `required_conversation_resolution.enabled=true` |
| force push / 删除 | 均禁止 |
| Pages 部署分支 | `protected_branches=true`、`custom_branch_policies=false` |
| Pages 管理员绕过 | `can_admins_bypass=false` |

复核命令：

```powershell
gh api repos/AureliusWu/FundVal/branches/main/protection
gh api repos/AureliusWu/FundVal/environments/github-pages
```

这些是仓库设置证据，不能替代 `candidate` 和 `codeql` 在真实 Actions runner 上通过的证据。

## 本地治理实现

- `.github/workflows/ci.yml`：push/PR 运行检查并生成与提交 SHA 绑定的候选产物；不调用 Pages 部署。
- `.github/workflows/deploy.yml`：只接受显式 `workflow_dispatch`，验证候选 run、提交主线关系、清单及每个产物字节，再部署同一份产物。
- `scripts/release-candidate.mjs`、`scripts/resolve-release-candidate.mjs`：候选打包、来源验证、路径与字节校验。
- `.github/codeql-config.yml`：JavaScript CodeQL 扫描范围和排除项。
- `.node-version`、`package.json`、`package-lock.json`：固定 Node 24.14.0 / npm 11.9.0；业务依赖版本保持基线。
- `.npmrc`、`.github/dependency-install-policy.json`、`scripts/dependency-install-policy.mjs`：默认禁止依赖安装脚本，按锁文件及完整性字段核对；仅单独执行已审查 esbuild 安装脚本。
- `scripts/check-source.mjs`：扫描所有业务、脚本、测试及 E2E JavaScript，避免旧手工文件清单漏掉新模块。
- `serve-site`/Playwright/E2E 支持独立端口，避免复用其它项目的开发服务。

GitHub 流水线已在 [M0 PR #10](https://github.com/AureliusWu/FundVal/pull/10) 首次验证。提交 `ba3346c977f5ec29a15785ee517dbe89291dbce7` 的 push run `36685686499` 和 PR run `36685696104` 均完成，`candidate`、`codeql` 作业均成功。PR 候选记录实际 merge SHA，不能把它冒充为 head SHA 或可部署主线候选。

首次 CodeQL 分析另外报告了两个新增脚本告警，自动 `CodeQL` 检查失败。提交 `f514f4c9ba05fa28aa2a08225a2c6bcfe53be130` 修复后，两项均被扫描标记为 fixed（没有排除规则或 dismiss）；最新 `f4a71c8e89dbb0d16c6b5a57c6ff78e39b71e4dc` 的 push run `36687586037`、PR run `36687592688` 的 candidate、codeql 和独立 CodeQL 检查均成功。PR analysis `1865035398` 没有新增发现；分支 analysis `1865035626` 保留五项既有业务发现，详见 `CODEQL_BASELINE.md`。

期间 PR run `36686518090` 的跨标签页 stale-editor E2E 发生一次间歇失败（拒绝提示断言未出现，尚未运行到最终持仓断言），不能推断为已经证实数据被覆盖。原始用例本机连续 10 次通过；新增仅含合成数据的现场诊断后本机 3/3、最新 push/PR 12/12 通过。业务写入逻辑及拒绝覆盖断言未修改，没有自动 retry；此观察项继续进入 M1/M4 回归，不宣称业务 Bug 已修复。

## v15.0.2 可重复基线

机器可读报告：[`BASELINE.json`](./BASELINE.json)。报告明确绑定原始提交，后续治理测试、配置和业务修复不计入历史基线。

重现命令：

```powershell
node scripts/collect-baseline.mjs --reference 40e68edab9cb3fba0b17338dc3672a82d13ad17e
```

脚本行为与证据边界：

1. 将指定提交 `git archive` 到独立临时目录，按 LF 统一文本换行；不改工作区源文件。
2. 对照原锁文件与已安装根依赖版本；M0 `engines` 元数据不影响依赖身份，任何解析包变化则停止。
3. 使用独立随机 localhost 端口，只替换临时快照内 serve/Playwright/fixture 的端口字面量；保持原始测试断言。
4. 在快照中运行原始测试、原始 check、Node coverage、audit、两次完整 build、原始 E2E。
5. 保存逐文件 raw/LF-normalized SHA-256、chunk/OCR 清单、三组 UI 耗时和三组冷/暖刷新请求数。
6. 完整日志及清单位于报告所引用的 `baseline-evidence/`；工作区 `site/` 重建不会删除它们。
7. 清理仅针对脚本新建且验证过的临时目录；先移除依赖 junction，不递归触及工作区 `node_modules`。

当前原始基线结果：

| 项目 | 实测结果 |
| --- | --- |
| 原始 Node 测试 | 410/410 |
| 原始语法检查 | 通过 |
| 两次完整构建 | 通过；所有生成文件指纹一致 |
| 原始浏览器 E2E | 12/12 |
| 官方 npm registry audit | 0 vulnerabilities |
| 冷启动 gzip | 51,941 B / 52,241 B hard budget |
| 所有非 OCR chunks gzip | 70,207 B；22 chunks |
| OCR 清单校验 | 23 assets / 88,196,906 B |
| Node 可观察模块 coverage | line 89.83%、branch 约 76.8%、functions 92.57% |
| 冷启动请求图 | 三组均 36 总请求 / 8 结构化数据或行情请求 |
| 同页暖手动刷新 | 三组均 11 总请求 / 7 结构化数据或行情请求 |

暖刷新每组仍有正式净值 3 次、重仓 1 次；这是 M3 应减少的稳定数据请求基线。其它请求被分别计入静态资源、指数、证券行情或阻断的外部来源，不能把 7 次数据请求误写成全部网络请求。

默认本机 npm mirror 不实现 security audit API，原始 `npm audit` 返回 404；显式 `--registry=https://registry.npmjs.org` 通过。报告保留失败与重跑证据，失败不能被解释为依赖存在漏洞。

Coverage 的分母仅包括 Node 运行实际导入的 `js/**/*.js`，不包含 `app.js` 的浏览器 DOM 行为和未导入模块，不能宣称“全项目覆盖率 89.83%”。三次性能采样不支持稳定 p95；该值为 `null`。最终精确样本、指纹及采集时间以 `BASELINE.json` 为准。

## 责任人与回滚

| 角色 | 当前安排 |
| --- | --- |
| 仓库及最终版本范围负责人 | GitHub 仓库所有者 AureliusWu / 当前用户 |
| 实施及门禁执行 | 当前被授权的 Codex 任务 |
| 发布执行 | 当前任务在 M6 所有门禁满足后，使用已验证候选显式 dispatch |
| 回滚执行 | 当前被授权任务按 `UPGRADE_PLAN.md` 第 13.3 节，生成向前补丁并验证 |
| 物理设备验收 | 待提供可连接的目标设备；模拟器不作为真机通过证据 |

业务回滚点仍为 `40e68ed`。v16 实际发布失败时使用向前补丁版本，不能只替换页面或把 SW 缓存版本降回旧值。当前 M0 阶段尚无 v16 可发布或可回滚产物。

## M0 退出记录

- [x] 原始 v15.0.2 基线可隔离重现。
- [x] 主分支和 Pages 环境设置读回一致。
- [x] CI/Deploy 分离实现已落入工作区。
- [x] Node/npm 与安装脚本策略已固定。
- [x] 基线工具辅助测试通过。
- [x] `f4a71c8` 本地门禁：Node 421 项（420 通过、0 失败、1 个 Windows symlink 权限跳过；Linux CI 实际执行）、语法扫描 134 文件、两次 build 指纹一致（`1b66e1fceed57efe43706536490010787b96c4a6fde488eccb2c9a04abd77945`）；冷 gzip 51,941 B、总非 OCR gzip 70,207 B。指纹包含提交相关构建元数据，不能和不同 SHA 直接判为业务漂移。
- [x] M0 PR 的真实 `candidate` / `codeql` / CodeQL analysis 均通过（最新 push / PR）。
- [x] 新增 CodeQL 告警修复并通过真实重扫。
- [ ] 跨平台 npm 发现审阅项闭环，按受保护 PR 路径合并（不使用 admin bypass）。
- [ ] 候选清单可追溯至同一 SHA / run，且部署路径验证通过。

以下保持 `NOT_RUN`：三类物理设备、实际长图 OCR 耗时、真实双设备合成 Gist 写读、已安装 v15→v16 升级、生产性能与真实上游请求数、独立网络/服务端/主线程时延分解。
