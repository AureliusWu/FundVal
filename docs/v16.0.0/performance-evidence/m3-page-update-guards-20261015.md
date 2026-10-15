# M3 真实应用更新保护：P1 修复与边界

父提交fb559，版本15.0.2。机器摘要见[JSON](m3-page-update-guards-20261015.json)。**M3 IN PROGRESS / NOT RELEASED**。

## 实际发现与修复

新增原生Chrome / 真实构建app、bootstrap、SW双标签页测试，首轮 **1 FAIL /1 PASS**：脏peer阻止更新通过，但清空草稿后，请求页更新使peer也从导航1变2、documentId改变，且peer未收到ACK。修正一个尚未执行到的浏览器假设后，永久测试在旧源由root再次得到 **1 FAIL /1 PASS**，同一失败被重现。

一次独立最小原生诊断证实：即使不调用clients.claim，激活仍会更换两个既有受控标签页的controller；没有app重载处理器时两页都不导航。问题在app无条件处理controllerchange，不是浏览器不该换controller。首失败、trace、初版测试及预启动Windows ESM工具错误均保留，没有用后续通过覆盖。

app现在仅在本页完成排空与最终dirty检查、紧邻SKIP_WAITING前登记实际请求worker。同源且身份一致的ACK才可重载；原生controllerchange与ACK双顺序均去重。非请求页保留文档/界面/输入/持仓，只提示手动重新载入；主动重载也先排空并复查草稿，不向已激活worker重复发SKIP_WAITING。排空中别页激活只记录待重载，不提前重载/解除applying/启用按钮；BC后复查防双点击。首次安装保留，null不抹去已有身份，post失败清授权可重试。

## 先红后绿与最终门禁

真实app函数与registration块由AST提取，不复制helper：原17项 **5 PASS /12 FAIL** →17/17；新增合成old→null→new反例在中间补丁 **17 PASS /1 FAIL**，最终 **18/18**。不声称现场发生过null序列。独立6个合成race有覆盖重叠，不累计。

- 最终npm test：**1030项/1027 PASS/0 FAIL/3 Windows条件skip**；syntax **204**。
- npmmirror默认审计端点404不算通过，显式官方registry审计 **0 vulnerabilities**；未修改配置/依赖。
- 最终完整E2E **30/30（57.8s）**，新增真实app用例7.9s/2.4s。中间补丁完整30/30也保留，不当最终源码证明。owned12437/12438退出，其他项目4173未动。
- finally保留原断言并另记cleanup错误；本地测试server四个纯路径负控拒绝跨盘/absolute/UNC/越界，不读真实系统文件。

最终三次实际build原配方/固定epoch1792046773完全一致，后两次在最终E2E之后：**16chunks/raw235665/all80477/cold42992 B**。关键发布指纹 `e6f89a3d534040d6bef8a98555dda95d45978e64f43a741f2bb16dd6fd726725`；whole-site **127文件/92507487 B/01b76d4781c3c1e1fefd2a529874feaa4ba555a5f94dbfd41b0d00224a631f93**。app及23份OCR资产bytes/SHA核验通过，未执行OCR。213份最终输入前后相同，算法范围不同于旧214份库存，不横比hash。

本次正确性成本相对父app：**raw+250/all gzip+83/cold+85 B**，whole-site明文+1415 B。中间补丁build all80484另存，不混入最终三轮。原budget CLI **exit1**：cold42992/52241 PASS，all80477/77227.7 FAIL，至少还需 **3250 B**。CLI importClosureVerified=false不替代实际build图校验。旧200-pair仍INCONCLUSIVE，未重跑挑PASS。三个绝对交互smoke全保留（含warm395.8ms/save214.7ms慢样本），不是新relative/p95或性能改善结论。

## 结构审查与证据限制

三轮当前原配方内存库存80394（修复前）；单独三轮40e旧源码当前配方为65275。历史原配方esbuild/codeSplitting:true不同，**65275不是原70207预算基线**。增长主要是实际消费的wire/cache/刷新所有权，且有app旧职责移出，不能只加新增模块长度或把renderedLength当gzip。

cache读投影与序列化原记录语义不同，wire/cache是不同不可信边界，Bridge四操作和超时覆盖真实使用。固定云生命周期设计保持原eager/lazy顺序后仍需桥接，在变体/build前停止；未找到新材料性安全去重候选，未重跑旧34微试验。该有界否决不证明所有未来架构不可优化。

只证明同版本revision尾注释+旧cache marker的本地合成Chrome流程，不证明v15→v16迁移、真实云、物理设备或生产。page/iframe外部请求被阻，SW实际只请求同源CORE/资产及owned合成GET/HEAD服务器，不能称context.route为通用SW网络防火墙。late9.99只断言基金aggregate localStorage与可见NAV，不证明Cache Storage无写。

完整原件仍在JSON列出的本地Temp目录，此MD/JSON**不是完整归档**；当前list/retain-on-failure不保留通过用例inline附件。未重新验证真实金融数据、调整时钟、放宽Worker契约或改版本/预算/分组/main/生产。M4/M5/M6未开始，不能据功能GREEN宣称M3退出或v16发布。

## 提交后的 Linux harness 修正

上述本地窗口提交为b9da4db；其[真实CI38704643538](https://github.com/AureliusWu/FundVal/actions/runs/38704643538)是**E2E失败**，不是只因budget红：28 PASS/2 FAIL（52.4s），新测试在打开页面前的路径负控失败，因为POSIX把C:/Windows路径当作site内字面文件名。单元/语法/build/资源/audit与CodeQL job成功，seal/upload/budget被跳过，不外推零告警或合格产物。

测试helper前置补node:path.win32.parse的root拒绝，保留原负控。真实helper AST在win32/POSIX注入矩阵58/58；旧helper两个POSIX负控确实失败。它是纯path证明，不是Linux浏览器或文件系统沙箱证明。新本地全量1027PASS/3skip、syntax204、E2E30/30（54.4s）、三build及产品指纹完全不变。原窗口不覆盖/改写，新范围和摘要见[兼容修正JSON](m3-page-update-portable-harness-20261015.json)；新提交仍须独立CI，不继承b9da结果。
