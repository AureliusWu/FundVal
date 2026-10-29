# v16.0.0 升版后的本地发布检查

2026-10-28。范围：`LOCAL_PRE_COMMIT_CANDIDATE`；不是最终提交CI、生产或被豁免的真实验收。后续结果由[固定tag Release](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.0)记录。

- package/lock根版本、runtime、首页、manifest、SW/cache、AGENTS/CLAUDE/README/changelog与实施反馈已统一 **16.0.0**。原版本一致性测试原样通过。
- `release16-build-1/2`：两次 `npm run build` 原生0、完整site清单相同；17非OCR chunks，**cold51,282/52,241 B PASS**、**all95,880 B NOT_ENFORCED**。用户仅取消总量硬限，未取消cold及安全/数据保护。
- `release16-formatted-repository-tests-1`：显式test/全部160个JS/MJS/CJS（含原fixtures），**2142 total / 2139 pass / 0 fail / 3既有Windows skip**，原生0。默认 `npm test` 也另执行；其包含本地Temp独立测试的宽发现总数不冒称永久测试数。
- `release16-syntax-1`：281 JavaScript文件，原生0；`release16-e2e-1`：**74/74、原生0、0retry**，原30s/expect8s不变，08:53:32.840Z→08:56:25.676Z。352 B颜色环境告警保留，合成Gist/桌面OCR不称实云/真机。
- `release16-graph-1`：17chunks、19static/11dynamic edges、6cold，literal闭包与静态绑定通过；不冒称该静态工具证明运行顺序，运行验证另见E2E。
- `release16-ocr-1`：23资产、88,197,828 B，原生0；OCR与模型不进首屏/CORE。
- `release16-audit-1`：官方npm registry，0漏洞、原生0；未升级依赖或合并Dependabot。
- stage只按显式文件清单，不含Temp、个人图片、三份约88MB旧性能raw JSON或38MB历史原始tar；合成785,150 B PNG及其expected/生成定义保留。独立有限复审没有发现新增已证实P0/P1，不等于形式化全仓安全证明。

## 冻结身份及格式边界

本地完整site清单SHA：`221e27ce3d9385a6ab1fbeac485173221cd54008b30b0a2e3af071a64c2f7799`。E2E前后source清单为`582d4c22bedd8a1e241dc4876ba276560fbc555c243d3386e5248856227d1e0c`。随后stage whitespace检查发现两个新测试末尾多余空白行，只各删一个空行，没有改测试逻辑/断言/运行代码；site字节未变，永久单测和默认npm test另重跑。

删空行后source清单SHA：`f0fc6e0812233b47dd2186054ed97438a6c24b51331347bd2315e530d33c015e`。源清单范围同LOCAL_QA，排除docs/Temp/环境；不把两个source身份混成一次冻结。原始命令、退出、stdout/stderr及前后清单在本机`Temp/v16-main-20261028/release16-*`保留，不随源码提交。

两次build stdout SHA：`f8376c44cb64d35bf9c8ec412a011991db7d44ebecf744e29f47ec46d2561fd5`；E2E stdout SHA：`c126c1c3ba2afd86411d6c30b6209eaaaf916a40c2d89482b642c86f66d6ba6a`；最终永久测试 stdout SHA：`8db7d9a5eb4a6eccf966d7c63eb67d7d4e04c5619087b767d1796aa93b8466dd`。

这份本地build使用当时HEAD的SOURCE_DATE_EPOCH，不能直接冒充之后不可变提交的CI产物指纹。发布必须等待新feature/PR和精确main-push CI实际成功，只部署后者的同一候选archive并验证线上字节；不上传本地site替代它。

## 仍保留的风险

真实Gist/专用账号、两版已安装PWA升级、最终配对性能、剩余M5软件和物理设备矩阵依[明确风险接受](RELEASE_RISK_ACCEPTANCE_20261028.md)跳过发布前置，实际NOT_RUN/NOT_COMPLETED不改判。本地实源/虚拟origin旧样本不能代替新线上版本；实际生产smoke、CI/artifact/部署/tag证据由主任务在Release正文/附件中记录。最终目标为`RELEASED WITH WARNINGS`，本文件冻结时尚未取得这些远端证明。
