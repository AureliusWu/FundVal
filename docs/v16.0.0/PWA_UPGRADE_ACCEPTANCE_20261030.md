# v15.0.2 → v16.0.0 PWA 升级验收（2026-10-30）

## 结果与范围

- **桌面原生 Service Worker 两版升级：3/3 PASS，原生退出 0。**
- **Windows Chrome 原生已安装 PWA：1/1 PASS，原生退出 0。** 本机 Chrome `156.0.8078.74`，headless、独立新 profile、随机 loopback `/FundVal/`。真实 `PWA.install` / `PWA.getOsAppState` / `PWA.openCurrentPageInApp`，不是 manifest 回放、媒体仿真或改版本尾注。
- **Android / iOS 物理设备、手机桌面安装、可见 Windows 快捷方式点击与图标裁切：NOT_RUN。** 本报告不将桌面原生协议验收外推成这些通过。
- 原 `PWA.launch` 两次未能绑定页面的 **FAIL 保留**；当前页原生已安装入口是明确的新变体，不追改旧结果。
- 被测目标为**精确已发布 v16.0.0 候选**，不是新增 maskable 图标的后续本地工作树；没有改生产部署或 tag。

机器可读总账：[upgrade-evidence/20261030/SUMMARY.json](upgrade-evidence/20261030/SUMMARY.json)。7 份原始收据按原字节 gzip 留存，同目录总账记录 raw/gzip 字节数和 SHA；解压回验均一致、每份压缩文件小于 2 MiB，原 Temp 文件未删改。公开前检查未发现绝对本机文件路径、凭证或真实用户金融数据。

## 两个真实版本的绑定

| 项目 | v15.0.2 旧版 | v16.0.0 新版 |
| --- | --- | --- |
| Git SHA | `40e68edab9cb3fba0b17338dc3672a82d13ad17e` | `35808ee3b4698db1f9919cbc8f0d4033f9baa986` |
| 构建来源 | 原 Git 源码、原 lock 独立安装、Vite 8.2.2、原构建脚本 | 原 main-push CI `40877032757` attempt 1，不重新构建 |
| 完整清单 | 110 文件、92,344,588 B | 原候选 139 文件，完整 inventory 与 `candidate.json` 深等 |
| 原生 Worker 版本 | `fuyu-v15.0.2` | `fuyu-v16.0.0` |
| app/manifest 身份 | Chrome 从旧 `start_url` 得到的原生 ID | 新 manifest 显式 ID 经 Chrome 解析与旧 ID 相同 |

旧版源码相对真实 v15 发布提交 `210433aec211da0da5c6b6a461bafdd094a2d123` 的相关业务、构建、锁、manifest、SW 无差异；其后两个提交是文档整理。旧产物的完整清单消费独立准备证明，另保留 7 个 Git blob 的规范化源绑定。不能仅保留 raw JS、混入另一版 app-shell/chunks 冒充旧版。

关键摘要（不同算法/范围不混用）：

- 旧源码清单：`d6799f083c63ab046caba1900a1fe9fc2851d27fc6344ea2615f06b71e465db5`。
- 旧原始 lock：`bee46bdc3098dd585b4347847121c2c76615d99171a87ec8d19d9a23b5111c82`。
- 旧 `artifactFingerprint`：`29641fb2e9ad927871a2485f07cbdd0d78e9707a6e999ea5160e5822b6471402`。
- 新 site inventory：`9cf89940f039d4221a956d08f8d98362f1a534217fe27b1283b99c1429591507`。
- 新 release-critical：`41be13fac787e2b5840b502cb52e716ad680b0965cff2d4457e7662bda633bb7`。
- 最后已安装入口使用的验收脚本：`3d73163291f91d5c21e7926f634239fa3283650d85f5823200b8879cbf6d6ebe`。此前 native 3 轮没有在原收据写入 tester hash，不补造历史值；其产物/数据绑定仍保留。

两边完整产物清单在测试前后不变。loopback server 只按清单读取原始字节，原 `sw.js`、manifest、JS 均未篡改；不是同版本 worker 尾注实验。数据接口固定 503、外域和写请求阻断，没有真实估值、Gist 或 OCR 验收声称。

## 实际验证的流程

变体名：`existingHoldingsDiscardDraftThenUpgrade`，CLI 必须显式 `--existing-holdings`。

1. 新隔离 profile 中预置一条 canonical Schema 3 **合成已有持仓**；真实旧版启动并读取，读取后原文 SHA 与种子相同。只输出 SHA，不输出持仓正文。
2. 等真实初装 `controllerchange` 引发的第二次主框架导航完成，确认运行版本和原生 controller 都为 15.0.2。
3. 通过真实旧版 UI 编辑未保存草稿，再将整个静态站点切换至完整 v16 候选；原生新 worker 安装后进入 waiting。
4. 点击旧页“安全更新”，确认草稿值、原文 SHA、文档身份和旧控制器保持；未发出 `SKIP_WAITING`，新 worker 继续 waiting。
5. 通过真实“取消编辑”主动清空合成草稿，确认旧持仓 SHA 未变，再安全更新。
6. 真实激活并重载到 v16；运行版本/controller 精确为 16.0.0，原持仓 canonical SHA 严格不变，manifest 原生身份相同，无永久 waiting；只保留预期 `fuyu-v15.0.2` / `fuyu-v16.0.0` 缓存桶。
7. 在真实 v16 UI 保存合成份额 101，成本真实 0 继续显示 0。重新冻结该次合法保存后的 SHA。
8. 原生网络离线后，在同一 standalone 窗口 reload，仍可编辑该持仓，新保存后的 SHA 不变。这不是结束 Chrome/OS 进程后重新从快捷方式启动。

