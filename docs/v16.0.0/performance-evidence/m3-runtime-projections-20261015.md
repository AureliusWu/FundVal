# M3 运行时投影与 SW 消息边界：2026-10-15 证据说明

状态：`M3 IN PROGRESS / NOT RELEASED`。版本仍为15.0.2；没有更改main、部署或启动M4。

## 实际实施与结果

- 通知：内部布尔入口保留所有输入、时间、来源、缓存和ValuationPeriod判断，只不构造生产端未消费的详细结果；原公开策略文件逐字未变。真实alias旧实现49/49 GREEN（不含候选AST测试）→新实现50/50 GREEN；新增12项永久测试、生产消费者闭合检查和AST负控。
- 刷新计划：公开完整计划API保留，生产消费者改用闭合执行投影；缓存guard只保留一份共享core，不复制/删减验证。公共factory原字节、reason、key顺序和冻结保留。旧包装170/170→实源170/170→最终护栏171/171 GREEN；不是Bug修复RED。旧TTL测试夹具先错误地制造时间倒置，后改为真正的TTL到期夹具；失败复核单独保存，不冒充原首次日志。
- SW：来源精确origin + 现存app WindowClient/id/双URL校验；waiting worker仍允许旧worker控制的合法页面；完整异步验证通过同步waitUntil保活。保留notify、dirty/drain和旧兼容桥，独立约束通知目标/点击窗口。旧源首批18项1 PASS/17 FAIL；最终旧源负控22项1 PASS/21 FAIL；新实现35/35 GREEN。native browser真实协议用例通过，但使用合成页面/CORE服务器，不是生产UI、真实通知权限、v15→v16升级或物理设备验收。
- root全量：1012项，1009 PASS/0 FAIL/3 Windows条件skip；syntax202；audit0；E2E28/28（44.6s，含native SW2.7s）。自有12437退出，未动4173。
- 同epoch1792046773固定三次实际构建，最后两次在E2E后，均16chunks/raw235415/all80394/cold42907。关键发布集指纹74c4a504c27c2b48fe8d91e981fef79d945d6e54c965da055e1b3154f81094a8；whole-site127文件/92506072B/hash3032ccdf6c57a945491bb44b00e7169e722977d81e2103934694fcb7bec5e07b。生产输入/测试214文件在检查前后逐字一致，独立复核也与实盘一致。
- 对e750基线：app raw−2250 B/all gzip−764 B/cold0；whole-site反而+6824 B、+1源文件，不能称全站减包。固定分组、编译器、minifier、target、依赖、预算均未改。
- 原budget CLI exit1：80394 > 77227.7 B，至少还须减3167 B。旧200-pair仍INCONCLUSIVE，没有新时延PASS，不能EXIT M3。
- 五次真实公开主源app形态GET：0接受，2超时、3元数据校验拒绝；另一次raw诊断也超时，未捕获payload。根因待确认，不推断为时钟漂移。原脚本空集合every产生的allRowsPredicatesEqual:true和无条件CONDITIONALLY_TRUSTED标签保留在原件中，但**均无验收效力**；正确状态为SOURCE_INGESTION_NOT_VERIFIED / POLICY_COMPARISON_NOT_EVALUATED，比较行数0，等价结论null。记录的是失败/超时耗时，不是成功源性能；没有修改时钟、上游或校验。

## 原件与重放边界

`m3-runtime-projections-20261015.json`为可读机器摘要；`m3-e750-ci-20261015.json`只证明父e750精确CI，不能继承给新源码。该CI唯一失败步骤为all-gzip预算，CodeQL仍有两个既存medium（#5/#7），成功扫描不等于无告警；产物未下载，没有生产发布。

71份UTF-8原件完整存于`m3-runtime-projections-20261015.bundle.json.gz.b64`。外层为gzip JSON再base64，按120列换行；JSON每项含name、bytes、sha256和content，保留原CRLF/LF，未改写失败日志、候选或报告。没有图片、真实持仓、Token或OCR原文。内容分组：

- notification-probe：固定3+3虚拟实际配方计量、完整候选/原源、资格runner、完整TAP和最初草稿；
- notification-implementation：真实磁盘alias/new两个GREEN及精确源码/输出绑定；
- plan：完整共享core候选、未采用的重复validator测量、严格ESM表征、fixture失败复核、实际包装/候选/护栏三个GREEN与源身份；
- service-worker：精确父CI、只读诊断、原旧SW源、原始RED、最终旧源负控与GREEN；
- root：完整npm/test/check/audit/E2E/三build/budget stdout/stderr、214源与127site库存、真实源五失败和单次raw超时。

解码JSON **1155199 B** /SHA256 **e6141b0e08aad86f588aca2a4f99c233ab0fd4ae6eb802f0ab6d6d23f50310fd**；gzip **241774 B** /SHA256 **d7538eee3f53371cc5425b24bb8e6ce7f97371ec404af6cc35bba8145b976a01**。它只是文档证据，不是产品压缩方案，不进SW CORE、app预算或OCR清单。

在仓库根目录只读核验（不执行归档脚本）：

```powershell
node --input-type=module -e 'import{readFileSync}from"node:fs";import{gunzipSync}from"node:zlib";import{createHash}from"node:crypto";import assert from"node:assert/strict";const h=b=>createHash("sha256").update(b).digest("hex");const z=Buffer.from(readFileSync("docs/v16.0.0/performance-evidence/m3-runtime-projections-20261015.bundle.json.gz.b64","utf8").replace(/\s/g,""),"base64");assert.equal(h(z),"d7538eee3f53371cc5425b24bb8e6ce7f97371ec404af6cc35bba8145b976a01");const raw=gunzipSync(z);assert.equal(h(raw),"e6141b0e08aad86f588aca2a4f99c233ab0fd4ae6eb802f0ab6d6d23f50310fd");const p=JSON.parse(raw);assert.equal(p.files.length,71);for(const f of p.files){const b=Buffer.from(f.content);assert.equal(b.length,f.bytes);assert.equal(h(b),f.sha256);}console.log("71 exact evidence files verified");'
```

归档早期草稿和probe的固定HEAD/clean断言属于当时已结束窗口；不得在当前源码上直接运行后覆盖历史输出。最初qualification的alias/AST虚拟组合不替代正式alias阶段；正式两阶段文件另有清晰记录。非strict表征保留，采用以strict复核为准。所有合成、定向、全量组存在重叠，不相加成“总覆盖率”。有限行为矩阵和AST护栏不是任意反射/恶意intrinsics或未来消费者的全程序等价证明。

待继续：原all-gzip门禁、新源码精确CI/CodeQL、公开主源元数据拒绝定位、可重复时延稳定性，以及后续真实Gist/设备/生产门禁；反向ACK来源校验和真实app双tab脏输入动态覆盖仍未实施。
