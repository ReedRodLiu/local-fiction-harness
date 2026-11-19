# UI 样式、图标与底部 Sheet 工程基座选型调研（方案 A 极简轻量栈 vs 方案 B 现代原子化栈）

核查日期：2026-11-19。本调研在分支 `research/ui-styling-and-sheet-stack` 完成，对应 Wayfinder 地图 [#36](https://github.com/ReedRodLiu/local-fiction-harness/issues/36) 下的研究票据 [#38](https://github.com/ReedRodLiu/local-fiction-harness/issues/38)，用于确定重构 `src/ui/` 时应采用的前端样式、线性图标与抽屉/底部 Sheet 工程基座。

---

## 一、明确结论：推荐「方案 A（极简轻量栈 + 规范化原生层）」

**推荐采用方案 A**：**`lucide-react`（静态按需导入、Vite Tree-shake）+ 模块化原生 CSS Design Tokens + 原生 `<dialog>.showModal()` 驱动的模态框/抽屉/底部 Sheet + 轻量独立 Pointer Events 手势 Hook（严格遵循 `modern-web-guidance` 规范与渐进降级兜底）**。

**明确不采用方案 B 中的 `vaul` 与 Tailwind CSS v4**：
1. **`vaul` 已于上游正式声明停止维护（unmaintained）**：作者在 [emilkowalski/vaul README（提交 `3e97aac`，2025-10-03）](https://github.com/emilkowalski/vaul/blob/main/README.md) 明确声明 *"This repo is unmaintained... I simply don't have the time or will to work on it right now"*，最近一次发版停留在 `v1.1.2`（2024-12-14），累计 162 个未关闭 Issue；将其作为文游播放器高频「剧情树 / 剧情回顾 / 故事蓝图」三合一底部 Sheet 底座存在长期缺陷无人修复风险。
2. **Tailwind CSS v4 抬高了非 GMS / 老旧 Android WebView 的渲染下限，且与现有 806 行 CSS 存在 Cascade 冲突**：[Tailwind CSS v4 官方兼容文档](https://tailwindcss.com/docs/compatibility) 要求 **Chrome 111+ / Safari 16.4+ / Firefox 128+**（核心依赖 `oklch()` 色彩与 `color-mix()` 透明度修饰符）；在 `minSdkVersion = 24`（Android 7.0）且面向 APK 侧载分发的低版本/无 Play 商店更新 ROM WebView 中会出现样式解析失效，同时与现有未分层的 `src/ui/styles.css` 混用会因 CSS `@layer` 优先级倒置引发样式覆盖冲突。
3. **仅靠 `@radix-ui/react-dialog` 无法替代手势 Sheet**：虽然 `@radix-ui/react-dialog@1.3.1` / `radix-ui@1.8.1` 维护活跃且支持 React 19，但它只提供焦点锁定、Portal 与遮罩关闭，**不包含任何移动端触摸拖拽、阻尼或停靠点（snap）能力**，仍需额外手写手势层；用原生 `<dialog>.showModal()` 可零第三方依赖直接获得浏览器原生 Top Layer、`inert`、焦点管理与返回关闭语义。

---

## 二、本仓工程基线核查

| 维度 | 本仓实测基线 | 来源文件 |
| --- | --- | --- |
| React & 构建链 | `react@^19.0.0`、`react-dom@^19.0.0`、`vite@^6.0.11`、`typescript@^5.7.3`（`target: ES2022`） | [package.json](../../package.json)、[tsconfig.app.json](../../tsconfig.app.json) |
| Capacitor & Android SDK | `@capacitor/core@8.6.2`、`@capacitor/android@8.6.2`；`minSdkVersion = 24`、`compileSdkVersion = 36`、`targetSdkVersion = 36` | [package-lock.json](../../package-lock.json)、[android/variables.gradle](../../android/variables.gradle) |
| WebView 与视口现状 | `index.html` 仅配置 `width=device-width, initial-scale=1.0`，尚未配置 `viewport-fit=cover`；`capacitor.config.ts` 未配置 `plugins.SystemBars` | [index.html](../../index.html)、[capacitor.config.ts](../../capacitor.config.ts) |
| APK 与产物审计 | Debug APK 基线 **4.15 MB**（地图 `#36`）；`audit-artifacts.mjs` 硬上限 **20 MB**，且校验 `AndroidManifest.xml` 仅允许 `INTERNET` 与 `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | [scripts/audit-artifacts.mjs](../../scripts/audit-artifacts.mjs)、[android/app/src/main/AndroidManifest.xml](../../android/app/src/main/AndroidManifest.xml) |
| 现有样式基座 | `src/ui/styles.css` 共 806 行（14.3 KB），已使用 `:root` 语义变量（`--bg-page`、`--bg-surface`、`--brand` 等）与 `@media (prefers-color-scheme: dark)`，含 242 处 `className=`；第 73/204 行裸用 `100dvh` 缺 `100vh` 回退 | [src/ui/styles.css](../../src/ui/styles.css) |
| E2E 测试契约 | `tests/e2e/run-e2e.mjs`（1,100 行）混合使用 `data-testid`、语义 ID、`role`、`details/summary` 状态及 **15+ CSS 类名选择器**（如 `.turn-card.assistant`、`.error-banner`、`.story-item`、`.reasoning-details`、`.main-stage > .error-banner`） | [tests/e2e/run-e2e.mjs](../../tests/e2e/run-e2e.mjs) |

---

## 三、方案 A vs 方案 B 多维对比总表

| 评估维度 | 方案 A：极简轻量栈（`lucide-react` + 原生 CSS Tokens + `<dialog>` / 轻量手势 Sheet） | 方案 B：现代原子化栈（`lucide-react` + Tailwind CSS v4 + Radix Dialog / Vaul） |
| --- | --- | --- |
| **产物 / APK 体积增量**（基于 npm tarball 实测） | **+12–23 KB gzip**（约 **+0.02 MB**，占 4.15 MB 基线 < 0.6%）：`lucide-react` 按需约 6–12 KB gz + 模块化 CSS 4–8 KB gz + 轻量 Sheet/Dialog Helper 1.5–3 KB gz，零新增第三方运行时依赖 | **+40–55 KB gzip**（约 **+0.04–0.06 MB**，占 4.15 MB 基线 ~1.0–1.4%）：`lucide-react` 6–12 KB gz + Tailwind 输出 CSS 4–10 KB gz + `@radix-ui/react-dialog`（20 个依赖包共 115.5 KB 原始 ESM）+ `vaul`（79.1 KB ESM + 6.1 KB CSS，~18.1 KB gz） |
| **构建工具链复杂度** | `vite.config.ts` 保持零 CSS 插件；`node_modules` 仅增加纯 JS/TS 的 `lucide-react` | 需引入 `@tailwindcss/vite@4.3.5`（依赖 `@tailwindcss/node`、`@tailwindcss/oxide` 原生 Rust 二进制与 `lightningcss`）及 20+ Radix 子包 |
| **React 19 兼容性与维护状态** | `lucide-react@1.75.0` 活跃维护（2026-11-18）且原生声明 `react: ^19.0.0`；`<dialog>`/CSS 无 React 版本耦合 | `tailwindcss@4.3.5` 与 `@radix-ui/react-dialog@1.3.1` 维护活跃且支持 React 19；但 **`vaul@1.1.2` 已停止维护**（2024-12-14 末版，162 个未关闭 Issue） |
| **Android WebView 兼容下限** | **WebView 60+（Cap 8 官方底线）核心可用**：Hex/RGB 变量与 `<dialog>.showModal()`（WebView 37+）全覆盖；`dvh`（108+）、`@starting-style`（117+）、`closedby`（134+）均可通过 `modern-web-guidance` 小型渐进兜底平滑降级 | **Tailwind v4 强制 Chrome/WebView 111+**（`oklch()`、`color-mix()`）；低于 WebView 111 的非 GMS/老旧设备将出现颜色与透明度大面积失效；`vaul` 依赖 `position: fixed` / `visualViewport` 启发式规则绕行 Safari/WebView 差异 |
| **移动端底部 Sheet 手感上限** | **高（可控、无黑盒冲突）**：侧栏抽屉可用纯 CSS 水平 `scroll-snap` 达到原生 60/120fps 跟手；底部 Sheet 用 `<dialog>` + ~150 行 Pointer Events 手柄拖拽 + `scrollTop <= 0` 交接 + 对数阻尼，可满足单/双停靠点阻尼回弹与速度甩出关闭 | **理论手感略高但受限于库冻结**：`vaul` 自带对数过拖阻尼（`8*(log(v+1)-2)`）与多停靠点状态机，但内部 `use-prevent-scroll` 与内部长列表滚动/输入框软键盘常发生手势锁死，且上游不再修复 |
| **现有工程 & E2E 维护成本** | **极低**：直接沿用 `styles.css` 的 `:root` Token 体系演进为分模块 CSS；`<dialog>` 保留在原 React DOM 树内，不破坏 `.main-stage > ...` 及现有 15+ E2E 类选择器 | **较高**：Tailwind v4 `preflight.css`（8.5 KB）重置边距/边框/标题，且 `@layer utilities` 优先级低于未分层的 `styles.css`，混合期易出错；Radix `Dialog.Portal` 会将弹窗移至 `body`，需同步改造 E2E 选择器与 DOM 结构预期 |

---

## 四、分维度实证依据

### 1. 构建产物与 APK 体积增量实测

通过直接查询 npm registry 与解压各候选包 `.tgz` 实测（排除 `.map` 与多套重复 CJS/ES5 构建，统计 Vite 6 Rollup 实际消费的 ESM + CSS）：

1. **`lucide-react@1.75.0`**（[npm registry](https://registry.npmjs.org/lucide-react/1.75.0) / [packages/lucide-react/package.json](https://github.com/lucide-icons/lucide/blob/main/packages/lucide-react/package.json)）：
   - 包元数据声明 `"sideEffects": false`。虽然 npm 解压总体积达 `39.8 MB`（含 4,854 个图标 ESM/CJS/`.d.ts`/`.map` 文件），但 Vite 6 按具名静态导入（如 `import { Menu, Settings } from 'lucide-react'`）执行 Tree-shaking 时，单个图标模块仅 **`260–830 B` raw（`200–460 B` gzip）**（例如 `icons/menu.mjs` 为 `573 B raw / 347 B gzip`），共享运行时（`createLucideIcon.mjs` `961 B`、`Icon.mjs` `2,061 B`、`buildLucideIconNode.mjs` `3,004 B`、`defaultAttributes.mjs` `504 B` 等）合计仅约 `~7.5 KB raw / ~3.2 KB gzip`。
   - **工程约束**：禁止使用 `DynamicIcon` 或导入 `dynamicIconImports.mjs`（实测 `145,577 B raw / 16,728 B gzip`），以免破坏按需裁剪。常规文游 UI 导入 20–30 个静态图标，增量仅 **`~15–25 KB` 未压缩 JS（`~6–12 KB` gzip / APK DEFLATE 压缩增量）**。
2. **方案 A 样式与原生浮层增量**：
   - 将现有 [src/ui/styles.css](../../src/ui/styles.css)（`14,296 B` raw）扩展为模块化 CSS Tokens + 侧滑抽屉 + 底部 Sheet 样式，预计产物体积约 **`15–30 KB` raw CSS（`4–8 KB` gzip）**；
   - 原生 `<dialog>` + Light-Dismiss/Exit 渐进兜底 + 底部 Sheet 手势 Hook 约 **`3–8 KB` raw JS（`1.5–3 KB` gzip）**。
   - **合计增量（含 `lucide-react`）**：**`~12–23 KB` gzip（约 `0.02 MB`）**。
3. **方案 B 原子化 CSS + 无障碍原语增量**：
   - **Tailwind CSS v4（`tailwindcss@4.3.5` + `@tailwindcss/vite@4.3.5`）**：编译期工具（运行依赖 `@tailwindcss/node@4.3.5`、`@tailwindcss/oxide@4.3.5`、`lightningcss@1.33.0`），向最终 APK 注入零运行时 JS；输出 CSS 包含 `preflight.css`（完整未裁剪 `8,489 B raw / 2,920 B gzip`）+ 被扫描到的 `@theme` 变量与工具类，通常产出 **`15–40 KB` raw CSS（`4–10 KB` gzip）**（若迁移期与旧 `styles.css` 并存则叠加 `14.3 KB`）。
   - **`@radix-ui/react-dialog@1.3.1`（或统一包 `radix-ui@1.8.1`）**：其 `dependencies` 实际拉取 **20 个运行时包**（`react-dismissable-layer@1.2.1` `14,935 B`、`react-focus-scope@1.3.1` `11,246 B`、`react-presence@1.1.11` `6,615 B`、`react-slot@1.5.0` `6,848 B`、`aria-hidden@1.2.6` `6,520 B`、`react-remove-scroll@2.7.2` `16,295 B`、`react-remove-scroll-bar@2.3.8` `4,475 B`、`use-sidecar@1.1.3` `6,739 B`、`use-callback-ref@1.3.3` `7,519 B` 等），实测单一 ESM 构建原始代码总计 **`115,480 B`（`112.8 KiB`）**（压缩后约 `38–42 KB min / 13–15 KB gzip`）。
   - **`vaul@1.1.2`**：依赖 `"@radix-ui/react-dialog": "^1.1.1"`，额外增加 `dist/index.mjs`（**`79,120 B` raw / `17,095 B` gzip**）与 `style.css`（**`6,078 B` raw / `1,037 B` gzip**）。
   - **合计增量（含 `lucide-react` + Tailwind + Radix + Vaul）**：**`~40–55 KB` gzip（约 `0.04–0.06 MB`）**。
4. **体积维度小结**：两种方案距离 `scripts/audit-artifacts.mjs` 的 `20 MB` 阈值都非常安全，相对 4.15 MB Debug APK 均仅增加 `0.5%–1.5%`；但方案 A 少解析压缩约 `~30 KB gzip` JS（解压后约 `150+ KB` JS 代码解析与挂载开销），更契合 Capacitor 低端 Android WebView 冷启动。

### 2. React 19 兼容性与上游维护状态

本仓锁定 `"react": "^19.0.0"` 与 `"react-dom": "^19.0.0"`（[package.json](../../package.json#L25-L26)）：

- **`lucide-react@1.75.0`**：2026-11-18 更新，`peerDependencies` 为 `"react": "^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0"`，完全兼容 React 19。
- **`@tailwindcss/vite@4.3.5` & `tailwindcss@4.3.5`**：2026-11-18 更新，`@tailwindcss/vite` 仅要求 `"vite": "^5.2.0 || ^6 || ^7 || ^8"`，与本仓 `vite@^6.0.11` 和 React 19 无冲突。
- **`@radix-ui/react-dialog@1.3.1` / `radix-ui@1.8.1`**：2026-10-14 发版，[radix-ui/primitives](https://github.com/radix-ui/primitives) 2026-10 仍有高频维护提交（如 `#4209` 修复 iOS Safari 遮罩点击不关闭、`#4105` 修复首帧点击拦截），`peerDependencies` 已正式包含 `^19.0.0`。
- **`vaul@1.1.2`（核心风险项）**：
  - 虽然 `vaul@1.1.2` 的 [package.json](https://github.com/emilkowalski/vaul/blob/main/package.json) 在 `peerDependencies` 中写入了 `^19.0.0`，但该版本发布于 `2024-12-14`；
  - 仓库最后一次功能提交为 `2025-07-25`，而 `2025-10-03` 的最后一次提交 `3e97aac`（*"Explain maintenance"*）在 [README.md](https://github.com/emilkowalski/vaul/blob/main/README.md) 顶部明确宣告停止维护；
  - 截至核查日仓库积压 **162 个未关闭 Issue**，集中在移动端软键盘顶起、嵌套滚动锁定与 Safari/Android 视口回跳；且内部强依赖 `@radix-ui/react-dialog@^1.1.1` 与 [use-position-fixed.ts](https://github.com/emilkowalski/vaul/blob/main/src/use-position-fixed.ts)、[use-prevent-scroll.ts](https://github.com/emilkowalski/vaul/blob/main/src/use-prevent-scroll.ts) 的全局 `document.body` 样式覆写。在 React 19 + Capacitor 8 新架构中引入已停维的手势组件库风险过高。

### 3. Android WebView 兼容边界与 Capacitor 8 适配细节

根据 [Capacitor Android 文档](https://capacitorjs.com/docs/android) 与 [Android Developers WebView 文档](https://developer.android.com/develop/ui/views/layout/webapps/managing-webview)：
- 本仓 `minSdkVersion = 24`（Android 7.0）。在 Android 7–9（API 24–28）上 WebView 由设备端 Google Chrome APK 提供；在 Android 10+（API 29+）上由独立的 Trichrome **Android System WebView** 通过 Google Play 独立更新；Capacitor 8 要求的最低 WebView 引擎为 **Chrome 60+**。
- **本仓分发特殊性**：结合 [docs/project-plan.md](../../docs/project-plan.md) 中的本地中文交互与 APK 侧载分发特征，部分无 Google Play 服务（非 GMS）的国内定制 ROM 或未升级镜像的 Android 模拟器，WebView 版本可能停留在 Chromium 83–110 区间。

结合 [mdn/browser-compat-data](https://github.com/mdn/browser-compat-data)、[Tailwind CSS v4 兼容文档](https://tailwindcss.com/docs/compatibility)、[Capacitor 8 SystemBars 文档](https://capacitorjs.com/docs/apis/system-bars) 及 `modern-web-guidance` 规则，关键特性在 **Android WebView** 的真实兼容边界如下：

| 特性 / 机制 | Android WebView 最低支持版本 | Baseline / 跨端状况 | 对方案 A / B 的工程影响与兜底策略 |
| --- | --- | --- | --- |
| `<dialog>` + `.showModal()` + `::backdrop` | **WebView 37+** | Widely available（2022-03） | 远低于 Capacitor 底线（60+），双端无条件安全使用；**唯一选择**作为模态抽屉与底部 Sheet 宿主 |
| `<dialog closedby="any">` | **WebView 134+** | Limited（Safari 不支持） | 必须按 `modern-web-guidance`（`dialog` / `light-dismiss-a-dialog`）补充 `if (!('closedBy' in HTMLDialogElement.prototype))` 的 `pointerdown`/`pointerup` 矩形边界检查（约 10 行 JS） |
| `overscroll-behavior: contain` | 有滚动溢出 **63+**；**无溢出容器（如 `::backdrop`）144+** | Limited（Safari 仅支持可滚动容器） | 按 `prevent-page-scroll-under-modal-dialog` 对 `dialog:modal` 与 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }` 作渐进增强；**严禁**对 `html`/`body` 设置 `overflow: hidden` 或 `position: fixed` |
| `dvh` / `svh` 动态视口单位 | **WebView 108+** | Widely available（2022-12） | 若兼容 WebView <108，必须先写 `100vh` 再写 `100dvh`/`100svh`（当前 `src/ui/styles.css` L73/L204 缺 `100vh` 回退，重构时补齐） |
| Tailwind v4 核心（`@layer` / `@property` / `oklch()` / `color-mix()`） | `@layer` **99+**、`@property` **85+**、**`oklch()` 与 `color-mix()` 111+** | 官方硬性门槛：**Chrome 111+ / Safari 16.4+ / Firefox 128+** | **方案 B 重大隐患**：WebView 60–110 设备打开 Tailwind v4 构建的页面时，默认色板（`oklch`）与透明度类（`bg-*/50` 使用 `color-mix`）会整条失效；方案 A 使用原生 `:root` Hex/RGB Token 可稳定兼容至 WebView 60+ |
| `popover` 属性 + `showPopover()` | **WebView 114+** | Newly available（2025-01；iOS 18.3 修复外部点击） | 非模态浮层若面向 WebView <114，按 `modern-web-guidance` 使用 `!Object.hasOwn(HTMLElement.prototype, 'popover')` 条件动态加载 `@oddbird/popover-polyfill`，或直接使用按钮状态切换 / `<dialog>` 避免依赖 Popover |
| `@starting-style` + `transition-behavior: allow-discrete` | **WebView 117+**（`overlay` 仅 Chromium 117+，Firefox/Safari 不支持） | Newly available（2024-08） | 在 WebView <117 上安全退化为即时显隐，不影响可用性；若需跨桌面 Safari/Firefox 完整离场动画，按 `animate-to-from-top-layer` 补充 `data-closing` + `getAnimations()` 兜底（~20 行 JS） |
| **`env(safe-area-inset-*)` + Android 15/16 Edge-to-Edge** | **Android WebView < 140 存在系统级返回 `0px` 缺陷** | Capacitor 8.3+ 内置 `SystemBars` 修复 | **双方案共性关键坑点**：本仓 `targetSdkVersion = 36`（[android/variables.gradle](../../android/variables.gradle#L4)）触发 Android 15+ 强制 Edge-to-Edge。据 [Capacitor 8 SystemBars 文档](https://capacitorjs.com/docs/apis/system-bars)，**WebView < 140 时 `env(safe-area-inset-*)` 返回 `0px`**。必须配合 `index.html` 加入 `viewport-fit=cover`、`capacitor.config.ts` 配置 `SystemBars.insetsHandling`（`css` 或 `native`），并在 CSS 中采用 `max(0.75rem, env(safe-area-inset-bottom, var(--safe-area-inset-bottom, 0px)))` |

### 4. 移动端侧滑抽屉与底部 Sheet 触摸拖拽/阻尼 UX 上限

结合地图 `#36` 的具体交互形态：左侧为「故事书架 + 新建/导入 + 底部设置」滑出抽屉，顶栏右上唤出**三合一底部 Sheet（剧情树 / 剧情回顾 / 故事蓝图）**，内含可垂直滚动的长列表、分支树折叠节点及表单输入框（如重命名分支、蓝图编辑）。

- **方案 B（`vaul` / `Radix Dialog`）的现实表现与上限**：
  - `@radix-ui/react-dialog` 本身**无任何手势拖拽能力**；手势拖拽依赖 `vaul`。
  - `vaul` 的核心逻辑（[src/index.tsx](https://github.com/emilkowalski/vaul/blob/main/src/index.tsx)、[src/constants.ts](https://github.com/emilkowalski/vaul/blob/main/src/constants.ts)、[src/helpers.ts](https://github.com/emilkowalski/vaul/blob/main/src/helpers.ts)）在 `pointermove` 阶段通过 `shouldDrag()` 沿 DOM 树向上爬检查 `scrollHeight > clientHeight && scrollTop !== 0`，在拖到顶部边界外时应用对数阻尼 `dampenValue(v) = 8 * (Math.log(v + 1) - 2)`，松手按 `VELOCITY_THRESHOLD = 0.4` 与 `CLOSE_THRESHOLD = 0.25` 决定关闭或回弹，并监听 `visualViewport.resize` 手动改写 `drawerRef.style.height/bottom`。
  - **局限**：因为把整套逻辑包裹在 `usePreventScroll` + `usePositionFixed` + `100ms scrollLockTimeout` 状态机内，内部嵌套可滚动列表与聚焦 `<input>` 时极易与 Android 软键盘高度变化及滚动容器产生手势抢占，且仓库已冻结维护。
- **方案 A（遵循 `modern-web-guidance` 的分层实现与上限）**：
  1. **左侧滑出抽屉**：直接采用 `modern-web-guidance`（`navigation-drawer`）推荐的 **原生 `<dialog>` + 水平 `scroll-snap-type: x mandatory` + `IntersectionObserver`** 模式（`scroll-timeline` 背景渐隐作 `@supports` 渐进增强，老 WebView 降级为固定半透遮罩或短 `scroll` 监听）。由于抽屉内列表是**纵向（`y`）滚动**而手势关闭是**横向（`x`）滑动**，两轴正交无冲突，可获得原生合成器 60/120fps 跟手与速度惯性，几乎无需手写拖拽状态机。
  2. **顶部/右上唤出的三合一底部 Sheet**：由于 Sheet 内部「剧情树 / 剧情回顾 / 故事蓝图」需要纵向滚动，**不建议**强行套用纯 CSS 纵向 `scroll-snap`（容易在 WebView <144 上与内部滚动容器发生 scroll chaining）。推荐在 `<dialog>.showModal()` 基础上编写一个 **~120–160 行的轻量 Pointer Events Hook**（遵循 `modern-web-guidance` `drag` 规范）：
     - 拖拽手柄（`grabber`）与顶部 Tab 标题栏声明 `touch-action: none` 并使用 `setPointerCapture(pointerId)`，保证手指拖拽绝不与内容区 `touch-action: pan-y` 冲突；
     - 内容滚动区仅在 `scrollTop <= 0` 且向下拖曳（`dy > 0`）时触发向 Sheet 关闭位移的平滑交接；
     - 拖拽过程中只更新 GPU 合成属性 `transform: translate3d(0, ${dy}px, 0)`（向上过拖施加 `dy / (1 + Math.abs(dy) * k)` 阻尼，配合 `requestAnimationFrame` 节流），松手按位移阈值（如 `> 30%` 面板高度）或下划速度（`> 0.4 px/ms`）执行平滑 CSS 曲线关闭或回弹（`@media (prefers-reduced-motion: reduce)` 下缩短或禁用位移动画）；
     - 同时监听 `<dialog>` 的 `cancel` 事件以无缝拦截桌面 `Esc` 与 Android 系统返回键/手势关闭 Sheet，而不是直接退出 App。
  - **UX 上限结论**：对于单/双停靠点（如 75%–88% dvh 半全屏切换）的文游工具型底部 Sheet，方案 A 的轻量手势实现可达到 **`vaul` 约 90%–95% 的物理跟手与阻尼质感**，同时彻底规避 `vaul` 的停维风险与 `body` 滚动锁死 Bug；仅当产品需要高德/Google Maps 式「内容区任意位置连续三段吸附联动」时才需要重型物理手势库，而本产品三合一 Sheet 并不存在该需求。

### 5. 与现有工程及 E2E 测试的维护成本

1. **与 `src/ui/styles.css` 的演进兼容**：
   - 本仓已有完善的语义 Token 命名习惯（[src/ui/styles.css#L1-L50](../../src/ui/styles.css#L1-L50)）。方案 A 可无痛拆分为 `src/ui/styles/tokens.css`（扩展纯净浅色 / 深邃炭黑 / 暖纸护眼三套主题与字号 Token）、`base.css`、`overlays.css` 与各组件局部样式。
   - 若切到方案 B，Tailwind v4 `@import "tailwindcss"` 会自动向 `@layer base` 注入 [preflight.css](https://tailwindcss.com/docs/preflight)（全局 `margin: 0; padding: 0; border: 0 solid` 与标题/列表样式重置），且 `@layer utilities` 的优先级**低于**未声明 `@layer` 的既有 `src/ui/styles.css` 选择器，渐进迁移极易发生样式层叠错乱，迫使一次性全量重写所有组件样式。
2. **与 `tests/e2e/run-e2e.mjs` 的契约衔接**：
   - [tests/e2e/run-e2e.mjs](../../tests/e2e/run-e2e.mjs) 除 `data-testid` 外，重度依赖稳定语义类（`.turn-card.assistant`、`.turn-card.user`、`.story-item`、`.choice-btn`、`.hud-panel`、`.error-banner`、`.main-stage > .error-banner`、`.reasoning-details`）。
   - 方案 A 中语义类名本身就是样式与结构契约，无需额外维护冗余类名；原生 `<dialog>` 也保持在原 React JSX 父节点内（浏览器通过 Top Layer 提升渲染层级，不改变 DOM 父子结构），不会破坏父子选择器与局部容器断言（相反，Radix `Dialog.Portal` 会将节点传送到 `document.body` 末尾）。
3. **与 `scripts/audit-artifacts.mjs` 的合规校验**：
   - 方案 A 不改动 `AndroidManifest.xml` 权限与原生桥接，产物仅静态 JS/CSS，天然通过 `audit-artifacts.mjs` 的所有安全与体积检查。

---

## 五、对地图 #36 后续原型与落地阶段的工程约束建议

在后续 `grilling` / `prototype` / 实现 Slice 中，建议将以下细则纳入规范基线：

1. **依赖准入清单**：仅引入 **`lucide-react`**（严格使用具名静态导入以保证 Vite 6 Tree-shaking），不引入 `vaul`、不引入 `@radix-ui/react-dialog`、不引入 `tailwindcss` / `@tailwindcss/vite`。
2. **Design Tokens 与颜色策略**：继续使用原生 CSS Custom Properties，基础色值采用 Hex / `rgb()` / `hsl()` 以保证 WebView 60–110 可用；若使用 `color-mix()` 做动态浅色高亮，需用 `@supports (color: color-mix(in srgb, red, blue))` 包裹并提供静态 Token 回退。
3. **Capacitor 8 Safe Area 必配项**：在后续 UI 重构落地前，补齐 `index.html` 的 `viewport-fit=cover`、`capacitor.config.ts` 的 `plugins.SystemBars.insetsHandling`（建议 `'css'` 或 `'native'`），所有顶栏、底部输入区、侧栏与底部 Sheet 的内边距统一使用 `env(safe-area-inset-*, var(--safe-area-inset-*, 0px))` 兼容 WebView `< 140`；全屏高度容器统一补齐 `min-height: 100vh; min-height: 100dvh;` 双行声明。
4. **Native `<dialog>` 统一封装**：封装一个 `<ModalSheet>` / `<SideDrawer>` 基础原语（复用原生 `<dialog>.showModal()`）：
   - 统一注入 `closedby="any"` + `HTMLDialogElement.prototype` 缺失时的 `pointerdown`/`pointerup` 外区点击回退；
   - 统一应用 `dialog:modal` 与 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }`；
   - 统一接入 `@starting-style` 入场 + `data-closing` / `getAnimations()` 退场动画，以及 `@media (prefers-reduced-motion: reduce)` 降级。
5. **E2E 契约保护**：重构组件时保留现有 `data-testid`、`#turn-input` / `#cfg-api-key` 等关键 ID 与测试依赖的语义类名（或同步以纯 `data-testid` 迁出 CSS 类耦合），确保 `npm run test:e2e` 与 `npm run verify:all` 全绿。

---

## 六、主要参考一手信源

- 仓库现状：[package.json](../../package.json)、[package-lock.json](../../package-lock.json)、[vite.config.ts](../../vite.config.ts)、[capacitor.config.ts](../../capacitor.config.ts)、[index.html](../../index.html)、[android/variables.gradle](../../android/variables.gradle)、[android/app/build.gradle](../../android/app/build.gradle)、[android/app/src/main/AndroidManifest.xml](../../android/app/src/main/AndroidManifest.xml)、[scripts/audit-artifacts.mjs](../../scripts/audit-artifacts.mjs)、[tests/e2e/run-e2e.mjs](../../tests/e2e/run-e2e.mjs)、[src/ui/styles.css](../../src/ui/styles.css)
- Tailwind CSS v4 官方文档：[Browser Compatibility](https://tailwindcss.com/docs/compatibility)、[Preflight](https://tailwindcss.com/docs/preflight)、[Adding Custom Styles](https://tailwindcss.com/docs/adding-custom-styles)、[`tailwindcss@4.3.5`](https://registry.npmjs.org/tailwindcss/4.3.5)、[`@tailwindcss/vite@4.3.5`](https://registry.npmjs.org/@tailwindcss/vite/4.3.5)
- Vaul 与 Radix 官方仓库及 npm 包：[emilkowalski/vaul README（commit `3e97aac`）](https://github.com/emilkowalski/vaul/blob/main/README.md)、[vaul `src/index.tsx`](https://github.com/emilkowalski/vaul/blob/main/src/index.tsx)、[vaul `src/helpers.ts`](https://github.com/emilkowalski/vaul/blob/main/src/helpers.ts)、[radix-ui/primitives](https://github.com/radix-ui/primitives)、[`@radix-ui/react-dialog@1.3.1`](https://registry.npmjs.org/@radix-ui/react-dialog/1.3.1)、[`lucide-react@1.75.0`](https://registry.npmjs.org/lucide-react/1.75.0)
- Capacitor 8 & Android WebView 官方文档：[Capacitor Android Documentation](https://capacitorjs.com/docs/android)、[Capacitor SystemBars API（v8）](https://capacitorjs.com/docs/apis/system-bars)、[Updating to Capacitor 8.0](https://capacitorjs.com/docs/v8/updating/8-0)、[Android WebView Overview](https://developer.android.com/develop/ui/views/layout/webapps/webview)、[Manage WebView objects](https://developer.android.com/develop/ui/views/layout/webapps/managing-webview)
- 浏览器兼容数据与现代 Web 指南：[mdn/browser-compat-data](https://github.com/mdn/browser-compat-data)（`dialog`、`HTMLElement.popover`、`@starting-style`、`overscroll-behavior`、`dvh`、`@layer`、`@property`、`oklch`、`color-mix`）、`modern-web-guidance`（`dialog`、`light-dismiss-a-dialog`、`prevent-page-scroll-under-modal-dialog`、`animate-to-from-top-layer`、`navigation-drawer`、`drag`、`form-factor-adaptation`）
