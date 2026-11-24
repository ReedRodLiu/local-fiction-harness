---
status: accepted
---

# Android 端基于 Gitee Releases 的应用内整包检查与更新机制

> 在不违背 [ADR 0004](0004-capacitor-monorepo-and-platform-runtime-seam.md) 与 [ADR 0008](0008-zero-content-diagnostics-and-turn-context-integrity.md) 的前提下，为 Android 最小封包新增面向 `https://gitee.com/liu-reed-rod/folio-android` 的应用内版本检查与原生 APK 下载安装能力；Web 端不展示安卓安装包更新入口。

## Decision

1. **端范围与整包边界**：
   - 检查更新与自动更新入口仅在 `PlatformRuntime.platform === 'android'` 时启用，通过 `PlatformRuntime.appUpdater` 接缝收口；Web 端隐藏更新入口。
   - 仅执行签名 APK 整包升级，不引入 JS 资源热更新或绕过系统包管理器的动态下发机制。
2. **版本数据源、通道与防漂移校验**：
   - 固定拉取 Gitee 仓库 `liu-reed-rod/folio-android` Releases API，过滤 `prerelease: false` 正式版，以 `tag_name`（剥离前导 `v`）按 SemVer 与本地 `APP_VERSION` 比对，并优先匹配 `-release.apk` / `.apk` 资产。
   - 工程校验强制检查 `package.json` 的 `version` 与 `android/app/build.gradle` 的 `versionName` 一致，避免发版版本号漂移导致升级后重复提示更新。
3. **触发时机、隐私控制与提示策略**：
   - 默认开启冷启动自动检查，受 24 小时冷却期节流；设置页「应用更新」独立分组提供开关可关闭自动检查，并支持随时手动无视冷却与跳过状态执行检查。
   - 发现新版后弹出非阻塞更新弹窗，提供「先导出备份（`.folio.json`）」「跳过此版本」「稍后提醒」与「立即更新」。
4. **原生流式落盘、双校验与权限续接**：
   - APK 不经 JS 桥 base64 中转内存，由原生 `NativeUpdater` 插件直接流式写入应用私有 `cacheDir/updates/`，同步校验 `PK` 魔数头与 `body` 中可选 `SHA-256`（有则必校，无则放行），并在原生层通过 `PackageManager` 强校验目标 APK 的 `applicationId` 与签名证书指纹必须与当前已安装应用一致。
   - 同版本且复检通过的缓存 APK 直接复用，冷启动及安装后自动清理过期缓存；下载或校验失败时提供重试及系统浏览器打开发布页兜底（签名不一致时额外提示先导出备份）。
   - 仅在 APK 下载校验完成后检查 `REQUEST_INSTALL_PACKAGES` 未知来源安装权限；未授权时引导至系统设置页，返回应用后自动续接唤起 `FileProvider` 系统安装器。
5. **零正文脱敏诊断**：
   - 检查、下载、校验、权限与唤起安装的状态码和脱敏结果记入本地 `DiagnosticCollector`（`update_*` 动作），严禁包含设备指纹、用户数据或密钥。

## Considered Options

- **Web 端同步展示 Android 安装包更新提示**：Web 本地玩家通常在桌面或网页体验，展示安卓 APK 下载易造成困惑。
- **沿用 `BinaryDownloadClient` 通过 JS 桥传输 APK 分块**：大体积二进制经 base64 往返 WebView 会带来内存放大，且 JS 层无法安全读取原生包签名指纹。
- **强制点击「立即更新」前先申请安装权限 / 强制阻断备份**：会在下载前打断用户意图或增加老用户升级摩擦。

## Consequences

- `AndroidManifest.xml` 与 `scripts/audit-artifacts.mjs` 白名单新增 `android.permission.REQUEST_INSTALL_PACKAGES`，`file_paths.xml` 显式暴露 `cache/updates/` 供 `FileProvider` 授权安装。
- `src/harness/` 保持纯 ES2022 零原生依赖，仅承载 SemVer 比对、Gitee Release 解析、冷却与跳过偏好管理及 `AppUpdater` 接口契约。
