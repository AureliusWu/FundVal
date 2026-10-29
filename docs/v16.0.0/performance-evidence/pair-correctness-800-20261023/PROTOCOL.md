# 当前正确性修复后M3独立配对性能预声明

PREDECLARED 2026-10-23 / NOT_RUN。当前产品15.0.2、HEAD170fd3eadc6da02750882f8a542904ee2358d0d9的既有dirty candidate，不冒称HEAD等于实际工作树。§51/52已修复独立模型provenance及enriched自动accuracy预测/正式结算；§57仅按用户明确批准调整总包上限。旧§48的800属于修复前产品，不能继承。本轮是这些实际新产品字节的独立验收，不是旧失败增加N/换seed救援。

## 已完成的准入前提

实际当前完整274输入行SHA89bdfff42618da6b1743a61e96bf4177ba34329ea716acb73c49e3ee920cc80f；最终site127行SHA0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31，16chunks/raw252331/all85969/cold46149。§57完整1320PASS/3原Windows skip、syntax216、Chrome35/35、4次全127逐字节确定性、真实新预算CLI0/旧CLI1、当前官方registry audit0已完成；该本地QA不等于本轮时延PASS。唯一政策all上限92160，cold52241及其他门禁不变，产品JS/build/依赖/版本未因政策变化。

## 不可变参考和原工具

复用既有本地不可变057042963a33579c624a41404a6d533dfda29768，parentc298/tree40098290fb64d31e0c8fcc12e552b3a913b5c715/epoch1791676800。该参考保留原v15业务，仅此前source-map-js与五个Vite8.2.4 scalar安全对齐；不新建/更新/push ref。预算原基点仍40e/70207，不重算。严格normalizedLock仍只省略原函数允许的root.engines，当前/057必须精确db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc，全部声明安装版本相等；不waive锁检查，不直接使用Vite8.2.2的c298。

原sampler SHA2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7、collector8a98f57980cfcde94e4035987c974b149c80bc27b51a1ca2309d3aed9d85bdd0不改。Node24.14.0/npm11.9.0，使用实际已安装Chrome、同一browser实例、390x844。同样固定合成2026-08-28T06:45:10Z，原Worker估值/空重仓fixture；所有真实provider/Gist隔离，不读取真实用户数据。冷：fresh context；暖：同context no-store reload，非HTTP暖缓存；保存：实际UI100份/成本1.2。导航renderer仅post-commit部分归因，非完整启动/OS CPU。保留console计数，不宣称console-zero。

## 一次固定执行

固定800 retained+4 warmups，AB/BA400各组，bootstrap5000/seed160003/timeout30000。沿用§47/48已预声明四倍样本精度/运行成本设计，仅为新产品独立实验，不保证PASS。没有60/200预览、试N/seed、混合历史样本、中途结果决定停止/补样/剔outlier/失败pair重试。4预热原件保留但不参与推断。真实setup/measurement failure为本轮终态，保留partial报告，不自动重跑/改1000。

```powershell
& 'C:\Program Files\nodejs\node.exe' 'D:\AI项目\FundVal\scripts\measure-performance-pair.mjs' --reference 057042963a33579c624a41404a6d533dfda29768 --pairs 800 --warmup-pairs 4 --bootstrap 5000 --seed 160003 --timeout-ms 30000 --current-site 'D:\AI项目\FundVal\site' --output 'D:\AI项目\FundVal\docs\v16.0.0\performance-evidence\m3-pair-correctness-800-20261023.json'
```

使用原managed生命周期：独占Temp Git archive/LF规范化、同已装依赖junction、仅3个snapshot transport固定端口替换，按reference epoch构建**仅参考**；当前site不重建。随机空闲loopback两server/一个headless浏览器，只清理本次拥有资源及经验证snapshot，不碰4173/其他进程。原sampler内部reference build日志故意不持久化，不能冒称其原始stdout/stderr已收录；完整before/after参考产物库存及Git/工具/依赖来源保留。删除后不声称重读旧snapshot。

外层新Temp runner独占锁及stdout/stderr/实际nativeexit保存，仅移除NODE_OPTIONS/NODE_V8_COVERAGE调试覆盖变量、固定SOURCE_DATE_EPOCH1792046773/FORCE_COLOR0/NO_COLOR1后单次spawn；环境规则先声明，不据结果修改。30000是单操作超时非整体总时长。观察句柄超时不等于进程死亡，只恢复同一会话，不启动替代。运行期间不改tracked文档/源码/锁/site，不并行build/test/E2E/minifier/浏览器采样/依赖工作。可做轻量只读进度检查。系统其他负载是局限，不能据此删除样本。

## 原门禁与最终复核

原项目冷/暖median ratio≤1.15、p95≤1.20，保存median≤1.15；原sampler保守地对save也检查p95≤1.20，继续保留，不重新定义/放宽。所有current retained关键路径单样本<3000ms；双侧p95相对95%区间宽≤0.20、上界ratio均达限、bootstrap pass fraction≥0.95、平衡且无零分母。函数generic minimum60不能代替本协议800完整+4预热。原PASS/FAIL/INCONCLUSIVE与native0/1/2照实保存。pass fraction不是总体通过概率。

发射前冻结完整274源/127site/指定68安装、HEAD/branch/index、tracked binary diff/相关untracked、协议/工具/审阅hash与精确命令，并独立只读复核。结束后重枚举同一完整范围，重算整个原summarizePairs对象、800/4/ABBA、health/instrumentation/cleanup、SW/网络/renderer有限观测，保留全部失败/缺值/null及console计数。sorted-JSON rows SHA与sampler路径NULhash SHA是不同算法，不混写。源码或产物漂移、pageerror/观测不全/cleanup未确认使结论不完整；不把纯统计PASS当总准入。

本实验不是真实金融源、Gist写读、OCR引擎、PWA升级/离线、物理Android/iOS、精确SHA CI、M3退出或发布。无论结果如何均保留新旧政策报告、§53–55被拒绝候选与原200 INCONCLUSIVE；通过后仍须独立review/精确CI及后续完整M4–M6。当前不提交/推送/升版/部署。
