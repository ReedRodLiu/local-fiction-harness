import { createDefaultBlueprint } from './blueprint.ts';
import { EMPTY_SUMMARY_SNAPSHOT, excludeRefusedTurns, getActiveBranchNodes } from './context.ts';
import {
  getWorkActiveDiscussionNodes,
  newCharacter,
  newConversation,
  newWork,
  type CreativeWorkspaceState,
  type DraftWork,
  type LocalCharacter,
} from './creative.ts';
import { createDefaultId } from './id.ts';
import {
  normalizeGenerationPreference,
  normalizeReasoningEffort,
} from './keyConfig.ts';
import {
  buildPromptPackAnchorMessages,
  promptPackTailMessage,
  resolvePromptPackContext,
  type PromptPackContextOptions,
} from './promptPack.ts';
import {
  streamWithRefusalHandling,
  type RefusalStreamIntegrationOptions,
} from './refusalWrapper.ts';
import {
  CHANGE_PROMPT,
  documentVersion,
  newDocument,
  parseProposalReply,
  storyDocumentState,
  visibleReplyPrefix,
  type ParsedProposal,
  type UnparsedProposalBlock,
} from './markdownDocuments.ts';
import type {
  GenerationPreference,
  LlmMessage,
  LlmTransport,
  ModelConfig,
  NodeDiagnostics,
  ReasoningEffort,
  Story,
  TurnCallbacks,
  TurnNode,
} from './types.ts';

export type StageAssetMode = 'story' | 'writing' | 'character';
export type EntryRouteMode = StageAssetMode | 'ambiguous';

export interface EntryRouteResult {
  mode: EntryRouteMode;
  title: string;
  settingMarkdown: string;
  assistantReply: string;
  turnSummary?: string;
  characterName?: string;
  reasoningContent: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  proposals: ParsedProposal[];
  unparsedBlocks: UnparsedProposalBlock[];
  usedFallback: boolean;
  diagnostics?: NodeDiagnostics;
  prefillContent?: string;
}

export type ManuscriptReplyIntent =
  | {
      kind: 'suggestion';
      text: string;
      content: string;
      turnSummary?: string;
      reasoningContent: string;
    }
  | {
      kind: 'chat';
      content: string;
      turnSummary?: string;
      reasoningContent: string;
    }
  | {
      kind: 'proposal';
      content: string;
      turnSummary?: string;
      proposals: ParsedProposal[];
      unparsedBlocks: UnparsedProposalBlock[];
      reasoningContent: string;
    };

export const ENTRY_ROUTE_SYSTEM_PROMPT = [
  '你是 Folio 的自然语言第一入口助手。用户在欢迎页输入了自然语言想法，你需要在同一轮完成两件事：',
  '1) 在回复最开头输出一个 ```lfh-route 代码围栏，把用户意图单步归类并整理出清晰简洁的 Markdown 设定：',
  '```lfh-route',
  'mode: story | writing | character | ambiguous',
  'title: 作品、故事或角色名称（简短自然）',
  'character_name: 角色名（仅 mode 为 character 时填写）',
  '---',
  '整理后的单一 Markdown 设定（使用清晰二级标题；当 mode 为 ambiguous 时此处留空）',
  '```',
  '分类标准：',
  '- story（文游）：想玩互动叙事/跑团/剧情推演，或给出了世界观、规则、主角与开局行动/选择。',
  '- writing（写故事）：想写小说/同人、构思大纲、讨论人物关系、改写或续写文章正文。',
  '- character（角色互动）：想创建一个 AI 角色并直接聊天或扮演对戏，或直接贴出角色人设与对方对话。',
  '- ambiguous（模糊/中性试探）：仅打招呼、犹豫试探或信息过少，尚无法判断属于哪种模式。',
  '2) 在 ```lfh-route 围栏结束后，紧接着写出给用户的自然语言首轮回复：',
  '- 若为 story：自然开启第一幕具体场景与行动（如需选项可附 ```lfh-choices 围栏，如状态有数值变化可附 ```lfh-hud 围栏），不要跳出戏外做总结或分析，不要在正文里用“1/2/3”列菜单。',
  '- 若为 writing：像敏锐的创作搭档一样顺着用户的构思直接切入，不要套用“首先/其次/总结”的分点或客套，也不要写成说教。',
  '- 若为 character：直接以角色本人语气自然说出第一句问候或开场，不要客服腔、括号元评论或自称 AI。',
  '- 若为 ambiguous：温和、简短、自然地接住话头，一两句搭话并轻问一句即可，禁止推销产品功能、列举能力菜单或使用分点清单。',
  '- 当 mode 为 story、writing 或 character 时，在回复末尾附带一个单行 lfh-summary 围栏，用 15–25 字纯文本概括本轮进展（不含 Markdown）。',
  '若「我的记忆」或用户提供的「当前设定」中明确指定了文风、语气或格式偏好，以用户设定为准。',
].join('\n');

