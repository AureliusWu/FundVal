# 蜉蝣基金 (FundVal)

个人基金盘中估值监控 PWA，托管于 [aureliuswu.github.io/FundVal](https://aureliuswu.github.io/FundVal/)。

## 功能

- 📈 实时基金估值、持仓市值、累计盈亏汇总
- 📊 多维度排序（估值涨跌、今日盈亏、市值、收益率）
- 🔍 点击基金卡片展开十大重仓股
- 📅 收益日历，自动记录每日盈亏
- ☁️ GitHub Gist 云同步，多设备共享持仓
- 📱 PWA 离线可用，支持手机主屏安装
- ↔️ JSON 导入/导出持仓

## 技术

纯前端零框架单页应用：
- `index.html` — 三 Tab 页面（行情 / 持仓 / 状态）
- `js/app.js` — 全部业务逻辑，~910 行
- `css/style.css` — Apple 风格设计，CSS Custom Properties
- `sw.js` — Service Worker 离线缓存

数据源：天天基金 JSONP（主源）+ 东方财富 fetch（备源），双源并行自动降级。

## 部署

推送 `main` 分支，GitHub Pages 自动部署。