这里的未保存输入保护是“**阻止强制更新，直到用户明确处理草稿**”，不是声称未保存草稿能跨重载自动恢复。本变体明确选择主动取消，不把旧 UI 保存 lane 宣称为 PASS。

### 观测值

| 样本 | 模式 | 离线重开到可编辑 | 结论 |
| --- | --- | ---: | --- |
| native 1 | 原生两版 SW | 174.826 ms | PASS |
| native 2 | 原生两版 SW | 172.406 ms | PASS |
| native 3 | 原生两版 SW | 174.031 ms | PASS |
| installed/current-page 1 | 原生安装及 app window | 182.460 ms | PASS |

均低于原 3,000 ms 壳层目标。这是本地合成场景的绝对时限，不是冷暖性能配对报告、手机性能或互联网时延。

已安装样本真实 `PWA.openCurrentPageInApp` 前后 Page target/context 不变，原生 window ID 从 `1491893721` 变为 `1491893724`；旧版 app window、更新后、离线重开三个阶段 `matchMedia('(display-mode: standalone)')` 均为 true。没有设置媒体仿真、display-mode 或应用偏好来伪造该结果。

安装/卸载均只接受 Chrome `Page.getAppId` 返回且严格等于本次随机 loopback `/FundVal/` 的身份。最后仅卸载本次自建 app；所有 context/browser/server 已关闭，对三个自建 persistent profile 标签的额外进程检查为 **0 个 Chrome 进程**。没有枚举后按名称删除用户应用，没有触碰生产 PWA、个人 profile 或 Gist。

## 保留的失败与边界

| 留存收据 | 实际结果，不追改 |
| --- | --- |
| `historical-native-preflight-failure-1.receipt.json.gz` | realpath 直接作为 Array.map 回调导致 options 收到 index；零 browser 的预检 FAIL。修正调用签名并补实际 ENOENT 负控。 |
| `historical-native-old-save-failure-2.receipt.json.gz` | 旧 UI 新增合成持仓失败，尚未进入升级。FAIL。 |
| `historical-native-old-save-failure-3.receipt.json.gz` | 明确等首次 reload 后旧保存仍失败；有保存失败 toast 和 root modulepreload 404。保存函数吞掉的具体异常根因尚未确认，不能把 404 当作唯一已证原因。FAIL。 |
| `historical-installed-launch-target-failure-1.receipt.json.gz` | 原生 install/OS state/launch 成功，但返回 ID 未匹配 PW Page。FAIL。 |
| `historical-installed-tab-ancestry-failure-2.receipt.json.gz` | 原生 launch 返回 tab，Page 无 parentId；严格祖先链绑定拒绝，未按同 URL 任意挑页。FAIL。 |

新的已有持仓变体仍使用原版旧 App，只预置合成已有仓储；没有改旧包、伪造根 URL 映射或删掉原失败。后续使用原生 current-page API 是另一条真实已安装应用入口；默认 `launch` lane 仍可能因目标映射不能验收，不能由本次成功覆盖。

物理 Android / iOS、用户实际生产安装及可见安装 UX 继续单列，不由 headless/loopback 代替。专用 maskable 图标的视觉/安全区检查属于另一项工作，未将其混入原发布候选。

## 复现

前置：保留原基线 `D:\AI项目\.fundval-reference-20261030-40e68ed\site`，完整准备证明为 `D:\AI项目\FundVal\Temp\v16-performance-20261030-child\reference-build-provenance.json`。它由原源码/原 lock 独立准备，`SOURCE_DATE_EPOCH=1790569957`；不要用当前 node_modules 链接冒充原 Vite 8.2.2 构建。目标为原 CI 候选解包目录及同一原始 `candidate.json`。这些本地产物须另行保留；未把 90 MB 级站点复制进 Git。

先做零浏览器计划与纯检查：

```powershell
node --test test/pwa-upgrade-acceptance.test.js
node scripts/verify-pwa-upgrade.mjs --plan --existing-holdings --mode installed --installed-entry current-page
```

实际已安装入口，output 必须是新的不存在目录，父目录已存在：

```powershell
node scripts/verify-pwa-upgrade.mjs --execute --existing-holdings --mode installed --installed-entry current-page --samples 1 --old-site 'D:/AI项目/.fundval-reference-20261030-40e68ed/site' --old-provenance 'D:/AI项目/FundVal/Temp/v16-performance-20261030-child/reference-build-provenance.json' --new-site 'D:/AI项目/FundVal/Temp/v16-publish-20261029/main-40877032757-1/site' --new-candidate-json 'D:/AI项目/FundVal/Temp/v16-publish-20261029/main-40877032757-1/candidate/candidate.json' --output 'D:/AI项目/FundVal/Temp/pwa-upgrade-replay-new-label'
```

native 3 轮使用同一命令的产物参数，改为 `--mode native --samples 3`，去掉 `--installed-entry current-page` 并另选新 output。测试首次失败即停止计划样本，不补跑救绿。协议入口：[Chrome DevTools Protocol PWA](https://chromedevtools.github.io/devtools-protocol/tot/PWA/)。

## 主要收据摘要

- native 三轮原始 JSON SHA：`46fc1d29664d89b3e19f1e603dd9808fd915f01c4dc706858215b2b41ba966e7`。
- installed/current-page 原始 JSON SHA：`b6dcb951a7de94ab1c66c2ea2914317918a882c0889e8a0c9f95cc66dc10e706`。
- `SUMMARY.json` SHA：`320ae3332087fcfc46b3f44aed22f927510515e2a033a0fde7a433a706228d03`。
- 纯检查当前 7/7，覆盖执行入口、路径隔离、原生身份、真实 preflight 调用签名、完整旧包混版拒绝、native 父子链与 current-page CLI 负控；这些纯测试不替代上面实际运行证据。
