# AI 写作工具如何引用设定并让作者采纳建议

2026 年 11 月 20 日 · Wayfinder #52

## 结论

一句灵感可以直接发给 DeepSeek，作者再从回复中选取文字，带到自己的文档里。Sudowrite 的 First Draft 也接受一句灵感，直接在空白文稿中写入初稿。后续续写和修订有单独的采纳动作：Write 先给候选卡，再由作者插入。Quick Edit 在原处对照修改，作者可以接受或拒绝。对已有设定的短篇，最值得讨论的是持续引用经过作者确认的材料，并让作者保留一份能自己改、能单独带走的正文。 [DeepSeek 官方手机展示](https://www.deepseek.com/zh/download/) · [Sudowrite First Draft][first] · [Write][write] · [Quick Edit][quick] · [正文导出][export]

本仓已有剧本全文锚定、当前分支的剧情上下文、流式生成和本机存档。实际差距在作者操作正文的环节：成功生成的回复直接成为存档节点，现有编辑操作针对玩家输入。要让作者挑用一段、自己补写并导出短篇，需要明确哪些文字属于成稿。 [回合存档与激活](../../src/harness/harness.ts#L447) · [回合卡交互](../../src/ui/TurnCard.tsx#L70) · [现有导出](../../src/ui/App.tsx#L883)

## 两个案例共用的任务

两例分别选用 DeepSeek 官方网页及手机聊天作为通用聊天基线、Sudowrite 网页文稿和官方手机文档作为写作工具。证据标为**官方文档**、**官方展示**或**本仓源码**。以下是按证据推演的走法，未登录、购买、上传或发送样本，未实测生成、手机操作或实际导出文件。

| 任务 | 给作者的材料与目标 |
| --- | --- |
| A · 一句灵感，原创角色（OC）短篇 | 「停航三年的渡口重新亮灯时，三年不曾相见的两人同时赶来。」只给这一句，先得到可用开头。名字、关系及重逢缘由由作者决定，可以在写出第一段后再补。 |
| B · 有设定起步，虚构原作《回潮信局》的同人短篇 | 同一个渡口重逢题材，给足这场戏所需的两张人物档案、地点、背景和不可改动的原作事实，见下。先写小说正文，再用补充材料继续这场戏。 |

**任务 B 的完整样本。** 林汐，29 岁，渡口修灯员，擅长辨听继电器故障，说话简短。停航后一直守灯，想让旧搭档闻鹭替她读出三年前没能送走的信，怕被当成挽留。闻鹭，31 岁，前夜班信差，已离岛三年，说话习惯先问后答。她带着一封从未拆封的信回来，想把它交还林汐，又怕再被要求留下。两人曾搭档值夜，停航那一晚没有道别。地点是涨潮港旧渡口，潮声遮住脚步，检修灯亮起只表示恢复供电，旧候船室可供两人躲雨。**不得改动的原作事实是旧渡船「回潮号」三年前已经永久拆解。** 灯亮只表示通电，拆解事实适用于故事当下的所有续写方向。整组人物与原作均为研究虚构样本。

**共用检查动作。** 写一段中文开头，再补一条资料「候船室只剩一把椅子」，让 AI 给出两个承接方向或段落。作者只选其中一部分，改写一句对话、亲手补两句，保存一篇约 500 字的单场景短篇。重新打开后核对作者改写是否保留，拿出一份能在别处编辑的文本。任务 B 额外核对正文有没有让「回潮号」在故事当下重新驶回港里，或改变它已被拆解的事实。500 字是作者整理后的目标，生成长度和用时没有量测。

## DeepSeek 官方聊天

- **任务 A。** 在新对话发出灵感并明确要一段中文开头，随后把椅子的细节和想要的承接方向发成下一条消息。手机官方宣传图的回复菜单可见「复制」「选择文本」「重新生成」。这为把中意的句段带入外部编辑器提供了操作依据。作者在那里改一句、补两句并存成自己的文件。请求两个方向及复制拼稿是本报告的任务走法。 [官方展示 · 手机对话及回复菜单](https://www.deepseek.com/images/download/mobile-zh-606.webp)
- **任务 B。** 将人物、地点和不可改动的事实粘进同一对话，或将设定作为文件上下文，另在当前消息点明「回潮号」已永久拆解。写到一半可再发一条补充，并把最终认可的版本发回对话供后续改写参考。官方说明网页端及 App 有文件输入，文件经纯文本提取或图文解析进入对话上下文。本次未核实逐条设定的引用提示、长聊后如何保留早期设定、附件解析后的具体内容或事实遵守情况。 [官方文档 · 网页与 App 的文件输入][ds-app-api] · [官方文档 · 构建 Chatbot][ds-guide]
- **保存和拿回作品。** 官方中文隐私政策列出历史对话的查阅、输入内容的复制或修改，以及「设置 → 数据管理」导出所有历史对话，并提示步骤随版本变化。手机发布说明列有跨平台历史同步。聊天记录保存交互过程，任务要求的独立可编辑短篇在这条走法中由作者选文、粘贴和另存。官方资料未核实消费端能否直接导出单篇文稿、导出包的附件覆盖或各手机版本的具体导出步骤。API 文档另附公开的 BYOK 聊天演示，其消息编辑、分支与 ZIP 规则单列在官方仓库。 [官方文档 · 隐私政策第 2.2 节][ds-policy] · [手机发布说明][ds-mobile] · [官方演示项目说明][ds-demo]
- **手机及中文。** 官方下载页列出 iOS、Android，展示图可见中文输入框、历史列表与回复菜单，中国区 App Store 列出简体和繁体中文。中文界面有展示证据。中文小说语气、人物一致性、长按精确选段和复制后的排版未实测。 [官方展示 · 手机下载页](https://www.deepseek.com/zh/download/) · [开发者商店说明](https://apps.apple.com/cn/app/deepseek-ai-%E6%99%BA%E8%83%BD%E5%8A%A9%E6%89%8B/id6737597349)

**体验推测。** 一句灵感很容易转成一次问答。多次改写之后，作者要自己记住哪一段已经定稿，以及后续生成应该依据哪个版本。这条路径的额外工作主要发生在选段、回贴现稿和另存时，耗时未经观察。

## Sudowrite 文稿

- **任务 A。** 网页新建空白文稿，在 First Draft 的输入框放入一句灵感。文档明确支持短提示，生成结果直接流入编辑器并成为可改文字，此处没有候选卡插入步骤。作者可直接改开头，再在 Story Bible（项目内的设定资料）里补人物或地点。若开头由作者自己写，放好光标后也可直接转到 Write 取得续写建议。 [官方文档 · First Draft][first] · [Story Bible][bible] · [Write][write]
- **任务 B。** 在 Story Bible 手填两张 Characters 卡和 Worldbuilding 条目，把拆船事实写入相应条目。网页的两类条目也分别支持从现成文本或文件提取，导入前可核对并排除误识别条目。手写或导入后都可再检查字段。若让 AI 从设定起草，可在 Draft 的 Scenes 中手写一项重逢场景，在 Extra Instructions 重申拆船事实，再生成文稿。官方说明 Scenes 会给识别出的设定实体加下划线，Draft 可在开始写正文前接受或跳过对场景提纲的修改建议。正文生成时进入文稿，可以暂停。 [官方文档 · 角色资料][characters] · [世界设定][world] · [Scenes & Draft][draft]
- **续写与修订。** 作者在光标处调用 Guided Write，补充椅子的细节及本段方向。网页 Write 可按设置提供多张候选卡，点 Insert 才进入文稿，也可先给候选加星。插入文字初始为紫色，作者改动后去掉该颜色。选中既有对话用 Quick Edit 时，界面保留带删除线的原文供对照，作者可接受、拒绝或继续调整。可在同一文稿手改、补写收尾。官方 Write 教学的文字稿描述候选和插入，文档截图可见中央正文、右侧 History 和顶部 Saved。 [官方文档及教学文字稿 · Write][write] · [官方展示 · 编辑器截图](https://files.helpkit.co/2371/ca18d298-a952-49ec-bec5-da8e2c110ce9/CleanShot_2026-01-08_at_11.27.24.png) · [官方文档 · Quick Edit][quick]
- **引用范围与核对。** 启用且填好的 Story Bible、光标前正文和连接的前文都可供 Write 参考。连接文档时，Write 候选卡会标注纳入了哪些文档及各自的词数。官方也说明上下文过长时会先舍弃世界设定等材料。任务 B 的事实可以在当前指导里重申，人仍需检查候选和成稿。未核实在中文名称、别名和矛盾资料下的识别或遵守表现。 [官方文档 · Write][write] · [Chapter Continuity][continuity]
- **保存和拿回作品。** 官方说明网页与手机上的文稿存于同一云端并自动同步。网页支持撤销、浏览与恢复旧版本，可导出单篇可编辑 DOCX，或将项目文稿打包成 ZIP、合并成 DOCX。正文导出范围不含 Story Bible，角色、世界设定和大纲各有独立 CSV 导出。移动端资料没有核实能否直接导出单篇 DOCX。 [官方文档 · 手机同步][mobile] · [版本历史更新记录](https://feedback.sudowrite.com/changelog/undo-document-version-history-and-more) · [导出][export]
- **手机及中文。** 官方 iOS、Android 指南列出打开文稿后直接打字、手动增改角色及世界设定，以及移动 Write 的悬浮候选卡可插入、复制或丢弃。移动端功能对照列出文稿历史需到网页查看，Story Bible 的生成改走 Chat。官方多语言说明称 Write 通常跟随输入语言，Draft 等功能有时会回到英语。所查资料没有确认中文界面或手机上的 First Draft 入口。中文输入法选区、两条任务的中文生成与手机首段至导出均未实测。 [官方文档 · 手机总览][mobile] · [手机 Write][mobile-write] · [网页与手机版差异][mobile-diff] · [多语言说明][languages]

**体验推测。** 候选卡适合比较几条走向，原处修订适合只改一句。单句开头走 First Draft 的步骤较少，已有材料走 Story Bible 则多一道核对设定的操作，可能减少后续重复贴资料。这些体验判断未用同一批作者做过对照。

## 本仓可复用的能力和差距

以下基于隔离分支的基线提交 `509dd06ec64cb05e92e9e8bc60c73a5362649ed7` 静态检查。右栏是讨论项。

| 作者动作 | 本仓已有的实现与实际差距 | 值得讨论的复用方式 |
| --- | --- | --- |
| 从一句灵感写第一段 | 欢迎页的常规新建路径是导入自由剧本，或从 DeepSeek 存档继续。内核能创建空故事，欢迎态的行动输入框禁用。自由剧本允许粘贴短文本并跳过 AI 拆解、手动确认蓝图，保存后再通过行动框请求模型。缺少从空白文稿直接写或从一句话直接起稿的入口。 [欢迎页](../../src/ui/WelcomeView.tsx#L19) · [创建故事](../../src/harness/harness.ts#L183) · [手动确认蓝图](../../src/ui/ImportPanel.tsx#L218) · [行动输入框](../../src/ui/App.tsx#L1126) | 一句灵感直接进入短篇正文，复用本机存储及按需调用模型的能力。观察作者能否先自行写一段，之后才需要配置模型。 |
| 导入设定并随写随补 | 自由剧本支持粘贴与 DOCX、MD、TXT，可核对蓝图再保存。生成时把蓝图和原始剧本全文放入固定上下文，再加入当前路线的摘要与近期节点。开局后可微调主角和禁忌，原始剧本依旧随请求发送。当前蓝图界面没有逐条追加角色和世界规则的入口，行动框补充则以该路线的对话内容参与上下文。事实约束由提示词传给模型，源码未见对生成正文作确定性矛盾检查。 [导入界面](../../src/ui/ImportPanel.tsx#L338) · [蓝图微调](../../src/ui/ContextOverview.tsx#L40) · [固定锚定](../../src/harness/context.ts#L94) · [上下文组装](../../src/harness/context.ts#L208) | 复用作者确认蓝图、原文留存和上下文概览。先讨论如何把补充明确为全故事设定、当前路线事实或本次写作指示，以及作者如何确认不可改动的事实实际进了本次请求。 |
| 采纳候选、自己续写 | 流式回复完成后进入节点树并激活该路线。玩家节点能编辑重发成新分支，AI 节点可重生成分支并可切回已有路线。分支沿父节点取历史和摘要。现有文本框提交后进入模型轮次，AI 正文由回合卡渲染。缺少分句采纳、原处接受或拒绝，以及手写直接保存进连续文稿的操作。 [流式调用](../../src/harness/harness.ts#L241) · [生成与存档](../../src/harness/harness.ts#L447) · [编辑及重生成](../../src/harness/harness.ts#L712) · [剧情树](../../src/ui/StoryTree.tsx#L37) · [行动提交](../../src/ui/App.tsx#L566) | 复用流式生成和剧情树对照两种走向。用同一个场景核对选进正文的一句、被舍弃的候选和作者手写的结尾，确认下次生成沿用作者实际保留的正文。 |
| 保存并拿回作品 | Web 用 IndexedDB，Android 通过原生存储适配器。故事可导出或恢复 `.lfh.json`，保留原始剧本、蓝图、节点树和活动路线。DeepSeek ZIP 导入可作为旧会话的起点。当前导出入口面向完整故事备份，未找到剥离行动指令、思考及旁支后导出独立正文的入口。 [Web 存储](../../src/platform/webRuntime.ts#L87) · [Android 存储](../../src/platform/androidRuntime.ts#L49) · [故事结构](../../src/harness/types.ts#L39) · [备份格式](../../src/harness/storyStorage.ts#L213) · [DeepSeek ZIP 导入](../../src/ui/DeepSeekImportPanel.tsx#L405) | 讨论独立的正文导出，例如 TXT 或 Markdown。用外部编辑器打开，核对只包含作者认可的短篇，同时保留现有 JSON 用于恢复创作过程。 |
| 用自己的模型 | BYOK 即自带 API Key。本仓通过运行时向所配置的模型端点发送生成所需上下文。未配置凭据时，生成入口会引导配置，手动确认蓝图和本机备份有独立路径。Android 与 Web 有各自的网络与存储适配。配置到首段的手机体验和实际中文输出未测。 [BYOK 入口](../../src/ui/App.tsx#L553) · [模型配置](../../src/harness/types.ts#L103) · [传输调用](../../src/harness/harness.ts#L241) · [本地优先定义](../../GLOSSARY.md) | 复用按动作触发的凭据检查。验证作者能否在本机手写和保存，直到主动要求生成时才配置凭据并发送必要的设定与正文。 |

## 仍需验证的问题

- 两个产品都未提交这组样本。未知项包括初稿质量、两种材料起点的耗时、作者是否容易找回自己接受的版本，以及多轮补充后中文正文是否仍遵守「回潮号已拆解」这一事实。
- 手机结论来自官方截图与说明。中文输入法、选区、窄屏候选比较、切到其他 App 再回来后的稿件保留，以及导出文件能否用常见编辑器继续编辑，都需要真机观察。Sudowrite 的独立 DOCX 出口有网页文档证据。
- 本仓已核对入口、存储模型与生成链路。以两条互斥路线、一个矛盾候选和一段作者手写结尾作对照，可以检验切换路线后会引用哪些设定，以及最终能否只导出作者确认的正文。这个验收依赖实际创作入口。

[ds-app-api]: https://api-docs.deepseek.com/zh-cn/news/news261113/
[ds-guide]: https://api-docs.deepseek.com/guides/build_a_chatbot/
[ds-policy]: https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html
[ds-mobile]: https://api-docs.deepseek.com/news/news250115/
[ds-demo]: https://github.com/deepseek-ai/chat-demo
[first]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/first-draft/gMcJCRTRFqB8w3hBWYAC5M
[bible]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC
[characters]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/characters/a7tdE1ZB8KvAwMD3Mopwpd
[world]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/worldbuilding/uc5NfWSz4x8Wm3S19LZeo8
[draft]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/scenes--draft/49p5MTVxTKkVFEC5rVUzpY
[write]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/write/pvxUvbQqYybfEosqx1sXjY
[quick]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/quick-edit/2asL35fds36oHAFJN7bYzz
[continuity]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/chapter-continuity/4KL8gFeLZQ6GSBjDWtSbV6
[export]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/exporting-files/3NtVWXcnwYaRCmPW2iwcCB
[mobile]: https://docs.sudowrite.com/using-sudowrite/1owq1kGqof9rtcyGnrWUBS/using-the-sudowrite-mobile-app/4MxYzYduLSPQ3VpoP6dyxo
[mobile-write]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/write/6JmxspPSKDf6y7K5PVBZxa
[mobile-diff]: https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/web-app-vs-mobile-app-differences/6JmxspPSKC83DkQZ7rFYcJ
[languages]: https://docs.sudowrite.com/resources/ktuxRrzphwp3uTNneRtaos/can-i-use-sudowrite-in-other-languages/aR5Me5vw2J3wmLD9acqrvw
