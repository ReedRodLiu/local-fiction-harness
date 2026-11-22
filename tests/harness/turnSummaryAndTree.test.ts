import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  ENTRY_ROUTE_SYSTEM_PROMPT,
  appendWorkDiscussionTurn,
  buildRedactedStorySkeleton,
  buildSystemAnchorPrompt,
  characterContext,
  createDefaultBlueprint,
  createFictionHarness,
  createInMemoryStoryStorage,
  emptyWorkspace,
  exportFolioBackupV3,
  formatTurnPreview,
  getForkSiblingBranches,
  inspectStreamingReplyPrefix,
  mergeRestoredBackup,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  parseAndValidateFolioBackup,
  parseEntryRouteReply,
  parseManuscriptAssistantReply,
  parseProposalReply,
  previewDeepSeekSessions,
  projectStoryTreeSpine,
  streamCreativeReply,
  stripMarkdownToPlainText,
  toCompactPreview,
  visibleEntryRoutePrefix,
  visibleReplyPrefix,
  workContext,
  type CreativeWorkspaceState,
  type LlmTransport,
  type ModelConfig,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';
import { MessageContent } from '../../src/ui/MessageContent.tsx';
import { StoryTree } from '../../src/ui/StoryTree.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const testConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test-123456',
  memoryOnly: true,
};

