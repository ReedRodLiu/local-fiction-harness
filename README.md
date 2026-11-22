# Folio 文游框架

Folio 是一款本地优先的 AI 文游与写作客户端，面向希望导入剧本、延续长对话、管理角色互动和整理故事正文的玩家。当前提供 Android 安装包，也可在桌面浏览器中运行开发版。

Folio 不运行自建模型中转或业务服务器。用户在客户端配置自己的模型 API Key，由客户端直接向所选模型服务发送请求；模型服务会收到本轮请求所需的提示词和对话内容。故事、角色资料和本地记录保存在设备上。

## 下载与安装

仓库目前为私有仓库，GitHub Release 仅对获授权的仓库成员开放。安装包和每版变更记录见：

- [Folio V0.2.0 Release](https://github.com/ReedRodLiu/local-fiction-harness/releases/tag/v0.2.0)
- [Folio V0.1.0 Release](https://github.com/ReedRodLiu/local-fiction-harness/releases/tag/v0.1.0)

Android 最低版本设为 Android 7.0（API 24），当前构建目标为 Android API 36。下载 Release 中的 APK 后，按 Android 系统提示允许本次安装来源，再打开 Folio。首次使用需要在应用设置中填写你自己的模型 API Key；模型调用费用由你与模型服务商之间的账户承担。

安装新版或更换设备前，建议先在应用中导出 `.folio.json` 备份。V0.2 会将 V0.1 的本地资料静默迁移到新数据结构；备份仍是更换设备或处理异常时最稳妥的恢复方式。API Key 不会包含在 `.folio.json` 备份中。

## 功能概览

- **文游**：导入已有剧本和对话，继续推进剧情，并管理作品与分支。
- **写故事**：围绕作品资料和正文进行讨论、续写与改写；V0.2 支持先查看文本变更，再选择采纳或撤销。
- **角色互动**：管理角色资料和独立对话；支持本人聊天与扮演对戏。
- **导入与备份**：导入剧本文件或 DeepSeek 对话导出；使用 `.folio.json` 导出或恢复本地资料。
- **长对话管理**：按分支组织对话，并使用滚动摘要控制长期上下文。
- **本地优先**：故事、对话、角色资料和记忆保存在设备端；客户端不代管模型账户或 API Key。

## 版本说明

### V0.2.0

- 统一三种模式的入口和创作工作区，支持自然语言意图分流。
- 增加 `.folio.json` v3 全量备份、旧版备份导入和 V0.1 → V0.2 静默迁移。
- 增加写故事正文建议卡片、差异预览、确认写入、自动保存和撤销。
- 增加安全的 Markdown 展示、流式提案降级处理和更温和的错误提示。
- 改进 DeepSeek 对话导入、隐私诊断包和跨模式滚动摘要。

### V0.1.0

- 首个 Folio 试用版本，提供文游、写故事和角色互动三种模式。
- 支持导入剧本与 DeepSeek 对话、管理本地作品、配置 DeepSeek API Key 和继续对话。
- 提供本地保存、对话分支和基础长上下文整理能力。

完整记录见 [CHANGELOG.md](CHANGELOG.md)。

## 本地开发

需要 Node.js 22 或更新版本。Android 构建还需要 Android SDK、JDK 17 和本项目的 Gradle Wrapper。

```bash
npm ci
npm run dev
```

构建网页资源：

```bash
npm run build
```

构建 Android 调试版：

```bash
npm run android:build
```

`npm run android:build` 会同步网页资源、运行 Android 单元测试并生成调试 APK。面向用户分发时，请使用 Release 页面提供的正式构建；签名私钥和密码只应保存在本地，不要提交到仓库。

## 项目文档

- [项目方案](docs/project-plan.md)：产品方向、技术路线与范围边界。
- [术语表](GLOSSARY.md)：产品与架构术语。
- [三种模式验收流程](docs/three-mode-acceptance.md)：主要交互流程和手工验收场景。
- [界面设计规范](docs/ui-design-system.md)：界面结构、设计令牌与实现约定。
- [架构决策记录](docs/adr/)：已经确认的关键技术决策。
- [Wayfinder 开发地图](wayfinder/map.md)：调研、开发路线与待办事项。

## 数据与费用提示

Folio 是客户端工具。配置 API Key 后，模型请求会发送到你选择的服务商；请检查服务商的隐私政策、计费方式和数据处理规则。导出的 `.folio.json` 不包含 API Key，但可能包含你保存的故事、角色资料和对话，请按包含个人内容的文件妥善保管。
