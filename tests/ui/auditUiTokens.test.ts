import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const auditScript = join(repoRoot, 'scripts', 'audit-ui-tokens.mjs');
let fixtureRoot = '';

function createFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lfh-ui-audit-'));
  mkdirSync(join(fixtureRoot, 'src', 'ui', 'styles'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'src', 'ui', 'styles', 'tokens.css'),
    [
      '[data-theme="light"] { --canvas: #fff; --text: #111; }',
      '[data-theme="dark"] { --canvas: #000; --text: #fff; }',
      '[data-theme="warm"] { --canvas: #f7f3eb; --text: #111; }',
    ].join('\n'),
  );
  writeFileSync(join(fixtureRoot, 'src', 'ui', 'styles', 'base.css'), '.sample { color: var(--text); }');
  writeFileSync(
    join(fixtureRoot, 'src', 'ui', 'Sample.tsx'),
    "import { Menu } from 'lucide-react';\nexport const Sample = () => <Menu />;\n",
  );
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    JSON.stringify({ dependencies: { 'lucide-react': '1.75.0' } }),
  );
}

function runAudit(scriptPath = auditScript) {
  return spawnSync(process.execPath, [scriptPath, '--root', fixtureRoot], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = '';
});

describe('UI token audit command', () => {
  it('rejects named CSS colors in styles and inline TSX styles', () => {
    createFixture();
    writeFileSync(
      join(fixtureRoot, 'src', 'ui', 'styles', 'base.css'),
      '.sample { color: red; background: var(--canvas); }',
    );
    writeFileSync(
      join(fixtureRoot, 'src', 'ui', 'Sample.tsx'),
      "import { Menu } from 'lucide-react';\nexport const Sample = () => <div style={{ color: 'blue' }}><Menu /></div>;\n",
    );

    const result = runAudit();
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toMatch(/base\.css:1: 样式中出现裸色值/);
    expect(output).toMatch(/Sample\.tsx:2: 样式中出现裸色值/);
  });

  it('allows only hex and rgba color values in the token file', () => {
    createFixture();
    writeFileSync(
      join(fixtureRoot, 'src', 'ui', 'styles', 'tokens.css'),
      [
        '[data-theme="light"] { --canvas: #fff; --text: rgb(0, 0, 0); }',
        '[data-theme="dark"] { --canvas: #000; --text: red; }',
        '[data-theme="warm"] { --canvas: #f7f3eb; --text: rgba(0, 0, 0, 0.8); }',
      ].join('\n'),
    );

    const result = runAudit();
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toMatch(/tokens\.css:1:.*rgb\(\)/);
    expect(output).toMatch(/tokens\.css:2:.*命名色值/);
  });

  it('accepts a compliant UI and reports every required drift category', () => {
    createFixture();
    const clean = runAudit();
    expect(clean.status).toBe(0);

    writeFileSync(
      join(fixtureRoot, 'src', 'ui', 'styles', 'base.css'),
      '.sample { color: #abc; background: oklch(0.5 0.1 2); z-index: 100; }',
    );
    writeFileSync(
      join(fixtureRoot, 'src', 'ui', 'styles', 'tokens.css'),
      [
        '[data-theme="light"] { --canvas: #fff; --text: #111; }',
        '[data-theme="dark"] { --canvas: #000; --text: #fff; }',
        '[data-theme="warm"] { --canvas: #f7f3eb; }',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'src', 'ui', 'Sample.tsx'),
      "import { Menu } from 'lucide-react';\nimport { Alert } from 'react-icons';\nexport const Sample = () => <div style={{ color: '#fff', backgroundColor: \"#112233\", zIndex: 1e3 }}><svg><Menu /></svg></div>;\n",
    );
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'lucide-react': '1.75.0', 'react-icons': '1.0.0' } }),
    );

    const result = runAudit();
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain('裸色值');
    expect(output).toContain('主题');
    expect(output).toContain('oklch');
    expect(output).toContain('z-index 1000');
    expect(output).toContain('Sample.tsx');
    expect(output).toContain('图标');
  });

  it('runs when the absolute script path is a symlink', () => {
    createFixture();
    const scriptLink = join(fixtureRoot, 'audit-ui-tokens.mjs');
    symlinkSync(auditScript, scriptLink);

    const result = runAudit(scriptLink);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI 样式审计通过');
  });
});
