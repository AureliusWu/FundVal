# 2026-10-15：未采用的较大边界候选归档

本轮仍是M3检查，不是M3退出、版本升级或发布。结果索引：[机器汇总](m3-larger-boundary-probes-20261015.json)，解释：[M3_STATUS第29节](../M3_STATUS.md)。

原始源码检查点为17bb8b8dbaacfdf91bccf30b0d89a2c3e33fb9c1，业务仍06aa。7个独立脚本族各自预设变体并固定三轮；共22个候选，不表示统一事前注册，组合收益也不可相加。全部未实施。

## 归档格式

[rejected-probes-20261015.bundle.json.gz.b64](rejected-probes-20261015.bundle.json.gz.b64) 是 **gzip(JSON)的Base64文本**，不是图片、截图、OCR数据或可执行程序。压缩只为保存重复虚拟源与原始报告，不用于改变产品包预算。

- 解码JSON：999622 B，SHA256 `2b7115730a163c2476edab5b3a9e7debcfedcd65f83c6c89a477f5bb37e7a40c`。
- gzip字节：203381 B，SHA256 `236faa2aa36a8e99750bb9eb32e3b07477f7ed9f84f3d5fc6964b1091afb0af1`。
- 解码Base64字符数：271176（忽略排版换行）。
- JSON结构为 `{schema,sourceCommit,normalization,files:[{path,lfBytes,lfSha256,content}]}`。
- 19份文件content与仓库外原文件的CRLF→LF文本逐字一致，包括末尾空行；没有裁剪source、TAP、失败、metadata或投影。逐文件bytes/hash见机器汇总的archive.files。8个JSON解析已检查。

| 内部路径 | 内容 |
| --- | --- |
| app/ | 共同cloud编排、Map分派、5种函数排布；完整脚本与报告 |
| post/ | 模型装配、descriptor/enum、时间解析尾部；精确源、三轮、说明 |
| business/ | HTTP transport、Bridge错误helper、私有HTTP投影；loader/确认脚本/完整失败TAP与说明 |
| ui/ | 静态DOM查找门面、action switch及组合；精确patch、逐轮产物和前后库存 |

## 仅解码、验哈希，不执行内容

在仓库根目录使用现有Node运行以下只读检查。它不会写文件、提取脚本或运行归档内容：

```powershell
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; import {gunzipSync} from "node:zlib"; import assert from "node:assert/strict"; const sha=x=>crypto.createHash("sha256").update(x).digest("hex"); const p="docs/v16.0.0/performance-evidence/rejected-probes-20261015.bundle.json.gz.b64"; const gz=Buffer.from(fs.readFileSync(p,"utf8").replace(/\s/g,""),"base64"); assert.equal(sha(gz),"236faa2aa36a8e99750bb9eb32e3b07477f7ed9f84f3d5fc6964b1091afb0af1"); const raw=gunzipSync(gz); assert.equal(sha(raw),"2b7115730a163c2476edab5b3a9e7debcfedcd65f83c6c89a477f5bb37e7a40c"); const data=JSON.parse(raw); for(const f of data.files){ assert.equal(Buffer.byteLength(f.content),f.lfBytes); assert.equal(sha(f.content),f.lfSha256); } console.log(data.files.map(({content,...meta})=>meta));'
```

如需检查某份原报告，先按上面的hash核验后读取该file.content即可。重放需新的仓库外目录、冻结的17bb源码/锁文件/运行时、仅修改环境路径并另存新结果。脚本包含历史绝对路径、HEAD断言和固定输出名；不得在归档目录执行，不得覆盖原报告，也不把新样本混进旧三轮。

## 特别边界

- 私有HTTP投影虽省120 B，却被原28项表征否决：基线28/28、候选27/28。ChangingDate反例必须保留二次验证及ROW_INVALID safe rescue。原spec观察与新的固定TAP确认分开说明，不冒称唯一一次测试。
- 其余最大收益34 B，不值得增加新门面。没有完成通用行为等价或真机资格验证，不可把候选当修复。
- 函数排布保留138个函数全文与104条其他语句顺序，仅是有界静态事实，不证明异常堆栈、函数位置、调度或完整行为。
- root初次layout工具错误在3轮baseline后首个candidate touched=0失败；修正Windows路径后唯一完整系列为18条有效记录。失败依据root实际工具输出，不存在单独失败文件，也不将其3条baseline合并。脚本/report保存的是最终有效版本。
- orchestration的230 tracked/126 site前后库存只覆盖自身窗口；layout只有app前后相同，不追认后续全树库存。UI独立91源文件库存。各图/库存hash算法不同，不直接横比。
- sharedCloud读取result.changed次数及async微任务未资格化；DFS是直接调用名称启发式，不是完整解析调用图。
- 业务脚本记录Bridge constructor数量断言错误、loader c: URL错误；UI记录静态ID断言错误。它们均是工具诊断，原内容完整保留。
- 新本地全量测试、E2E、三build和资产核验属于本轮未改业务源的复核；不是新文档SHA的CI、真实Gist、设备或生产证明。原all预算FAIL与旧pair INCONCLUSIVE保持。
