# FundVal v15.0.2 发布检查表

## 发布前门禁

- [x] 版本面同步：package、runtime、页面、manifest、Service Worker 与维护文档均为 15.0.2。
- [x] 缺失数据继续保持 `null / --`，旧缓存继续显式标记。
- [x] Schema 3、Gist legacy 文件和 OCR 本地隐私边界未改变。
- [x] `npm audit --audit-level=high` — 0 vulnerabilities
- [x] `npm test` — 410/410
- [x] `npm run check`
- [x] `npm run build` — 连续两次构建指纹一致；cold gzip 51,941/52,241 B
- [x] `npm run test:e2e` — 12/12
- [x] 发布关键文件指纹与 app chunk 清单验证 — `2571bf9c52d79196f4f0043a911a4e588c40bcfda7bafd94431ccd35cad54e6e`；22 chunks / 195,074 B；23 OCR assets / 88,196,906 B

## 发布与生产

- [x] `main` 提交并推送 — `210433aec211da0da5c6b6a461bafdd094a2d123`
- [x] GitHub Actions Build and Deploy 成功 — run `36377191275`，build/deploy 全部成功
- [x] 生产 Pages 关键文件与发布候选一致 — `js/version.js`、`js/app-shell.js`、`js/app-chunks.json` 原始字节 SHA-256 一致；`index.html`、`manifest.json`、`sw.js` 仅存在 Windows CRLF 与 Pages LF 差异，换行归一化后逐字一致
- [x] 生产页面、manifest、runtime 与 SW 均显示 15.0.2；SW 缓存桶为 `fuyu-v15.0.2`
- [x] 生产核心页面 smoke — 页面可见、行情卡片日期/数值与独立数据抽查一致，受控无效路径返回 404，OCR 关键静态资源均返回 200
- [x] 持仓增删重载、降级路径、PWA 离线与旧缓存升级由 hermetic E2E 12/12 覆盖；未在生产环境写入真实用户数据
- [ ] 生产来源上的真实持仓/Gist 写入及既有已安装 PWA 的更新、离线与 console/network 深查（`NOT_RUN`）

生产地址：<https://aureliuswu.github.io/FundVal/>

Actions：<https://github.com/AureliusWu/FundVal/actions/runs/36377191275>

发布结论：`RELEASED WITH WARNINGS`。发布和生产 smoke 已通过；警告为非 OCR chunks 相对历史基线增长 11.15%，以及物理设备门禁仍未执行。

数据可靠性：`CONDITIONALLY TRUSTED`。抽查样本与独立东方财富净值序列一致，但截至 2026-09-28，上游最新数据仅到 2026-09-24 / 2026-09-23，不能解释成当日实时估值。

## 独立设备门禁

- [ ] 物理 Android Chrome/PWA（`NOT_RUN`）
- [ ] iOS Safari/PWA（`NOT_RUN`）

桌面浏览器、自动化测试和 MuMu 模拟器不得勾选以上两项。

## 回滚点

- 发布前提交：`5e135b51ce2b9c0fbe37c4119b62cab4b1c33927`
- 如需回滚，使用 `git revert 210433aec211da0da5c6b6a461bafdd094a2d123` 后推送 `main`，由同一 Pages 工作流重新发布；禁止只回滚 `index.html`、版本文件或 SW 中的单一文件。
