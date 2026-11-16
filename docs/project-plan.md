# 项目方案：本地优先 AI 文游

## 项目方向

先服务于希望继续游玩 AI 文游的手机用户，尤其是已有剧本、角色设定和长对话存档的玩家。DeepSeek 免费端限额带来的迁移需求是切入机会；产品长期价值仍需通过用户验证。

产品按反馈分三阶段演进：

1. **文游播放器**：导入剧本和历史存档，继续演绎故事，支持独立故事、流式回复、本地存档、重写回溯、基础剧情记忆和 API 配置。
2. **文游 Harness**：强化长上下文管理、长期记忆、角色一致性、文风控制、剧情分支和世界状态。
3. **文游游戏引擎**：探索自然语言规则、数值结算、事件系统、创作者工具和剧本生态。只有前两阶段得到正向反馈后再立项。

## 用户体验与运营边界

- 做独立手机 App，不要求玩家先安装电脑客户端，也不让手机依赖用户电脑。
- 采用本地优先方式：剧本、剧情、存档和记忆保存在设备；API Key 使用系统安全存储能力。
- 用户直接配置模型服务商并从 App 连接其 API。项目方不自建业务服务器、不托管用户数据、不代付模型费用。
- 这条路线不绕过 DeepSeek 网页端限额，也不承诺免费模型调用；用户是否愿意配置 API Key 并直接承担费用，需要尽早验证。
- 以 Android 和 iOS 应用商店兼容为目标。实际商店审核、各系统运行限制和可支持设备范围仍需验证。
- 保持轻量和最小权限：不采用 Ubuntu/PRoot，不开放任意 Shell 或动态代码执行；不把完整桌面智能体能力带入文游产品。

## 技术路线

DeepSeek Harness（DSH）是候选运行底座，先检查官方 SDK 与最小 Profile 的当前状态，再验证能否在手机 App 中承担流式对话、会话和本地存储。Android 方向优先验证原生打包及必要的运行时裁剪；iOS 方向并行验证进程内运行及系统政策约束。两端能否共用同一运行方式尚未确定。

当前源码核对显示，官方 DSH 仓库声明 MIT 许可证；Android 移植项目 `v1.5.0-beta.22` 对应提交 `b5266d866124132b176fbf392c45100fcdb48efc` 也有 MIT 许可证。该版本说明其 DSH 引擎固定在 `0.2.2-rc.1`，Android 项目提供完整的 Bionic Node.js 运行环境及服务能力；官方发布物标注完整 APK 约 156 MB，免运行时 APK 约 29 MB，后者还需下载运行时。这些是上游发布信息，不代表本项目的实测结果或体积目标。

上述 MIT 声明只确认对应仓库/版本的主许可证，不能替代对每个依赖、预编译组件、插件和资源的清点。Android 移植项目包含独立 `NOTICE`，并列出部分第三方代码与资源边界；本项目目前只把它作为技术参考，不复制其应用代码、资源或完整工具环境。DeepSeek Harness 的精确依赖闭包、可用 SDK 形态和先前提到的 `sdk-minimal` 是否为当前可直接使用的 Profile，仍需在 POC 中确认。上游源码中出现过 `sdk-minimal` 相关归档设计记录，但这不能证明该 Profile 仍作为可发行能力存在。

## 首批验证与后续门槛

Wayfinder 地图首批只安排三个验证：Android 原生运行、Android 文游运行时裁剪、iOS 进程内运行。每项都要记录所用源码版本、依赖及许可证、实际安装包和运行数据、阻塞点与可复核步骤。验证不能证明可行时，暂停扩大开发并重新选择技术路线。

三个 POC 得到结论后，再确定 MVP 的设备范围、可接受安装体积和启动/内存指标，验证 BYOK 的配置门槛，并开展目标用户测试。应用商店政策、API Key 隐私安全、剧本和角色内容权利、第三方许可证闭包以及商业模式均是继续投入前必须解决的问题。

## 上游资料

- [DeepSeek Harness 仓库与 MIT 许可证](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Mobile v1.5.0-beta.22 发布说明](https://github.com/Soodok/Deepseek-Harness-Local-Android/releases/tag/v1.5.0-beta.22)
- [该版本对应提交的 LICENSE](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/b5266d866124132b176fbf392c45100fcdb48efc/LICENSE)
- [该版本对应提交的 NOTICE](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/b5266d866124132b176fbf392c45100fcdb48efc/NOTICE)
- [该版本 Android 依赖声明](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/b5266d866124132b176fbf392c45100fcdb48efc/app/build.gradle.kts)
- [该版本英文说明](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/b5266d866124132b176fbf392c45100fcdb48efc/README_EN.md)
