import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import type { Token, Tokens } from 'marked';
import {
  extractAssistantChoices,
  isHudCodeBlock,
  parseHudFields,
  stripProposalBlocksForDisplay,
  type AssistantMode,
  type ParsedChoice,
} from '../harness/index.ts';
import { lexMarkdownTokens, renderMarkdownTokens } from './MarkdownView.tsx';

interface MessageContentProps {
  content: string;
  mode?: AssistantMode;
  showChoices?: boolean;
  disabled?: boolean;
  onSelectChoice?: (choiceText: string) => void;
  afterContent?: ReactNode;
}

function stripTrailingChoices(content: string, choices: ParsedChoice[]): string {
  if (choices.length === 0) return content;
  const choiceLines = new Set(choices.map((choice) => choice.fullText.trim()));
  const lines = content.split(/\r?\n/);
  let index = lines.length - 1;
  let remaining = choiceLines.size;

  while (index >= 0 && remaining > 0) {
    const line = lines[index].trim();
    if (!line) {
      index -= 1;
      continue;
    }
    if (!choiceLines.has(line)) break;
    remaining -= 1;
    index -= 1;
  }

  return remaining === 0 ? lines.slice(0, index + 1).join('\n').trimEnd() : content;
}

function HudPanel({ code }: { code: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const parsedHud = parseHudFields(code);
  const showGrid = parsedHud !== null && !showRaw;

  return (
    <section className="hud-panel" data-testid="hud-panel" aria-label="状态面板">
      <header className="hud-panel-header">
        <button
          type="button"
          className="hud-panel-title"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Terminal size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>状态面板</span>
        </button>
        <div className="hud-panel-actions">
          {!collapsed && parsedHud && (
            <button
              type="button"
              className="hud-view-toggle"
              aria-pressed={showRaw}
              onClick={() => setShowRaw((value) => !value)}
            >
              {showRaw ? '网格视图' : '原始格式'}
            </button>
          )}
          <button
            type="button"
            className="hud-collapse-toggle"
            data-testid="hud-collapse-toggle"
            aria-label={collapsed ? '展开状态面板' : '折叠状态面板'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? (
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {!collapsed && (
        showGrid ? (
          <>
            {parsedHud.heading && <div className="hud-grid-heading">{parsedHud.heading}</div>}
            <dl className="hud-grid" data-testid="hud-grid">
              {parsedHud.fields.map((field, index) => (
                <div
                  key={`${field.key}-${index}`}
                  className={`hud-field${field.isWide ? ' hud-field-wide' : ''}`}
                  data-testid={field.isWide ? 'hud-field-wide' : undefined}
                >
                  <dt>{field.key}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <pre className="hud-panel-raw" data-testid="hud-raw-view">
            <code>{code}</code>
          </pre>
        )
      )}
    </section>
  );
}

type PartitionedBlock =
  | { type: 'hud'; code: string }
  | { type: 'markdown'; tokens: Token[] };

function partitionTokens(tokens: Token[], mode: AssistantMode): PartitionedBlock[] {
  const blocks: PartitionedBlock[] = [];
  let currentRun: Token[] = [];

  const flushRun = () => {
    const meaningful = currentRun.some((token) => token.type !== 'space' && token.type !== 'def');
    if (meaningful) {
      blocks.push({ type: 'markdown', tokens: currentRun });
    }
    currentRun = [];
  };

  for (const token of tokens) {
    if (token.type === 'code') {
      const codeToken = token as Tokens.Code;
      if (isHudCodeBlock(codeToken.lang, codeToken.text, mode)) {
        flushRun();
        blocks.push({ type: 'hud', code: codeToken.text });
        continue;
      }
    }
    currentRun.push(token);
  }

  flushRun();
  return blocks;
}

export function MessageContent({
  content,
  mode = 'story',
  showChoices = false,
  disabled = false,
  onSelectChoice,
  afterContent,
}: MessageContentProps) {
  const { visibleChoices, blocks } = useMemo(() => {
    const clean = stripProposalBlocksForDisplay(content);
    const { displayContent, choices } = extractAssistantChoices(clean);
    const activeChoices = showChoices && onSelectChoice ? choices : [];
    const narrativeMarkdown = stripTrailingChoices(displayContent, activeChoices);
    const tokens = lexMarkdownTokens(narrativeMarkdown);
    return {
      visibleChoices: activeChoices,
      blocks: partitionTokens(tokens, mode),
    };
  }, [content, mode, showChoices, onSelectChoice]);

  return (
    <div className="message-content">
      {blocks.map((block, idx) =>
        block.type === 'hud' ? (
          <HudPanel key={`hud-${idx}`} code={block.code} />
        ) : (
          <div key={`md-${idx}`} className="turn-body md-view" data-testid="turn-body">
            {renderMarkdownTokens(block.tokens, { mode, keyPrefix: `seg-${idx}` })}
          </div>
        ),
      )}

      {afterContent}

      {visibleChoices.length > 0 && (
        <div className="choices-row" role="group" aria-label="快捷选项" data-testid="choice-row">
          {visibleChoices.map((choice, idx) => (
            <button
              key={`choice-${choice.key}-${idx}`}
              type="button"
              className="btn choice-btn"
              data-testid="choice-option"
              aria-label={choice.fullText}
              disabled={disabled}
              onClick={() => onSelectChoice?.(choice.fullText)}
            >
              <span className="choice-badge" aria-hidden="true">{choice.key}</span>
              <span>{choice.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
