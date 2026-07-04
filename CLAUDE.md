# 蜉蝣基金 · AI 协作指南

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
