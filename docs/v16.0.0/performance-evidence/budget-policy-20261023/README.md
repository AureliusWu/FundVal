# 用户批准的总包政策实施与本地验收

2026-10-23。**POLICY_AND_LOCAL_QA_PASS_ONLY / M3 IN_PROGRESS / NOT_RELEASED**。用户明确同意仅把全部非OCR总包上限从77,227.7B调整为90KiB（92,160B）；冷启动52,241B、原基线70,207B/40e、数据校验、功能兼容、性能/CI/设备/生产门禁均不变。这不是压缩优化或直接发布。

## 实际变更与失败保留

相对§52/55的273输入，本轮仅修改release-fingerprint政策常量/报告字段、原budget边界测试、release-candidate超限夹具；新增7项policy测试。没有修改业务runtime、原build/五组/OXC/ES2022、依赖、配置或15.0.2版本。工具仍重算gzip并验证manifest路径/字节/SHA/完整partition，不接受可编辑元数据覆盖阈值。旧基线和previousAllBudgetBytes保留。

先保存原工具并执行旧CLI native1；新7测试在旧实现实际6RED/1PASS。新政策及原budget测试13/13 GREEN后，全量V1真实native1：1323total/1319PASS/1FAIL/3skip。唯一失败的90,000 raw候选夹具在新gzip上限内，故没有发生预期拒绝。预声明V2仅把负例提高至100,000 raw并先断言实际gzip>92,160，保留原admission拒绝断言，不改admission实现。V1源码/日志/收据完整保留；独立只读审阅通过该必要夹具修正。

## V2最终实际结果

| 检查 | 原生证据 |
| --- | --- |
| npm test | native0；1323total/1320PASS/0FAIL/3既有Windows skip，skip不是PASS |
| npm run check | native0；216个源码/测试 |
| npm run test:e2e | native0；真实App桌面Chrome35/35、0flaky/skip；JSON report保存 |
| 浏览器stderr | 352B，两条NO_COLOR/FORCE_COLOR告警；不冒称console-zero |
| 原npm run build | 4次native0/stderr0；固定epoch1792046773，全127路径/字节/SHA精确同§52原产品 |
| chunks/graph/OCR/fingerprint | 各native0；graph仅静态bindings/literal closure，非模块evaluation/startup-order/dynamic namespace证明；OCR是资源核验，不是识别真机资格 |
| 新政策CLI | native0/PASS，all85,969≤92,160；cold46,149≤52,241 |
| 冻结旧CLI对同一最终site | native1/FAIL，all85,969>77,227.7；失败不改判 |
| 当前实际npm audit | native0，官方registry，found 0 vulnerabilities；未安装/升依赖 |

源274完整行SHA `89bdfff42618da6b1743a61e96bf4177ba34329ea716acb73c49e3ee920cc80f`；产品127行SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`，16chunks/raw252331。指定68安装、HEAD170fd3e/branch/index与原窗口同。2份实际成功E2E文件（含自动accuracy生命周期JSON）在构建前recoverable move、逐项核对后收录，不再只依赖list reporter文字。E2E仅合成外源/桌面，非真实金融、云写或设备验证。

## 原件与范围

[archive-plan.json](archive-plan.json)列完整库存及每个收录成员；[archive-audit.json](archive-audit.json)记录全新解压逐项字节/SHA同。归档[original-evidence.tar.gz](original-evidence.tar.gz)：**702成员/19,960,502B**，压缩**9,663,880B / SHA256 `0e5614192ef63cdf7f943d5159f93fa6e2d0d3053a45fc002ec8fc82b5c74011`**。包括全部本轮协议/审阅/原生收据/RED/V1失败/V2结果、最终250份非历史源payload、选定非OCR构建payload、2份实际浏览器原件。完整274源/127site/68安装库存保留；24历史Android输出、生成OCR和node_modules大payload仅库存，不冒称收录。包外README/归档审计是后续addendum，不在包内自证。

结论仅为政策实施及当前本地QA通过。第48节800在后续正确性修复前，不能继承；新配对性能、精确提交CI/独立review及M4–M6仍待完成。本轮未提交/推送/合并/升版/部署，不进入M4，不追溯采用任何失败私有/编译器候选。
