import { unzipSync } from 'fflate';
import { decodeUtf8WithGbFallback } from './encoding.ts';

export const DEFAULT_STORY_TITLE = '未命名故事';

export type ScriptInput =
  | { kind: 'paste'; text: string; title?: string }
  | { kind: 'file'; fileName: string; bytes: Uint8Array };

export interface ParsedScript {
  suggestedTitle: string;
  rawScript: string;
  sourceType: 'docx' | 'md' | 'txt' | 'paste';
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractParagraphText(pXml: string): string {
  const tokenRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)(?:\s+[^>]*)?\/>/g;
  let result = '';
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(pXml)) !== null) {
    if (match[1] !== undefined) {
      result += decodeXmlEntities(match[1]);
    } else if (match[2] === 'tab') {
      result += '\t';
    } else {
      result += '\n';
    }
  }
  return result.trim();
}

function extractHeadingLevel(pXml: string): number {
  const styleMatch = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(pXml);
  if (!styleMatch) return 0;
  const val = styleMatch[1].trim();
  const headingMatch = /^(?:Heading|heading|标题)\s*([1-6])$/.exec(val) ?? /^([1-6])$/.exec(val);
  return headingMatch ? Number(headingMatch[1]) : 0;
}

function formatParagraph(pXml: string): string {
  const text = extractParagraphText(pXml);
  if (!text) return '';
  const level = extractHeadingLevel(pXml);
  return level > 0 ? `${'#'.repeat(level)} ${text}` : text;
}

function findMatchingTagEnd(xml: string, tag: string, openTagEnd: number): number {
  const closeTag = `</${tag}>`;
  let depth = 1;
  let pos = openTagEnd + 1;

  while (depth > 0) {
    const nextOpen = xml.indexOf(`<${tag}`, pos);
    const nextClose = xml.indexOf(closeTag, pos);
    if (nextClose === -1) return -1;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const ch = xml[nextOpen + tag.length + 1];
      if (ch === '>' || ch === ' ') {
        const innerEnd = xml.indexOf('>', nextOpen);
        if (innerEnd !== -1 && xml[innerEnd - 1] !== '/') {
          depth += 1;
        }
      }
      pos = nextOpen + tag.length + 1;
    } else {
      depth -= 1;
      pos = nextClose + closeTag.length;
    }
  }
  return pos;
}

function extractTopLevelElements(xml: string, tags: readonly string[]): Array<{ tag: string; xml: string }> {
  const items: Array<{ tag: string; xml: string }> = [];
  let cursor = 0;

  while (cursor < xml.length) {
    let bestTag: string | null = null;
    let bestStart = -1;
    for (const tag of tags) {
      const idx = xml.indexOf(`<${tag}`, cursor);
      if (idx !== -1 && (bestStart === -1 || idx < bestStart)) {
        bestStart = idx;
        bestTag = tag;
      }
    }
    if (!bestTag || bestStart === -1) break;

    const afterName = xml[bestStart + bestTag.length + 1];
    if (afterName !== '>' && afterName !== ' ' && afterName !== '/') {
      cursor = bestStart + bestTag.length + 1;
      continue;
    }

    const openEnd = xml.indexOf('>', bestStart);
    if (openEnd === -1) break;
    if (xml[openEnd - 1] === '/') {
      cursor = openEnd + 1;
      continue;
    }

    const endPos = findMatchingTagEnd(xml, bestTag, openEnd);
    if (endPos === -1) break;
    items.push({ tag: bestTag, xml: xml.slice(bestStart, endPos) });
    cursor = endPos;
  }
  return items;
}

function formatCellContent(cellXml: string): string {
  const inner = cellXml.replace(/^<w:tc\b[^>]*>|<\/w:tc>$/g, '');
  const blocks = extractTopLevelElements(inner, ['w:p', 'w:tbl']);
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.tag === 'w:p') {
      const text = extractParagraphText(block.xml);
      if (text) parts.push(text);
    } else {
      const nestedRows = extractTableRows(block.xml);
      parts.push(nestedRows.map((r) => r.join(' / ')).join('; '));
    }
  }
  return parts.join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

function extractTableRows(tblXml: string): string[][] {
  const inner = tblXml.replace(/^<w:tbl\b[^>]*>|<\/w:tbl>$/g, '');
  const rowBlocks = extractTopLevelElements(inner, ['w:tr']);
  const rows: string[][] = [];

  for (const row of rowBlocks) {
    const rowInner = row.xml.replace(/^<w:tr\b[^>]*>|<\/w:tr>$/g, '');
    const cellBlocks = extractTopLevelElements(rowInner, ['w:tc']);
    const cells = cellBlocks.map((cell) => formatCellContent(cell.xml));
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function formatTable(tblXml: string): string {
  const rows = extractTableRows(tblXml);
  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const padRow = (r: string[]) =>
    `| ${Array.from({ length: colCount }, (_, i) => r[i] ?? '').join(' | ')} |`;

  return [
    padRow(rows[0]),
    `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map(padRow),
  ].join('\n');
}

function parseDocxBytes(bytes: Uint8Array): string {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error('无法解压 .docx 文件，请确认文件未损坏且为标准 Word (.docx) 格式。');
  }

  const docBytes = archive['word/document.xml'];
  if (!docBytes) {
    throw new Error('.docx 文件缺少 word/document.xml 正文内容。');
  }

  const xml = decodeUtf8WithGbFallback(docBytes);
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  const blocks = extractTopLevelElements(bodyXml, ['w:p', 'w:tbl']);
  const parts: string[] = [];

  for (const block of blocks) {
    const formatted = block.tag === 'w:tbl' ? formatTable(block.xml) : formatParagraph(block.xml);
    if (formatted) {
      parts.push(formatted);
    }
  }

  return parts.join('\n\n').trim();
}

function deriveTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return base || DEFAULT_STORY_TITLE;
}

function deriveTitleFromText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#*\s「『【]+|[」』】\s]+$/g, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return DEFAULT_STORY_TITLE;
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
}

/**
 * Pure client-side script parser supporting .docx (paragraphs, headings, and tables),
 * .md, .txt (UTF-8 with GB18030 fallback), and direct pasted text.
 */
export function parseScriptInput(input: ScriptInput): ParsedScript {
  if (input.kind === 'paste') {
    const rawScript = input.text.replace(/\r\n/g, '\n').trim();
    if (!rawScript) {
      throw new Error('剧本文本不能为空。');
    }
    return {
      suggestedTitle: input.title?.trim() || deriveTitleFromText(rawScript),
      rawScript,
      sourceType: 'paste',
    };
  }

  const lowerName = input.fileName.toLowerCase();
  const suggestedTitle = deriveTitleFromFileName(input.fileName);

  if (lowerName.endsWith('.docx')) {
    const rawScript = parseDocxBytes(input.bytes);
    if (!rawScript) {
      throw new Error('.docx 文件未提取到有效文本内容。');
    }
    return { suggestedTitle, rawScript, sourceType: 'docx' };
  }

  const rawScript = decodeUtf8WithGbFallback(input.bytes).replace(/\r\n/g, '\n').trim();
  if (!rawScript) {
    throw new Error('导入的文件内容为空。');
  }

  return {
    suggestedTitle,
    rawScript,
    sourceType: lowerName.endsWith('.md') ? 'md' : 'txt',
  };
}
