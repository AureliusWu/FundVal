# M3 新源码800组独立配对预声明（2026-10-18）

状态：**PREDECLARED / NOT_RUN**。本文先于新测量写入；不是结果报告，不把第27节的总体INCONCLUSIVE改成PASS。运行后保留本文原始预声明，用另一个结果文件记录结论。

## 目的与允许范围

M3同时有两个未闭合门禁：all gzip 80,494 > 77,227.7 B，以及当前源码缺少完整可判定的相对时延证据。第27节明确允许“有材料性候选后，或先给独立合理的大样本方案”再做新配对。上一轮压缩器验证已结束、均未采用；本轮转而独立补足后者，不以性能结果覆盖前者，也不允许提前进入M4/发布。

旧200组报告固定在06aa源码，唯一统计不确定性为warm current p95的95% bootstrap区间相对宽度24.457% > 原20%稳定性上限；点估计或相对ratio区间不是失败原因。旧报告22,410,202 B，raw SHA256 `5e4199a9268ecb8761dc3f91725daba3f1b63adedd7b86ef2a9b820f940b3ddd`，保持不可覆盖。

## 样本量的事前理由（不是保证PASS）

固定保留样本 **800 pairs**，正好是旧200的四倍，AB/BA各400。对连续且局部密度稳定的分位数估计，CI宽度近似按1/√n缩放，仅作规划启发：旧24.457%四倍样本约为12.2285%，为原20%留出余量。尾分布、机器漂移和自相关可能使该近似失效，不能称严格功效计算或保证置信宽度。

不对多组N做旧数据bootstrap/下采样试探后挑选能PASS的N；不根据新样本中途结果停止、增加N或更改阈值。选择一次四倍样本也控制本机运行时长及报告规模（旧200约9.5分钟/22.4MB，预计800约38分钟/90MB；仅粗略资源估计，不是ETA承诺）。采样器原本支持60–1000，无需改范围或实现。

## 冻结参数与身份

- 参考：本地不可变 `c2980265d3c89f960517ced1527ba9cb85bf7c2b`，唯一父40e，只对齐source-map-js1.2.2安全补丁，不推送参考ref。原budget锚仍40e的70,207 B，不重算。
- 当前业务：`170fd3eadc6da02750882f8a542904ee2358d0d9`、15.0.2。工作树只含本地M3证据文档；无业务/构建配置修改。采样器会记录全部tracked diff hash及相关untracked hash，前后不一致则INCONCLUSIVE；本文不把dirty工作树伪称全树clean或不可变HEAD身份。
- 当前已构建原OXC site：16chunks/raw235647/all80494/cold42985；整个site127files/92507677B，`[{path,bytes,sha256}]`排序JSON inventory为7d4d8c1e0828f09164bf10b8ef64e8be6f06ccb8cdca61ed7dc2f031c0e68e37；critical集4bda36bc3ed361fcbf69d44d96f30af47fc1fff3b75eefd8728a341a45680948。采样器使用它自己的另一种完整file inventory算法，不混淆两种hash。
- 已亲自核对两侧normalizedLock完全相同：`0b9db07c13394523bbee5d7b21d51cadb00f39b160794ebbda53ea8766b4aebf`；只忽略原算法允许的root.engines，不忽略安全补丁或任意依赖条目。
- 已存在采样器 `scripts/measure-performance-pair.mjs` 原始SHA256 `2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7`。不修改采样器、fixture、计时定义、网络规则、清理策略或统计函数。
- 固定 **800 retained / 4 warm-up / bootstrap5000 / seed160003 / timeout30000ms**。
- 中位数ratio上限1.15、p95 ratio上限1.20、current任一critical path样本不得达到3000ms、双侧p95区间相对宽度≤0.20、bootstrap pass confidence≥0.95，均使用原函数。
- 浏览器：同一本机已安装Chrome、共用一个browser实例（不代表操作系统单进程）、390×844；记录实际版本。冷/暖各使用原no-store/禁SW策略，暖阶段同context reload，保存通过原UI输入100份/成本1.2。所有外部提供者/Gist请求被隔离；仅固定合成fixture，不读写真实用户数据。

## 一次执行、全部保留

```powershell
node scripts/measure-performance-pair.mjs --pairs 800 --warmup-pairs 4 --bootstrap 5000 --seed 160003 --timeout-ms 30000 --reference c2980265d3c89f960517ced1527ba9cb85bf7c2b --output docs/v16.0.0/performance-evidence/m3-pair-security-v15-800-20261018.json
```

由原采样器管理独占reference快照、随机空闲loopback端口和headless Chrome。它只构建独立参考，不重建当前site；不碰其他项目4173、不重复利用既有服务。计划800+4组全留，只有预声明4组warm-up不参与推断；失败按原实现中止并保留已完成/失败pair，不保证故障后仍凑满804。不剔outlier、不重试失败pair、不混入历史任何样本。

期间不修改当前源码、配置、锁文件或site，不并行运行本项目build/test/E2E/压缩构建。其他系统负载只能作为观测局限记录，不能事后以“噪声”为由删样本。观察句柄超时不代表采样器死亡；只检查原句柄/进程，不另启动第二份。

任意采样/观测失败保留原不完整报告及安全失败原因，本计划不自动重跑；没有报告落盘成功也不能记成完整测量。结束后独立重算summarizePairs与完整性/cleanup/计数，分别报告统计结论、工具健康、身份稳定与包预算。无论PASS/FAIL/INCONCLUSIVE均照实归档；原200总体INCONCLUSIVE不变。

这不是物理Android/iOS、真实网络延迟、真实云同步或生产发布证明。若时延最终PASS，M3仍须先填平原all包缺口；若仍INCONCLUSIVE，不增加到1000或换seed立即重跑。

## 执行前独立复核

另一只读审阅者重新解析原200报告并核对采样器/本预声明：确认warm当前p95宽度0.2445703494是唯一统计不确定项；认为800没有原则性统计缺陷，固定四倍样本/平衡顺序/不试N或续补，构成一次有界独立测量。1000只是精度/成本取舍，不是保证或必须。上述文字澄清browser实例与故障中止边界后，仍未开始采集新数据；不改变N、计时、阈值或统计函数。
