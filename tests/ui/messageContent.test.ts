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
          '```lfh-choices',
          'A. 搜查书桌',
          'B. 离开房间',
          '```',
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

  it('falls back to the full raw state block when an explicit HUD fence cannot find key-value pairs', () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, { content: '```lfh-hud\n无法识别的状态描述\n```' }),
    );

    expect(markup).toContain('data-testid="hud-raw-view"');
    expect(markup).toContain('无法识别的状态描述');
    expect(markup).not.toContain('data-testid="hud-grid"');

    const plainCode = renderToStaticMarkup(
      createElement(MessageContent, { content: '```text\n无法识别的状态描述\n```' }),
    );
    expect(plainCode).not.toContain('data-testid="hud-panel"');
    expect(plainCode).toContain('<pre class="md-code-block" data-lang="text"><code>无法识别的状态描述</code></pre>');
  });

  it('falls back to the full raw state block when free text is mixed with fields in an explicit HUD fence', () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: '```lfh-hud\n地点: 东楼\n不可解析但不能丢失\n人气: 60\n```',
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

  it('renders bare lfh-choices as choice buttons while preserving bold, lists, and GFM tables', () => {
    const content = [
      '**重点线索**已出现：',
      '- 铜钥匙',
      '- 泛黄的信笺',
      '',
      '| 区域 | 状态 |',
      '|---|---|',
      '| 东楼 | 封锁 |',
      '',
      'lfh-choices  ',
      'A. 撬开东楼门锁',
      'B. 先回客厅休息',
    ].join('\n');

    const activeMarkup = renderToStaticMarkup(
      createElement(MessageContent, {
        content,
        showChoices: true,
        onSelectChoice: () => undefined,
      }),
    );

    expect(activeMarkup).toContain('<strong>重点线索</strong>');
    expect(activeMarkup).toContain('<ul><li>铜钥匙</li><li>泛黄的信笺</li></ul>');
    expect(activeMarkup).toContain('<table class="md-table">');
    expect(activeMarkup).toContain('data-testid="choice-row"');
    expect(activeMarkup).toContain('data-testid="choice-option"');
    expect(activeMarkup).toContain('aria-label="A. 撬开东楼门锁"');
    expect(activeMarkup).not.toContain('lfh-choices');
    expect(activeMarkup).not.toContain('撬开东楼门锁</p>');

    const historyMarkup = renderToStaticMarkup(
      createElement(MessageContent, {
        content,
        showChoices: false,
      }),
    );

    expect(historyMarkup).not.toContain('data-testid="choice-row"');
    expect(historyMarkup).not.toContain('lfh-choices');
    expect(historyMarkup).toContain('A. 撬开东楼门锁');
    expect(historyMarkup).toContain('B. 先回客厅休息');
  });

  it('renders unclosed and 4-backtick fenced lfh-choices as choice buttons and keeps plain lists intact', () => {
    const unclosedMarkup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: '雾气弥漫。\n\n````lfh-choices   \nA. 举起提灯\nB. 原地聆听',
        showChoices: true,
        onSelectChoice: () => undefined,
      }),
    );

    expect(unclosedMarkup).toContain('data-testid="choice-row"');
    expect(unclosedMarkup).toContain('aria-label="A. 举起提灯"');
    expect(unclosedMarkup).not.toContain('lfh-choices');

    const plainListMarkup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: '1. 物品\n2. 笔记',
        showChoices: true,
        onSelectChoice: () => undefined,
      }),
    );

    expect(plainListMarkup).toContain('<ol><li>物品</li><li>笔记</li></ol>');
    expect(plainListMarkup).not.toContain('data-testid="choice-row"');
  });
});
