# Vite 8.2.4 最小安全补丁：隔离资格通过，root审计服务阻断

> 后续独立单次复查已在同输入/产物身份下收到root audit0，见[安全闭合报告](../audit-closure-20261022/README.md)。本窗口的503/timeout、UNKNOWN及原件保持历史原样，不追改为成功；all预算仍FAIL。

2026-10-22，FundVal15.0.2，`codex/v16.0.0-m3-continuation`，HEAD仍`170fd3eadc6da02750882f8a542904ee2358d0d9`。这是构建工具安全补丁，不是新的JS压缩策略、v16发布或M3退出。此前压缩器有限试验未采用，不能借本轮冒称其兼容/性能通过。

## 当前结论

- 隔离A8.2.2/B8.2.4，完整行为与六次全产物字节身份screen通过，且经独立只读审查。B完整官方audit JSON为0（包含dev），内联launch-editor/middleware实装2.14.2。
- 只回写`package.json`和`package-lock.json`五处标量，保留8.2同minor、Rolldown1.2.5/esbuild0.28.2。无依赖横向重解、`npm audit fix --force`或安装脚本放行；应用版本仍15.0.2。
- root新干净安装、完整测试/语法/Chrome回归及三轮产物身份通过。**root官方audit首次503、唯一有界重查network timeout，均nativeexit1；root最终安全资格为UNKNOWN_REMOTE_SERVICE，尚未闭合。补丁已本地回写保留，不叫最终验收完成。** 本轮已到预声明两次上限，没有继续重试挑0。
- 所有输出仍相同，all84187/cold44699；原all预算77227.7仍FAIL，至少差6960整数B。字节身份只能证明浏览器载荷/静态资源字节成本不变，不能叫时延实测PASS。旧800组不继承；未重跑相对时延、精确CI、真机、OCR引擎、真实金融对账或Gist写入，未提交推送/合并/部署/升版，M3仍IN_PROGRESS。

## 原始问题及最小范围

上一轮8.2.2返回一个high依赖项、六条GHSA，原始证据留在[上轮security-triage](../execution-skips-20261022/security-triage/README.md)。8.2.4为官方列出的同minor修复版本，并非直接采用npm建议的新minor。Vite在本项目只用于构建，`serve`是自写loopback Node服务；没有证明生产静态PWA已被利用，也不忽略构建依赖风险。候选的实装源码含newline/%/UNC拒绝，非只看lock条目；仍不应将开发编辑器服务暴露公网。

允许变化恰为：`package.devDependencies.vite`、`lock.packages[''].devDependencies.vite`、`lock.packages['node_modules/vite']`的`version/resolved/integrity`。其余107个package entry元数据相同；另有root entry使`packages`键总数109。57个实际安装包仅Vite不同，其余56个manifest字节相同，三个原生文件SHA相同；51个未装lock依赖都是本机win32/x64不适用的optional平台包。

## 预声明及冻结输入

先写PROTOCOL，再复制完整当前dirty工作树，不替换为HEAD，A/B无共享node_modules或site。Node24.14.0/npm11.9.0，Chrome155.0.8059.86，epoch1792046773，OXC/es2022/原五组及52241/77227.7预算不变。两边各自`npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund --fetch-timeout=20000 --fetch-retries=0`；前后原五项策略检查通过，仅显式执行已批准的esbuild安装器。

全复制270files/214510943B，inventory SHA`82606e6a07d805379f68889304d04cb228b883599b68ad2b33f1539beaf1349a`。该范围包含24个`.codex-tmp`旧Android输出（202403286B），不应叫230项所选输入或全是构建依赖。A/B这些历史文件也逐项一致，A首轮全site重现旧锚，未进入发布输出。归档保留270全库存，但不重复保存这24个非构建历史产物；其余246份原A文件（含图标/许可证/vendor模型/测试所需v15反馈文档）和B两依赖文件原件归档。没有node_modules或完整127份输出的OCR大文件副本；保留九轮完整输出库存和每轮全部16JS+manifest，不声称完整输出payload归档。

## 原生验证结果

