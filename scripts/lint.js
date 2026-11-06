#!/usr/bin/env node
'use strict';

/**
 * Dependency-free lint gate (the repo has no devDependencies by design):
 *  1. `node --check` syntax validation of every shipped .js/.mjs file,
 *  2. banned patterns that previously caused security issues,
 *  3. every GitHub Actions `uses:` must be pinned to a full commit SHA.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'assets', 'dist', '.crv-skills']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const JS = ['.js', '.mjs'];
const BANNED = [
  { exts: JS, re: /require\(['"]vm['"]\)|\brunInNewContext\b/, why: 'vm is not a sandbox; never execute report content' },
  { exts: JS, re: /\beval\s*\(|new Function\s*\(/, why: 'dynamic code evaluation' },
  { exts: [...JS, '.py'], re: /securityLevel:\s*['"]loose['"]/, why: 'Mermaid must run with securityLevel "strict"' },
  { exts: JS, re: /\$\{\s*d\.(impact|fix|reasoning)\s*(\|\|\s*'')?\s*\}/, why: 'finding HTML must go through sanitizeHtml()' },
  { re: /\.tu-skills|tu-code-review/, why: 'legacy internal tool name' },
  { re: /\b13[- ]lens/i, why: 'the skill has 14 lenses' }
];
const SELF = path.relative(ROOT, __filename);
const BANNED_EXEMPT = new Set([SELF, 'test/security.test.js', 'fixtures/pr1230-report.json']);

const files = walk(ROOT);
const problems = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const ext = path.extname(file);
  if (ext === '.js' || ext === '.mjs') {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) problems.push(`${rel}: syntax error\n${res.stderr.trim()}`);
  }
  if (BANNED_EXEMPT.has(rel) || !['.js', '.mjs', '.html', '.md', '.py', '.json'].includes(ext)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const { re, why, exts } of BANNED) {
    if ((!exts || exts.includes(ext)) && re.test(text)) problems.push(`${rel}: ${why} (${re})`);
  }
}

const wfDir = path.join(ROOT, '.github', 'workflows');
if (fs.existsSync(wfDir)) {
  for (const name of fs.readdirSync(wfDir)) {
    const text = fs.readFileSync(path.join(wfDir, name), 'utf8');
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      if (m[1].startsWith('./')) continue;
      if (!/@[0-9a-f]{40}$/.test(m[1])) problems.push(`.github/workflows/${name}: "${m[1]}" is not pinned to a commit SHA`);
    }
  }
}

if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`lint: ok (${files.length} files scanned)`);
