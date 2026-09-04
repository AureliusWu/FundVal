# 蜉蝣基金（FundVal）v15.0.1 实施反馈

## 目标

修复旧版已安装 PWA 在升级到 v15 时出现的混合发布状态：导航请求取得新版 HTML，但旧 Service Worker 的 stale-while-revalidate 先返回缓存的 v14 `app-shell.js`。新版按钮使用 `data-action="apply-update"`，旧版脚本只暴露全局 `applyPendingServiceWorkerUpdate` 给旧 inline handler，导致“安全更新”按钮显示但点击无响应。

## 根因与范围

- MuMu Android 15 / Brave 的生产来源中确认 active worker 为 `fuyu-v14.0.3`、waiting worker 为 `fuyu-v15.0.0`。
- 页面同时呈现 v15 HTML 与 v14 JS；CSP 正常阻止旧版主页面直连第三方 JSONP，这解释了指数为 `--`，但不是行情源故障。
- 人工向等待 Worker 发送 `SKIP_WAITING` 后，页面进入完整 v15 运行态，黄金、上证、沪深 300、纳指 100、标普 500 均恢复为有限值；Bridge iframe 仍为精确 `sandbox="allow-scripts"`。
- 该人工操作仅用于诊断，正式修复不得绕过页面现有安全门禁。

## 实现

- 新增 `js/update-compat.js`，作为首页模块入口之前的独立同源 classic script。
- 仅当全局对象拥有旧版 `applyPendingServiceWorkerUpdate` 函数且用户点击精确更新按钮时，阻止后续重复处理并调用旧函数。
- 没有旧版全局函数时完全不阻止事件，由当前 `js/app.js` 的 `data-action` 委托正常处理。
- 兼容脚本不包含 `SKIP_WAITING`、Service Worker 消息、页面重载或安全状态判断，因而不会复制或绕过旧版的未保存输入、云同步、跨标签页与刷新排空保护。
- 新 URL 位于 SW 构建替换标记之外，并纳入 CORE、发布指纹、构建/部署不变量和 PWA 离线缓存验证。

## 验证状态

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 定向 Node 回归 | `PASS` | 21/21 |
| 全量 `npm test` | `PASS` | 337/337 |
| `npm run check` | `PASS` | 包含兼容脚本与发布脚本语法检查 |
| `npm run build` | `PASS` | 连续两次产物体积一致；16 chunks / 180,728 B |
| `npm run test:e2e` | `PASS` | 8/8，包含新 HTML + 旧 app-shell 组合测试 |
| GitHub Pages 部署 | `PASS` | Actions `33829421960`：审计、测试、构建、E2E、指纹与生产 smoke 全通过 |
| MuMu 生产复验 | `EMULATOR_PASS` | Brave 从 15.0.0 安全更新到 15.0.1；active cache 正确且无 waiting worker |
| 物理 Android Chrome/PWA | `NOT_RUN` | `BLOCKED_FOR_DEVICE_VALIDATION` |
| iOS Safari/PWA | `NOT_RUN` | `BLOCKED_FOR_DEVICE_VALIDATION` |

## 性能边界

兼容脚本是一个新的首屏同源请求，但不进入 app-shell chunk 图，也不加载 OCR、行情或第三方资源。其体积为 1,127 B raw / 511 B gzip；首页 chunk 冷启动图为 149,279 B raw / 51,598 B gzip，低于未上调的 52,241 B 门禁。连续两次构建的 chunk 名称与体积一致。

本地 `npm audit --audit-level=high` 曾因 npm registry bulk advisory endpoint 超时而未形成结论；依赖未在本补丁中变更。GitHub Actions 随后成功完成同一高危审计，未触发漏洞门禁。

## 生产证据

- 应用提交：`4df72bc1b1b38cad5ca4ca1bb7541bc8864bc964`。
- GitHub Actions：[Build and Deploy 33829421960](https://github.com/AureliusWu/FundVal/actions/runs/33829421960)；build 与 deploy 均成功，工作流下载生产关键文件并与构建指纹逐字节比对。
- 独立 HTTP 复核：`index.html`、`js/version.js`、`manifest.json`、`sw.js`、`js/update-compat.js`、`js/app-shell.js`、`js/app-chunks.json`、`quote-bridge.html` 均为 HTTP 200；线上版本为 `V15.0.1`，SW 为 `fuyu-v15.0.1`，兼容脚本位于 app-shell 前且在 CORE 中恰好一份。
- MuMu Android 15 / Brave：从已运行的 15.0.0 点击“安全更新”后进入 15.0.1；`GET_VERSION` 返回 `fuyu-v15.0.1`、waiting worker 为空、缓存只保留 15.0.0 与 15.0.1。Bridge iframe 保持 `sandbox="allow-scripts"`。
- 模拟器行情快照：黄金 9999 `967 / +1.03%`、上证 `3,966 / +0.62%`、沪深 300 `4,583 / +0.67%`、纳指 100 `29,482 / +1.16%`、标普 500 `7,748 / +1.06%`。更新后的首轮异步刷新短暂保持 `--`，约 10 秒后全部成为有限值；期间没有用 `0` 填充缺失数据。
- 真实 v14 缓存壳与新版 HTML 的按钮断裂由确定性 Node 测试和 Playwright 组合测试覆盖；本轮生产来源已先人工诊断升级到 v15.0.0，因此没有伪造一次新的生产 v14→v15.0.1 实际迁移。

发布状态为 `DEPLOYED / DEVICE_VALIDATION_PENDING`。MuMu 是模拟器证据，物理 Android 与 iOS 门禁仍未执行。

## 回滚

如生产验证失败，回滚到最后一个已验证提交。不要只删除兼容脚本而保留引用；`index.html`、`sw.js`、发布指纹和缓存版本必须作为一个原子发布单元回滚。