describe('Issue #104 shared plain-text sanitizer & summary-first previews', () => {
  it('strips Markdown syntax and internal lfh-* blocks cleanly without leaving raw markers', () => {
    const raw = [
      '## 第一章：雨夜渡口',
      '',
      '> “别回头，[灯塔](https://example.com)就在前面。”',
      '',
      '**林晚**握紧`铜哨`，穿过*冷雾*与~~旧桥~~。',
      '- 检查行囊',
      '1. 推开木门',
      '',
      '```lfh-hud',
      '时间: 子时 | 体力: 80',
      '```',
      '',
      '```lfh-choices',
      '1. 进屋避雨',
      '2. 绕到后门',
      '```',
      '',
      '```lfh-proposal',
      'target: setting',
      'op: append',
      'summary: 获得铜哨',
      '---',
      '- 物品：铜哨',
      '```',
      '',
      '```lfh-summary',
      '林晚冒雨渡口拾获铜哨。',
      '```',
    ].join('\n');

    const plain = stripMarkdownToPlainText(raw);
    expect(plain).toBe(
      '第一章：雨夜渡口 “别回头，灯塔就在前面。” 林晚握紧铜哨，穿过冷雾与旧桥。 检查行囊 推开木门',
    );
    expect(plain).not.toMatch(/##|\*\*|`|lfh-|https:\/\/example\.com/);
  });

  it('strips unclosed or four-backtick internal lfh-* fences and generic code fence delimiters', () => {
    const raw = [
      '### 码头夜谈',
      '```text',
      '风速：三级',
      '```',
      '````lfh-proposal',
      'target: note',
      '---',
      '```md',
      '## 隐藏笔记',
      '```',
      '````',
      '```lfh-summary',
      '未闭合摘要片段',
    ].join('\n');

    const plain = stripMarkdownToPlainText(raw);
    expect(plain).toBe('码头夜谈 风速：三级');
    expect(plain).not.toContain('```');
    expect(plain).not.toContain('隐藏笔记');
    expect(plain).not.toContain('未闭合摘要片段');
  });

  it('formats AI previews summary-first and truncates fallback cleanly (AI <=40, user <=30)', () => {
    expect(
      formatTurnPreview({
        role: 'assistant',
        turnSummary: '主角夜探东厢书房取得银钥匙。',
        content: '## 长段正文\n**很多细节**'.repeat(10),
      }),
    ).toBe('主角夜探东厢书房取得银钥匙。');

    const longAiFallback = formatTurnPreview({
      role: 'assistant',
      content: '## 雨夜\n\n**她**推开吱呀作响的雕花木门，发现桌面上摊开着一本沾满水渍的旧账簿，里面夹着半张泛黄的车票与一枚铜钥匙。',
    });
    expect(Array.from(longAiFallback).length).toBeLessThanOrEqual(40);
    expect(longAiFallback.endsWith('…')).toBe(true);
    expect(longAiFallback).not.toContain('##');
    expect(longAiFallback).not.toContain('**');

    const longUser = formatTurnPreview({
      role: 'user',
      content: '> **行动**：我悄悄绕到窗外观察屋内的动静，确认管家是否还在翻找抽屉里的密信。',
    });
    expect(Array.from(longUser).length).toBeLessThanOrEqual(30);
    expect(longUser.endsWith('…')).toBe(true);
    expect(longUser).not.toContain('>');
    expect(longUser).not.toContain('**');

    expect(toCompactPreview('```lfh-choices\n1. A\n2. B\n```', 40)).toBe('（空内容）');
  });

  it('extracts and strips lfh-summary alongside lfh-proposal and lfh-choices without creating needs_review', () => {
    const reply = [
      '雨丝敲在渡口铁皮棚顶上。',
      '',
      '```lfh-choices',
      '1. 推开仓库门',
      '2. 绕到后窗',
      '```',
      '',
      '```lfh-proposal',
      'target: setting',
      'op: append',
      'summary: 记录渡口线索',
      '---',
      '- 渡口东侧亮起微光。',
      '```',
      '',
      '```lfh-summary',
      '**林晚**冒雨抵达渡口发现微光。',
      '```',
    ].join('\n');

    const parsed = parseProposalReply(reply);
    expect(parsed.proposalStatus).toBe('recognized');
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.unparsedBlocks).toEqual([]);
    expect(parsed.turnSummary).toBe('林晚冒雨抵达渡口发现微光。');
    expect(parsed.content).not.toContain('lfh-summary');
    expect(parsed.content).not.toContain('林晚冒雨抵达渡口发现微光');
    expect(parsed.content).toContain('```lfh-choices');

    const truncatedSummary = parseProposalReply(
      '门轴发出低沉的声响。\n\n```lfh-summary\n半截未闭合',
      { finishReason: 'length' },
    );
    expect(truncatedSummary.proposalStatus).toBe('none');
    expect(truncatedSummary.unparsedBlocks).toEqual([]);
    expect(truncatedSummary.turnSummary).toBeUndefined();
    expect(truncatedSummary.content).toBe('门轴发出低沉的声响。');
  });

  it('hides partial, open, and closed lfh-summary fences during streaming without false proposalInProgress', () => {
    expect(inspectStreamingReplyPrefix('正文继续。\n```lfh-sum')).toEqual({
      visible: '正文继续。\n',
      proposalInProgress: false,
    });
    expect(inspectStreamingReplyPrefix('正文继续。\n```lfh-summary\n主角进入古宅')).toEqual({
      visible: '正文继续。\n',
      proposalInProgress: false,
    });
    expect(visibleReplyPrefix('正文继续。\n```lfh-summary\n主角进入古宅。\n```')).toBe('正文继续。\n');

    expect(inspectStreamingReplyPrefix('正文继续。\n```lfh-pro')).toEqual({
      visible: '正文继续。\n',
      proposalInProgress: true,
    });
  });

  it('never renders lfh-summary inside MessageContent turn-body even on unstripped content', () => {
    const raw = [
      '夜风吹熄了廊下的红灯笼。',
      '',
      '```lfh-choices',
      '1. 点亮火折子',
      '2. 摸黑前进',
      '```',
      '',
      '```lfh-summary',
      '夜风吹熄灯笼，主角摸黑前行。',
      '```',
    ].join('\n');

    const markup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: raw,
        mode: 'story',
        showChoices: true,
        onSelectChoice: () => undefined,
      }),
    );

    expect(markup).toContain('data-testid="turn-body"');
    expect(markup).toContain('夜风吹熄了廊下的红灯笼。');
    expect(markup).toContain('data-testid="choice-row"');
    expect(markup).toContain('点亮火折子');
    expect(markup).not.toContain('lfh-summary');
    expect(markup).not.toContain('夜风吹熄灯笼，主角摸黑前行');
  });

  it('instructs lfh-summary across narrative prompts and persists TurnNode.turnSummary in harness without streaming leaks', async () => {
    let callCount = 0;
    const chunksPerCall = [
      ['渡口浓雾渐起，', '船夫缓缓靠岸。\n\n```lfh-su', 'mmary\n渡口浓雾渐起，船夫靠岸。\n```'],
      ['改走后巷，', '石阶上留着湿脚印。\n\n```lfh-summary\n改走后巷发现湿脚印。\n```'],
      ['重摇火折子，', '暗门在墙角显露。\n\n```lfh-summary\n火光下暗门显露。\n```'],
    ];
    const transport: LlmTransport = {
      async *streamChat() {
        const chunks = chunksPerCall[callCount] ?? chunksPerCall[0];
        callCount += 1;
        for (const chunk of chunks) {
          yield { contentDelta: chunk };
        }
        yield { finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      transport,
      storage: createInMemoryStoryStorage(),
    });
    const story = await harness.createAndSaveStory({
      title: '雾渡',
      rawScript: '## 设定\n\n夜渡口规则。',
    });

    const storyAnchor = buildSystemAnchorPrompt(story);
    const char = newCharacter('沈砚', '老书店老板');
    const charCtx = characterContext(newDocument(''), char, newConversation(char), '开门了吗？');
    const work = newWork('雨夜', '悬疑');
    const workCtx = workContext(newDocument(''), work, '聊聊开篇');
    expect(storyAnchor).toContain('lfh-summary');
    expect(charCtx.messages[0].content).toContain('lfh-summary');
    expect(workCtx.messages[0].content).toContain('lfh-summary');
    expect(ENTRY_ROUTE_SYSTEM_PROMPT).toContain('lfh-summary');

    const streamedRun: string[] = [];
    const runRes = await harness.runTurn(story, '走向渡口', testConfig, {
      onContentDelta: (delta) => streamedRun.push(delta),
    });
    expect(streamedRun.join('')).not.toContain('lfh-summary');
    expect(streamedRun.join('')).not.toContain('渡口浓雾渐起，船夫靠岸');
    expect(runRes.assistantNode.content).toBe('渡口浓雾渐起，船夫缓缓靠岸。');
    expect(runRes.assistantNode.turnSummary).toBe('渡口浓雾渐起，船夫靠岸。');

    const branchRes = await harness.editAndBranch(
      runRes.story,
      runRes.userNode.id,
      '绕到后巷看看',
      testConfig,
    );
    expect(branchRes.assistantNode.content).toBe('改走后巷，石阶上留着湿脚印。');
    expect(branchRes.assistantNode.turnSummary).toBe('改走后巷发现湿脚印。');

    const regenRes = await harness.regenerateNode(
      branchRes.story,
      branchRes.assistantNode.id,
      testConfig,
    );
    expect(regenRes.assistantNode.content).toBe('重摇火折子，暗门在墙角显露。');
    expect(regenRes.assistantNode.turnSummary).toBe('火光下暗门显露。');
  });

  it('propagates turnSummary and strips lfh-summary across creative, entryRouter, and manuscript replies', async () => {
    const creativeChunks = [
      '「先坐下喝杯热茶。」\n\n```lfh-su',
      'mmary\n沈砚递来热茶安抚来客。\n```',
    ];
    const streamedCreative: string[] = [];
    const creativeRes = await streamCreativeReply(
      {
        async *streamChat() {
          for (const chunk of creativeChunks) yield { contentDelta: chunk };
          yield { finishReason: 'stop' };
        },
      },
      testConfig,
      [{ role: 'user', content: '你好' }],
      { onContentDelta: (d) => streamedCreative.push(d) },
    );
    expect(streamedCreative.join('')).not.toContain('lfh-summary');
    expect(creativeRes.content).toBe('「先坐下喝杯热茶。」');
    expect(creativeRes.turnSummary).toBe('沈砚递来热茶安抚来客。');

    const work = newWork('短篇', '设定');
    const appended = appendWorkDiscussionTurn(work, {
      role: 'assistant',
      content: creativeRes.content,
      turnSummary: creativeRes.turnSummary,
    });
    expect(appended.node.turnSummary).toBe('沈砚递来热茶安抚来客。');

    const routeRaw = [
      '```lfh-route',
      'mode: story',
      'title: 雾夜渡口',
      '---',
      '## 设定',
      '雨夜。',
      '```',
      '',
      '雨点敲打棚顶。\n\n```lfh-summary\n雨夜抵达渡口棚下。\n```',
    ].join('\n');
    expect(visibleEntryRoutePrefix('```lfh-route\nmode: story\n---\n```\n雨点。\n```lfh-sum')).toBe('雨点。\n');
    const routed = parseEntryRouteReply(routeRaw, '开始一个雨夜渡口文游');
    expect(routed.assistantReply).toBe('雨点敲打棚顶。');
    expect(routed.turnSummary).toBe('雨夜抵达渡口棚下。');

    const manuscriptChat = parseManuscriptAssistantReply(
      '```lfh-manuscript-intent\nintent: chat\n```\n把伏笔前移一节。\n\n```lfh-summary\n建议将伏笔前移一节。\n```',
      '这里节奏怎么调？',
    );
    expect(manuscriptChat.kind).toBe('chat');
    if (manuscriptChat.kind === 'chat') {
      expect(manuscriptChat.content).toBe('把伏笔前移一节。');
      expect(manuscriptChat.turnSummary).toBe('建议将伏笔前移一节。');
    }
  });

  it('uses summary-first + sanitized fallback across StoryTree projection, fork cards, and DeepSeek import preview', () => {
    const nodes: Record<string, TurnNode> = {
      u1: {
        id: 'u1',
        parentId: null,
        role: 'user',
        content: '> **选择**：推开沉重的铁门走入地下室探查机关',
        createdAt: 1000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      a1: {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        content: '## 地下室\n\n**冷风**从石缝吹出。\n\n```lfh-choices\n1. 点灯\n2. 离开\n```',
        turnSummary: '主角推门进入地下室听见水声。',
        createdAt: 2000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      u2a: {
        id: 'u2a',
        parentId: 'a1',
        role: 'user',
        content: '走向左侧石阶',
        createdAt: 3000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      a2a: {
        id: 'a2a',
        parentId: 'u2a',
        role: 'assistant',
        content: '### 西侧密室\n\n**墙角**刻着一串古老日期与暗号，石桌上摆着一只生锈的铜盒。',
        createdAt: 4000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      u2b: {
        id: 'u2b',
        parentId: 'a1',
        role: 'user',
        content: '退回地面大厅',
        createdAt: 5000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      a2b: {
        id: 'a2b',
        parentId: 'u2b',
        role: 'assistant',
        content: '## 大厅\n\n壁炉火光重新亮起。',
        turnSummary: '退回大厅见壁炉重燃。',
        createdAt: 6000,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    };

    const story: Story = {
      id: 'tree-summary-1',
      title: '地下室探险',
      rawScript: '悬疑规则',
      blueprint: createDefaultBlueprint('地下室探险'),
      nodes,
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a2a',
      createdAt: 1000,
      updatedAt: 6000,
    };

    const spine = projectStoryTreeSpine(story);
    const span1 = spine.items[0];
    const span2 = spine.items[2];
    if (span1.kind !== 'span' || span2.kind !== 'span') {
      throw new Error('Expected span items');
    }
    expect(span1.preview).toBe('主角推门进入地下室听见水声。');
    expect(Array.from(span2.preview).length).toBeLessThanOrEqual(40);
    expect(span2.preview).not.toContain('###');
    expect(span2.preview).not.toContain('**');

    const siblings = getForkSiblingBranches(story, 'a1');
    expect(siblings).toHaveLength(2);
    expect(Array.from(siblings[0].preview).length).toBeLessThanOrEqual(40);
    expect(siblings[0].preview).not.toContain('###');
    expect(siblings[1].preview).toBe('退回大厅见壁炉重燃。');

    const treeMarkup = renderToStaticMarkup(createElement(StoryTree, { story }));
    expect(treeMarkup).toContain('主角推门进入地下室听见水声。');
    expect(treeMarkup).not.toContain('###');
    expect(treeMarkup).not.toContain('**墙角**');

    // DeepSeek import preview strips Markdown & lfh-* blocks from latestSnippet and tree previews
    const zipBytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/s-md.json': strToU8(
        JSON.stringify({
          id: 's-md',
          title: 'Markdown 导入测试',
          inserted_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:05:00Z',
          current_message_id: 2,
          messages: [
            {
              message_id: 1,
              parent_id: null,
              role: 'USER',
              inserted_at: '2026-01-01T00:01:00Z',
              fragments: [{ type: 'REQUEST', content: '> **设定**：雨夜码头冒险' }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: 'ASSISTANT',
              inserted_at: '2026-01-01T00:02:00Z',
              fragments: [
                {
                  type: 'RESPONSE',
                  content: '## 第一幕\n\n**码头**雾色浓重。\n\n```lfh-choices\n1. 登船\n2. 返航\n```',
                },
              ],
            },
          ],
        }),
      ),
    });

    const [preview] = previewDeepSeekSessions(zipBytes, ['s-md']);
    expect(preview.latestSnippet).not.toContain('##');
    expect(preview.latestSnippet).not.toContain('**');
    expect(preview.latestSnippet).not.toContain('lfh-choices');
    expect(preview.latestSnippet).toContain('第一幕');

    const baseCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'base.css'), 'utf8');
    const sheetCss = readFileSync(join(repoRoot, 'src', 'ui', 'styles', 'companion-sheet.css'), 'utf8');
    expect(baseCss).toContain('-webkit-line-clamp: 2');
    expect(baseCss).toContain('-webkit-line-clamp: 1');
    expect(sheetCss).toContain('.companion-branch-preview');
  });

  it('round-trips TurnNode.turnSummary in .folio.json v3 backup/merge, preserves v1/v2 compat, and redacts from skeleton', () => {
    const story: Story = {
      id: 'story-v3-sum',
      title: '渡口夜话',
      rawScript: '夜渡口规则',
      blueprint: createDefaultBlueprint('渡口夜话'),
      nodes: {
        u1: {
          id: 'u1',
          parentId: null,
          role: 'user',
          content: '走向渡口',
          createdAt: 1000,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
        a1: {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          content: '船夫递来铜哨。',
          turnSummary: '船夫夜渡递来铜哨_CANARY',
          createdAt: 2000,
          summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
        },
      },
      rootNodeIds: ['u1'],
      activeLeafNodeId: 'a1',
      createdAt: 1000,
      updatedAt: 2000,
    };

    let work = newWork('同人短篇', '设定');
    work = appendWorkDiscussionTurn(work, { role: 'user', content: '聊聊开头', id: 'wu1', createdAt: 10 }).work;
    work = appendWorkDiscussionTurn(work, {
      role: 'assistant',
      content: '可以从雨夜写起。',
      turnSummary: '确定从雨夜站台开篇',
      id: 'wa1',
      parentId: 'wu1',
      createdAt: 20,
    }).work;

    const character = newCharacter('江澄', '人设');
    const conv = newConversation(character, 'personal', '');
    conv.nodes = {
      cu1: {
        id: 'cu1',
        parentId: null,
        role: 'user',
        content: '在吗',
        createdAt: 10,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
      ca1: {
        id: 'ca1',
        parentId: 'cu1',
        role: 'assistant',
        content: '刚泡好茶。',
        turnSummary: '江澄泡茶回应问候',
        createdAt: 20,
        summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
      },
    };
    conv.activeLeafNodeId = 'ca1';
    character.conversations = [conv];
    character.activeConversationId = conv.id;

    const workspace: CreativeWorkspaceState = {
      revision: 1,
      publicDocument: newDocument('', 'user', 'public-original'),
      works: [work],
      characters: [character],
      activeWorkId: work.id,
      activeCharacterId: character.id,
    };

    const json = exportFolioBackupV3({ stories: [story], workspace, now: () => 5000 });
    const parsed = parseAndValidateFolioBackup(json);
    expect(parsed.stories[0].nodes.a1.turnSummary).toBe('船夫夜渡递来铜哨_CANARY');
    expect(parsed.stories[0].nodes.u1.turnSummary).toBeUndefined();
    expect(parsed.workspace.works[0].discussionNodes?.wa1.turnSummary).toBe('确定从雨夜站台开篇');
    expect(parsed.workspace.works[0].discussion[1].turnSummary).toBe('确定从雨夜站台开篇');
    expect(parsed.workspace.characters[0].conversations[0].nodes.ca1.turnSummary).toBe('江澄泡茶回应问候');

    const merged = mergeRestoredBackup(
      { stories: [], workspace: emptyWorkspace() },
      parsed,
    );
    expect(merged.stories[0].nodes.a1.turnSummary).toBe('船夫夜渡递来铜哨_CANARY');
    expect(merged.workspace.works[0].discussionNodes?.wa1.turnSummary).toBe('确定从雨夜站台开篇');
    expect(merged.workspace.characters[0].conversations[0].nodes.ca1.turnSummary).toBe('江澄泡茶回应问候');

    // Legacy v1 without turnSummary remains valid
    const legacyV1 = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1000,
      story: {
        ...story,
        nodes: {
          u1: story.nodes.u1,
          a1: {
            id: 'a1',
            parentId: 'u1',
            role: 'assistant',
            content: '旧格式回复。',
            createdAt: 2000,
            summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
          },
        },
      },
    });
    const parsedLegacy = parseAndValidateFolioBackup(legacyV1);
    expect(parsedLegacy.stories[0].nodes.a1.turnSummary).toBeUndefined();

    // Non-string turnSummary fails validation clearly
    const invalidJson = JSON.parse(json) as { stories: Story[] };
    (invalidJson.stories[0].nodes.a1 as unknown as { turnSummary: number }).turnSummary = 123;
    expect(() => parseAndValidateFolioBackup(JSON.stringify(invalidJson))).toThrow(/格式无效|turnSummary/);

    // Diagnostic skeleton never leaks turnSummary
    const skeletonJson = JSON.stringify(buildRedactedStorySkeleton(story));
    expect(skeletonJson).not.toContain('CANARY');
  });
});
