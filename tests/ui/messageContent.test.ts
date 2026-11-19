import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../../src/ui/MessageContent.tsx';

describe('MessageContent', () => {
  it('renders parseable state as a grid and keeps choice letters in accessible names', () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: [
          '你来到东楼。',
          '```text',
          '[状态 | 人气: 60 | 地点: 东楼 | 长线索: 这是一个需要在状态面板中完整保留并跨两列显示的较长线索描述]',
          '```',
          'A. 搜查书桌',
          'B. 离开房间',
        ].join('\n'),
        showChoices: true,
        onSelectChoice: () => undefined,
      }),
    );

    expect(markup).toContain('data-testid="hud-grid"');
    expect(markup).toContain('<div class="hud-grid-heading">状态</div>');
    expect(markup).toContain('class="hud-field hud-field-wide"');
    expect(markup).toContain('data-testid="choice-row"');
    expect(markup).toContain('aria-label="A. 搜查书桌"');
    expect(markup).toContain('class="choice-badge" aria-hidden="true">A</span>');
  });

  it('falls back to the full raw state block when it cannot find key-value pairs', () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, { content: '```text\n无法识别的状态描述\n```' }),
    );

    expect(markup).toContain('data-testid="hud-raw-view"');
    expect(markup).toContain('无法识别的状态描述');
    expect(markup).not.toContain('data-testid="hud-grid"');
  });

  it('falls back to the full raw state block when free text is mixed with fields', () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: '```text\n地点: 东楼\n不可解析但不能丢失\n人气: 60\n```',
      }),
    );

    expect(markup).toContain('data-testid="hud-raw-view"');
    expect(markup).toContain('不可解析但不能丢失');
    expect(markup).not.toContain('data-testid="hud-grid"');
  });

  it('spans values with twenty CJK glyphs across both grid columns', () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: '```text\n地点: 东楼\n线索: 这是二十个中文字符需要跨越两列完整显示完成\n人气: 60\n```',
      }),
    );

    expect(markup).toContain('class="hud-field hud-field-wide"');
  });
});
