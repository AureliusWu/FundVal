# M3 controller 提取后的固定配对性能协议

PREDECLARED 2026-10-25 / NOT_RUN。本轮对应实际接入 sync-status 与 pwa-update-controller、补名尾部收敛及取消后App状态保护的新 runtime；§58旧产物结果不继承。产品仍15.0.2，当前HEAD170fd3e与dirty工作树区分。仅总包政策改92,160B，cold52,241B及相对时延/数据/兼容门禁不变。

## 前置准入

本轮完整QA、两次全产物确定性、真实gzip、模块图与OCR资源、官方依赖审计须实际通过后才freeze。最终源来自独立QA_SOURCE_V3.json物理清单，最终site来自qa-v3第二次构建完整清单；不按HEAD推断未提交源码。V1的34/35浏览器失败、自动补名竞态复现与先红测试、V2两处未迁移结构断言的失败全部保留；V3仅修正这两处断言并保持原验证。本实验尚未启动，不是按性能结果更换候选。协议、runner、依赖安装、原采样工具、Git diff与精确命令一并冻结。执行前独立复核；期间不改源码、文档、依赖或site，不并行测试/构建/浏览器实验。

## 参考与固定方法

沿用已验证的不可变参考057042963a33579c624a41404a6d533dfda29768，parentc2980265d3c89f960517ced1527ba9cb85bf7c2b，tree40098290fb64d31e0c8fcc12e552b3a913b5c715，epoch1791676800。声明依赖/实际安装版本及严格normalizedLock必须与当前相等；只省略原函数允许的root.engines，预期lock SHA db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc。不移动参考，不改原40e/70,207B历史预算基点。

原sampler SHA2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7、collector SHA8a98f57980cfcde94e4035987c974b149c80bc27b51a1ca2309d3aed9d85bdd0不改。Node24.14.0/npm11.9.0，同机已装Chrome，一个浏览器390×844；同固定合成时钟/持仓/Worker fixture，实际外部provider与Gist隔离。冷启动fresh context；暖启动同context no-store reload；保存实际UI100份/成本1.2。导航renderer仅post-commit PARTIAL，不代表完整启动CPU。

**唯一固定800 retained +4 warmup，AB/BA各400，bootstrap5000、seed160003、单操作timeout30000ms**。全部原始pair与预热保留，不重试失败pair、不剔除离群、不扫N/seed、不混合历史样本、不按中途数据早停或补样。真实setup/measurement failure保留为终态。输出在本轮独立Temp/PAIR.json，归档时作为唯一raw交付，不在仓库重复提交88MB副本。

原门禁：cold/warm/save中位ratio≤1.15，p95≤1.20（保持sampler对保存的额外p95检查），所有current retained单样本<3000ms，双侧p95相对95%区间宽≤0.20、ratio95%上界达限、bootstrap pass fraction≥0.95。保持原PASS/FAIL/INCONCLUSIVE与native0/1/2。800完整+4预热不可用函数minimum60替代，pass fraction不是总体通过概率。

## 运行与复核

命令为原scripts/measure-performance-pair.mjs，--reference上述SHA、--pairs800、--warmup-pairs4、--bootstrap5000、--seed160003、--timeout-ms30000、--current-site D:/AI项目/FundVal/site、--output本轮Temp/PAIR.json；完整数组记录于FROZEN/LAUNCH。环境SOURCE_DATE_EPOCH1792046773、FORCE_COLOR0、NO_COLOR1，移除NODE_OPTIONS/NODE_V8_COVERAGE。原工具创建独占Temp参考快照、共享已装依赖并按参考epoch只构建参考，随机空闲端口、受控浏览器，清理仅本轮拥有资源；原内部reference build日志不持久化，不冒称留存。

保存原生stdout/stderr/exit、原始全部pair、前后物理源/site/安装/Git/工具指纹；观察超时不当作进程结束，不启动替代实验。结束后独立重算整个summarizePairs对象、renderer delta、health/instrumentation/cleanup/SW/请求与console计数。保留缺值及非零console；sorted-JSON行SHA与sampler路径NULhash不可混用。

本轮只证明本地合成Chrome性能；不代表真实金融源、Gist写读、OCR、PWA升级/离线、物理设备、精确提交CI、M3退出或v16发布。后续M4–M6完整范围保持。
