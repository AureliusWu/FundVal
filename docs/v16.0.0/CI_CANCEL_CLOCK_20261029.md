# PR取消计时复查（2026-10-29）

本文件为发布前快照。PR28第一版head `cecd2cf29b20c25fa1f8859aa26218da8fe870ce` 的分支CI40660875638成功（2142/2142、281 syntax、74/74 E2E、audit0），PR CI40660942683却为73 pass/1 fail。实际PR checkout/分析为合并测试SHA `e1825ea074c09233ab1d843ee0d2704a1c35ec76`，不能把head元数据当作实测checkout。

## 保留原生失败，不盲重跑

predict取消的 Node“自动点击调用开始→最后Worker close事件”保守上界 **2051.749613 ms** 超过2000，原生exit1；页面真实取消→finally解锁为7 ms。点击调用本身耗时100.738478 ms，所以仅旧记录能界定“真实点击→Node close观察”落在约1951.011～2051.750 ms，不能证明产品超过2秒，也不能把失败判成纯actionability开销。未提高门限、未加重试，也未以分支绿覆盖PR红。

原run、失败artifact和receipt/trace保留；只读归档位于本机 `Temp/release-security-ci-20261029/`。旧失败不改写成PASS。

## 最小测量修正

仅修改测试与新增 `e2e/helpers/cancel-clock.mjs`、`test/cancel-clock-v16.test.js`，没有改变OCR运行代码或取消行为。

1. 在可信点击前以Node before→页面performance.now/timeOrigin→Node after取得跨钟区间。
2. 将实际可信click的页面时刻映射为Node区间，保守起点下界为`max(invocationStart, nodeBefore + cancelPage - samplePage - 1ms)`；关闭延迟上界以最后原生Worker close观察时刻减该下界。禁止用midpoint或after制造更小的乐观上界。
3. 明示1 ms**总**误差预算与短区间等速单调时钟假设，不称物理CPU/GPU/内存释放证明；RTT须≤100ms、样本年龄≤5s、同一timeOrigin、有限合法顺序，映射区间必须与click调用区间相交，无效则失败。
4. 保留原`allActiveWorkersClosedUpperBoundMs`原始诊断；新增可信click保守上界，仍按 **2000 ms** 检查；30s总测试、2s等待/解锁和0 retry不变。

纯函数原6/6通过；独立8个无效样本拒绝、6个>2000边界拒绝、3780个等速±1ms组合均保持保守、420个超5s样本拒绝。它们不是浏览器或设备证明。

实际原SDK/模型的本地Chrome两case在新计量下2/2、native0，真实同图重试通过；本机收据 `Temp/v16-main-20261028/cancel-clock-browser-20261029-1*`。init可信click上界54.934ms（旧raw90.233）、finally1.7ms；predict可信click上界1169.545ms（旧raw1199.494）、finally2ms。新完整QA/精确CI仍须另跑，旧PR失败不会由这两个桌面结果覆盖。

## CodeQL另项警告，未消警

两次旧精确分析各103 rules / 1 result，新增alert9 `js/missing-origin-check`、medium，指`js/ocr/preprocess-worker.js`消息监听；分析job成功不等于零告警。

当前监听只安装于WorkerGlobalScope，唯一生产client固定同源Dedicated Worker URL，Worker/MessagePort保持闭包私有，不转交端口，协议仅处理受限本地Blob/尺寸/裁片，且无网络、存储或eval。结合[WHATWG Dedicated Worker私有端口模型](https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface)及[CodeQL面向跨Window消息的规则说明](https://codeql.github.com/codeql-query-help/javascript/js-missing-origin-check/)，独立审查推断这是对当前调用链强疑似不适用的通用来源告警；**仍保持OPEN并作为warning，不擅自dismiss或加错误的Window origin比较压告警**。未来改成SharedWorker、ServiceWorker或暴露端口须重新评估，不将此判断外推到其他消息处理。

正式发布若成功，必须在Release保留这项告警和全部既有用户豁免，不声称所有安全扫描结果为0或所有验收完成。

追加本地冻结：新算法接线后永久test/集2148 total/2145 pass/3既有Windows skip、283 syntax、完整74/74 E2E均native0，原30s/expect8s/0retry不变；两次构建一致，cold51,282/52,241 B、all95,880 B NOT_ENFORCED。原始收据`Temp/v16-main-20261028/clock29-*`。这些不是后续精确head/main CI或生产证据，不覆盖旧PR失败。
