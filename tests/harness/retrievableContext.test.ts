import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY_SNAPSHOT,
  assembleCreativeThreeZoneContext,
  assembleThreeZoneContext,
  createDefaultBlueprint,
  documentVersion,
  newDocument,
  retrieveCoveredBranchContext,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

function turn(
  id: string,
  parentId: string | null,
  role: TurnNode['role'],
  content: string,
  createdAt: number,
  extra: Partial<TurnNode> = {},
): TurnNode {
  return {
    id,
    parentId,
    role,
    content,
    createdAt,
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    ...extra,
  };
}

describe('retrievableContext production retrieval', () => {
  it('retrieves positive-score covered ancestors on active branch without leaking sibling branches or recent nodes', () => {
    const nodes: Record<string, TurnNode> = {
      u1: turn('u1', null, 'user', '我们在钟楼发现了共同的青铜密码盘。', 100),
      a1: turn('a1', 'u1', 'assistant', '共同前情：钟楼青铜密码盘刻着北星七号。', 101),
      u2: turn('u2', 'a1', 'user', '甲线：林舟把铜钥匙缝在袖口内侧。', 200),
      a2: turn('a2', 'u2', 'assistant', '甲线回执：林舟确认袖口藏好了铜钥匙。', 201),
      u3: turn('u3', 'a1', 'user', '乙线 SECRET_SIBLING_ONLY：林舟把铜钥匙扔进了枯井。', 250),
      a3: turn('a3', 'u3', 'assistant', '乙线回执 SECRET_SIBLING_ONLY：枯井里的铜钥匙沉底了。', 251),
      u4: turn('u4', 'a2', 'user', '最近一轮对话：我们推开仓库铁门。', 300),
      a4: turn('a4', 'u4', 'assistant', '最近一轮回应：仓库里点着油灯。', 301),
    };

    const result = retrieveCoveredBranchContext({
      nodes,
      targetParentId: 'a4',
      coveredUpToNodeId: 'a2',
      excludeNodeIds: new Set(['u4', 'a4']),
      query: '林舟 铜钥匙 SECRET_SIBLING_ONLY',
      limit: 3,
    });

    const selectedText = result.selected.map((item) => item.content).join('\n');
    expect(result.pathNodeIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u4', 'a4']);
    expect(selectedText).toContain('袖口内侧');
    expect(selectedText).not.toContain('SECRET_SIBLING_ONLY');
    expect(selectedText).not.toContain('仓库铁门');
    expect(result.selected.every((item) => item.score > 0)).toBe(true);
  });

  it('excludes REFUSAL turns and respects chronological order & character caps', () => {
    const nodes: Record<string, TurnNode> = {
      n1: turn('n1', null, 'user', '银屑留在暗格深处。', 10),
      n2: turn('n2', 'n1', 'assistant', '抱歉，我无法回应银屑与暗格。', 20, {
        diagnostics: { sourceStatus: 'REFUSAL', refusalRoute: 'refused_exhausted' },
      }),
      n3: turn('n3', 'n2', 'user', '暗格里有一封盖着老闸印章的信。', 30),
      n4: turn('n4', 'n3', 'assistant', '最近一轮。', 40),
    };

    const result = retrieveCoveredBranchContext({
      nodes,
      targetParentId: 'n4',
      coveredUpToNodeId: 'n3',
      excludeNodeIds: new Set(['n4']),
      query: '暗格 银屑 老闸',
      limit: 3,
    });

    const ids = result.selected.map((item) => item.node.id);
    expect(ids).toEqual(['n1', 'n3']);
    expect(ids).not.toContain('n2');
  });

  it('wires covered-node retrieval and compression char metrics into assembleThreeZoneContext and assembleCreativeThreeZoneContext', () => {
    const nodes: Record<string, TurnNode> = {
      u0: turn('u0', null, 'user', '前夜旅店外下着冷雨，街灯在雾里泛黄。'.repeat(12), 0),
      a0: turn('a0', 'u0', 'assistant', '店伙计递来热茶，窗棂发出细碎风声。'.repeat(12), 0.5),
      u1: turn('u1', 'a0', 'user', '共同伏笔：沈砚随身带着半枚缺角铜牌。'.repeat(12), 1),
      a1: turn('a1', 'u1', 'assistant', '共同前情：缺角铜牌背面刻着老闸码头。'.repeat(12), 2),
      u2: turn('u2', 'a1', 'user', '旁支 B 线 SIBLING_CANARY：沈砚烧掉了铜牌。', 3),
      u3: turn('u3', 'a1', 'user', '最近问：外头下着小雨。', 4),
      a3: turn('a3', 'u3', 'assistant', '最近答：风声穿过长廊。', 5, {
        summarySnapshot: {
          content: '沈砚曾查到老闸线索。',
          coveredUpToNodeId: 'a1',
          summarizedTurnCount: 4,
        },
      }),
    };

    const story: Story = {
      id: 's-retrieve',
      title: '钟楼旧事',
      rawScript: '# 钟楼旧事',
      blueprint: createDefaultBlueprint('钟楼旧事'),
      nodes,
      rootNodeIds: ['u0'],
      activeLeafNodeId: 'a3',
      createdAt: 1,
      updatedAt: 5,
    };

    const storyCtx = assembleThreeZoneContext(story, 'a3', '检查铜牌和老闸线索');
    const storyPayload = storyCtx.messages.map((m) => m.content).join('\n');
    expect(storyPayload).toContain('按需回取当前分支前情');
    expect(storyPayload).toContain('老闸码头');
    expect(storyPayload).not.toContain('SIBLING_CANARY');
    expect(storyCtx.metrics.retrievedNodeCount).toBeGreaterThan(0);
    expect(storyCtx.metrics.uncompressedPromptChars!).toBeGreaterThan(
      storyCtx.metrics.compressedPromptChars!,
    );

    const creativeCtx = assembleCreativeThreeZoneContext({
      systemPrompt: '角色扮演规则',
      documents: [['设定', documentVersion(newDocument('人设详情'))]],
      nodes,
      targetParentId: 'a3',
      userInput: '再看看那枚铜牌',
    });
    const creativePayload = creativeCtx.messages.map((m) => m.content).join('\n');
    expect(creativePayload).toContain('按需回取当前分支前情');
    expect(creativePayload).not.toContain('SIBLING_CANARY');
    expect(creativeCtx.metrics.retrievedNodeCount).toBeGreaterThan(0);
  });
});
