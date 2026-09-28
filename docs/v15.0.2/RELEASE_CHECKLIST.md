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

- [ ] `main` 提交并推送
- [ ] GitHub Actions Build and Deploy 成功
- [ ] 生产 Pages 关键文件与构建候选指纹一致
- [ ] 生产页面、manifest、runtime 与 SW 均显示 15.0.2
- [ ] 生产核心页面、持仓增删重载、降级路径和 PWA 离线 smoke

## 独立设备门禁

- [ ] 物理 Android Chrome/PWA（`NOT_RUN`）
- [ ] iOS Safari/PWA（`NOT_RUN`）

桌面浏览器、自动化测试和 MuMu 模拟器不得勾选以上两项。
