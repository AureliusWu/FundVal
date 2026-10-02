# M3 配对性能证据

报告只含合成持仓、耗时、分类后的请求和测试环境/源码/产物指纹。不得加入 Token、真实持仓、原始 URL/query、图片或 OCR 文本。大 JSON 是原始样本，不是生成的生产资源，不进入 site/SW。

## 采样约定

- 固定旧版 SHA：`40e68edab9cb3fba0b17338dc3672a82d13ad17e`，不是可变分支名。
- 同机同浏览器、390×844、HTTP 缓存关闭/no-store，SW 不控制页面，固定合成时钟。
- 每个 side 使用独立空 context；warm 为同 context reload；save 为真实 UI 保存合成份额。
- 先声明样本数与 warm-up；交错 AB/BA，保留全部原始观察，不挑最快、不剔除 outlier、不自动重跑失败 pair。
- p95 为 nearest-rank；不把最大值当 p95。分层 bootstrap 保留整组配对相关性，固定 seed。
- 网络字段仅本地 HTTP/拦截 fixture；不冒充生产服务端、公网或手机性能。
- 前后源码与产物指纹不变、无意外 pageerror、请求记录完整、资源清理可证后才讨论统计结果。
- 工具的 PASS 还要求 95% 上界满足相对目标和稳定 p95；样本不足/区间宽记 INCONCLUSIVE。保存 p95 是额外工具诊断，不是原升级方案中新增的硬预算。

PowerShell 运行需显式传递 Node exit code（2=INCONCLUSIVE，非 0 不代表必然业务失败）：

```powershell
node scripts/measure-performance-pair.mjs --pairs 200 --warmup-pairs 4 --bootstrap 5000 --seed 160003 --output docs/v16.0.0/performance-evidence/m3-pair-200.json
exit $LASTEXITCODE
```

已有报告禁止覆盖；脚本使用独占创建。采样期间不编辑源码/构建、不并发跑 test/E2E/虚拟 bundle；不使用或终止其他项目的 4173 服务。

下表 SHA256 对应生成报告的 LF 文本，也是 Git blob 的文本形式。若 Windows checkout 将文本变为 CRLF，校验时先还原 LF；不能把换行形式误报为采样数据被修改。

## 报告索引

| 文件 | 结论和范围 |
| --- | --- |
| `m3-pair-60.json` | 第一轮 60 retained +4 warm-up；统计 INCONCLUSIVE，harness pageerror 和请求记录问题使完整性证据不足；原样保存，SHA256 `88b927752e589553cea18dba88e3d2233c780f208beeb1ea77a1de6902a4611d` |
| `m3-pair-200.json` | 修正 harness 后预设 200 retained +4 warm-up；health/instrumentation/integrity/cleanup PASS，统计 INCONCLUSIVE（旧版 p95 区间宽、保存额外 p95 观察不稳定）；SHA256 `b7abe1b6f9409a8ebf5543b0b380acbb252bc2db60676db5ead7d75491813ad9` |
| `m3-counter-probe.json` | 新同文档 counter 协议的 3 次 current-only 桌面实际采集兼容性预检；COMPATIBILITY_PASS，不是 v15 相对性能/p95；SHA256 `94f658237181e97021f64881bd550522e7f05796842aa324fe05bb975448e707` |
| `m3-bundle-gate.json` | 当前本地完整生成 app chunks 实算：cold 43,845 PASS、all 82,481 FAIL；预算 CLI exit 1，不是 CI/生产产物证明 |

后续修复 harness 不会改变第一轮结论。新报告按实际结果追加；总包 gzip 独立硬门禁不能被桌面工具 PASS 覆盖。

200 组报告的 warm renderer counter 跨导航重置，差值保持 null，因此不能确认该阶段 CDP 主线程分解。console errors 为主动阻止外部请求的已记录观察，非“无 console error”验收。详见上级 `M3_STATUS.md` 第 9 节。

当前采样器协议为 `paired-readiness-v2-same-document-counters`，以 commit 后同文档 baseline 避免跨导航相减。额外 RPC 有观察开销，cold/warm attribution 仅 PARTIAL 到 collection，不是完整启动或隔离 OS CPU。future relative samples 必须两侧同新协议、另存新文件，不与旧 60/200 混样。既有文件仍可重现其历史结论；上面的示例输出路径已经存在，不能直接重跑覆盖，应先选定新的证据文件名。

实际体积门禁可独立运行（PowerShell 同样保留 exit code）：

```powershell
node scripts/release-fingerprint.mjs --assert-app-bundle-budget site
exit $LASTEXITCODE
```

它枚举完整 chunk 文件集并实算每份 gzip，不信任 manifest 自报压缩长度。报告 `importClosureVerified:false`：真实静态依赖图/冷启动隔离仍由 build-site 的 Rolldown 输出图校验负责。超预算的 WIP review artifact 可以封包保存，但 CI 必须红、standalone candidate/deploy 准入必须拒绝。
