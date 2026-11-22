import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView, isSafeHref } from '../../src/ui/MarkdownView.tsx';
import { MessageContent } from '../../src/ui/MessageContent.tsx';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('MarkdownView pure React renderer', () => {
  it('never uses dangerouslySetInnerHTML in MarkdownView', () => {
    const source = readFileSync(join(repoRoot, 'src', 'ui', 'MarkdownView.tsx'), 'utf8');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders GFM headings, emphasis, lists, blockquotes, tables, code, and horizontal rules', () => {
    const md = [
      '# 一级标题',
      '',
      '包含 **加粗**、*斜体*、~~删除线~~ 与 `行内代码`。',
      '',
      '> 这是一段引用。',
      '',
      '- 项目一',
      '- 项目二',
      '',
      '| 角色 | 状态 |',
      '| :--- | ---: |',
      '| 岑灯 | 正常 |',
      '',
      '---',
      '',
      '```ts',
      'const level = 1;',
      '```',
    ].join('\n');

    const markup = renderToStaticMarkup(createElement(MarkdownView, { content: md }));
    expect(markup).toContain('<h1>一级标题</h1>');
    expect(markup).toContain('<strong>加粗</strong>');
    expect(markup).toContain('<em>斜体</em>');
    expect(markup).toContain('<del>删除线</del>');
    expect(markup).toContain('<code class="md-inline-code">行内代码</code>');
    expect(markup).toContain('<blockquote>');
    expect(markup).toContain('<ul>');
    expect(markup).toContain('<div class="md-table-wrap"><table class="md-table">');
    expect(markup).toContain('<hr class="md-hr"/>');
    expect(markup).toContain('<pre class="md-code-block" data-lang="ts"><code>const level = 1;</code></pre>');
  });

  it('renders raw HTML blocks and inline HTML strictly as escaped plain text', () => {
    const md = [
      '<script>alert("xss")</script>',
      '',
      '正文包含 <img src=x onerror=alert(1)> 标签。',
    ].join('\n');

    const markup = renderToStaticMarkup(createElement(MarkdownView, { content: md }));
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('enforces strict link protocol allowlist and adds safe external attributes', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://localhost:3000')).toBe(true);
    expect(isSafeHref('mailto:test@example.com')).toBe(true);
    expect(isSafeHref('#section-1')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);

    const md = [
      '[官网](https://example.com)',
      '[锚点](#top)',
      '[危险](javascript:alert(1))',
      '[数据](data:text/html,hi)',
    ].join(' ');

    const markup = renderToStaticMarkup(createElement(MarkdownView, { content: md }));
    expect(markup).toContain('<a href="https://example.com" rel="noopener noreferrer" target="_blank">官网</a>');
    expect(markup).toContain('<a href="#top">锚点</a>');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('data:text/html');
    expect(markup).toContain('<span class="md-blocked-link">危险</span>');
  });
});

describe('HudPanel mode isolation in MessageContent', () => {
  it('renders explicit lfh-hud/hud/status fences as HudPanel in all modes', () => {
    const content = '正文\n```lfh-hud\n时间: 深夜\n地点: 渡口\n```';
    for (const mode of ['story', 'writing', 'character'] as const) {
      const markup = renderToStaticMarkup(createElement(MessageContent, { content, mode }));
      expect(markup).toContain('data-testid="hud-panel"');
      expect(markup).toContain('data-testid="hud-grid"');
      expect(markup).toContain('data-testid="turn-body"');
    }
  });

  it('does not hijack untagged or normal codeblocks in writing and character modes', () => {
    const content = [
      '给你一段设定参考：',
      '```text',
      '地点: 东楼',
      '人气: 60',
      '```',
      '```python',
      'print("ok")',
      '```',
    ].join('\n');

    for (const mode of ['writing', 'character'] as const) {
      const markup = renderToStaticMarkup(createElement(MessageContent, { content, mode }));
      expect(markup).not.toContain('data-testid="hud-panel"');
      expect(markup).toContain('class="md-code-block"');
    }

    const storyMarkup = renderToStaticMarkup(createElement(MessageContent, { content, mode: 'story' }));
    expect(storyMarkup).toContain('data-testid="hud-panel"');
    expect(storyMarkup).toContain('class="md-code-block" data-lang="python"');
  });

  it('strips lfh-proposal blocks from streamed or completed message display', () => {
    const content = [
      '我来帮你加上这条设定。',
      '```lfh-proposal',
      'target: setting',
      'op: append',
      'summary: 增加银匕首',
      '---',
      '- 武器：银匕首',
      '```',
      '请确认是否采纳。',
    ].join('\n');

    const markup = renderToStaticMarkup(createElement(MessageContent, { content, mode: 'writing' }));
    expect(markup).toContain('我来帮你加上这条设定。');
    expect(markup).toContain('请确认是否采纳。');
    expect(markup).not.toContain('lfh-proposal');
    expect(markup).not.toContain('target: setting');
  });
});
