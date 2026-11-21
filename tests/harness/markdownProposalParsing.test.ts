import { describe, expect, it } from 'vitest';
import { splitMarkdownReply, visibleReplyPrefix } from '../../src/harness/markdownDocuments.ts';

describe('Markdown proposal parsing', () => {
  it('reports an ordinary reply without changing its content', () => {
    expect(splitMarkdownReply('普通回复')).toEqual({ content: '普通回复', proposalStatus: 'none' });
  });

  it('reports an invalid marker as invalid even when it leaves no visible content', () => {
    const result = splitMarkdownReply('```lfh-change\n{"target":"unknown","markdown":"bad"}\n```');
    expect(result).toEqual({ content: '', proposalStatus: 'invalid' });
  });

  it('recognizes a valid proposal with JSON whitespace between object lines', () => {
    const reply = [
      '请核对文档。',
      '```lfh-change',
      '{',
      '  "target": "local",',
      '  "markdown": "第一行\\n第二行",',
      '  "name": null',
      '}',
      '```',
    ].join('\n');

    expect(splitMarkdownReply(reply)).toEqual({
      content: '请核对文档。',
      proposalStatus: 'recognized',
      proposal: { target: 'local', markdown: '第一行\n第二行', name: undefined },
    });
  });

  it('rejects a raw newline inside a JSON string', () => {
    const reply = '```lfh-change\n{"target":"local","markdown":"第一行\n第二行"}\n```';
    expect(splitMarkdownReply(reply)).toEqual({ content: '', proposalStatus: 'invalid' });
  });

  it('requires a non-empty name only for character proposals', () => {
    const character = (name: string) => `\`\`\`lfh-change\n{"target":"character","markdown":"角色资料","name":${name}}\n\`\`\``;
    expect(splitMarkdownReply(character('"灯客"')).proposalStatus).toBe('recognized');
    expect(splitMarkdownReply(character('null')).proposalStatus).toBe('invalid');
  });

  it('rejects multiple blocks and content after the closing fence', () => {
    const block = '```lfh-change\n{"target":"local","markdown":"内容"}\n```';
    expect(splitMarkdownReply(`${block}\n${block}`).proposalStatus).toBe('invalid');
    expect(splitMarkdownReply(`${block}\n额外内容`).proposalStatus).toBe('invalid');
  });

  it('keeps proposal payload out of the visible streaming prefix', () => {
    const reply = '请核对。\n```lfh-change\n{\n  "target": "local",\n  "markdown": "秘密草稿"\n}\n```';
    expect(visibleReplyPrefix(reply)).toBe('请核对。\n');
    expect(visibleReplyPrefix(reply)).not.toContain('秘密草稿');
  });
});
