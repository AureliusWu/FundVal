# 蜉蝣基金 Android APK

这是 FundVal 的 Android 安装版：轻量原生容器加上同一套网页应用。界面、数据目录和 OCR 资产随 APK 打包；行情和主动启用的 Gist 同步仍需要网络。没有新增服务器或图片上传服务。

- 包名：`io.github.aureliuswu.fundval`；最低 Android 8.0（API 26），目标 API 35。安装门槛不等于所有旧版 Android System WebView 都能运行 OCR。
- APK 与浏览器/PWA 不共用持仓、缓存或登录状态。迁移时先在原版导出持仓 JSON，再在 APK 的「持仓」页导入。不要为了更新而卸载旧 APK 或清除其数据。
- 截图和持仓文件通过 Android 系统文件选择器读取；持仓备份由系统保存对话框选择目的地。只声明 `INTERNET` 权限，不请求全盘/媒体访问或摄像头权限。发行包禁用 WebView 调试和自动备份。
- 内置 HTTPS 资源沿用原站点来源以兼容估值 API 的 CORS；同一主机的未打包路径不会回退到线上网页。APK 不注册网页 Service Worker、不提供网页 14:30 通知；更新通过安装同签名、更高 `versionCode` 的 APK。

持仓事务仍使用原有 Schema 3 和 Web Lock。APK 会在同一事务内写入应用私有的原生检查点，完成原子替换、同步和读回后才返回保存成功。重启先读取已确认的检查点，再恢复 WebView 投影；首次覆盖安装会从可验证的旧持仓迁移。原生检查点不包含 Token、行情缓存或截图。遇到损坏、版本冲突或写入结果无法确认时停止写入，不用空数据覆盖原件。不要回退到不认识检查点的旧 APK；如需恢复，先保留备份并使用同签名的更高版本。

## Windows 构建

使用项目 `package.json` 锁定的 Node/npm 与依赖，以及 JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。无需安装 Gradle 或 Android Studio。先在干净构建目录执行 `npm ci`、`npm test`、`npm run check`、`npm run build`、`npm run test:e2e`，然后从仓库根目录运行（把工具与构建路径替换为自己的路径）：

```powershell
New-Item -ItemType Directory -Force -Path android/out
./android/build-release.ps1 `
  -JavaHome 'C:/AndroidTools/jdk-17' `
  -AndroidJar 'C:/AndroidTools/sdk/platforms/android-35/android.jar' `
  -BuildTools 'C:/AndroidTools/sdk/build-tools/35.0.0' `
  -SiteDirectory 'site' `
  -OutputDirectory 'android/out/v16.0.1-6'
```

上例用于已有签名的更新。仅首次创建本应用签名时追加 `-InitializeSigning`。脚本不会覆盖已存在的输出或签名。专用 PKCS12 私钥及 Windows 用户 DPAPI 加密密码位于 `%LOCALAPPDATA%\FundVal\Signing`，不进入仓库或安装包。保留可恢复的签名备份：只复制 DPAPI 文件到另一台机器或账户，不保证能解密；丢失签名无法覆盖更新已安装版本。不要将签名资料放到 Release 附件。

脚本核验网页构建、原冷启动 gzip 门槛、OCR 文件、版本和 Android 权限，再执行编译、对齐、签名及 `apksigner verify`。APK、SHA-256 和构建证据位于指定输出目录。`prepare-assets.mjs` 的 `apkRevision` 用于同一 Web 版本下的 Android 更新；对外发过的版本号不得复用来发布不同字节。

参考：[Android 命令行构建](https://developer.android.com/build/building-cmdline) · [apksigner 签名和验证](https://developer.android.com/tools/apksigner)。

## 验收范围

签名通过不等于真机兼容。实装时至少核对打开、返回/草稿保护、保存后重启、备份导入导出、截图选择和 OCR 结果；不能用桌面网页测试替代 Android 测试。线上 Pages 和 GitHub Release 不由本构建脚本修改。
