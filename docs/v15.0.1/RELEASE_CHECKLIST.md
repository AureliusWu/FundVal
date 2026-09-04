# FundVal v15.0.1 发布检查表

## 代码与安全

- [x] 兼容脚本仅调用旧版已存在的受保护更新函数。
- [x] 兼容脚本不直接发送 `SKIP_WAITING`、不重载页面、不复制安全门禁。
- [x] 首页继续禁止 inline handler，第三方 JSONP 信任边界未改变。
- [x] 缺失行情仍保持 `null / --`，未增加任何 `0` 回填。

## 自动化门禁

- [x] `npm test` — 337/337
- [x] `npm run check`
- [x] `npm run build` — 连续两次一致
- [x] `npm run test:e2e` — 8/8
- [x] 发布关键文件指纹 — 提交后构建候选 `e74092ce191d8d5e2bdfacd47b2e0b6618554f80f332f4dcf41a454f2a534a9d`
- [x] app-shell gzip 门禁与兼容脚本独立体积 — 51,598/52,241 B；兼容脚本 511 B gzip
- [x] `npm audit --audit-level=high` — 本地 endpoint 曾超时；Actions 同一门禁通过

## 发布与生产

- [x] 提交并推送 `main` — 应用提交 `4df72bc1b1b38cad5ca4ca1bb7541bc8864bc964`
- [x] GitHub Actions build/deploy 成功 — run `33829421960`
- [x] 生产静态资源与构建指纹一致 — 工作流生产下载比对通过
- [x] 生产页面为 `V15.0.1` / `fuyu-v15.0.1`
- [x] MuMu Android 15 / Brave 生产 smoke — 15.0.0→15.0.1、五项行情有限、Bridge sandbox 正确

## 仍保留的设备门禁

- [ ] 物理 Android Chrome/PWA（`NOT_RUN`）
- [ ] iOS Safari/PWA（`NOT_RUN`）

模拟器和桌面浏览器结果不得勾选以上两项。
