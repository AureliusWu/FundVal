# 蜉蝣基金（FundVal）v16.0.1 实施反馈

这是16.0.1候选提交前的范围与证据快照，不是发布成功证明。最终精确提交、CI、候选hash、部署与真实生产核对以 [Release v16.0.1](https://github.com/AureliusWu/FundVal/releases/tag/v16.0.1) 正文/附件为准，执行范围见 [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)。

## 本补丁实现

- 独立192/512不透明maskable PNG、manifest声明、构建前尺寸/透明度/蓝色主体安全区检查；原any/Apple图标保留，两图进入18个发布关键文件的指纹与生产核验，不进入JS图或SW CORE。
- 持久化设计原稿/提示词/裁切预览；可重复的PWA原生两版与headless已安装窗口验收工具、整版本60对性能对照工具、纯负控及小型原始压缩证据。
- 原同步测试仅改transport入口握手，原50ms和全部断言保留；CI候选ZIP使用传输压缩。两者都不更改金融/同步业务或应用性能预算。
- package/lock/runtime/HTML/manifest/SW/README及指南统一16.0.1；依赖图、Schema3、数据/来源/日期、null与0、沙箱、OCR隐私与原有安全更新保护不变。

## 证据不能混用

- [10-30补充工作](../v16.0.0/FOLLOWUP_20261030.md) 的原生SW3轮/已安装窗口1轮，严格绑定v15.0.2→原v16.0.0，不冒充16.0.1补丁或真机测试。
- 历史60对整版对照的总体INCONCLUSIVE、暖重载稳定性缺口、阶段字节增长和所有中途FAIL均保留；本补丁不宣称新增全面提速。
- 本次16.0.1本地/精确CI/原候选/部署/生产/补丁升级结果须实际运行后记入固定Release。首次本地升版检查发现本文件缺失并报错，补齐文档而不删除版本门禁；原输出保留在Temp。
- 真实Gist双端、物理Android/iOS、可见OS快捷方式与进程重启、完整生产行情、CodeQL9及OCR资源目标等既有限制不因tag自动消除。新数据/安全错误不能借历史豁免改判。

## 恢复原则

保留原16.0.0 tag和证据；需要恢复时优先统一向前补丁，保护Schema3和备份。不强制清空持仓、不降写旧Schema、不单独替换index或SW，也不使用force reset/push覆盖历史。
