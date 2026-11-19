import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = 'src/ui/styles/tokens.css';
const THEME_NAMES = ['light', 'dark', 'warm'];
const ICON_IMPORT_PATTERN = /(?:icon|heroicons|fontawesome|react-feather|phosphor)/i;
const NAMED_COLOR_PATTERN = /\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)\b/i;
const COLOR_TOKEN_NAME_PATTERN = /^--(?:bg|text|border|action|accent|status)-[\w-]+$/;
const HEX_COLOR_VALUE_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const RGBA_COLOR_VALUE_PATTERN = /^rgba\(\s*(?:(?:\d+(?:\.\d+)?|\.\d+)\s*,\s*){3}(?:0(?:\.\d+)?|1(?:\.0+)?|(?:0?\.\d+))\s*\)$/i;
const COLOR_DECLARATION_PATTERN = /(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-[\w-]+)?|outline(?:-[\w-]+)?|text-decoration-color|text-emphasis-color|column-rule-color|caret-color|scrollbar-color|box-shadow|text-shadow|filter|fill|stroke|accent-color)\s*:\s*([^;{}]+)/gi;
const CUSTOM_PROPERTY_VALUE_PATTERN = /--[\w-]+\s*:\s*([^;{}]+)/g;
const TSX_COLOR_VALUE_PATTERN = /\b(?:color|background|backgroundColor|borderColor|borderTopColor|borderRightColor|borderBottomColor|borderLeftColor|outlineColor|textDecorationColor|textEmphasisColor|columnRuleColor|caretColor|scrollbarColor|boxShadow|textShadow|fill|stroke|accentColor)\s*:\s*(['"`])([a-z]+)\1/gi;

function listUiFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listUiFiles(entryPath);
    return /\.(?:css|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function parseThemes(tokensCss) {
  const themes = new Map();
  const pattern = /\[data-theme\s*=\s*["']?(light|dark|warm)["']?\][^{]*\{([^}]*)\}/g;
  for (const match of tokensCss.matchAll(pattern)) {
    const name = match[1];
    const keys = new Set(
      Array.from(match[2].matchAll(/--([\w-]+)\s*:/g), (keyMatch) => keyMatch[1]),
    );
    themes.set(name, keys);
  }
  return themes;
}

function hasColorLiteral(source) {
  return /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i.test(source);
}

function namedColorInUiLine(line) {
  const cssValues = Array.from(line.matchAll(COLOR_DECLARATION_PATTERN), (match) => match[1]);
  const customValues = Array.from(line.matchAll(CUSTOM_PROPERTY_VALUE_PATTERN), (match) => match[1]);
  const tsxValues = Array.from(line.matchAll(TSX_COLOR_VALUE_PATTERN), (match) => match[2]);
  return [...cssValues, ...customValues, ...tsxValues].some((value) => NAMED_COLOR_PATTERN.test(value));
}

function colorLiteralLines(source) {
  const lines = source.split(/\r?\n/);
  const violations = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const allowed = /\/\*\s*ui-token-allow:\s*[^*]+\*\//i.test(line) ||
      /\/\*\s*ui-token-allow:\s*[^*]+\*\//i.test(lines[index - 1] ?? '');
    if (!allowed && (hasColorLiteral(line) || namedColorInUiLine(line))) violations.push(index + 1);
  }
  return violations;
}

function tokenColorLiteralLines(source) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const declarations = Array.from(line.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g));
    for (const [, name, rawValue] of declarations) {
      if (!COLOR_TOKEN_NAME_PATTERN.test(name)) continue;
      const value = rawValue.replace(/\/\*.*?\*\//g, '').trim();
      if (HEX_COLOR_VALUE_PATTERN.test(value) || RGBA_COLOR_VALUE_PATTERN.test(value)) continue;

      const message = /\b(?:rgb|hsl|hsla)\s*\(/i.test(value)
        ? 'Token 色值必须使用 Hex 或 rgba()，不支持 rgb()/hsl()。'
        : NAMED_COLOR_PATTERN.test(value)
          ? 'Token 中出现命名色值；请改用 Hex 或 rgba()。'
          : 'Token 色值必须使用有效的 Hex 或 rgba()。';
      violations.push({ line: index + 1, message });
    }
  }
  return violations;
}

export function auditUiTokens(rootDirectory = process.cwd()) {
  const errors = [];
  const uiDirectory = path.join(rootDirectory, 'src', 'ui');
  const tokenPath = path.join(rootDirectory, TOKEN_FILE);
  const files = listUiFiles(uiDirectory);

  if (!fs.existsSync(tokenPath)) {
    errors.push(`${TOKEN_FILE}: 缺少唯一 Design Tokens 文件。`);
  } else {
    const themes = parseThemes(fs.readFileSync(tokenPath, 'utf8'));
    const missingThemes = THEME_NAMES.filter((name) => !themes.has(name));
    if (missingThemes.length > 0) {
      errors.push(`${TOKEN_FILE}: 缺少主题声明：${missingThemes.join(', ')}。`);
    }
    const referenceName = THEME_NAMES.find((name) => themes.has(name));
    if (referenceName) {
      const referenceKeys = themes.get(referenceName);
      for (const name of THEME_NAMES.filter((item) => themes.has(item) && item !== referenceName)) {
        const keys = themes.get(name);
        const missing = [...referenceKeys].filter((key) => !keys.has(key));
        const extra = [...keys].filter((key) => !referenceKeys.has(key));
        if (missing.length || extra.length) {
          errors.push(
            `${TOKEN_FILE}: ${name} 主题 Token 键名与 ${referenceName} 不一致（缺少：${missing.join(', ') || '无'}；多出：${extra.join(', ') || '无'}）。`,
          );
        }
      }
    }
  }

  for (const filePath of files) {
    const relativePath = path.relative(rootDirectory, filePath).split(path.sep).join('/');
    const source = fs.readFileSync(filePath, 'utf8');
    const isTokenFile = relativePath === TOKEN_FILE;
    if (isTokenFile) {
      for (const violation of tokenColorLiteralLines(source)) {
        errors.push(`${relativePath}:${violation.line}: ${violation.message}`);
      }
    } else {
      for (const lineNumber of colorLiteralLines(source)) {
        errors.push(`${relativePath}:${lineNumber}: 样式中出现裸色值；请改用 Design Token。`);
      }
    }

    for (const match of source.matchAll(/\b(?:oklch|oklab|color-mix|light-dark)\s*\(/gi)) {
      const lineNumber = source.slice(0, match.index).split('\n').length;
      errors.push(`${relativePath}:${lineNumber}: 禁止使用 ${match[0].split('(')[0]}()，旧 WebView 不支持。`);
    }

    for (const match of source.matchAll(/\b(?:z-index|zIndex)\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi)) {
      if (Number(match[1]) >= 100) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        errors.push(`${relativePath}:${lineNumber}: z-index ${Number(match[1])} 过高；模态界面应使用原生 dialog Top Layer。`);
      }
    }

    if (/\.tsx$/.test(filePath)) {
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (match[1] !== 'lucide-react' && ICON_IMPORT_PATTERN.test(match[1])) {
          const lineNumber = source.slice(0, match.index).split('\n').length;
          errors.push(`${relativePath}:${lineNumber}: 图标必须统一使用 lucide-react，发现 ${match[1]}。`);
        }
      }
      if (/import\s+(?!\{)[^;\n]+from\s+['"]lucide-react['"]/.test(source)) {
        errors.push(`${relativePath}: lucide-react 必须使用静态具名导入以支持 Tree-shaking。`);
      }
      const svgMatch = /<svg\b/i.exec(source);
      if (svgMatch) {
        const lineNumber = source.slice(0, svgMatch.index).split('\n').length;
        errors.push(`${relativePath}:${lineNumber}: 图标不得散落为手写 SVG，请使用 lucide-react。`);
      }
    }
  }

  const packagePath = path.join(rootDirectory, 'package.json');
  if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    for (const dependency of Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })) {
      if (dependency !== 'lucide-react' && ICON_IMPORT_PATTERN.test(dependency)) {
        errors.push(`package.json: 图标库必须统一使用 lucide-react，发现 ${dependency}。`);
      }
    }
  }

  return errors;
}

function getRootArgument(args) {
  const rootIndex = args.indexOf('--root');
  return rootIndex >= 0 ? path.resolve(args[rootIndex + 1] ?? '.') : process.cwd();
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentModulePath = fileURLToPath(import.meta.url);
const isMainModule = scriptPath && fs.realpathSync(scriptPath) === fs.realpathSync(currentModulePath);

if (isMainModule) {
  const errors = auditUiTokens(getRootArgument(process.argv.slice(2)));
  if (errors.length > 0) {
    console.error(`UI 样式审计发现 ${errors.length} 项问题：`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('UI 样式审计通过。');
  }
}