const MANUSCRIPT_INTENT_SYSTEM_PROMPT = [
  '你是 Folio 写故事模式的创作协作者，当前作者正在正文稿纸界面。',
  '你已自动获得「我的记忆」「作品设定」「正文参考窗口」和「近期聊天」上下文。',
  '请根据作者这次输入自然判断意图：',
  '- 若作者明确要求修改「作品设定」「我的记忆」或「分支笔记」：请使用 ```lfh-proposal 围栏提出增量修改提案，并在围栏外用一两句点明改动，不要长篇解释修改理由。',
  '- 若作者要求续写、扩写、改写或润色某段正文：请写出干净克制的小说正文（避免翻译腔、套路化 AI 比喻和说教式收尾），并附带 target: manuscript 的 ```lfh-proposal 围栏（有选区或替换原句时优先用 op: patch 配合 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE，在末尾续写用 op: append，整篇重写用 op: full）。',
  '- 若作者是在提问、讨论剧情漏洞、核对设定或闲聊而非要直接写入正文：直接像敏锐的创作搭档一样直奔重点回答（也可在开头附 ```lfh-manuscript-intent / intent: chat 围栏），不要套用“首先/其次/总结”的模板分点或客套寒暄；仅当作者明确要求大纲、人物表或分条拆解时才使用结构化清单。',
  '若「我的记忆」或「当前设定」中明确指定了文风、人称或结构偏好，以用户设定为准。',
].join('\n');

export function deriveEntryTitle(input: string, fallback = '未命名创作'): string {
  const cleaned = input
    .trim()
    .split(/[\n。！？!?]/, 1)[0]
    .replace(/^(?:我想|我要|帮我|请帮我|来个|开一个|建一个|写一个|玩一个|名称|姓名|标题)[：:\s]*/, '')
    .trim()
    .slice(0, 24);
  return cleaned || fallback;
}

/**
 * Recognizes explicit in-chat commands asking to convert the current session to another mode.
 */
export function detectNaturalModeSwitchIntent(input: string): StageAssetMode | null {
  const normalized = input.replace(/\s+/g, '').trim();
  if (!normalized || normalized.length > 48) return null;
  const switchMatch =
    /(?:转成|转为|切换成|切换到|切换为|改成|改为|换成|转去|切回|变成)(?:「)?(文游|互动故事|互动小说|写故事|写小说|小说|角色互动|角色聊天|对戏)(?:」)?/.exec(
      normalized,
    );
  if (!switchMatch) return null;
  const target = switchMatch[1];
  if (target === '文游' || target === '互动故事' || target === '互动小说') return 'story';
  if (target === '写故事' || target === '写小说' || target === '小说') return 'writing';
  return 'character';
}

/**
 * Heuristic fallback classifier when LLM output does not include an `lfh-route` metadata block.
 */
