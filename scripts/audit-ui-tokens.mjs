import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = 'src/ui/styles/tokens.css';
const THEME_NAMES = ['light', 'dark', 'warm'];
const ICON_IMPORT_PATTERN = /(?:icon|heroicons|fontawesome|react-feather|phosphor)/i;

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

function colorLiteralLines(source) {
  const lines = source.split(/\r?\n/);
  const violations = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const allowed = /\/\*\s*ui-token-allow:\s*[^*]+\*\//i.test(line) ||
      /\/\*\s*ui-token-allow:\s*[^*]+\*\//i.test(lines[index - 1] ?? '');
    if (!allowed && hasColorLiteral(line)) violations.push(index + 1);
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
    if (!isTokenFile) {
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
