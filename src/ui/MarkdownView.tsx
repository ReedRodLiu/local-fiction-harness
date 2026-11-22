import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { isHudCodeBlock, type AssistantMode } from '../harness/index.ts';

export interface MarkdownViewProps {
  content: string;
  mode?: AssistantMode;
  className?: string;
  'data-testid'?: string;
  renderHud?: (code: string, key: string) => ReactNode;
}

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

export function isSafeHref(href: string | undefined | null): boolean {
  if (!href) return false;
  const cleaned = href.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!cleaned) return false;
  if (cleaned.startsWith('#')) return true;
  try {
    const parsed = new URL(cleaned);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function renderInlineTokens(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens || tokens.length === 0) return [];
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          return <Fragment key={key}>{renderInlineTokens(textToken.tokens, key)}</Fragment>;
        }
        return <Fragment key={key}>{textToken.text}</Fragment>;
      }
      case 'escape':
        return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
      case 'codespan':
        return (
          <code key={key} className="md-inline-code">
            {(token as Tokens.Codespan).text}
          </code>
        );
      case 'strong':
        return <strong key={key}>{renderInlineTokens((token as Tokens.Strong).tokens, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInlineTokens((token as Tokens.Em).tokens, key)}</em>;
      case 'del':
        return <del key={key}>{renderInlineTokens((token as Tokens.Del).tokens, key)}</del>;
      case 'br':
        return <br key={key} />;
      case 'link': {
        const linkToken = token as Tokens.Link;
        const children = linkToken.tokens?.length
          ? renderInlineTokens(linkToken.tokens, key)
          : linkToken.text;
        if (!isSafeHref(linkToken.href)) {
          return (
            <span key={key} className="md-blocked-link">
              {children}
            </span>
          );
        }
        const cleanedHref = linkToken.href.trim();
        const isHashAnchor = cleanedHref.startsWith('#');
        return (
          <a
            key={key}
            href={cleanedHref}
            title={linkToken.title ?? undefined}
            rel={isHashAnchor ? undefined : 'noopener noreferrer'}
            target={isHashAnchor ? undefined : '_blank'}
          >
            {children}
          </a>
        );
      }
      case 'image': {
        const imageToken = token as Tokens.Image;
        return (
          <span key={key} className="md-image-alt">
            [图片: {imageToken.text || '未命名'}]
          </span>
        );
      }
      case 'checkbox': {
        const checkbox = token as Tokens.Checkbox;
        return (
          <input
            key={key}
            type="checkbox"
            className="md-task-checkbox"
            checked={Boolean(checkbox.checked)}
            disabled
            readOnly
            aria-label={checkbox.checked ? '已完成' : '未完成'}
          />
        );
      }
      case 'html':
        return <Fragment key={key}>{token.raw}</Fragment>;
      default:
        return <Fragment key={key}>{token.raw}</Fragment>;
    }
  });
}

function renderHeading(depth: number, key: string, children: ReactNode[]): ReactNode {
  switch (depth) {
    case 1:
      return <h1 key={key}>{children}</h1>;
    case 2:
      return <h2 key={key}>{children}</h2>;
    case 3:
      return <h3 key={key}>{children}</h3>;
    case 4:
      return <h4 key={key}>{children}</h4>;
    case 5:
      return <h5 key={key}>{children}</h5>;
    default:
      return <h6 key={key}>{children}</h6>;
  }
}

export function renderMarkdownTokens(
  tokens: Token[],
  options: {
    mode?: AssistantMode;
    renderHud?: (code: string, key: string) => ReactNode;
    keyPrefix?: string;
  } = {},
): ReactNode[] {
  const mode = options.mode ?? 'story';
  const keyPrefix = options.keyPrefix ?? 'md';

  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading': {
        const heading = token as Tokens.Heading;
        return renderHeading(heading.depth, key, renderInlineTokens(heading.tokens, key));
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph;
        return <p key={key}>{renderInlineTokens(paragraph.tokens, key)}</p>;
      }
      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        return (
          <blockquote key={key}>
            {renderMarkdownTokens(quote.tokens, { ...options, keyPrefix: key })}
          </blockquote>
        );
      }
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => {
          const itemKey = `${key}-item-${itemIndex}`;
          return (
            <li key={itemKey}>
              {renderMarkdownTokens(item.tokens, { ...options, keyPrefix: itemKey })}
            </li>
          );
        });
        if (list.ordered) {
          return (
            <ol key={key} start={typeof list.start === 'number' && list.start !== 1 ? list.start : undefined}>
              {items}
            </ol>
          );
        }
        return <ul key={key}>{items}</ul>;
      }
      case 'table': {
        const table = token as Tokens.Table;
        return (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {table.header.map((cell, cIdx) => (
                    <th key={`${key}-h-${cIdx}`} style={cell.align ? { textAlign: cell.align } : undefined}>
                      {renderInlineTokens(cell.tokens, `${key}-h-${cIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rIdx) => (
                  <tr key={`${key}-r-${rIdx}`}>
                    {row.map((cell, cIdx) => (
                      <td key={`${key}-r-${rIdx}-c-${cIdx}`} style={cell.align ? { textAlign: cell.align } : undefined}>
                        {renderInlineTokens(cell.tokens, `${key}-r-${rIdx}-c-${cIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case 'code': {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? '').trim().toLowerCase();
        if (options.renderHud && isHudCodeBlock(lang, codeToken.text, mode)) {
          return options.renderHud(codeToken.text, key);
        }
        return (
          <pre key={key} className="md-code-block" data-lang={lang || undefined}>
            <code>{codeToken.text}</code>
          </pre>
        );
      }
      case 'hr':
        return <hr key={key} className="md-hr" />;
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        return (
          <p key={key} className="md-escaped-html">
            {htmlToken.raw}
          </p>
        );
      }
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          return <Fragment key={key}>{renderInlineTokens(textToken.tokens, key)}</Fragment>;
        }
        return <Fragment key={key}>{textToken.text}</Fragment>;
      }
      case 'checkbox': {
        const checkbox = token as Tokens.Checkbox;
        return (
          <input
            key={key}
            type="checkbox"
            className="md-task-checkbox"
            checked={Boolean(checkbox.checked)}
            disabled
            readOnly
            aria-label={checkbox.checked ? '已完成' : '未完成'}
          />
        );
      }
      default:
        return (
          <p key={key} className="md-escaped-html">
            {token.raw}
          </p>
        );
    }
  });
}

export function lexMarkdownTokens(content: string): Token[] {
  if (!content) return [];
  return marked.lexer(content, { gfm: true, breaks: true });
}

export const MarkdownView = memo(function MarkdownView({
  content,
  mode = 'story',
  className,
  'data-testid': dataTestId,
  renderHud,
}: MarkdownViewProps) {
  const tokens = useMemo(() => lexMarkdownTokens(content), [content]);
  const combinedClassName = className ? `md-view ${className}` : 'md-view';

  return (
    <div className={combinedClassName} data-testid={dataTestId}>
      {renderMarkdownTokens(tokens, { mode, renderHud })}
    </div>
  );
});
