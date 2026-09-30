# M0：候选产物与生产发布流水线

状态：本地实现完成；GitHub CI、分支保护与环境配置的实际证据由 `BASELINE.json` / `IMPLEMENTATION_FEEDBACK.md` 记录。业务版本保持 15.0.2。

## 运行流程

```text
分支 push / PR / CI 手动运行
  → FundVal CI: candidate + codeql
  → audit / unit / check / build / E2E / 静态资源完整性
  → 原样封装 site.tar + candidate.json
  → fundval-candidate-<40位SHA>-<run_attempt>（保留30天）

protected main 的成功 push CI
  → 显式运行 Deploy verified candidate，输入 run_id + SHA
  → 校验仓库/事件/main/SHA/CI结果/祖先关系/attempt
  → 校验tar摘要、条目类型/路径和全站逐文件SHA-256
  → 原字节重新封装Pages artifact，绝不重构建
  → 受保护的 github-pages 部署环境
  → 部署 + 原有生产资源/发布指纹/OCR完整性smoke
```

`main` push 不再触发生产部署。分支、PR、手动 CI 候选可供审查和真机测试，但生产入口只接受本仓库 `main` push 产生且整个 CI workflow 已成功的候选。`candidate` 和 `codeql` 为固定 Actions 状态检查名称；独立 `CodeQL` analysis 也为必需状态检查，不能仅以扫描上传作业成功代替安全分析门禁。CodeQL 使用 JavaScript/TypeScript `security-extended` 实际分析。

CodeQL job 成功只代表扫描执行/上传成功，不能等同于“无漏洞”；必须再查看 code scanning alerts 并在反馈中记录实际结果。不能以旧主线 CI 成功替代本次新流水线的真实运行。

## 产物身份与重跑

`candidate.json` 固定记录 origin repository、提交 SHA、run ID、run attempt、实际 event/branch、Node/npm、发布关键文件指纹、tar SHA-256、每个站点文件路径/大小/SHA-256及全站聚合指纹。打包脚本不联网、不构建，不把 `.playwright-results` 打包。

每个 attempt 使用不同不可变 artifact 名，避免重跑覆盖或混淆。若仅重跑 CodeQL 导致 attempt 增加，却没有新 candidate，生产校验会失败；请使用 **Re-run all jobs**，重新形成对应 attempt 的完整候选。不能删除旧 artifact 后用不同内容冒充原候选。过期产物需重新跑全部 CI，不在 deploy job 中重新 build。

下载前通过 GitHub API核对 workflow ID/path、origin repository/head_repository、`event=push`、`head_branch=main`、`head_sha`、completed/success 与 artifact SHA。随后用 Git 核对候选 SHA 为最新 `origin/main` 祖先。fork PR、feature push、失败 CI、SHA 不符、未知 workflow、旧 attempt、过期 artifact 都拒绝。

解包前限制文件数/总大小、拒绝路径穿越和任何链接；解包目标必须为空。解包后重新扫描全部文件并比对原清单。Pages 官方产物同样禁止符号链接/硬链接，参见 [upload-pages-artifact](https://github.com/actions/upload-pages-artifact)。

## 本地与CI运行时

固定 Node 24.14.0（`.node-version`）和 npm 11.9.0（package manager/CI断言）。本地使用仓库对应 Node/npm 后运行既有命令：

```powershell
node scripts/dependency-install-policy.mjs
npm ci --ignore-scripts
node scripts/dependency-install-policy.mjs
node node_modules/esbuild/install.js
npm test
npm run check
npm run build
npm run test:e2e
```

`.npmrc` 默认关闭所有 npm lifecycle scripts。`.github/dependency-install-policy.json` 对 lockfile 中5个带安装脚本的包按精确版本与完整性摘要审查：esbuild的已锁定安装脚本在校验后显式执行；fsevents（2个）、protobufjs、tesseract的脚本保持关闭。Playwright 浏览器通过独立显式命令安装。新增/升级安装脚本包会使policy fail closed，需要审查来源、脚本内容与必要性后更新allowlist。

依赖版本、模型、OCR引擎未在M0升级。CodeQL配置/Actions所有 `uses` 固定40位commit SHA；查询配置见 `.github/codeql-config.yml`，[GitHub CodeQL配置说明](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options)。

## 打包/校验命令

CI直接使用以下脚本，不需要新增npm命令：

```powershell
node scripts/release-candidate.mjs create --site site --output <临时目录> --repository AureliusWu/FundVal --sha <40位SHA> --run-id <CI-run-ID> --attempt <attempt> --event push --branch main --release-fingerprint <64位摘要> --npm 11.9.0
node scripts/release-candidate.mjs verify --bundle <候选目录> --output <空站点目录> --repository AureliusWu/FundVal --sha <40位SHA> --run-id <CI-run-ID> --attempt <attempt>
```

`resolve-release-candidate.mjs` 仅在部署验证job通过Actions只读token查询候选元数据。Token不记录在日志、清单或站点产物中。

## GitHub外部设置和验收

需要核对实际GitHub设置，而非仅凭YAML推断：

- `main` 要求 PR，strict required checks 为 `candidate`、`codeql`（App 15368）与独立 `CodeQL`（App 57789），禁止 force push/删除，管理员也遵守保护；单维护者仓库不设置无法满足的第二人审批。
- `github-pages` 环境禁止管理员绕过，部署分支限定受保护主分支；显式 `workflow_dispatch` 是发布入口，当前不增加额外的 required reviewers。
- Pages `build_type=workflow`；Actions权限足以读产物、执行CodeQL和部署。
- 第一次候选CI须在GitHub实际完成，产物可下载且SHA/attempt/全站清单匹配；生产部署仍等M6设备/RC门禁。

定向本地测试覆盖：CI/deploy权限与触发分离、动作SHA固定、未通过/错误仓库/PR/分支/错误SHA候选拒绝、原字节tar往返、篡改摘要、路径穿越、重复清单、非空目标与安装策略变化拒绝。完整test/check/build/E2E由根代理统一执行，避免共享 `site/` 的并行构建冲突。
