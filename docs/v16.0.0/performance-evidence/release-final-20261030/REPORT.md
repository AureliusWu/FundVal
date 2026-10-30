# v16.0.0 最终版本性能对照（2026-10-30）

结论：**对照已完成，整体 INCONCLUSIVE，不是全部性能门禁通过。** 首次唯一运行完整保留60对有效样本及4对预热，AB/BA各30，无重试、移样或异常值删除。冷启动、保存通过原门禁；暖重载点值更快，但p95置信区间宽度超过原20%稳定度，不能升级为PASS。未追加采样或调宽门槛。

## 版本与方法

- 基线：真实v15.0.2源码 `40e68edab9cb3fba0b17338dc3672a82d13ad17e`，164个文件逐Git blob核对，原锁独立安装、仅受审esbuild安装脚本执行；原build的SOURCE_DATE_EPOCH=1790569957，build前后源码不变。
- 当前：已发布v16.0.0 `35808ee3b4698db1f9919cbc8f0d4033f9baa986`，CI40877032757 attempt1原始candidate的139文件完整匹配。**不是后来新增maskable图标的工作树产物**。
- 两版各自原锁/真实构建：Vite8.2.2→8.2.4，故是整版对照，不是仅应用源码变化的单因素因果实验。旧版npm ci报告2个历史high漏洞，基线只在隔离本地使用，不部署、不擅自升级。
- 同机、Chrome 156.0.8078.74、390×844、同一个自有loopback origin及同一根URL。服务器仅切换只读artifact根，逐项校验启动图HTTP字节；每side全新context，完成关闭后才切换。
- **URL边界**：这是可比的根URL本地基准，不是实际 `/FundVal/` 路径验收。旧v15在真实子路径同时观察到root-absolute preload 404与UI保存失败，保存异常具体根因未完成溯源，不能把两者当成已证唯一因果。详见独立升级报告；不修旧包，也不把根URL保存成绩推广为旧生产路径可用。
- **冷/暖含义**：cold为空持仓新context的壳ready；warm为保留本地存储的同context重载，HTTP cache仍关闭/no-store，SW被安全屏蔽。不是HTTP缓存热启动、OS冷/暖启动或已安装PWA性能。保存新增一条合成持仓，不是7基金实盘组合。
- 沿用现有measureSide和summarizePairs：4预热、60有效配对、5000分层整对bootstrap、seed160003；median≤基线115%、p95≤120%、当前任一样本<3000ms、p95区间宽≤20%、bootstrap通过比例≥95%。项目门槛未放宽。

## 时间结果

单位ms；每格为median / p95 / 最慢。

| 指标 | v15.0.2 | v16.0.0 | median变化 / p95变化 | 原判 |
| --- | ---: | ---: | ---: | --- |
| 冷启动 ready | 142.850 / 174.600 / 200.300 | 136.750 / 179.600 / 196.100 | -4.27% / +2.86% | PASS |
| 暖重载 ready | 75.200 / 113.100 / 129.900 | 70.900 / 87.500 / 100.800 | -5.72% / -22.63% | INCONCLUSIVE |
| 保存 UI（runner wall） | 75.717 / 89.546 / 100.800 | 65.730 / 72.712 / 107.549 | -13.19% / -18.80% | PASS |

## 置信与稳定度

比例1表示不变；置信区间为95%分层整对bootstrap，全部60对计入。bootstrap通过比例不是“总体通过概率”。

| 指标 | median比率区间 | p95比率区间 | p95区间宽：旧 / 新 | 稳定 | 重采样通过比例 |
| --- | ---: | ---: | ---: | --- | ---: |
| coldReadyMs | 0.931 – 0.977 | 0.880 – 1.116 | +8.30% / +19.32% | true | 99.920% |
| warmReadyMs | 0.889 – 0.988 | 0.681 – 0.995 | +26.44% / +21.26% | false | 100.000% |
| saveUiMs | 0.844 – 0.891 | 0.787 – 0.869 | +6.53% / +3.37% | true | 100.000% |

暖重载的p95相对区间宽分别26.44%与21.26%，超过20%，故即使其点值及比率上界看起来更好，仍是INCONCLUSIVE；不是已确认回归，也不是PASS。

## 网络等待与客户端残余

以下为各60个样本的中位数；missing>0时整项保持null而非删掉缺失样本。loopback TTFB/download不是生产API延迟或隔离服务端CPU；postHttpBootstrapAndDom是HTTP响应后到ready的残余，不是纯JS CPU。renderer只覆盖同document的部分计数窗口，不能外推为完整启动CPU；LCP只是采集时观测值。

