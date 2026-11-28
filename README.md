# Folio 文游框架

Folio 是一款本地优先的 AI 文游与写作客户端，面向希望导入剧本、延续长对话、管理角色互动和整理故事正文的玩家。当前包含 Android 客户端源码，也可在桌面浏览器中运行开发版。

Folio 不运行自建模型中转或业务服务器。用户在客户端配置自己的模型 API Key，由客户端直接向所选模型服务发送请求；模型服务会收到本轮请求所需的提示词和对话内容。故事、角色资料和本地记录保存在设备上。

## 下载与安装

仓库已开源。GitHub Releases 提供源码归档与签名 Android APK；请从 Release 页面下载与你设备匹配的 APK，并按 Android 系统提示允许安装来源。

- [Folio V0.5.1 Release](releases/tag/v0.5.1)
- [全部 Releases](releases)

Android 最低版本设为 Android 7.0（API 24），当前构建目标为 Android API 36。Release 附带 APK 后，按 Android 系统提示允许本次安装来源，再打开 Folio。首次使用需要在应用设置中填写你自己的模型 API Key；模型调用费用由你与模型服务商之间的账户承担。

安装新版或更换设备前，建议先在应用中导出 `.folio.json` 备份。V0.2 会将 V0.1 的本地资料静默迁移到新数据结构；备份仍是更换设备或处理异常时最稳妥的恢复方式。API Key 不会包含在 `.folio.json` 备份中。

## 功能概览

- **文游**：导入已有剧本和对话，继续推进剧情，并管理作品与分支。
- **写故事**：围绕作品资料和正文进行讨论、续写与改写；V0.2 支持先查看文本变更，再选择采纳或撤销。
- **角色互动**：管理角色资料和独立对话；支持本人聊天与扮演对戏。
- **导入与备份**：导入剧本文件或 DeepSeek 对话导出；使用 `.folio.json` 导出或恢复本地资料。
- **长对话管理**：按分支组织对话，并使用滚动摘要控制长期上下文。
- **本地优先**：故事、对话、角色资料和记忆保存在设备端；客户端不代管模型账户或 API Key。

## 版本说明

当前稳定版本为 **V0.5.1**。版本历史与详细变更请见：

- [CHANGELOG.md](CHANGELOG.md)
- [docs/releases/](docs/releases/)

## 本地开发

需要 Node.js 22 或更新版本。Android 构建还需要 Android SDK、JDK 17 和本项目的 Gradle Wrapper。

```bash
npm ci
npm run dev
```

打开 Vite 提示的本地地址后，在应用设置中填写你自己的模型 API Key，即可开始使用。开发时请不要把 API Key 写入仓库或提交到 Git。

构建网页资源：

```bash
npm run build
```

构建 Android 调试版：

```bash
npm run android:build
```

`npm run android:build` 会同步网页资源、运行 Android 单元测试并生成调试 APK。面向用户分发时，请使用已发布的签名 APK；当前 Release 页面提供源码归档与签名 Android APK。签名私钥和密码只应保存在本地，不要提交到仓库。

## 项目文档

- [术语表](GLOSSARY.md)：产品与架构术语。
- [架构概览](docs/architecture.md)：模块边界、数据流与运行时边界。
- [故障排查](docs/troubleshooting.md)：环境、构建、签名与常见错误。
- [三种模式验收流程](docs/three-mode-acceptance.md)：主要交互流程和手工验收场景。
- [界面设计规范](docs/ui-design-system.md)：界面结构、设计令牌与实现约定。
- [架构决策记录](docs/adr/)：已经确认的关键技术决策。
- [Wayfinder 开发地图](wayfinder/map.md)：调研、开发路线与待办事项。

## 数据与费用提示

Folio 是客户端工具。配置 API Key 后，模型请求会发送到你选择的服务商；请检查服务商的隐私政策、计费方式和数据处理规则。导出的 `.folio.json` 不包含 API Key，但可能包含你保存的故事、角色资料和对话，请按包含个人内容的文件妥善保管。


## 文档导航

### 用户
- [README](README.md)：项目介绍、安装与基础开发
- [CHANGELOG.md](CHANGELOG.md)：版本历史
- [docs/releases/](docs/releases/)：发布说明

### 贡献者
- [CONTRIBUTING.md](CONTRIBUTING.md)：开发与 PR 流程
- [GLOSSARY.md](GLOSSARY.md)：术语
- [docs/architecture.md](docs/architecture.md)：架构概览
- [docs/ui-design-system.md](docs/ui-design-system.md)：界面设计规范
- [docs/three-mode-acceptance.md](docs/three-mode-acceptance.md)：验收流程
- [docs/adr/](docs/adr/)：架构决策

### 维护者
- [docs/troubleshooting.md](docs/troubleshooting.md)：故障排查
- [SECURITY.md](SECURITY.md)：安全政策


## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commands, and pull request expectations.

## Environment variables

Copy `.env.example` to `.env.local` for local-only test credentials. Never commit `.env.local` or real keys.

## Testing

```bash
npm test
npm run test:e2e
npm run audit:ui
npm run audit:version
```

## Releasing

Release notes are published under `docs/releases/`.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
