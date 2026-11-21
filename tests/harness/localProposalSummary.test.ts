import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  createInMemoryStoryStorage,
  editStoryDocument,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

const testConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'fixture',
  model: 'deepseek-chat',
  memoryOnly: true,
};

const confirmedProgress = '## 当前进度\n\nCONFIRMED_PROGRESS_MARKER';

function proposalReply(target: string, markdown: string, name?: string): string {
  return [
    '拟保存资料，请核对。',
    '```lfh-change',
    JSON.stringify({ target, markdown, ...(name ? { name } : {}) }),
    '```',
  ].join('\n');
}

function isSummaryRequest(request: LlmStreamRequest): boolean {
  return (request.messages[0]?.content ?? '').includes('剧情摘要压缩');
}

describe('local proposal and automatic summary ordering', () => {
  it('keeps a historical local proposal saveable, then compresses its confirmed content before continuing', async () => {
    const storage = createInMemoryStoryStorage();
    const requests: LlmStreamRequest[] = [];
    let narrationCount = 0;
    const transport: LlmTransport = {
      async *streamChat(request) {
        requests.push(request);
        if (isSummaryRequest(request)) {
          const prompt = request.messages[1]?.content ?? '';
          yield {
            contentDelta: prompt.includes('CONFIRMED_PROGRESS_MARKER')
              ? '已读取确认进度的压缩摘要'
              : '分支 A 摘要',
            finishReason: 'stop',
          };
          return;
        }

        narrationCount += 1;
        if (narrationCount === 3) {
          yield { contentDelta: proposalReply('local', confirmedProgress), finishReason: 'stop' };
          return;
        }
        yield { contentDelta: `叙事回复${narrationCount}`, finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      transport,
      storage,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 5000 },
    });

    const initial = await harness.createAndSaveStory({ title: '历史节点提案测试' });
    const first = await harness.runTurn(initial, '开场', testConfig);
    const branchA = await harness.runTurn(first.story, '进入分支 A', testConfig);
    const branchASummaryCount = requests.filter(isSummaryRequest).length;
    expect(branchASummaryCount).toBe(1);

    const historical = await harness.rewindToNode(branchA.story, first.assistantNode.id);
    const branchB = await harness.runTurn(historical, '进入分支 B 并整理当前进度', testConfig);
    expect(branchB.proposal).toEqual({ target: 'local', markdown: confirmedProgress, name: undefined });
    expect(requests.filter(isSummaryRequest)).toHaveLength(branchASummaryCount);

    const localRead = branchB.assistantNode.documentReads?.find((read) => read.scope === 'local');
    expect(localRead?.versionId).toBe(first.assistantNode.documents?.local);
    expect(branchB.assistantNode.documents?.local).toBe(localRead?.versionId);

    const staleBranchVersion = branchA.assistantNode.documents?.local;
    expect(staleBranchVersion).toBeTruthy();
    expect(staleBranchVersion).not.toBe(localRead?.versionId);
    expect(() => editStoryDocument(branchB.story, 'local', staleBranchVersion!, confirmedProgress))
      .toThrow(/当前路径的文档已变化/);

    const confirmed = editStoryDocument(branchB.story, 'local', localRead!.versionId, branchB.proposal!.markdown);
    await harness.saveStory(confirmed, branchB.story.updatedAt);
    const saved = await storage.getStory(branchB.story.id);
    expect(saved?.documents?.edits[branchB.assistantNode.id]).toBe(confirmed.documents?.edits[branchB.assistantNode.id]);

    const priorRequestCount = requests.length;
    await harness.runTurn(saved!, '继续故事', testConfig);
    const nextRequests = requests.slice(priorRequestCount);
    const summaryIndex = nextRequests.findIndex(isSummaryRequest);
    const continuationIndex = nextRequests.findIndex((request) => !isSummaryRequest(request));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(continuationIndex);
    expect(nextRequests[summaryIndex].messages[1]?.content).toContain('CONFIRMED_PROGRESS_MARKER');
    expect(nextRequests[continuationIndex].messages.map((message) => message.content).join('\n'))
      .toContain('已读取确认进度的压缩摘要');
  });

  it.each([
    {
      name: 'ordinary reply',
      reply: '普通叙事回复',
      finishReason: 'stop',
      proposal: undefined,
    },
    {
      name: 'invalid proposal',
      reply: '回执\n```lfh-change\n{"target":"unknown","markdown":"无效"}\n```',
      finishReason: 'stop',
      proposal: undefined,
    },
    {
      name: 'truncated local proposal',
      reply: proposalReply('local', confirmedProgress),
      finishReason: 'length',
      proposal: undefined,
    },
    {
      name: 'completed non-local proposal',
      reply: proposalReply('container', '## 故事资料\n\n容器提案'),
      finishReason: 'stop',
      proposal: { target: 'container', markdown: '## 故事资料\n\n容器提案', name: undefined },
    },
    {
      name: 'completed public proposal',
      reply: proposalReply('public', '## 公共记忆\n\n公共提案'),
      finishReason: 'stop',
      proposal: { target: 'public', markdown: '## 公共记忆\n\n公共提案', name: undefined },
    },
    {
      name: 'completed character proposal',
      reply: proposalReply('character', '角色人设提案', '新角色'),
      finishReason: 'stop',
      proposal: { target: 'character', markdown: '角色人设提案', name: '新角色' },
    },
  ])('$name still runs the end-of-turn summary', async ({ reply, finishReason, proposal }) => {
    const requests: LlmStreamRequest[] = [];
    let narrationCount = 0;
    const transport: LlmTransport = {
      async *streamChat(request) {
        requests.push(request);
        if (isSummaryRequest(request)) {
          yield { contentDelta: '滚动摘要', finishReason: 'stop' };
          return;
        }
        narrationCount += 1;
        yield narrationCount === 2
          ? { contentDelta: reply, finishReason }
          : { contentDelta: '第一轮叙事', finishReason: 'stop' };
      },
    };
    const harness = createFictionHarness({
      transport,
      contextBudget: { recentMaxNodes: 2, recentMaxChars: 5000 },
    });

    const first = await harness.runTurn(harness.createStory({ title: '提案边界测试' }), '第一轮', testConfig);
    const second = await harness.runTurn(first.story, '第二轮', testConfig);

    expect(second.proposal).toEqual(proposal);
    expect(requests.filter(isSummaryRequest)).toHaveLength(1);
  });
});
