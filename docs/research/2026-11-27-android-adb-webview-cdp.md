# 调研报告：ADB + Capacitor WebView CDP 混合驱动能力与 Debug 开关安全边界

调研日期：2026-11-27 · 对应 Wayfinder 地图 [#150](https://github.com/ReedRodLiu/local-fiction-harness/issues/150) 下的研究票据 [#155](https://github.com/ReedRodLiu/local-fiction-harness/issues/155)（关联 [#156](https://github.com/ReedRodLiu/local-fiction-harness/issues/156) 三包隔离决策：`io.localfiction.harness` / `.e2e` / `.smoke`）。

---

## 1. WebView CDP Socket 自动发现与多 PID / 多 Target 绑定

### 1.1 仓库现状核验（`scripts/android-back-regression.mjs:206-333`）

1. **进程与端口转发（`connectToWebView`, L297-333）**：
   - 当前通过 `adb -s <serial> shell pidof io.localfiction.harness` 获取 PID，再执行 `adb -s <serial> forward tcp:0 localabstract:webview_devtools_remote_${pid}`。
   - **多 PID / 多包风险**：`pidof` 若返回多个空格分隔 PID 会拼接出非法 socket 名；在三包共存设备（主包 / `.e2e` / `.smoke`）上必须严格按目标 `applicationId` 绑定。
2. **Target 筛选（L318-326）**：
   - 访问 `/json/list` 后仅取首条 `target.type === 'page' && target.webSocketDebuggerUrl`。若进程内出现多 WebView（内嵌预览/子页），应进一步校验 `target.url` 匹配 Capacitor 主 Origin（`http://localhost/` 或 `https://localhost/`）并通过 `Runtime.evaluate` 验证应用特征。
3. **轻量客户端（`CdpClient`, L206-276）**：
   - 基于 Node 内置 `WebSocket` 维护 `nextId` 与 5000 ms 超时 `Map`，但丢弃无 `id` 的服务端事件（如 `Runtime.executionContextDestroyed`、`Inspector.targetCrashed`、`Target.targetDestroyed`），且断线后无重连机制。

### 1.2 Capacitor 8 (`@capacitor/android@8.6.2`) 与 Chromium WebView 一手机制

1. **调试开关注入链路**：
   - `CapConfig.java`（`deserializeConfig`）根据 `(context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0` 决定默认 `webContentsDebuggingEnabled`，并支持读取 `android.webContentsDebuggingEnabled` 覆盖。
   - `Bridge.java:624`（`initWebView`）调用 `WebView.setWebContentsDebuggingEnabled(this.config.isWebContentsDebuggingEnabled())`。该开关在 Android 中是**进程级全局静态状态**。
2. **Chromium `AwDevToolsServer` Socket 模型**：
   - Chromium `android_webview/browser/aw_devtools_server.cc` 固定使用 `webview_devtools_remote_%d`（`getpid()`）绑定 Linux 抽象域套接字（区别于 Chrome 浏览器 APK 使用的 `chrome_devtools_remote`）。
   - 同进程内多个 `WebView` 共享同一 `webview_devtools_remote_<pid>`（表现为 `/json/list` 下的多个 `page` target）；若存在独立子进程 WebView，则绑定子进程各自 PID。
3. **切后台（`KEYCODE_HOME`）、灭屏（`KEYCODE_POWER`）与恢复行为**：
   - `BridgeActivity.java:14,50` 与 `Bridge.java:1376` 默认 `KeepRunning = true`，调用 `MockCordovaWebViewImpl.handlePause(true)`（`MockCordovaWebViewImpl.java:124-132`），**不会**主动调用 `webView.onPause()` / `pauseTimers()`。
   - 但 OS/Chromium 仍会在后台或灭屏期间对渲染进程节流（挂起或降频 `requestAnimationFrame` 等），因此切后台期间不能依赖基于 `rAF` 的稳定态探测；若系统回收进程或发生渲染进程崩溃，旧 `webview_devtools_remote_<oldPid>` 销毁，切回或重启后必须清理旧 `adb forward` 并按新 PID 重新发现与重连。

### 1.3 推荐自动发现与重连流程

1. 使用 `adb -s <serial> shell pidof <packageId>` 拆分校验 PID，并与 `adb -s <serial> shell cat /proc/net/unix` 中的 `@webview_devtools_remote_<pid>` 取交集确认监听就绪。
2. 查询 `http://127.0.0.1:<localPort>/json/list`，按 `type === 'page'` + Capacitor Origin + `Runtime.evaluate` 特征精准绑定主 WebView target。
3. 为 `CdpClient` 补充 `onEvent(method, handler)` 与 `reconnect()`：后台/灭屏恢复时自动检测断线并重建 `adb forward` 与 WebSocket 会话。

---

## 2. Playwright `connectOverCDP` vs 扩展轻量原生 `CdpClient`

- **依赖核验**：`package.json` 未安装 `playwright` / `playwright-core`；桌面 Web E2E（`tests/e2e/run-e2e.mjs:12-16`）是通过环境变量路径加载外部全局 `playwright-core`。
- **一手机制对比（核验自本地 `playwright-core/lib/coreBundle.js`）**：
  - `chromium.connectOverCDP` 强制请求 `/json/version/` 读取浏览器级 `/devtools/browser` 端点（`coreBundle.js:44769-44788`），并在 `_onAttachedToTarget()` 中若发现 `!targetInfo.browserContextId` 会直接 detach session（`coreBundle.js:40222-40225`），易与 Android System WebView 冲突或报错。
  - Playwright `_android`（`device.webView()`）为实验性 API，仍强依赖 `playwright-core` 且需要额外的 `Runtime.disable/enable` 重试探测。
  - **选型结论**：不接入 `connectOverCDP`。继续扩展零依赖 `CdpClient`（负责 DOM/存储读写、布局/滚动指标与事件监听）+ `adb`（负责物理触摸、系统按键、截屏、`dumpsys` 与 `logcat`），结构最轻、可控性最高。

---

## 3. 设备分辨率自适应手势坐标换算

1. **真实显示边界读取**：
   - 通过 `adb -s <serial> shell dumpsys window displays` 读取当前旋转方向下的有效屏幕宽高 `(displayW, displayH)`（辅以 `wm size` / `wm density`），并解析 `InsetsState` 中的 `statusBars`、`navigationBars`、`systemGestures`、`mandatorySystemGestures` 与 `mDisplayCutout`。
   - 通过 CDP `Runtime.evaluate` 读取 `window.visualViewport`、`window.devicePixelRatio`（`dpr`）、CSS `--safe-area-top/right/bottom/left`（`src/ui/styles/tokens.css:19-22`）及目标元素 `getBoundingClientRect()`；通过 `uiautomator dump` 获取 WebView 容器像素边界 `(wvLeft, wvTop, wvRight, wvBottom)`。
2. **避开系统边缘热区的百分比换算（对齐 `src/ui/swipeGesture.ts:3,154`）**：
   - 仓库定义 `OS_EDGE_GUARD_PX = 32`（CSS px），拦截 `clientX < 32` 的应用内起手以避开 Android 系统侧滑返回。
   - **应用内手势**：水平起点夹逼在 `safeLeftPx = max(systemGestureLeftPx, wvLeft + ceil((OS_EDGE_GUARD_PX + marginCss) * dpr))` 与 `safeRightPx` 之间按比例取点（如抽屉右滑取安全区宽度 `12%–18%`），纵向夹逼在状态栏/刘海与导航栏之间；
   - **OS 系统返回手势测试**：刻意将起手放在 `0 < x1 <= max(4, systemGestureLeftPx / 2)` 热区内横向滑入；
   - **DOM 元素物理点击（`adb shell input tap`）**：`tapX = round(wvLeft + (visualViewport.offsetLeft + rect.left + rect.width / 2) * dpr)`，发送前校验未被状态栏/输入法遮挡。

---

## 4. 三包构建变体隔离与 `audit:artifacts` 安全边界

### 4.1 Gradle 变体与 `BuildConfig` / `NetworkSecurityConfig` 设计

在 `android/app/build.gradle`（AGP `8.13.0`）开启 `buildFeatures { buildConfig = true }`，配置 3 个显式 `buildTypes`（`e2e` 与 `smoke` 使用 `initWith debug` 并设置 `matchingFallbacks = ['debug']` 以兼容 Capacitor 库模块）：

| 构建变体 | 包名 (`applicationId`) | `debuggable` | `ALLOW_WEBVIEW_DEBUGGING` | `ALLOW_LOOPBACK_HTTP` | `network_security_config` |
| --- | --- | --- | --- | --- | --- |
| `release` | `io.localfiction.harness` | `false` | `false` | `false` | 全局禁止明文（无 `127.0.0.1`、无用户 CA） |
| `e2e` | `io.localfiction.harness.e2e` | `true` | `true` | `true` | 全局禁止明文，**仅**对 `127.0.0.1` 与 `localhost` 开放回环明文（供 `adb reverse`） |
| `smoke` | `io.localfiction.harness.smoke` | `true` | `true` | `false` | 全局禁止明文（与 `release` 同级，严禁本地回环） |

配套代码加固要点：
- **源集隔离**：按 `src/{release,e2e,smoke}/res/xml/network_security_config.xml` 物理隔离 XML 资源，确保 `release` APK 资源表内完全不存在回环明文规则。
- **WebView 调试双重锁**：在 `MainActivity.onCreate()` 显式校验 `BuildConfig.ALLOW_WEBVIEW_DEBUGGING && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0` 后调用 `WebView.setWebContentsDebuggingEnabled(...)`（或覆盖 `CapConfig.Builder`），防止被错误 JSON 配置开启。
- **Native 插件对齐**：`NativeUpdaterPlugin` / `NativeBinaryPlugin` 将 `allowLoopbackHttpForTest` 接为 `BuildConfig.ALLOW_LOOPBACK_HTTP`；`SseForegroundService` 的 `ACTION_START` 建议改为动态包名前缀；禁止在 `main` 源集注册任何测试专用插件。

### 4.2 `audit:artifacts` 与 `apksigner` 升级缺口

核验 `scripts/audit-artifacts.mjs`（L6-178）发现以下现有盲区，落地时需同步补齐：
1. **动态权限白名单**：`L15` 硬编码 `'io.localfiction.harness.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'`，需按当前审计包名动态放行 `${expectedPackageId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`。
2. **Release 安全红线审计**：当前 `runRepoArtifactAudit()` 仅检查 `debug` 目录下的 Manifest 与 `app-debug.apk`，且 `auditManifestXml()` 未校验 `android:debuggable` 与 `network_security_config`。需补充对 `release` Merged Manifest 与 `app-release.apk` / 签名包的全量核验：
   - 严禁存在 `android:debuggable="true"`；
   - 校验打包 XML 不含 `127.0.0.1`/`localhost` 明文放行，且 `assets/capacitor.config.json` 无 `webContentsDebuggingEnabled: true` 与 `server.url`；
   - 通过 `apksigner verify --print-certs` 验证正式发布证书指纹（`0cce9656...040d`），禁止使用默认 Android Debug 证书签名发布包。

---

## 一手参考索引

- 仓库：`scripts/android-back-regression.mjs`、`scripts/audit-artifacts.mjs`、`src/ui/swipeGesture.ts`、`src/ui/styles/tokens.css`、`android/build.gradle`、`android/app/build.gradle`、`android/app/src/main/AndroidManifest.xml`、`android/app/src/main/java/io/localfiction/harness/{MainActivity,NativeUpdaterPlugin,ApkUpdateClient,NativeBinaryPlugin,BinaryDownloadClient,NativeVaultPlugin,SseStreamClient,SseForegroundService}.java`
- `@capacitor/android@8.6.2`：`BridgeActivity.java`、`Bridge.java`、`CapConfig.java`、`MockCordovaWebViewImpl.java`
- Chromium：`android_webview/browser/aw_devtools_server.cc`、`content/browser/devtools/devtools_http_handler.cc`
- 本地 `playwright-core/lib/coreBundle.js`（`connectOverCDP` 与 `_android` 实现）
