# v16.0.1 本地候选检查（2026-10-30）

本文件冻结在提交前，不是最终main CI/候选或生产证明。机器摘要见 [LOCAL_QA.json](LOCAL_QA.json)，最终发布结果以 [Release](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.1) 为准。

- 本地默认 `npm test`：2194 total /2191 pass /3既有Windows skip /0 fail，native0；包含现有Temp宽发现，不冒充永久库或Linux CI计数。
- `npm run check`：291 JavaScript源码/测试，native0。
- `npm run build` 两次native0、完整site文件map及stdout字节相同。cold51,282/52,241 B PASS；all95,871 B NOT_ENFORCED，不把hash命名变化的9B差值当性能优化。
- `npm run test:e2e`：74/74 native0，原30s/expect8s/0retry。352B颜色环境warning保留；源与site map前后相同。
- 17 chunks/280,237 B、图closure/静态binding、23 OCR资产/88,197,828 B均验证通过。图验证本身不执行模块、不保证全部启动顺序，实际浏览器证据单列。
- 新maskable两个PNG的尺寸/不透明/蓝色主体安全余量通过，原any图片未改；18关键文件包含两图。官方registry审计0漏洞，依赖锁只改根版本。
- 11份原生记录的runtime/test/script/config输入清单前后及彼此一致；docs/Temp/环境不在该源摘要内，图标另行验字节。原始日志/receipt在`Temp/v16-main-20261028/release1601-local-*`，没有被覆盖或删除。
- 首次全量版本门禁因缺少本版本IMPLEMENTATION_FEEDBACK报错，已补文档及README原格式再跑；原失败stdout/receipt保留，没有删除或放宽版本断言。

这不是新增配对性能PASS，也不继承历史15→16安装升级为本补丁通过。真实Gist/真机不在本地回归中；补丁原候选与生产验证继续走独立发布链路。