export function classifyEntryHeuristic(
  userInput: string,
  history: readonly TurnNode[] = [],
): EntryRouteMode {
  const explicitSwitch = detectNaturalModeSwitchIntent(userInput);
  if (explicitSwitch) return explicitSwitch;

  const combined = [...history.map((n) => n.content), userInput].join('\n').trim();
  if (!combined) return 'ambiguous';

  if (/(?:角色人设|角色设定|角色互动|角色聊天|扮演对戏|(?:创建|建|找|来)一个?.{0,16}角色|和.{1,16}聊天|^名称[：:]|^姓名[：:])/m.test(combined)) {
    return 'character';
  }
  if (/(?:写故事|写小说|同人|大纲|写正文|开书|小说草稿|稿纸|写一篇)/.test(combined)) {
    return 'writing';
  }
  if (/(?:文游|跑团|第一幕|状态栏|规则|世界观|主角|开局|剧情推进|冒险|攻略)/.test(combined)) {
    return 'story';
  }

  const trimmed = userInput.trim();
  if (
    trimmed.length < 18 &&
    /^(?:你好|您好|嗨|hi|hello|在吗|有人吗|随便聊聊|不知道|迷茫|想聊聊|试试|测试|嗯+|啊+|\?+|？+)$/i.test(
      trimmed,
    )
  ) {
    return 'ambiguous';
  }
  if (trimmed.length < 12 && history.length === 0 && /[?？]$/.test(trimmed)) {
    return 'ambiguous';
  }
  if (trimmed.length < 8 && history.length === 0) {
    return 'ambiguous';
  }

  return 'story';
}

interface ExtractedRouteFence {
  raw: string;
  innerLines: string[];
  closed: boolean;
  startIndex: number;
  endIndex: number;
}

