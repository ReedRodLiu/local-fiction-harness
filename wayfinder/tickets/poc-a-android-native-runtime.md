---
kind: wayfinder-ticket
type: task
status: open
parent: map
blocked_by: []
blocks:
  - poc-b-fiction-runtime-footprint
---

# POC-A：Android 原生运行 DSH 是否满足文游闭环？

## Question

能否在不依赖 Root、Termux、Ubuntu/PRoot、电脑或项目方服务器的 Android App 中运行选定版本的 DSH，并完成一次最小文游对话？“应用内运行”所需的实际进程边界是什么？

## Work

- 先核实官方 DSH SDK 的当前接口、版本和构建方式；确认 `sdk-minimal` 是可用 Profile，还是仅为历史设计记录。
- 用最小原生 Android 宿主验证启动、用户配置的模型 API 流式请求、剧本上下文传入和本地保存/恢复。
- 记录 DSH 运行在主进程、应用子进程还是其他机制中，并列出其可执行能力；文游原型不得暴露 Shell、任意脚本或不必要权限。
- 固定源码提交、构建环境、依赖清单和许可证证据；记录真实 APK/安装体积、冷启动时间和内存占用。

## Acceptance

- 原型可在至少一台明确记录型号和 Android 版本的实体设备上独立运行，不需要电脑、Root、容器或项目方后端。
- 能完成脚本上下文导入、模型流式回复、故事落盘，并在强制结束 App 后恢复故事。
- 附上可重复的构建/运行说明、进程边界、依赖与许可证清单及设备实测数据。
- 对不能满足的安全、运行时或许可证条件明确标记阻塞，不把上游应用的能力当作已满足。

## Risks

- DSH 目标运行时可能不能作为移动应用内组件分发；手机可运行 CLI 不等于适合 App 内嵌。
- 上游完整 Agent 环境可能带入产品不需要的 Shell、插件或原生依赖。
- 先前讨论的最小 Profile、官方 SDK API 和实际许可闭包尚未确认。
