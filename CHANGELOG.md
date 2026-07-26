# Changelog

## 11.0.3 - 2026-07-26

- 修复 GitHub Pages 直连东方财富重仓接口因来源校验返回 404、被误显示为“暂无重仓股数据”的问题。
- 十大重仓改走受限只读 Worker 代理，并显示季度披露截止日期。
- 区分“暂无公开重仓”和“重仓数据获取失败”；失败后重新展开可重试，不再缓存为无数据。
- 增加重仓字段、空披露、来源失败及代理链路回归测试。

## 11.0.2 - 2026-07-26

- 非交易日或盘中估值表不可用时，改为显示最近两个正式净值计算出的涨跌幅与净值日期。
- 正式净值降级明确标记为“最近净值/净”，不再显示空白、获取失败或误标为海外非实时估值。
- 增加非交易日正式净值语义和显示优先级回归测试。

## 11.0.1 - 2026-07-22

- Route browser valuation requests through the server-side estimate proxy so the upstream-required Referer is supplied reliably.
- Preserve partial results and missing values, and fall back to cached or model estimates without converting missing data to zero.
- Add proxy, partial-response, and model-rule regression coverage.

## 11.0.0 - 2026-07-22

- 将已下线的单基金估值 JSONP 替换为东方财富现行估值表 JSONP，并保留上游行情日期。
- 新增市场分类、统一数据新鲜度与六类可见状态；旧数据不参与估值排序。
- 页面打开、定时、手动、恢复前台和网络恢复均触发真实新请求，刷新请求按顺序应用。
- 修复顶部时间冒充行情时间、部分失败复用旧排序和 PWA 安装失败被吞掉的问题。
- GitHub Pages 工作流补齐锁定安装、测试、检查、产物上传与正式部署。
