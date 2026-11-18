---
kind: wayfinder-map
label: wayfinder:map
status: active
---

# 本地优先 AI 文游开发地图

## Destination

跑通“自研轻量文游 Harness + 本地存储”的最小实现与双端统一架构，并在此基础上打通 DeepSeek 网页端导出包迁移（筛选勾选、剧本与进度/分支树还原）与文游专属剧情树体验，为下一阶段 MVP 与真实玩家测试提供可用版本。

## Notes

- 已调整的产品路线和边界见[项目方案](../docs/project-plan.md)；核心领域词汇见[术语表](../GLOSSARY.md)；架构决策见 `docs/adr/0001`–`0008`。
- 彻底放弃 DSH（DeepSeek Harness）运行底座及微信小程序载体；核心文游 Harness 保持纯客户端逻辑与本地存储，不依赖桌面客户端、项目方业务服务器或云端模型代理。
- 坚持单仓共享 `src/harness/` 与 `src/ui/` 同步产出 Web 与 Android APK；未实测的体积、性能、内存与兼容性指标不写作既定指标。
- 开发机构建可使用前端工具链，但不得将 Node.js、Ubuntu/PRoot 或任意 Shell 能力打包分发给终端用户。

## Decisions so far

- 已决定彻底放弃 DSH 底座，转向自研轻量文游 Harness 与本地存储（见 `docs/adr/0001`–`0003`）。
- [POC-01 (#2)](https://github.com/ReedRodLiu/local-fiction-harness/issues/2)：已验证并关闭。完成纯 TS 核心 + 本地网页闭环与双轴加固（`7c79ef8`）。
- [POC-02 (#3)](https://github.com/ReedRodLiu/local-fiction-harness/issues/3)：已验证并关闭（`docs/adr/0004`–`0005`、`d3f4bc0`）。通过 Capacitor + `PlatformRuntime` 实现单仓 Web 与 Android APK（4.14 MB）同步交付，并在真机（Android 16）实测通过。
- [DeepSeek 导出包迁移与聚焦主干剧情树（#18）](https://github.com/ReedRodLiu/local-fiction-harness/issues/18)：`#19`–`#23` 全部子票据已完成实现、双轴审查与双端离线校验（`npm run verify:all` 通过，Debug APK 4.15 MB），待真机插线终验后关闭。
- **DeepSeek 导出包按需导入与迁移（`docs/adr/0006`）**：支持 `export_format_version: 3` ZIP 两阶段按需解压，本地启发式预筛置顶 + 复选框多选（可选模型二次筛选），每条选中外部会话 1 对 1 转化为独立 `Story`，按需抽取所引 `.docx`/`.md`/`.txt` 附件（忽略图片/PDF，旧 `.doc` 提示另存为 `.docx`），清洗平台噪音并保留只读 `Node Diagnostics`，用「本地强信号直判 + 模糊开局轻量 LLM 定位」自动识别 `Raw Script`，仅对当前激活线即时补算 `Plot Summary`（历史分支惰性压缩）。
- **聚焦主干的竖向剧情树（`docs/adr/0007`）**：重构分支交互为竖向轨道**剧情树（Story Tree）**，默认展示起点至当前激活分支路径（自动折叠连续无分叉轮次，在历史分叉路口显示 `⑂ N` 徽标），点开路口再按需展示本地规则抽取的进展线索及可选 AI 梗概，统一服务日常游玩与 DeepSeek 导入。
- **零正文本地脱敏诊断导出与 Harness 上下文可靠性加固（`docs/adr/0008`）**：引入近 30 分钟本地防崩溃循环日志缓冲、设置导出与全局崩溃弹窗，预览确认后本地导出不含正文/密钥的**脱敏诊断包**（可选去正文树骨架、官方白名单域名与中转域名短哈希，预留未来只写 HTTP 上报接缝）；同步修补生成前分段补算摘要、`Setup Node` 去重防双倍注入及摘要/重命名并发锁死。

## Not yet specified

- DeepSeek 官方 API（`api.deepseek.com`）与兼容端点在剧本拆解、文风遵循与浏览器直连 CORS 上的具体差异（见 `#4`）。
- 长期运行下不同长度与密度剧本的最佳上下文 Token 预算配比及摘要压缩提示词的体验调优基线（见 `#4`）。
- Android 最小封包在低版本 Android / WebView 机型上的兼容性覆盖表现。
- 目标玩家的 Android/iOS 设备占比、BYOK 上手流失率、工具付费意愿，以及后续是否及何时补做 iOS 端（见 `#5`）。
- 面向公众公开发行前的 AI 内容标识、拟人化互动边界、用户自导剧本权属提示，以及用户提出后续想探讨的“风控误杀应对与开发方责任/条款合规边界”法律可行性评估（见 `#5`）。

## Out of scope

- 放弃基于 DSH（DeepSeek Harness、`@deepseek-ai/dsh-sdk-minimal`、DSH Go、DSH Mobile）的移植、裁剪与运行底座；不做微信小程序版本。
- 本轮不做业务后端、用户数据托管、云端模型代理转发、账号体系或需要连接电脑客户端的方案。
- 本轮不做多外部会话自动拼接合并为单一故事、旧版二进制 `.doc` 解析，以及任何用于绕过/规避第三方模型安全审核的插件或机制。
- 本轮不启动 iOS 原生适配、完整数值游戏引擎、创作者工作台或剧本交易市场。
