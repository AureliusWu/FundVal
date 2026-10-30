# PWA maskable 图标

2026-10-30 本地后续改动；不改写已发布 v16.0.0 的资产或验收状态。

- 原有 `icon-192.png` / `icon-512.png` 保留 `purpose: any`，像素不变。
- 新 `icon-maskable-192.png` / `icon-maskable-512.png` 单独声明 `purpose: maskable`，完全不透明、方形纸纹背景铺满四边，不预裁圆角。
- 设计遵循现有蓝色蝴蝶品牌。使用 **builtin imagegen** 对原 icon-512.png 做一次生成式构图编辑，不是原像素等比缩放；无 CLI/API fallback。
- 原始输出实际 1254×1254，保存在 `docs/design/pwa-maskable-source.png`；SHA-256 `81e3d82463c47652332e74b9a72f4954963ccfd29503f37a7b051df9d2126a60`。此原始设计稿不复制到站点。
- `node scripts/build-maskable-icons.mjs` 使用已有 Chrome canvas **仅机械导出尺寸**，不重绘/调色/添加内容；拒绝覆盖已有输出。Chrome 渲染版本会记录，跨浏览器版本不保证 PNG 编码字节一致，已提交的 PNG 才是实际消费资产。
- `node scripts/pwa-icon-assets.mjs .` 检查尺寸、透明度及蓝色主体半径 ≤0.36W，规范 safe-circle 半径为 0.4W；蓝色阈值检查不证明每根棕色触须，仍需完整轮廓和不同系统裁切的视觉确认。
- 新图不进入首页 JS 图或 SW CORE；安装器按 manifest 获取，SW 既有普通同源资源缓存策略可处理后续请求。不为仅图标新增首页预加载或大型核心预缓存。
- 原192px Apple touch icon仍沿用，不把Android maskable预览冒充iOS真实安装验收。
- 规范来源：[W3C Manifest — Icon masks and safe zone](https://www.w3.org/TR/appmanifest/#icon-masks)。`node scripts/render-maskable-preview.mjs` 生成桌面裁切审查图，标明圆形、圆角与近似squircle；不是手机系统实拍。

## 最终提示词

Use case: precise-object-edit. Asset type: a production PWA maskable app icon, square 1024 by 1024 pixels, fully opaque. Input image 1 is the EDIT TARGET and exact FundVal brand identity: a symmetric blue watercolor butterfly on warm cream parchment. Change ONLY the layout/framing: make the identical butterfly smaller and centered, extend the identical warm cream paper texture seamlessly all the way to every square edge. Preserve the blue shades, gold/brown fine outlines and veins, wing silhouette, round lower-wing spots, body and both antennae; no redesign, no extra objects. Composition: butterfly including every wingtip and antenna should span approximately 54% of canvas width and 45% of canvas height, centered around (512,512), entirely inside a circle centered on the canvas with radius 0.34 times canvas width. The area outside that invisible safe circle is only continuous cream parchment texture, never blue butterfly detail. This is deliberately generous padding for Android circular and squircle masks. Do not draw the safe circle or guides. No text, lettering, border, rounded corners, shadows, circular badge or transparency. Deliver a single finished opaque 1024x1024 PNG icon.
