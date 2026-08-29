# FundVal v15.0.0 发布检查表

发布日期：2026-08-29
目标分支：`main`
发布状态：`BLOCKED_FOR_DEVICE_VALIDATION`

## 代码与数据门禁

- [x] P0-1 基金/股票代码碰撞关闭。
- [x] P0-2 主页面 JSONP/PAT 同域关闭，隔离 Bridge 沙箱无 `allow-same-origin`。
- [x] P0-3 远端 code/name XSS 关闭。
- [x] Schema 3、tombstone、revision、expectedDocument 与 legacy projection 不变。
- [x] 未知值保持 `null / --`，不归零。
- [x] 删除后立即裁剪显示态、缓存和在途请求。
- [x] 启动只有一个 refresh generation。
- [x] 通知只使用当日新鲜盘中估值并由用户显式启用。
- [x] OCR 保持本地、独立页面、按需加载和人工确认。

## 自动门禁

- [x] `npm test` — `332/332 PASS`
- [x] `npm run check` — `PASS`
- [x] `npm run build` — `PASS`
- [x] `npm run test:e2e` — `7/7 PASS`
- [x] `node scripts/release-fingerprint.mjs --verify-app-chunks-directory site` — `PASS`（16 chunks / 180,728 B）
- [x] `npm audit --audit-level=high` — `PASS`（0 vulnerabilities）
- [x] `git diff --check` — `PASS`（仅行尾提示）
- [x] 版本一致性 — `PASS`（package/lock/runtime/index/manifest/SW/README/协作文档）

## 性能与产物

- [x] cold gzip 预算没有调高：`52,241 B`。
- [x] v15 cold：`149,279 B raw / 51,597 B gzip`。
- [x] lazy：`31,449 B raw / 11,569 B gzip`。
- [x] `js/app-chunks.json` 包含 path/role/bytes/gzip/SHA-256。
- [x] OCR 大资源不进入首页图或 SW CORE。
- [x] 同一 HEAD 连续构建发布指纹一致。

## 移动端与 PWA

- [x] MuMu Android/Brave 持仓新增、刷新、编辑、删除闭环。
- [x] MuMu Android/Brave 真实长截图本地 OCR：15 候选，12 自动匹配，3 人工核对；未确认写入。
- [x] MuMu Android/Brave 14.0.4 → 15.0.0 安全更新。
- [ ] 物理 Android Chrome/PWA — `NOT_RUN`。
- [ ] 物理 iOS Safari/PWA — `NOT_RUN`。

## 提交、部署与生产 smoke

- [ ] release commit — 尚未创建；完成后回填精确 hash。
- [ ] push `origin/main` — 尚未执行。
- [ ] GitHub Actions/Pages — 尚未执行。
- [ ] 生产根页、version、manifest、SW、Bridge、chunk manifest — 等待部署。
- [ ] 生产 chunk 字节数/SHA-256 — 等待部署。
- [ ] 生产代表性基金数据来源、状态、日期/时间 — 等待部署。

## 回滚

- v15 前稳定提交：`3f89327a58c6d5ded7efc0031676aa08733d149d`（v14.0.4）。
- `sw.js` 会在升级后保留紧邻的旧版本应用 shell 缓存，较旧版本在下一次升级清理。
- Schema 3 没有迁移，代码回滚不需要降写用户数据；仍不得用旧客户端覆盖更高 revision 或 future schema。

## 最终结论

自动门禁和生产 smoke 完成后，代码可发布到 Pages；但在物理 Android/iOS 均有证据前，按方案只能记为：

```text
BLOCKED_FOR_DEVICE_VALIDATION
```
