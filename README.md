# 蜉蝣基金 (FundVal)

个人基金盘中估值监控 PWA，托管于 [aureliuswu.github.io/FundVal](https://aureliuswu.github.io/FundVal/)。

## 功能

- 📈 实时基金估值、持仓市值、累计盈亏汇总
- 🌍 顶部指数行情条（纳斯达克/标普500/AU9999实时金价/上证/沪深300）
- 📊 多维度排序（估值涨跌、今日盈亏、市值、收益率）
- 🔍 点击基金卡片展开：十大重仓股 / 基金类型与费率
- 👀 仅关注模式：0份额添加基金，只看估值不计算盈亏
- 📅 收益日历，自动记录每日盈亏
- ☁️ GitHub Gist 云同步，多设备共享持仓
- 📱 PWA 离线可用，支持手机主屏安装
- 🔄 自动检测更新，提示用户刷新
- ↔️ JSON 导入/导出持仓

## 技术

纯前端零框架单页应用：
- `index.html` — 三 Tab 页面 + 指数行情条
- `js/app.js` — 全部业务逻辑，~1450 行
- `css/style.css` — Apple 风格设计，CSS Custom Properties
- `sw.js` — Service Worker v6 离线缓存 + 自动更新检测

数据源：
- 基金净值：天天基金 JSONP（主源）+ 东方财富 fetch（备源），双源并行自动降级
- 指数行情：腾讯行情 JSONP（纳斯达克/标普/上证/沪深300）+ 新浪财经 AU9999 金价
- 基金详情：东方财富 `FundArchivesDatas.aspx`（script 注入，3 类顺序加载）

## 部署

推送 `main` 分支，GitHub Pages 自动部署。
