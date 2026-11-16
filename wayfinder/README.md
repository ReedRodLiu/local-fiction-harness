# Wayfinder 本地 Markdown 记录方式

当前没有为本项目指定外部 issue tracker，因此按 Wayfinder 的本地 Markdown tracker 方式记录。

- [map.md](map.md) 是唯一开发地图；开放票据保存在 `tickets/`，不在地图中重复列举。
- 每张票据用 front matter 标明 `type`、`status`、父地图和依赖关系；`blocks` / `blocked_by` 表示先后关系。
- 票据用 `## Question` 表达要解开的判断，用 `## Acceptance` 记录需要留下的证据。完成时在票据中追加 `## Resolution`，再将结论链接补入地图的 Decisions so far。
- 类型采用 Wayfinder 定义的 `research`、`prototype`、`grilling`、`task`。
