# Android 真机 LLM + ADB E2E / Smoke 测试与三包隔离 Runbook

本手册面向 Folio（`local-fiction-harness`）在 Android 真机（Android 14–16）上的自动化回归与发版前真模型冒烟，对应 Spec `#170` 与矩阵 `#157`。

---

## 1. 三包变体构建与安装隔离

Android 工程在 `android/app/build.gradle` 中配置了三个相互隔离的构建变体，可同时安装在同一台测试机上互不干扰：

| 变体 | `applicationId` | WebView 调试 | 回环明文 (`127.0.0.1`) | 构建命令 |
| --- | --- | --- | --- | --- |
| `release` | `io.localfiction.harness` | 禁止 (`ALLOW_WEBVIEW_DEBUGGING=false`) | 禁止 | `npm run android:build:release` |
| `e2e` | `io.localfiction.harness.e2e` | 开启 | 仅允许 `127.0.0.1` / `localhost` | `npm run android:build:e2e` |
| `smoke` | `io.localfiction.harness.smoke` | 开启 | 禁止（与正式包同级） | `npm run android:build:smoke` |

安装示例（先确认 `adb devices` 仅连接一台设备，或使用 `-s <serial>`）：

```bash
adb install -r -t android/app/build/outputs/apk/e2e/app-e2e.apk
adb install -r -t android/app/build/outputs/apk/smoke/app-smoke.apk
```

---

## 2. 真机前置条件

1. 开启开发者选项与 USB 调试（优先 USB 连接 ADB）。
2. 关闭外接物理键盘，确保点击输入框能正常弹出虚拟软键盘（用于 `E2E-05` `visualViewport` 检查）。
3. 锁屏状态说明：
   - 推荐将测试机设为「无密码 / 滑动解锁」，以运行完整的 `E2E-06B`（`KEYCODE_POWER` 息屏 30–60s SSE 保活）。
   - 若设备开启了 PIN / 密码 / 生物锁屏，编排器会自动检测并显式将 `E2E-06B` 标记为 `SKIPPED_LOCKSCREEN_PROTECTED`（严禁静默伪造通过）。
4. `.smoke` 前置说明：请由操作者**亲自在手机端**打开 `io.localfiction.harness.smoke` 连接真实 DeepSeek API Key；如需测试 `SMK-06`，再额外配置一个第三方非 DeepSeek 服务商档案。

---

## 3. 运行 `.e2e`、`--dry-run` 与 `.smoke`

### 无真机 Dry-Run（本地全流程编排验证）

```bash
node scripts/android-e2e.mjs --dry-run
node scripts/android-smoke.mjs --dry-run
```

### 真机运行 `.e2e` 离线全量回归（`E2E-01` ~ `E2E-07`）

```bash
npm run test:android-e2e -- --serial <DEVICE_SERIAL>
# 可选参数：
#   --apk android/app/build/outputs/apk/e2e/app-e2e.apk   安装指定 APK
#   --record                                               全场景开启 screenrecord 录制
#   --only E2E-01,E2E-05                                   仅执行指定场景
#   --label nightly                                        自定义产物目录标签
```

说明：
- 编排器会在宿主机启动 `MockSseServer` 并自动通过 `adb reverse` 映射至测试机回环端口。
- `E2E-03`、`E2E-05`、`E2E-06A`、`E2E-06B` 默认启用限时 `screenrecord`（`PASS` 自动删除视频，`FAIL` 自动拉取保存）。
- 单步 DOM 超时 5s，软键盘/Launcher/冷启 8–10s，后台恢复收尾 15s；任何硬断言失败立即落盘并判 `FAIL`（零静默重试）。
- 每次运行结束都会强制生成 `llm-review-input.json` 与 `llm-review-output.json`（无跳过开关，严格执行 Hard Gate 校验）。

### 真机运行 `.smoke` 真模型冒烟（`SMK-01` ~ `SMK-06`）

```bash
npm run test:android-smoke -- --serial <DEVICE_SERIAL>
# 可选参数：
#   --keep-stories    保留本次创建的 [SMK-TEST] 临时故事/作品/角色，便于人工复核
#   --record          全场景录制 screenrecord
#   --only SMK-01     仅运行指定冒烟场景
```

### `.smoke` 安全红线（强制硬约束）

1. **严禁**对 `io.localfiction.harness.smoke` 执行 `pm clear`。
2. **严禁**通过 CDP 调用 `NativeVault.loadApiKey()` / `saveApiKey()` / `clearApiKey()` / `loadMeta()`。
3. **严禁**在设置页密钥向导或 `#byok-api-key` 可见时截图。
4. 测试结束（无论 PASS 或 FAIL）默认仅按本次新建实体 ID（`storyIds` / `workIds` / `characterIds`）精准清理，绝不触碰用户原有存档；传入 `--keep-stories` 可跳过清理。

---

## 4. 多源产物目录布局

每次运行在 `android/captures/<suite>-<runId>/` 下生成标准化产物：

```text
android/captures/e2e-<runId>/
  run.json                        # 设备元信息、clockSync、各场景汇总
  timeline.jsonl                  # 按 clockOffsetMs 对齐合并的 7 源统一时间轴
  llm-review-input.json           # 经二次正则隐私扫描的送审输入
  llm-review-output.json          # 经 Hard Gate 校验器锁定的评审结论
  scenarios/
    <SCENARIO_ID>/
      assertions.json             # 全部硬断言记录与 hardOutcome
      logcat.txt                  # 按 PID 与时间窗过滤的 logcat 片段
      console.jsonl               # CDP Console / Lifecycle 事件
      diagnostic-bundle.json      # 免分享窗提取的脱敏诊断包
      steps/*.png|dom.json|ui.xml|activity.txt
      failure.png|dom.json|ui.xml|activity.txt  # 仅 FAIL 时生成
      screenrecord.mp4                          # 仅 FAIL 时拉取保留
```

---

## 5. LLM Hard Gate 评审工作流

1. **二次脱敏扫描**：`buildLlmReviewInput` 在送审前扫描 `llm-review-input.json` 及全部文本产物，拦截 `sk-*`、`Bearer`、非空敏感字段及密钥向导标记。
2. **Hard Gate 一票否决**：`validateLlmReviewOutput` 强制校验：
   - 只要任一场景 `hardOutcome === 'FAIL'`，`overallHardGate` 必须为 `FAIL` 且 `llmReviewVerdict` 必须为 `CONFIRMED_FAIL`（禁止 Fail-to-Pass 翻盘）。
   - 全部未失败时，LLM 视觉检查仅可从 `CONFIRMED_PASS` 降级为 `NEEDS_HUMAN_REVIEW`（`VISUAL_WARNING_NEEDS_REVIEW`）。
   - `SKIPPED_*` 场景必须对应 `SKIPPED_ACKNOWLEDGED`，不得计入 `CONFIRMED_PASS`。
   - 每条 `evidenceCitations[].artifactPath` 必须真实存在于本次产物目录内，严禁虚构路径。

---

## 6. 审计与全量验证

```bash
npm run audit:artifacts
npm run verify:all
```
