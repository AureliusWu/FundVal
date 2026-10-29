# v16 全部非 OCR 总包政策变更

生效依据：2026-10-23用户明确答复“同意仅调整总包上限，继续验收”。这是新授权，不是压缩优化、不等同直接发布，也不追溯覆盖先前固定预算试验。

| 项目 | 原政策 | 本次批准后 |
| --- | ---: | ---: |
| 全部非OCR app chunks gzip上限 | 77,227.7 B（v15基线+10%） | **92,160 B（90KiB）** |
| 冷启动gzip上限 | 52,241 B | 52,241 B，不变 |
| v15比较基点 | 70,207 B / `40e68edab9cb3fba0b17338dc3672a82d13ad17e` | 原样保留 |
| 其他验收 | 数据/兼容/性能/CI/设备/生产等门禁 | 不变，仍须逐项验证 |

唯一执行入口仍为 `scripts/release-fingerprint.mjs --assert-app-bundle-budget <directory>`。阈值固定在工具代码中，不接受artifact/manifest/调用参数覆盖；仍实算每个chunk的gzip并核对路径、分区、未列文件、字节与SHA。报告保留原baseline、`previousAllBudgetBytes:77227.7`，新增明确policy id `v16-total-90kib-approved-20261023`；精确整数比较仍使用numerator/denominator。

当前未变产品是all85,969/cold46,149，按旧政策仍FAIL，按新政策只可能通过包体这一项。新政策没有把拒绝的私有原型或编译器改成合格，也不继承旧800到后续正确性修复。模块归属/三路结构审查的政策前原件见[只读证据](performance-evidence/module-attribution-20261023/README.md)，历史失败见M3_STATUS原各节。

实施顺序：保存原工具/测试和真实旧CLI native1；先增加新政策测试，在旧实现上保留RED；再仅修改政策常量/报告与相应边界测试。运行全量test/check/build/真实App Chrome E2E、最终连续确定性构建、资源及新旧CLI核对；新配对时延、精确提交CI和其余M3条件仍未自动完成。具体结果随后以独立原生证据记录，不提前宣称PASS。

边界不动：业务runtime、金额与null/0、日期/源/缓存/evidence、数据校验、Schema3/device shard/tombstone/legacy、Bridge隔离、OCR隐私、五加载组、ES2022/OXC、依赖、版本仍15.0.2。M3仍IN_PROGRESS / NOT_RELEASED；本次政策阶段不直接提交/推送/部署或开始M4新功能。

实施后结果：新全量1320PASS/3既有Windows skip、syntax216、Chrome35/35、4次完整127构建逐字节一致；新政策CLI0与保留旧CLI1针对同一85,969/46,149B产品。首次全量负例夹具失败与预声明V2纠正均保留，未改admission规则。实际原件、独立审阅及限制见[本地验收证据](performance-evidence/budget-policy-20261023/README.md)。这只关闭包政策及本地QA，不替代新时延/CI或发布。

后续独立补充：当前正确性产品已按原固定800+4协议完成新本地时延PASS及双路重算，详见[§58完整证据](performance-evidence/pair-correctness-800-20261023/README.md)；不继承旧800，不改变政策批准范围。精确提交CI、阶段完整性和M4–M6仍独立待完成，未发布。
