import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { parseAssistantMessage, type ParsedChoice } from '../harness/index.ts';

interface MessageContentProps {
  content: string;
  showChoices?: boolean;
  disabled?: boolean;
  onSelectChoice?: (choiceText: string) => void;
  afterContent?: ReactNode;
}

interface HudField {
  key: string;
  value: string;
  isWide: boolean;
}

interface ParsedHud {
  heading: string | null;
  fields: HudField[];
}

function parseHudFields(code: string): ParsedHud | null {
  const trimmed = code.trim();
  const hasBracketedHeading = trimmed.startsWith('[') && trimmed.endsWith(']');
  const body = hasBracketedHeading ? trimmed.slice(1, -1) : trimmed;
  let heading: string | null = null;
  const parts = body.split(/\r?\n|[|｜]/).map((part) => part.trim()).filter(Boolean);
  const fields: HudField[] = [];

  for (const [index, part] of parts.entries()) {
    const separator = part.search(/[:：]/);
    if (separator < 1) {
      if (hasBracketedHeading && index === 0) {
        heading = part;
        continue;
      }
      return null;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key || !value) return null;
    const cjkGlyphCount = Array.from(value).filter((glyph) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(glyph),
    ).length;
    fields.push({
      key,
      value,
      isWide: value.length >= 28 || cjkGlyphCount >= 20,
    });
  }

  return fields.length >= 2 ? { heading, fields } : null;
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

export function MessageContent({
  content,
  showChoices = false,
  disabled = false,
  onSelectChoice,
  afterContent,
}: MessageContentProps) {
  const parsed = parseAssistantMessage(content);
  const visibleChoices = showChoices && onSelectChoice ? parsed.choices : [];
  const finalTextSegment = parsed.segments.reduce(
    (lastIndex, segment, index) => (segment.type === 'text' ? index : lastIndex),
    -1,
  );

  return (
    <div className="message-content">
      {parsed.segments.map((seg, idx) =>
        seg.type === 'codeblock' ? (
          <HudPanel key={`code-${idx}`} code={seg.code} />
        ) : (
          <div key={`text-${idx}`} className="turn-body" data-testid="turn-body">
            {idx === finalTextSegment
              ? stripTrailingChoices(seg.content, visibleChoices)
              : seg.content}
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
