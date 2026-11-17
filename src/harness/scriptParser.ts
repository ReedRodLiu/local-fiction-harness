import { unzipSync } from 'fflate';

export type ScriptInput =
  | { kind: 'paste'; text: string; title?: string }
  | { kind: 'file'; fileName: string; bytes: Uint8Array };

export interface ParsedScript {
  suggestedTitle: string;
  rawScript: string;
  sourceType: 'docx' | 'md' | 'txt' | 'paste';
}

interface TextDecoderLike {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

type TextDecoderCtor = new (label?: string, options?: { fatal?: boolean }) => TextDecoderLike;

function getTextDecoderCtor(): TextDecoderCtor {
  const ctor = (globalThis as { TextDecoder?: TextDecoderCtor }).TextDecoder;
  if (!ctor) {
    throw new Error('TextDecoder is not available in this JavaScript runtime.');
  }
  return ctor;
}

function decodeTextBytes(bytes: Uint8Array): string {
  const Decoder = getTextDecoderCtor();
  try {
    const utf8 = new Decoder('utf-8', { fatal: true }).decode(bytes);
    return utf8.replace(/^\uFEFF/, '');
  } catch {
    return new Decoder('gb18030').decode(bytes).replace(/^\uFEFF/, '');
  }
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
  const normalized = pXml
    .replace(/<w:tab(?:\s+[^>]*)?\/>/g, '\t')
    .replace(/<w:br(?:\s+[^>]*)?\/>/g, '\n')
    .replace(/<w:cr(?:\s+[^>]*)?\/>/g, '\n');

  let result = '';
  const textTagRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = textTagRegex.exec(normalized)) !== null) {
    result += decodeXmlEntities(match[1]);
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
  if (level > 0) {
    return `${'#'.repeat(level)} ${text}`;
  }
  return text;
}

function matchTopLevelBlocks(bodyXml: string): Array<{ type: 'p' | 'tbl'; xml: string }> {
  const blocks: Array<{ type: 'p' | 'tbl'; xml: string }> = [];
  let cursor = 0;

  while (cursor < bodyXml.length) {
    const nextP = bodyXml.indexOf('<w:p', cursor);
    const nextTbl = bodyXml.indexOf('<w:tbl', cursor);
    if (nextP === -1 && nextTbl === -1) break;

    const useTbl = nextTbl !== -1 && (nextP === -1 || nextTbl < nextP);
    const tag = useTbl ? 'w:tbl' : 'w:p';
    const start = useTbl ? nextTbl : nextP;
    const afterName = bodyXml[start + tag.length + 1];
    if (afterName !== '>' && afterName !== ' ' && afterName !== '/') {
      cursor = start + tag.length + 1;
      continue;
    }

    const openTagEnd = bodyXml.indexOf('>', start);
    if (openTagEnd === -1) break;
    if (bodyXml[openTagEnd - 1] === '/') {
      cursor = openTagEnd + 1;
      continue;
    }

    const closeTag = `</${tag}>`;
    let depth = 1;
    let searchPos = openTagEnd + 1;
    let endPos = -1;

    while (depth > 0) {
      const nextOpen = bodyXml.indexOf(`<${tag}`, searchPos);
      const nextClose = bodyXml.indexOf(closeTag, searchPos);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        const ch = bodyXml[nextOpen + tag.length + 1];
        if (ch === '>' || ch === ' ') {
          const innerEnd = bodyXml.indexOf('>', nextOpen);
          if (innerEnd !== -1 && bodyXml[innerEnd - 1] !== '/') {
            depth += 1;
          }
        }
        searchPos = nextOpen + tag.length + 1;
      } else {
        depth -= 1;
        endPos = nextClose + closeTag.length;
        searchPos = endPos;
      }
    }

    if (endPos === -1) break;
    blocks.push({ type: useTbl ? 'tbl' : 'p', xml: bodyXml.slice(start, endPos) });
    cursor = endPos;
  }

  return blocks;
}

function formatTable(tblXml: string): string {
  const rowRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  const rows: string[][] = [];
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tblXml)) !== null) {
    const cellRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      const cellLines: string[] = [];
      let pMatch: RegExpExecArray | null;
      while ((pMatch = pRegex.exec(cellMatch[1])) !== null) {
        const text = extractParagraphText(pMatch[0]);
        if (text) cellLines.push(text);
      }
      cells.push(cellLines.join(' ').replace(/\|/g, '\\|').trim());
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const padRow = (r: string[]) =>
    `| ${Array.from({ length: colCount }, (_, i) => r[i] ?? '').join(' | ')} |`;

  const lines = [
    padRow(rows[0]),
    `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map(padRow),
  ];
  return lines.join('\n');
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

  const xml = decodeTextBytes(docBytes);
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  const blocks = matchTopLevelBlocks(bodyXml);
  const parts: string[] = [];

  for (const block of blocks) {
    const formatted = block.type === 'tbl' ? formatTable(block.xml) : formatParagraph(block.xml);
    if (formatted) {
      parts.push(formatted);
    }
  }

  return parts.join('\n\n').trim();
}

function deriveTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return base || '未命名剧本';
}

function deriveTitleFromText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#*\s「『【]+|[」』】\s]+$/g, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '未命名剧本';
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
}

/**
 * Pure client-side script parser supporting .docx (paragraphs, headings, and tables),
 * .md, .txt (UTF-8 with GB18030 fallback), and direct pasted text.
 */
export async function parseScriptInput(input: ScriptInput): Promise<ParsedScript> {
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

  const rawScript = decodeTextBytes(input.bytes).replace(/\r\n/g, '\n').trim();
  if (!rawScript) {
    throw new Error('导入的文件内容为空。');
  }

  return {
    suggestedTitle,
    rawScript,
    sourceType: lowerName.endsWith('.md') ? 'md' : 'txt',
  };
}
