# AI 角色聊天工具的人设开场与续聊

2026 年 11 月 20 日 · [研究票「调研现有 AI 角色工具怎样从预设人设开始聊天并续聊」](https://github.com/ReedRodLiu/local-fiction-harness/issues/61)

两款工具都让创作者分别填写角色设定和开场白，并让同一角色拥有多段对话。隔天接着聊时，要找回的是原来那段对话。角色设定、对话记录和提供给模型的记忆内容各有自己的编辑入口。以下是公开官方资料和 SillyTavern 1.19.0 源码的对照，两款产品均未执行实机试用。 [Character.AI 创建指南](https://support.character.ai/hc/en-us/articles/50608869548699) · [Character.AI 历史归档公告](https://support.character.ai/hc/en-us/articles/44779615557787) · [SillyTavern 角色管理](https://docs.sillytavern.app/usage/characters/) · [SillyTavern 对话文件管理](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/)

## 同一份虚构人设

- 岑雾是旧港灯塔的守塔人，冷静，说话简短。玩家是前来帮忙查修的访客。
- 写好的开场是「雾里有一艘没有灯的船。你先看海面，还是跟我上塔？」
- 第一天在原对话发送「我把一枚蓝色铜钥匙放在灯塔第三层的抽屉里。」隔天回到那一段，发送「我昨天把钥匙放在哪儿了？」先核对原消息能否找回，再记录回复是否正确。若把钥匙记成红色，用「钥匙是蓝色的」试验当前对话的更正入口。以下操作是按证据推演的复核步骤。

## Character.AI

1. **带入人设并开聊。** 网页左侧选 `+Create → Character`，移动端底部选 `+ → Character`。把「岑雾」填入名字，性格、背景和与玩家的关系填入 `Character Definition`，把同一开场单独填入 `Greeting`。官方流程支持创建为 `Private`，点 `Create` 后即可聊天。新对话显示所写开场，若启用额外开场可滑动选择；复核样例用一条固定开场，保持 `AI Greeting for New Chats` 关闭。官方指南还说明用户可从公开角色的搜索或发现入口进入；这里用自建角色承载已有的人设。 [创建指南](https://support.character.ai/hc/en-us/articles/50608869548699) · [角色定义](https://support.character.ai/hc/en-us/articles/50609183646875) · [开场白指南](https://support.character.ai/hc/en-us/articles/50609011294235)
2. **隔天找回原对话。** 从 `Chats`／近期聊天找到岑雾，若有多段则在该角色的历史归档里找第一天那一条，确认钥匙原消息仍在后再继续发送。官方资料确认移动端有 `Chats` 入口、近期聊天和按角色保存的历史归档，公告配图中的历史条目有时间、消息数及会话文字。各端当前打开归档的具体按钮和点角色时默认打开哪一段，尚待试用核对。官方另有 `Start new chat`，以及从某处复制原对话的 `Start New Chat From Here`。 [移动端 Chats 入口](https://support.character.ai/hc/en-us/articles/54400390862875) · [近期聊天](https://blog.character.ai/first-60-days-update/) · [历史归档公告与配图](https://support.character.ai/hc/en-us/articles/44779615557787) · [从此处开始新对话](https://support.character.ai/hc/en-us/articles/34428285052827)
3. **修改设定或更正剧情。** 创作者在自己角色的编辑页修改 `Definition`；官方建议重大变更后另开对话测试，因为旧对话带有已有上下文。钥匙颜色属于这一段的剧情，可在聊天顶部的笔记本图标或菜单进 `Memory`，在 `Story Memory` 写明正确事实，或固定原消息。按官方发布说明，`Facts` 属于 c.ai+，可新增、编辑或停用自动记录，也可在开始新对话时选择复制这些条目。 [角色编辑页](https://support.character.ai/hc/en-us/articles/52739596326811) · [编辑与测试](https://support.character.ai/hc/en-us/articles/50609303987099) · [Memory 发布说明](https://blog.character.ai/memory/)

## SillyTavern 1.19.0

1. **带入人设并开聊。** 在角色面板选 `Create New Character`，把身份和性格写入 `Character Description`，把访客来查修写入 `Scenario`，同一开场填入 `First Message`。若已有可识别的角色卡，可用 `Import Character` 导入文件，源码可核对 JSON、PNG 等格式。点角色卡进入一对一对话。源码显示，新对话空白时客户端把卡片里的开场写成第一条角色消息，备用开场来自 `alternate_greetings`；显示这条预写消息无需生成，发送玩家消息后的回复由已连接的模型提供。 [角色面板](https://docs.sillytavern.app/usage/characters/) · [聊天操作](https://docs.sillytavern.app/usage/chatting/) · [导入格式源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/endpoints/characters.js#L1560-L1598) · [开场写入源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/script.js#L7684-L7741)
2. **隔天找回原对话。** 点岑雾的卡片会加载该角色当前关联的对话。若打开了别的一段，用输入栏左侧 `Options → Manage chat files` 选择第一天的记录，可用文件名和末尾消息预览确认。源码按角色目录和文件名保存、读取 JSONL（每行一条 JSON 记录），包含对话元数据和消息。另开一段用 `Start new chat`。 [角色切换源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/script.js#L875-L908) · [历史列表源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/script.js#L8598-L8622) · [点击历史条目的源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/bookmarks.js#L688-L719) · [加载所选对话源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/script.js#L7634-L7752) · [存储源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/endpoints/chats.js#L545-L614) · [对话管理](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/)
3. **修改设定或更正剧情。** 角色面板可修改卡片。源码显示改卡后，自动替换当前开场的情形限于符合条件的空对话或只有一条角色开场的对话。若钥匙颜色写错在某条消息，可通过消息的 `Edit` 纠正；若要给当前聊天加一条明确设定，用 `Options → Author’s Note`，它按配置插入请求；若错误出在滚动摘要，可在 `Extensions → Summarize → Current summary` 手改，也可恢复上一份摘要。 [角色编辑](https://docs.sillytavern.app/usage/characters/) · [修改开场的源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/script.js#L9883-L9921) · [消息编辑](https://docs.sillytavern.app/usage/chatting/#edit-message-content) · [Author’s Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/) · [摘要扩展](https://docs.sillytavern.app/extensions/summarize/)

## 本项目在 `cf52712` 的对应能力

- **已有设定与开场。** 已支持粘贴或导入 DOCX、MD、TXT，将原始剧本全文保存在故事中，并让玩家在导入确认时核对故事蓝图里的主角、角色档案、禁忌及开场提示。开场提示可预览，确认保存后调用模型生成实际的第一幕。 [术语表](../../GLOSSARY.md) · [蓝图 ADR](../adr/0002-blueprint-extraction-with-full-raw-script-anchoring.md) · [导入界面](../../src/ui/ImportPanel.tsx#L475) · [启动第一幕](../../src/ui/App.tsx#L1088)
- **重访进度。** 故事库按故事打开本地记录，故事保存当前分支的末端节点。生成请求沿所选路径采用原始剧本与确认的蓝图、剧情摘要快照和近期对话。续聊对应的是同一故事的当前进度。 [故事选择逻辑](../../src/ui/App.tsx#L1153) · [故事数据](../../src/harness/types.ts#L40) · [三区上下文 ADR](../adr/0003-three-zone-context-and-node-summary-snapshots.md) · [上下文组装](../../src/harness/context.ts#L205)
- **开局后的修正。** 「微调蓝图」可改主角和禁忌，历史行动可编辑后生成新分支。「当前路线剧情回顾」可查看摘要及覆盖范围，在需要时补算摘要。已核对的界面没有逐条编辑剧情记忆或手改当前摘要的入口。 [蓝图微调](../../src/ui/StoryBlueprintCard.tsx#L33) · [编辑行动并分支](../../src/ui/App.tsx#L898) · [剧情回顾](../../src/ui/StoryReview.tsx#L60)

## 待实测

Character.AI 的创建后落点、移动端和网页的历史定位、编辑角色后旧对话采用哪些设定，以及目标账户的记忆功能呈现，需在产品内确认。SillyTavern 的导入、退出重启、选回同一条记录和编辑摘要，已可据文档与源码编排操作，仍待运行验证。两款工具均未发送样例消息，隔天记录恢复、模型答对钥匙位置、接受颜色更正及在长对话中保持人设，均无实测结果。