| 指标 | v15 median(ms) | v16 median(ms) | missing：旧 / 新 |
| --- | ---: | ---: | ---: |
| cold navigationTtfbMs | 1.900 | 2.000 | 0 / 0 |
| cold htmlDownloadMs | 0.500 | 0.500 | 0 / 0 |
| cold postHttpBootstrapAndDomMs | 134.950 | 128.350 | 0 / 0 |
| cold longTaskTotalMs | 0.000 | 0.000 | 0 / 0 |
| cold lcpAtCollectionMs | null | null | 7 / 8 |
| cold partialRendererScriptMs | 8.172 | 10.114 | 0 / 0 |
| warm navigationTtfbMs | 1.500 | 1.500 | 0 / 0 |
| warm htmlDownloadMs | 0.400 | 0.400 | 0 / 0 |
| warm postHttpBootstrapAndDomMs | 70.300 | 64.650 | 0 / 0 |
| warm longTaskTotalMs | 0.000 | 0.000 | 0 / 0 |
| warm lcpAtCollectionMs | null | null | 1 / 2 |
| warm partialRendererScriptMs | 1.999 | 2.378 | 0 / 0 |

保存click到可见DOM的中位数：21.250→18.600ms；主表saveUi包含Playwright调度/等待开销，不能与这个页面内计时混用。

## 请求与字节

每格旧/新中位数；缺尺寸列为单轮最多未测得响应尺寸数。phase总量含ready/save边界后的非计时排空，不代表全部请求都阻塞首屏。HTTP body是本地未压缩传输的已测响应体，不能当生产CDN gzip体积；被阻止的第三方/Gist没有真实响应体，未假造0字节。

| 阶段 | 全部请求数 | 本地HTTP请求数 | 已测本地响应体B | 缺尺寸最多：旧 / 新 |
| --- | ---: | ---: | ---: | ---: |
| cold | 23.000 / 18.000 | 19.000 / 14.000 | 214327.000 / 291804.000 | 0.000 / 0.000 |
| warm | 23.000 / 18.000 | 19.000 / 14.000 | 214327.000 / 291804.000 | 0.000 / 0.000 |
| savePreparation | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |
| save | 7.000 / 11.000 | 4.000 / 4.000 | 17851.000 / 29830.000 | 0.000 / 0.000 |

## 构建体积

| 指标 | v15.0.2 | v16.0.0 | 门槛/含义 |
| --- | ---: | ---: | --- |
| cold chunks | 12 | 6 | 仅原manifest cold图 |
| 所有非OCR chunks | 22 | 17 | 继续记录实际值 |
| cold gzip B | 51941 | 51282 | ≤52,241，PASS |
| 全非OCR gzip B | 70207 | 95880 | 用户取消总上限，NOT_ENFORCED，不是安装包大小 |

## 解释与后续方向

1. 可直接观测的结构差异是cold图从12降至6块，本地cold/warm HTTP等待基本不变，ready差异主要落在HTTP后的残余。但不同锁、构建工具、调度和模块内容同时变化，不能断言唯一因果；部分窗口ScriptMs中位数反而由8.172升至10.114，未证明完整JS CPU下降。最小后续动作是保留cold预算/图边界，并拆分观测，不为追分移回重模块。
2. **请求少不等于下载更轻**：cold/warm整阶段本地已测响应体214,327→291,804B（+36.15%），save阶段17,851→29,830B（+67.11%）。这些包含ready后的非计时排空，不能冒充关键路径传输回归或生产压缩流量，但提示慢网负担可能增加；取消总包硬限不代表此风险消失。最小后续动作是另做真实子路径/受控带宽下的分阶段传输及非关键加载审查，不能仅凭loopback ready更快宣称所有网络都变快。
3. 暖重载尾部有波动，60对不足以通过原稳定度；本轮无法区分桌面调度、自动化观测与应用自身差异。后续若需闭合应另行预先注册更大平衡样本/更安静环境，保留本次完整结果，不盲重跑挑绿或调宽20%标准。保存runner wall与页面内click→DOM也不是同一指标，实际/FundVal、多持仓及物理设备仍需另测，不用本次结果替代。

## 完整性、清理与证据

- 60/60有效对、4/4预热；pageerror0、请求计时/尺寸记录失败0；两个完整artifact树前后指纹相同；Chrome及自有server关闭PASS。无真实Gist写、无个人profile/持仓、无截图或OCR原文。
- 外层命令回执exit1，脚本记录INCONCLUSIVE（该状态的runner配置退出码为2）；这是非PASS结果，不记录native0。
- 原始JSON本地保留：`Temp/v16-performance-20261030-child/release-pair-60-20261030.json`，7109221B，SHA256 `86e0d73dc026e4afc0be0f271a9151736ed68835259cf92145c1e56763d3b74a`。
- 原始字节gzip档案：[release-pair-60.raw.json.gz](release-pair-60.raw.json.gz)，409965B，SHA256 `4d2d2aec3b2eef1f3c874dcc8c2aa5304604b9a166ec574ca8a8b7a75e80bcc9`；gunzip后SHA已与原始JSON完全一致。压缩只作存档，不重写raw。
- 小型机器汇总：[SUMMARY.json](SUMMARY.json)。原冻结 `docs/v16.0.0/PERFORMANCE.json` 和历史失败未改写。此报告是新增补充记录，不是再次发布或修改v16标签。
