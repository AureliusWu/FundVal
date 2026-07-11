# 蜉蝣基金 · AI 协作指南

## V10 维护约定

本项目当前版本为 `10.0.3`。保持纯前端和零第三方运行时依赖。业务逻辑应按职责进入 `config`、`calculator`、`storage`、`overseas-model`、`accuracy` 模块，`app.js` 只承担编排和浏览器适配。海外模型配置只允许在 `data/overseas-models.json` 维护。

数据展示优先级与标签固定为：海外基金官方净值 `净` 优先，其次盘中估值 `估` 或海外模型 `模`，网络失败保留旧值并标记 `旧`。任何导入或云端覆盖前都要备份；Gist 新写入使用 Schema 2，但必须继续读取旧数组格式。

完成修改后运行：

```bash
npm test
node --check js/app.js
```

## 项目锚点

- 中文名：蜉蝣基金
- 目录名：`FundVal`
- 类型：纯前端基金盘中估值 PWA
- 部署：GitHub Pages

用户说「蜉蝣基金」时，优先定位到本仓库。

## 不可违背

1. 保持零框架、零构建、零 npm 依赖。
2. 不把本项目与 `pan`（盘中宝）或 `fund-compass`（司南基金）混改。
3. 不硬编码、不输出任何 GitHub Token 或 Gist 私密信息。
4. 涨跌幅字段可为负或 0，判断时使用 `Number.isFinite()`。
5. QDII/海外基金展示要区分：
   - 最新公布净值涨跌：用于主涨跌、排序、今日盈亏。
   - 下一净值模型估算：作为辅助说明，不冒充官方净值。

## 关键文件

- `index.html`：页面结构、PWA meta、版本展示。
- `js/app.js`：核心逻辑，改动后必须做 JS 语法检查。
- `css/style.css`：样式。
- `manifest.json`：PWA 名称与图标。
- `sw.js`：缓存版本、通知、离线策略。

## 数据源注意

- 天天基金估值接口依赖 `window.jsonpgz`。
- 东方财富 `FundArchivesDatas.aspx` 依赖 `window.apidata`，多 type 顺序加载。
- 东方财富 `pingzhongdata` 依赖 `Data_netWorthTrend`，多基金并发时必须串行读取。
- Service Worker 不缓存基金/行情 API，避免估值过期。

## 自检

```bash
node --check js/app.js
git status --short
```

静态项目无构建流程。修改图标、manifest、SW 或主 JS 时，记得同步 bump `APP_VERSION` 和 `CACHE`。
