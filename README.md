# 蜉蝣基金 (FundVal)

<!-- project-badges:start -->
[![Version](https://img.shields.io/github/v/tag/AureliusWu/FundVal?sort=semver&style=flat-square&label=version)](https://github.com/AureliusWu/FundVal/tags) [![Build](https://github.com/AureliusWu/FundVal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AureliusWu/FundVal/actions/workflows/ci.yml) [![Last commit](https://img.shields.io/github/last-commit/AureliusWu/FundVal?style=flat-square)](https://github.com/AureliusWu/FundVal/commits/main)
<!-- project-badges:end -->

当前版本：`16.0.1`。

轻量、移动端优先的个人基金盘中观察 PWA，用于查看基金估值、净值涨跌、持仓市值和主要市场行情。它不做自动交易，也不构成投资建议。

[在线使用](https://aureliuswu.github.io/FundVal/) · [v16.0.1 Release](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.1)

## 核心能力

- 基金盘中估值、最新净值、持仓市值、今日盈亏与排序。
- QDII / 海外基金模型估算；证据不足或过期时回退到正式净值或不可用状态。
- GitHub Gist 持仓同步、JSON 导入导出、备份与恢复。
- 支付宝 / 蚂蚁财富持仓截图本地 OCR，人工确认后才写入持仓。
- PWA 安装、离线缓存、更新提示与本地通知。
- 行情、缓存、同步和错误处理保留来源、时间与失败降级，不用 `0` 冒充缺失数据。

## 开发与验证

```bash
npm ci
npm test
npm run check
npm run build
npm run test:e2e
```

## AI / 维护者入口

修改前先读 [AGENTS.md](AGENTS.md)。它是当前架构、安全边界、数据语义与验证要求的主要工程约束。

- 当前正式发行与资产：以 GitHub Release 为准。
- 当前工程约束：`AGENTS.md`。
- 发布风险、验收和历史证据：`docs/`，不要回填进 README。
- OCR、本地数据与第三方许可：按仓库现有文档和 `THIRD_PARTY_NOTICES.md` 执行。
- 不得通过清空持仓、伪造行情、借用真实 Token 或跳过来源/时间校验来让测试通过。

README 只维护用户入口和当前状态；发布审计、性能证据、逐版本流水继续留在 `docs/`、Release 和 Git 历史中。