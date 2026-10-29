# 后续完整纵切面规格（只读产物）

[REPORT.md](REPORT.md) 与 [FIELD_LEDGER.json](FIELD_LEDGER.json) 来自本轮另一个独立只读子任务。它们在主验证归档封存后完成，**不属于上一级684成员原件包**。这里单独保存；报告仅规范LF/末尾换行并把字段账本链接改为相对路径，JSON未改字段值。原始系统Temp路径和源/派生SHA见上一级`final-status.json`。

这不是实现、测试结果或新的数据可信验收。报告的有限来源解释不能替代真实数据/独立NAV对账、全量HTTP、设备或生产检查，也没有任何≥6,960 B净gzip承诺。

最重要的新增规格：某些opaque字段先影响Quote、随后才被resource白名单剪掉，不能提前丢弃；第二时钟真类safe-rescue仍须保留；source_quote与selected quote身份不同；双model flag和共享值的旧顺序碰撞不能静默修正；编辑writer保留top unknown而刷新writer重建顶层，两者不仅采集时钟政策不同。

后续从A08/R01/R03/M04/S01的完整旧实现差分和存在性/key-order矩阵开始，再验证一个闭合的私有获取→缓存→投影→兼容输出候选；不直接采用部分迁移，不改变公共API、持久化格式、五组、ES2022、验证规则或预算。
