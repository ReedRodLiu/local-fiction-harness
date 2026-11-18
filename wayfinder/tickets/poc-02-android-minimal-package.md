---
kind: wayfinder-ticket
type: task
status: open
parent: map
blocked_by:
  - poc-01-local-web-fiction-harness
blocks: []
---

# POC-02 / Spec：安卓构建环境配置与 Web + Android APK 统一双端架构

> 完整规范已同步发布并覆盖更新至 GitHub Issue `#3`（标签：`wayfinder:task`、`ready-for-agent`），本文件保留为仓库内索引指针以与 GitHub Tracker 保持一致。

## 核心目标

1. 在本机完成纯命令行最小 Android 构建环境配置（JDK 21 + Android SDK Command-Line Tools，不安装 Android Studio 与模拟器镜像）。
2. 基于 Capacitor 建立 Web 与 Android 共享同一套 `src/harness/` + `src/ui/` 源码的统一构建架构，通过单一顶层 `PlatformRuntime` 接缝隔离网络流式请求（自研轻量原生分块桥接，避开 `CapacitorHttp` 缓冲限制）、API Key 原生加密存储、App 私有目录故事持久化及原生备份导出。
3. 支持在无实时手机连接的情况下通过契约测试、Web E2E、Android JVM 测试及离线 `assembleDebug` 验证每次提交；在最终实测阶段接入 Android 真机完成一次性端到端验收。
