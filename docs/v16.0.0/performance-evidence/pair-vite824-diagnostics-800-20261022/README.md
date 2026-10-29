# 当前诊断源码/Vite8.2.4：独立800配对预声明

更新：唯一新采样已于2026-10-22完成，native0/统计PASS；原始数据、独立重算、参考三次重建与限制见[最终结果](RESULTS.md)。下面保留测前预声明原文；不可把其中的“准备/不是结果”理解为当前仍在采样。

状态：预声明/执行前准备，**不是结果**。后续以唯一采样进程及最终新raw JSON为准，空的独占预留文件不算完整结果；不得重复启动或覆盖历史报告。完整冻结协议为本目录`PROTOCOL.md`，先于新参考对象及浏览器测量写入。

测前独立只读审查已通过，原件见`independent-preflight-review.md`；不授予时延PASS。`reference.json`的`before.index/after.index`是暂存差异`git diff --cached --binary HEAD`的SHA，只证明暂存内容未变，不是原始`.git/index`文件字节SHA；创建参考确实使用独立Temp index。

本次参考`057042963a33579c624a41404a6d533dfda29768`，本地专用ref为`refs/fundval-performance/v15.0.2-source-map-js-1.2.2-vite-8.2.4-20261022`，父`c2980265d3c89f960517ced1527ba9cb85bf7c2b`。新树只改package/lock五个Vite8.2.4标量，其余v15业务/static对象不变，不是产品提交或升版；root业务分支/HEAD/index未移动，也不推送参考ref。参考元数据保留parentepoch1791676800供构建复现，不冒称该日期发布了新代码。原预算参考40e/70207B不重算。

两侧normalizedLock严格同SHA`db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc`，原算法只忽略root.engines；declared依赖同，不waive锁比较。当前源码仍HEAD170fd3e加既有dirty内容，app15.0.2，真实输入270/输出127/安装68行实读同前；current raw245170/all84187/cold44699，sorted-JSON wholeSHA5b946d23，sampler原算法wholeSHA4e8dddb5ce4f81992f384afd0ee552431787c6b30600a643bcb97f6a0837e4e4，算法不同不能混用。

未改原sampler SHA`2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7`、collector SHA`8a98f57980cfcde94e4035987c974b149c80bc27b51a1ca2309d3aed9d85bdd0`、fixtures/计时/网络/阈值/统计/cleanup。固定800retained/4warmup/bootstrap5000/seed160003/timeout30000，一次、AB/BA各400，不混旧样本、不试N、不增加1000、不重试失败pair、不剔outlier。warm为同context no-store reload，不是HTTP热缓存。新源码/锁/Chrome与旧800不同，旧PASS不继承。

当前总包84187>77227.7仍FAIL，至少差6960整数B。**无论时延结果如何，都不能覆盖包预算或进入M4/发布。** 本次独立补当前代码的时延证据，不代表放弃减包目标。无新精确CI、真机/真实金融/Gist写入/OCR引擎/生产资格。

新raw路径为上一级`m3-pair-vite824-diagnostics-800-20261022.json`，原exclusive writer保留完整/不完整样本。执行期间不改任何root源码、site、tracked文档，也不并行build/test/E2E/压缩；只观察同一个活进程/会话，观察timeout不构成重启理由。唯一启动器的本机工作目录：`C:/Users/84046/AppData/Local/Temp/fundval-m3-pair824-20261022-84c9ce529d91`，其中`launch-reservation.json`防重复，`live-handle.json`是路由线索而非活进程证明，必须用工具进程句柄复核。
