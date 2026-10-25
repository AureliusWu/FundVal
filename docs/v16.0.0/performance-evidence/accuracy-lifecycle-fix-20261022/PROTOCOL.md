# P1-ACCURACY-ENRICHED：独立生命周期修复协议

2026-10-22，实施前。完整v16目标/M3原all77227.7/cold52241/五组/OXC/ES2022/版本15.0.2不变。本修复不是压缩等价候选，不采用Temp部分pipeline或Closure，不把旧800性能继承给改源。

当前§51产品的真实App/Bridge/render/cache合成回归已经在独立Temp执行：交易日匹配的usQQQ模型value1.212/change1/base1.2/Sep25→Sep28/statusmodel/独立证据和显示均通过，但中国Sep29 14:30后自动accuracy ledger仍0，native1。root272/site127/安装68/Git前后同。此前三个工具/夹具失败原件保留：CJS fileURL import、full-title grep均0tests；美股时区不匹配场景被产品正确拒绝，不作为本P1证据。完整原件目录C:/Users/84046/AppData/Local/Temp/FundVal-accuracy-lifecycle-20261022-parent。

## 修复和范围

- 只改js/app.js中accuracy调度：primary和enriched均走同一按海外类别筛选的入口；异步import完成后仍用原generation context.commit，且确认该code当前数据对象仍是同一投影，禁止同代过时对象/旧代回写ledger。
- 不重复使用包含自动改名/持仓事务的整个commitRefreshedFund来发布enriched；重仓、正式/市场模型计算/排序/新槽有效期、canonical Quote规则不变。accuracy核心算法/持久化格式/clock/minute/去重/settle规则不变。
- 新入口成功更新后安排原去重渲染，避免说明统计滞留；加载失败继续原静默降级，不加网络重试/云写入。
- 增加当前实际函数体的受控async调度测试（import seam替换明示，非完整ESM证明），覆盖冷/取消/同代替换/失败/渲染/非海外；正式浏览器测试用真实模块，不显式调用accuracy入口，验证自动预测、暖刷新去重、后续正式NAV结算与不虚造新模型。

## 验证和停止条件

先保存实施前app/E2E字节与Git差异；原已执行Temp accepted-session测试保持原文，再对新实际产物独立GREEN（独占新output、不覆盖RED）。全量test/check/E2E和固定epoch原配方三次完整127构建、原budget/graph必须实际记录；任何FAIL保留。只修正确性、完整测量成本，不为预算删约束/加额度。无新真实金融源对账、Gist/OCR/真机/生产、统计时延、精确SHA CI/发布资格。

本轮只有计划内业务app、既有E2E测试和一新单测会修改；其余§51输入必须同。原A/B248重基线/public64/2×97结果只保其旧源窗口身份，新root变更后不可冒称同身份。编译器前置报告/Java metadata为只读研究，无下载/安装/构建/采用。最终仍需解决总包预算、以最终候选新测性能和全部后续里程碑。