| 实测 | A 8.2.2 | B 8.2.4 | root回写后 |
| --- | --- | --- | --- |
| 完整单元测试 | 1224/1221PASS/0FAIL/3skip | 同左 | 同左，7234.0174ms |
| syntax | 212 | 212 | 212 |
| Chrome E2E | 33/33，1.2m | 33/33，1.2m | 33/33，1.1m |
| 实际build | 3次 | 3次 | 3次 |
| 全site | 127files/92537133B | 全字节相同 | 全字节相同 |
| all/cold gzip | 84187/44699 | 不变 | 不变 |
| 官方audit | 沿用上轮原始8.2.2告警，非本轮新audit | timeout→唯一重查完整JSON total0 | 503→唯一重查timeout，UNKNOWN |

A/B单元和浏览器套件并行执行、各自单worker/独立端口12453/12455，时长不能用于性能比较。root另行完成。三个skip是既有Windows条件项，不是新跳过失败。Chrome非物理Android/iOS；财务值/日期来自原合成fixture，非真实金融验收。

六次隔离build严格顺序A1,B1;B2,A2;A3,B3，不重叠、不重跑替换；第一轮A复现原root锚后才构建B。后续root三轮也完全相同：

- whole sorted-JSON SHA`5b946d23a08cd42743e5151b3ba5bb62ec52b7b6016dcd83eafaac42817124a9`。
- critical SHA`3103251a7107ebb76d61c0a7131430ccf221e204e6aac931a319649c7608bf55`。
- app16/raw245170B；实际图16/18静态/10字面动态/6cold、原生静态绑定通过。未evaluate，图检查不证明启动时序/动态namespace成员；原启动/E2E断言另测。
- OCR23assets/88196906B仅核字节，未运行OCR。SW/CSP/路径及lazy隔离输出完全同锚，既有相关测试保持原断言。
- root预算CLI实原生exit1；wrapper expected1只保存失败，不叫预算PASS。新实际图工具与native-only各自如实标明证明范围。

原`normalizedLock`纯函数对A/B返回不同，原pair/dependencyIdentity严格比较保持原样；未运行sampler、未给旧锁比较开例外。以后真正相对时延测量需要按既有独立协议处理同依赖参考，而不是修改旧证据。

## 失败、隐私及归档边界

1. A1实际build native0并保存正确whole/critical后，临时verifier错误地对字符串读`.sha256`而断言失败。仅改helper为字符串比较；certify只读核同原A1保存报告/磁盘，不build，不替换样本。notes保留，归档helper为纠正版；原assertion完整堆栈未单独捕获为归档成员，不能冒称所有失败都有独立完整stdout。
2. B audit首次timeout/native1和一次成功/native0均保留。root503/native1和唯一timeout/native1都保留。网络失败UNKNOWN，不用B0覆盖root失败。
3. root503响应带短效Cloudflare bot cookie；公开归档仅遮盖`stdout` JSON的`headers.set-cookie`，命令/时间/nativeexit/503错误其余保留，redactions.json记录原件与遮盖版SHA。未遮盖原件仅留本机Temp，报告不输出cookie、密钥或凭证。
4. `qa-summary.json`标注rootApplied=true、rootQualificationComplete=false、UNKNOWN_REMOTE_SERVICE及所有未测项。`original-evidence.tar.gz`与`archive-audit.json`记录实际原件范围/SHA，并在新Temp解压逐文件核验；多数原生凭据原字节，只有上条明确隐私遮盖。

完整本机工作区：`C:/Users/84046/AppData/Local/Temp/fundval-vite824-qualification-20261022-0d5350fa5e31a`。原A包锁可用于审阅/回退对照，不执行破坏性reset。归档内包含预声明、收据、输入/输出库存、工具、完整app字节及独立输入/实装/最终screen报告；根目录最终审查单列其时间边界。此阶段仍无发布资格。

## 归档实核

`original-evidence.tar.gz`共8594767B，SHA256`7b733a9af510dffb59937670f9862e59885bd200fbf49bfaa2cd2f483b3795c5`；484份成员/16264236B，新Temp解压后逐文件bytes/SHA全部一致，库存SHA`9425ff2e18a256162ba3ba58d7aad8ead69981aa9b3b19e6686ae5f4651f36ba`，详见`archive-audit.json`。其中246份A源输入、B两依赖文件、九轮全部app字节/库存和各阶段独立报告均在归档；root503收据仅上述cookie header遮盖，`redactions.json`保留原始/公开版SHA。原270项快照中24个历史输出仅存路径/大小/SHA，不冒称归档全量源副本。
