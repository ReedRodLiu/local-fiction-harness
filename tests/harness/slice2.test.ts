import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createFictionHarness,
  parseBlueprintResponse,
  parseScriptInput,
  type LlmStreamRequest,
  type LlmTransport,
} from '../../src/harness/index.ts';

function buildSyntheticDocx(): Uint8Array {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="2"/></w:pPr>
      <w:r><w:t>第一章：规则总纲 &amp; 禁忌</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>每次输出必须附带状态栏。</w:t><w:br/><w:t>第二行</w:t><w:tab/><w:t>对齐</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>角色</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>好感度</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>备注</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>沈砚</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>20</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>表面冷淡</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

  return zipSync({
    'word/document.xml': strToU8(documentXml),
  });
}

describe('Slice 2: Free-format script parsing (.docx / .md / .txt / paste)', () => {
  it('extracts paragraphs, heading levels, entities, and tables from .docx OOXML', async () => {
    const docxBytes = buildSyntheticDocx();
    const parsed = await parseScriptInput({
      kind: 'file',
      fileName: '宫廷测试.docx',
      bytes: docxBytes,
    });

    expect(parsed.suggestedTitle).toBe('宫廷测试');
    expect(parsed.rawScript).toContain('## 第一章：规则总纲 & 禁忌');
    expect(parsed.rawScript).toContain('每次输出必须附带状态栏。\n第二行\t对齐');
    expect(parsed.rawScript).toContain('| 角色 | 好感度 | 备注 |');
    expect(parsed.rawScript).toContain('| 沈砚 | 20 | 表面冷淡 |');
  });

  it('parses pasted script text and derives suggested title cleanly', () => {
    const pasted = parseScriptInput({
      kind: 'paste',
      text: '【海岛恋综测试】\r\n规则一：每晚匿名投票。\r\nA. 邀请对话\r\nB. 独自离开',
    });
    expect(pasted.sourceType).toBe('paste');
    expect(pasted.suggestedTitle).toBe('海岛恋综测试');
    expect(pasted.rawScript).toContain('规则一：每晚匿名投票。');
  });

  it('decodes UTF-8 and falls back to GB18030 for legacy .txt files while preserving markers', async () => {
    // "测试剧本" in GB18030: 测(B2 E2) 试(CA D4) 剧(BE E7) 本(B1 BE)
    const gbBytes = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4, 0xbe, 0xe7, 0xb1, 0xbe]);
    const parsedGb = await parseScriptInput({
      kind: 'file',
      fileName: 'legacy.txt',
      bytes: gbBytes,
    });
    expect(parsedGb.rawScript).toBe('测试剧本');

    const mdText = '【核心铁律】\n严禁越权。\n```\n[体力: 100]\n```\nA. 前往大厅\nB. 原地休息';
    const parsedMd = await parseScriptInput({
      kind: 'file',
      fileName: 'rules.md',
      bytes: new TextEncoder().encode(mdText),
    });
    expect(parsedMd.rawScript).toBe(mdText);
  });
});

describe('Slice 2: Blueprint extraction & full rawScript anchoring', () => {
  it('parses fenced JSON preceded by prose/thinking into a complete StoryBlueprint', () => {
    const rawResponse = `<think>分析角色设定</think>
好的，以下是提取结果：
\`\`\`json
{
  "title": "星光练习生",
  "worldRules": ["每周进行一次舞台考核", "淘汰制不可逆"],
  "protagonist": "林知夏（练习生）",
  "npcs": [{"name": "顾川", "role": "声乐导师", "traits": "严格但公正"}],
  "taboos": ["禁止无故缺席训练"],
  "openingHook": "推开练习室门，镜墙前已经站着三名队友。"
}
\`\`\``;

    const blueprint = parseBlueprintResponse(rawResponse, '默认标题');
    expect(blueprint.extractionStatus).toBe('complete');
    expect(blueprint.title).toBe('星光练习生');
    expect(blueprint.worldRules).toHaveLength(2);
    expect(blueprint.npcs[0]?.name).toBe('顾川');
    expect(blueprint.taboos).toEqual(['禁止无故缺席训练']);
  });

  it('degrades gracefully to partial_fallback when model output is malformed or truncated', () => {
    const blueprint = parseBlueprintResponse('抱歉，我无法输出完整JSON {title: broken', '备用剧本名');
    expect(blueprint.extractionStatus).toBe('partial_fallback');
    expect(blueprint.title).toBe('备用剧本名');
    expect(blueprint.worldRules).toEqual([]);
  });

  it('extracts blueprint via LLM and retains full rawScript plus confirmed blueprint in turn system prompt', async () => {
    const capturedRequests: LlmStreamRequest[] = [];
    let callCount = 0;

    const transport: LlmTransport = {
      async *streamChat(req) {
        capturedRequests.push(req);
        callCount += 1;
        if (callCount === 1) {
          yield { reasoningDelta: '先梳理人物和规则' };
          yield {
            contentDelta: JSON.stringify({
              title: '校园规则怪谈',
              worldRules: ['十一点准时熄灯'],
              protagonist: '高二学生',
              npcs: [{ name: '宿管阿姨', role: '管理员', traits: '只看证件' }],
              taboos: ['不可回应走廊呼唤'],
              openingHook: '铃声刚落，宿管敲响了门。',
            }),
            finishReason: 'stop',
          };
        } else {
          yield { contentDelta: '门外传来缓慢的脚步声。', finishReason: 'stop' };
        }
      },
    };

    const harness = createFictionHarness({ transport });
    const rawScript = '【隐藏细则】每周三食堂二楼不供应番茄炒蛋。\n【核心铁律】十一点熄灯，不可回应走廊呼唤。';
    const blueprint = await harness.extractStoryBlueprint(
      rawScript,
      { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'k', memoryOnly: true },
      '校园测试',
    );

    expect(blueprint.extractionStatus).toBe('complete');
    expect(blueprint.title).toBe('校园规则怪谈');

    const confirmedBlueprint = {
      ...blueprint,
      taboos: [...blueprint.taboos, '用户补充禁忌：不可单独进地下室'],
    };
    const story = harness.createStory({
      title: confirmedBlueprint.title,
      rawScript,
      blueprint: confirmedBlueprint,
    });

    await harness.runTurn(story, '我查看门缝外的情况', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'k',
      memoryOnly: true,
    });

    expect(capturedRequests).toHaveLength(2);
    const systemPrompt = capturedRequests[1].messages.find((m) => m.role === 'system')?.content ?? '';
    // Raw script details omitted from blueprint MUST still be anchored
    expect(systemPrompt).toContain('每周三食堂二楼不供应番茄炒蛋');
    // User edits to confirmed blueprint MUST also appear
    expect(systemPrompt).toContain('用户补充禁忌：不可单独进地下室');
  });
});