function extractLeadingRouteFence(rawContent: string): {
  fence: ExtractedRouteFence | null;
  outsideContent: string;
} {
  const normalized = rawContent.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const openIdx = lines.findIndex((line) => /^(`{3,})lfh-route\s*$/.test(line));
  if (openIdx < 0) {
    return { fence: null, outsideContent: normalized };
  }
  const outerLen = /^(`{3,})/.exec(lines[openIdx])![1].length;
  let closedIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i += 1) {
    const closeMatch = /^(`{3,})\s*$/.exec(lines[i].trimEnd());
    if (closeMatch && closeMatch[1].length >= outerLen) {
      closedIdx = i;
      break;
    }
  }
  if (closedIdx < 0) {
    return {
      fence: {
        raw: lines.slice(openIdx).join('\n'),
        innerLines: lines.slice(openIdx + 1),
        closed: false,
        startIndex: openIdx,
        endIndex: lines.length - 1,
      },
      outsideContent: lines.slice(0, openIdx).join('\n').trim(),
    };
  }
  const outside = [...lines.slice(0, openIdx), ...lines.slice(closedIdx + 1)]
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  return {
    fence: {
      raw: lines.slice(openIdx, closedIdx + 1).join('\n'),
      innerLines: lines.slice(openIdx + 1, closedIdx),
      closed: true,
      startIndex: openIdx,
      endIndex: closedIdx,
    },
    outsideContent: outside,
  };
}

const ROUTE_FENCE_MARKERS = ['````lfh-route', '```lfh-route'] as const;

/**
 * Strips any active or partial `lfh-route` metadata fence during streaming so users
 * only see the natural assistant reply arriving in real time.
 */
export function visibleEntryRoutePrefix(rawContent: string): string {
  const normalized = rawContent.replace(/\r\n?/g, '\n');
  const { fence, outsideContent } = extractLeadingRouteFence(normalized);
  if (fence) {
    return fence.closed ? visibleReplyPrefix(outsideContent) : '';
  }
  const lastLine = normalized.split('\n').at(-1) ?? '';
  for (const marker of ROUTE_FENCE_MARKERS) {
    for (let size = marker.length - 1; size > 0; size -= 1) {
      if (lastLine === marker.slice(0, size)) {
        return normalized.slice(0, -size);
      }
    }
  }
  return visibleReplyPrefix(normalized);
}

function parseEntryRouteMode(rawMode: string | undefined): EntryRouteMode | null {
  if (!rawMode) return null;
  const m = rawMode.trim().toLowerCase();
  if (m === 'story' || m === 'writing' || m === 'character' || m === 'ambiguous') return m;
  if (m === '文游') return 'story';
  if (m === '写故事' || m === '写作') return 'writing';
  if (m === '角色互动' || m === '角色') return 'character';
  return null;
}

export function parseEntryRouteReply(
  rawContent: string,
  userInput: string,
  neutralHistory: readonly TurnNode[] = [],
  reasoningContent = '',
): EntryRouteResult {
  const { fence, outsideContent } = extractLeadingRouteFence(rawContent);
  const parsedProposals = parseProposalReply(outsideContent);
  const cleanedReply = parsedProposals.content.trim();

  if (fence && fence.closed) {
    const sepIdx = fence.innerLines.findIndex((line) => /^\s*---\s*$/.test(line));
    const headerLines = sepIdx >= 0 ? fence.innerLines.slice(0, sepIdx) : fence.innerLines;
    const bodyLines = sepIdx >= 0 ? fence.innerLines.slice(sepIdx + 1) : [];
    const fields: Record<string, string> = Object.create(null);
    for (const line of headerLines) {
      const m = /^([a-zA-Z_-]+)\s*[:：]\s*(.*)$/.exec(line.trim());
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }
    const parsedMode = parseEntryRouteMode(fields.mode);
    if (parsedMode) {
      const fallbackModeTitle =
        parsedMode === 'story' ? '新故事' : parsedMode === 'writing' ? '未命名作品' : '未命名角色';
      const title =
        fields.title?.trim() ||
        fields.character_name?.trim() ||
        deriveEntryTitle(userInput, fallbackModeTitle);
      const bodyMd = bodyLines.join('\n').trim();
      const settingMarkdown =
        parsedMode === 'ambiguous'
          ? ''
          : bodyMd || [...neutralHistory.filter((n) => n.role === 'user').map((n) => n.content), userInput].join('\n\n');
      return {
        mode: parsedMode,
        title,
        settingMarkdown,
        assistantReply: cleanedReply || '好的，我们从这里开始。',
        ...(parsedProposals.turnSummary ? { turnSummary: parsedProposals.turnSummary } : {}),
        ...(fields.character_name?.trim() ? { characterName: fields.character_name.trim() } : {}),
        reasoningContent,
        proposals: parsedProposals.proposals,
        unparsedBlocks: parsedProposals.unparsedBlocks,
        usedFallback: false,
      };
    }
  }

  const mode = classifyEntryHeuristic(userInput, neutralHistory);
  const fallbackTitle =
    mode === 'story' ? '新故事' : mode === 'writing' ? '未命名作品' : mode === 'character' ? '未命名角色' : '新对话';
  const title = deriveEntryTitle(userInput, fallbackTitle);
  const settingMarkdown =
    mode === 'ambiguous'
      ? ''
      : [...neutralHistory.filter((n) => n.role === 'user').map((n) => n.content), userInput]
          .filter(Boolean)
          .join('\n\n');

  return {
    mode,
    title,
    settingMarkdown,
    assistantReply: cleanedReply || outsideContent.trim() || '好的，我们从这里开始。',
    ...(parsedProposals.turnSummary ? { turnSummary: parsedProposals.turnSummary } : {}),
    ...(mode === 'character' ? { characterName: title } : {}),
    reasoningContent,
    proposals: parsedProposals.proposals,
    unparsedBlocks: parsedProposals.unparsedBlocks,
    usedFallback: true,
  };
}

export function buildEntryRouteMessages(
  userInput: string,
  neutralHistory: readonly TurnNode[] = [],
  publicMemoryMarkdown = '',
  promptPackOptions?: PromptPackContextOptions,
): LlmMessage[] {
  const effectivePromptPack = resolvePromptPackContext(promptPackOptions);
  const baseSystemPrompt = effectivePromptPack.enabled
    ? `${ENTRY_ROUTE_SYSTEM_PROMPT}\n${CHANGE_PROMPT}`
    : ENTRY_ROUTE_SYSTEM_PROMPT;
  const messages: LlmMessage[] = buildPromptPackAnchorMessages(baseSystemPrompt, effectivePromptPack);
  if (publicMemoryMarkdown.trim()) {
    messages.push({
      role: 'system',
      content: `以下是作为资料使用的「我的记忆」Markdown。\n\n${publicMemoryMarkdown}`,
    });
  }
  for (const node of excludeRefusedTurns(neutralHistory)) {
    messages.push({ role: node.role, content: node.content });
  }
  const tail = promptPackTailMessage(
    effectivePromptPack,
    promptPackOptions?.includePromptPackTail ?? promptPackOptions?.includeTail ?? false,
  );
  if (tail) messages.push(tail);
  messages.push({ role: 'user', content: userInput });
  return messages;
}

export async function routeEntryMessage(
  userInput: string,
  neutralHistory: readonly TurnNode[],
  transport: LlmTransport,
  config: ModelConfig,
  callbacks: TurnCallbacks = {},
  publicMemoryMarkdown = '',
  promptPackOptions?: PromptPackContextOptions,
  refusalOptions?: RefusalStreamIntegrationOptions,
): Promise<EntryRouteResult> {
  const messages = buildEntryRouteMessages(userInput, neutralHistory, publicMemoryMarkdown, promptPackOptions);
  const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
  const heuristicMode = classifyEntryHeuristic(userInput, neutralHistory);
  const routePrefillMode = heuristicMode === 'ambiguous' ? 'story' : heuristicMode;
  const result = await streamWithRefusalHandling({
    transport,
    config,
    messages,
    callbacks,
    mode: refusalOptions?.mode ?? routePrefillMode,
    ...(promptPackOptions ? { promptPackOptions } : {}),
    ...(refusalOptions?.promptPackOptions
      ? { promptPackOptions: refusalOptions.promptPackOptions }
      : {}),
    prefixContent: `\`\`\`lfh-route\nmode: ${routePrefillMode}\n`,
    ...(refusalOptions?.characterName ? { characterName: refusalOptions.characterName } : {}),
    ...(refusalOptions?.onDiagnostic ? { onDiagnostic: refusalOptions.onDiagnostic } : {}),
    toVisibleContent: visibleEntryRoutePrefix,
  });

  if (callbacks.signal?.aborted) {
    const abortErr = new Error('操作已中止。');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  if (result.finishReason !== 'stop' && !result.content.trim()) {
    throw new Error('回复未完成，请重试。');
  }
  return {
    ...parseEntryRouteReply(result.content, userInput, neutralHistory, result.reasoningContent),
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...(result.prefillContent ? { prefillContent: result.prefillContent } : {}),
    model: config.model,
    reasoningEffort,
  };
}


export { normalizeGenerationPreference } from './keyConfig.ts';

/**
 * Materializes neutral (unpersisted) or existing turns + setting Markdown into a persisted target mode asset.
 */
export function materializeAssetFromNodes(opts: {
  targetMode: StageAssetMode;
  title: string;
  settingMarkdown: string;
  turns: readonly TurnNode[];
  body?: string;
  characterName?: string;
  generationPreference?: GenerationPreference;
  createId?: () => string;
  now?: number;
}): { story?: Story; work?: DraftWork; character?: LocalCharacter } {
  const createId = opts.createId ?? createDefaultId;
  const now = opts.now ?? Date.now();
  const generationPreference = normalizeGenerationPreference(opts.generationPreference);
  const clonedNodes: TurnNode[] = [];
  const idMap = new Map<string, string>();
  for (const turn of opts.turns) {
    const freshId = createId();
    idMap.set(turn.id, freshId);
  }
  let prevId: string | null = null;
  for (const turn of opts.turns) {
    const newId = idMap.get(turn.id)!;
    const mappedParent = turn.parentId && idMap.has(turn.parentId) ? idMap.get(turn.parentId)! : prevId;
    clonedNodes.push({
      ...turn,
      id: newId,
      parentId: mappedParent,
      summarySnapshot: turn.summarySnapshot ?? EMPTY_SUMMARY_SNAPSHOT,
    });
    prevId = newId;
  }

  const nodeMap: Record<string, TurnNode> = {};
  for (const n of clonedNodes) {
    nodeMap[n.id] = n;
  }
  const leafId = clonedNodes.at(-1)?.id ?? null;

  if (opts.targetMode === 'story') {
    const storyId = createId();
    const containerDoc = newDocument(opts.settingMarkdown, 'user', 'story-original');
    const localDoc = newDocument('', 'migration', 'path-original');
    const rootNodeIds = clonedNodes.filter((n) => n.parentId === null).map((n) => n.id);
    const story: Story = {
      id: storyId,
      title: opts.title.trim() || '新故事',
      sourceKind: 'manual_script',
      v2Migrated: true,
      ...(generationPreference ? { generationPreference } : {}),
      rawScript: '',
      blueprint: createDefaultBlueprint(opts.title.trim() || '新故事'),
      documents: {
        container: containerDoc,
        local: localDoc,
        edits: {},
      },
      nodes: Object.fromEntries(
        clonedNodes.map((n) => [
          n.id,
          { ...n, documents: { container: containerDoc.head, local: localDoc.head } },
        ]),
      ),
      rootNodeIds,
      activeLeafNodeId: leafId,
      createdAt: now,
      updatedAt: now,
    };
    return { story };
  }

  if (opts.targetMode === 'writing') {
    const baseWork = newWork(opts.title.trim() || '未命名作品', opts.settingMarkdown);
    const work: DraftWork = {
      ...baseWork,
      ...(generationPreference ? { generationPreference } : {}),
      body: opts.body ?? '',
      writingStarted: Boolean(opts.body?.trim()),
      discussion: clonedNodes,
      discussionNodes: nodeMap,
      activeDiscussionLeafId: leafId,
    };
    return { work };
  }

  const charName = opts.characterName?.trim() || opts.title.trim() || '未命名角色';
  const baseChar = newCharacter(charName, opts.settingMarkdown);
  const conv = newConversation(baseChar, 'personal', '', clonedNodes[0]?.content.slice(0, 20));
  conv.nodes = nodeMap;
  conv.activeLeafNodeId = leafId;
  const character: LocalCharacter = {
    ...baseChar,
    ...(generationPreference ? { generationPreference } : {}),
    conversations: [conv],
    activeConversationId: conv.id,
  };
  return { character };
}

/**
 * Losslessly converts an active Story / DraftWork / LocalCharacter into another mode,
 * preserving setting Markdown and active conversation nodes.
 */
export function convertActiveAssetMode(opts: {
  fromMode: StageAssetMode;
  toMode: StageAssetMode;
  story?: Story;
  work?: DraftWork;
  character?: LocalCharacter;
  workspace?: CreativeWorkspaceState;
  createId?: () => string;
  now?: number;
}): { story?: Story; work?: DraftWork; character?: LocalCharacter } {
  let title = '未命名创作';
  let settingMarkdown = '';
  let turns: TurnNode[] = [];
  let body = '';
  let generationPreference: GenerationPreference | undefined;

  if (opts.fromMode === 'story' && opts.story) {
    title = opts.story.title;
    generationPreference = opts.story.generationPreference;
    if (opts.story.documents) {
      const scoped = { ...opts.story, documents: opts.story.documents };
      const state = storyDocumentState(scoped, opts.story.activeLeafNodeId, true);
      settingMarkdown = documentVersion(scoped.documents.container, state.container).markdown;
    } else {
      settingMarkdown = opts.story.rawScript;
    }
    turns = getActiveBranchNodes(opts.story);
  } else if (opts.fromMode === 'writing' && opts.work) {
    title = opts.work.title;
    generationPreference = opts.work.generationPreference;
    settingMarkdown = documentVersion(opts.work.document).markdown;
    turns = getWorkActiveDiscussionNodes(opts.work);
    body = opts.work.body;
  } else if (opts.fromMode === 'character' && opts.character) {
    title = opts.character.name;
    generationPreference = opts.character.generationPreference;
    settingMarkdown = documentVersion(opts.character.document).markdown;
    const conv = opts.character.conversations.find((c) => c.id === opts.character!.activeConversationId);
    turns = conv ? getActiveBranchNodes(conv) : [];
  }

  return materializeAssetFromNodes({
    targetMode: opts.toMode,
    title,
    settingMarkdown,
    turns,
    body,
    characterName: opts.toMode === 'character' ? title : undefined,
    generationPreference,
    createId: opts.createId,
    now: opts.now,
  });
}

const MANUSCRIPT_INTENT_MARKERS = ['````lfh-manuscript-intent', '```lfh-manuscript-intent'] as const;

function extractManuscriptIntentFence(raw: string): {
  intent: 'chat' | 'suggestion' | null;
  cleaned: string;
  openIncomplete: boolean;
} {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const openIdx = lines.findIndex((line) => /^(`{3,})lfh-manuscript-intent\s*$/.test(line));
  if (openIdx < 0) {
    return { intent: null, cleaned: normalized, openIncomplete: false };
  }
  const outerLen = /^(`{3,})/.exec(lines[openIdx])![1].length;
  let closedIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i += 1) {
    const closeMatch = /^(`{3,})\s*$/.exec(lines[i].trimEnd());
    if (closeMatch && closeMatch[1].length >= outerLen) {
      closedIdx = i;
      break;
    }
  }
  if (closedIdx < 0) {
    return { intent: null, cleaned: lines.slice(0, openIdx).join('\n').trim(), openIncomplete: true };
  }
  const inner = lines.slice(openIdx + 1, closedIdx);
  let intent: 'chat' | 'suggestion' | null = null;
  for (const line of inner) {
    const m = /^intent\s*[:：]\s*(chat|suggestion)\s*$/i.exec(line.trim());
    if (m) intent = m[1].toLowerCase() as 'chat' | 'suggestion';
  }
  const cleaned = [...lines.slice(0, openIdx), ...lines.slice(closedIdx + 1)]
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  return { intent, cleaned, openIncomplete: false };
}

export function visibleManuscriptReplyPrefix(raw: string): string {
  const { cleaned, openIncomplete } = extractManuscriptIntentFence(raw);
  if (openIncomplete) return cleaned;
  const lastLine = cleaned.split('\n').at(-1) ?? '';
  for (const marker of MANUSCRIPT_INTENT_MARKERS) {
    for (let size = marker.length - 1; size > 0; size -= 1) {
      if (lastLine === marker.slice(0, size)) {
        return cleaned.slice(0, -size);
      }
    }
  }
  return cleaned;
}

export function getManuscriptIntentSystemPrompt(): string {
  return `${MANUSCRIPT_INTENT_SYSTEM_PROMPT}\n${CHANGE_PROMPT}`;
}

export function parseManuscriptAssistantReply(
  rawContent: string,
  _userPrompt: string,
  reasoningContent = '',
): ManuscriptReplyIntent {
  const { intent, cleaned } = extractManuscriptIntentFence(rawContent);
  const parsed = parseProposalReply(cleaned);

  if (parsed.proposals.length > 0 || parsed.unparsedBlocks.length > 0) {
    return {
      kind: 'proposal',
      content: parsed.content || '请核对下方的设定更新建议。',
      ...(parsed.turnSummary ? { turnSummary: parsed.turnSummary } : {}),
      proposals: parsed.proposals,
      unparsedBlocks: parsed.unparsedBlocks,
      reasoningContent,
    };
  }

  if (intent === 'suggestion') {
    return {
      kind: 'suggestion',
      text: parsed.content || cleaned,
      content: parsed.content || cleaned,
      ...(parsed.turnSummary ? { turnSummary: parsed.turnSummary } : {}),
      reasoningContent,
    };
  }

  return {
    kind: 'chat',
    content: parsed.content || cleaned,
    ...(parsed.turnSummary ? { turnSummary: parsed.turnSummary } : {}),
    reasoningContent,
  };
}
