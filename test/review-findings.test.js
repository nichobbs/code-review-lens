'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../packages/core');

const addLines = (...texts) => [
  { lines: texts.map((content, i) => ({ type: 'add', content, newNumber: i + 1 })) }
];

/* ---------- M1: shortcut extraction ---------- */

test('M1: hyphenated ceilings (in-memory, single-node) are bounded shortcuts, not rot risk', () => {
  const [a, b] = core.extractShortcutsFromHunks(
    'src/cache.ts',
    addLines(
      '// shortcut: in-memory map for <1000 users, migrate to Redis',
      '// shortcut: single-node scheduler, move to a queue when we add a second worker'
    )
  );
  assert.equal(a.hasTrigger, true);
  assert.equal(a.rotRisk, false);
  assert.equal(a.ceiling, 'in-memory map for <1000 users');
  assert.equal(a.upgrade, 'migrate to Redis');
  assert.equal(b.hasTrigger, true);
  assert.equal(b.ceiling, 'single-node scheduler');
});

test('M1: trailing shortcut/TODO comments after a quoted string are extracted', () => {
  const found = core.extractShortcutsFromHunks(
    'src/a.ts',
    addLines('const s = "a"; // TODO: remove', "const t = 'b'; // shortcut: 100 rows, switch to paging")
  );
  assert.equal(found.length, 2);
  assert.equal(found[0].marker, 'todo');
  assert.equal(found[1].hasTrigger, true);
});

test('M1: a comment marker inside a string literal is not a comment', () => {
  const found = core.extractShortcutsFromHunks('src/a.ts', addLines('const s = "// TODO: not a comment";'));
  assert.deepEqual(found, []);
});

/* ---------- M2: CODEOWNERS leading ** ---------- */

test('M2: leading **/ and /**/ patterns match root-level files and nested files', () => {
  const rules = core.parseCodeowners('**/index.js @index-owner\n/**/app.js @app-owner\n');
  assert.deepEqual(core.matchCodeowners('index.js', rules), ['@index-owner']);
  assert.deepEqual(core.matchCodeowners('src/deep/index.js', rules), ['@index-owner']);
  assert.deepEqual(core.matchCodeowners('app.js', rules), ['@app-owner']);
  assert.deepEqual(core.matchCodeowners('a/b/app.js', rules), ['@app-owner']);
  assert.deepEqual(core.matchCodeowners('src/other.js', rules), []);
});

test('M2: mid-path /**/ still matches zero or more directories', () => {
  const rules = core.parseCodeowners('docs/**/guide.md @docs\n');
  assert.deepEqual(core.matchCodeowners('docs/guide.md', rules), ['@docs']);
  assert.deepEqual(core.matchCodeowners('docs/a/b/guide.md', rules), ['@docs']);
});

/* ---------- M3: spec alignment ---------- */

test('M3: * and ** globs in Out-of-scope rules flag matching files', () => {
  const files = [
    { path: 'src/auth.ts', additions: 3, deletions: 0 },
    { path: 'packages/billing/migrations/001.sql', additions: 1, deletions: 0 },
    { path: 'src/ok/readme.txt', additions: 1, deletions: 0 }
  ];
  const sa = core.analyzeSpecAlignment(files, {
    body: "## Out of scope\n- Do not touch `src/*.ts`\n- Leave `packages/*/migrations` alone"
  });
  const flagged = sa.negativeSpaceViolations.map((v) => v.path).sort();
  assert.deepEqual(flagged, ['packages/billing/migrations/001.sql', 'src/auth.ts']);
});

test('M3: plain (non-bullet) lines under Out of scope / Repo precedent are recorded', () => {
  const sa = core.analyzeSpecAlignment(
    [{ path: 'src/payments/charge.ts', additions: 2, deletions: 0 }],
    {
      body: '## Out of scope\nDo not modify src/payments/charge.ts in this PR.\n\n## Repo precedent\nMirror src/orders/create.ts for the handler shape.\n'
    }
  );
  assert.equal(sa.outOfScope.length, 1);
  assert.equal(sa.repoPrecedents.length, 1);
  assert.equal(sa.negativeSpaceViolations[0].path, 'src/payments/charge.ts');
});

/* ---------- M4: compiler keeps repo-match reuse candidates + prompts ---------- */

const DUP_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -0,0 +1,3 @@',
  '+export function helperOne(x: number) {',
  '+  return x + 1;',
  '+}',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -0,0 +1,3 @@',
  '+export function helperOne(x: number) {',
  '+  return x + 2;',
  '+}',
  ''
].join('\n');

test('M4: repo-match reuse candidates from staged layers survive alongside duplicate-in-diff ones', () => {
  const staged = {
    attentionSignals: {
      reuseCandidates: [{ name: 'helperTwo', addedIn: 'src/a.ts:9', existingMatches: ['lib/x.ts:1'], kind: 'repo-match' }]
    }
  };
  const report = core.compileFindingsToWorkbenchReport(
    { meta: { title: 't' }, issues: [] },
    { diffText: DUP_DIFF, layers: staged }
  );
  const kinds = report.LAYERS.attentionSignals.reuseCandidates.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['duplicate-in-diff', 'repo-match']);
  assert.ok(report.LAYERS.attentionSignals.humanFocusPrompts.some((p) => /2 newly added helper/.test(p)));
});

test('M4: staged specAlignment contributes a focus prompt when no PR body is supplied', () => {
  const staged = {
    attentionSignals: {
      specAlignment: {
        outOfScope: ['src/b.ts'],
        repoPrecedents: [],
        negativeSpaceViolations: [{ path: 'src/b.ts', matchedToken: 'src/b.ts', outOfScopeItem: 'src/b.ts', reason: 'r' }],
        specClauses: []
      }
    }
  };
  const report = core.compileFindingsToWorkbenchReport({ meta: { title: 't' }, issues: [] }, { diffText: DUP_DIFF, layers: staged });
  assert.equal(report.LAYERS.attentionSignals.specAlignment.negativeSpaceViolations.length, 1);
  assert.ok(report.LAYERS.attentionSignals.humanFocusPrompts.some((p) => /Negative-Space violation/.test(p)));
});

/* ---------- L1 / L3 / D1: scratch artifact loading ---------- */

function makeScratch(prNum, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-scratch-'));
  const dir = path.join(base, '.crv-skills', 'crv-code-review', String(prNum));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { base, dir };
}

test('L3: scratch base directory is computed once, even when invoked inside .crv-skills', () => {
  assert.equal(core.resolveScratchBase('/work/proj'), path.resolve('/work/proj'));
  assert.equal(core.resolveScratchBase('/work/proj/.crv-skills'), path.resolve('/work/proj'));
  assert.equal(core.resolveScratchBase('/work/proj/.crv-skills/crv-code-review'), path.resolve('/work/proj'));
  assert.equal(core.resolveScratchBase('/work/proj/.crv-skills/crv-code-review/12'), path.resolve('/work/proj'));
  assert.equal(
    core.getScratchDir(12, '/work/proj/.crv-skills/crv-code-review/12'),
    path.resolve('/work/proj/.crv-skills/crv-code-review/12')
  );
});

test('D1: loadScratchArtifacts reads diff, pr-meta, layers and findings from one place', () => {
  const { base } = makeScratch(7, {
    'diff.patch': 'diff text',
    'pr-meta.json': { number: 7, url: 'https://github.com/o/r/pull/7' },
    'layers.json': { contracts: [] },
    'findings.json': { meta: { review: { repo: 'o/r' } }, issues: [] }
  });
  const a = core.loadScratchArtifacts(7, { cwd: base, repo: 'o/r' });
  assert.equal(a.diffText, 'diff text');
  assert.equal(a.prMeta.number, 7);
  assert.deepEqual(a.layers, { contracts: [] });
  assert.equal(a.findings.meta.review.repo, 'o/r');
});

test('L1: staged layers.json is ignored when its pr-meta.json belongs to a different repository', () => {
  const { base } = makeScratch(5, {
    'pr-meta.json': { number: 5, url: 'https://github.com/other/repo/pull/5' },
    'layers.json': { contracts: [{ path: 'stale.ts' }] },
    'diff.patch': 'stale diff'
  });
  const a = core.loadScratchArtifacts(5, { cwd: base, repo: 'mine/repo' });
  assert.equal(a.layers, null);
  assert.equal(a.prMeta, null);
  assert.equal(a.diffText, '');
  assert.equal(a.mismatch, true);
});

test('L1: staged layers without any repo evidence are not trusted for another repo', () => {
  const { base } = makeScratch(5, { 'layers.json': { contracts: [{ path: 'x.ts' }] } });
  assert.equal(core.loadScratchArtifacts(5, { cwd: base, repo: 'mine/repo' }).layers, null);
});

test('L1: findings.json from a different repo is rejected, matching one is accepted', () => {
  const { base } = makeScratch(5, {
    'pr-meta.json': { url: 'https://github.com/mine/repo/pull/5' },
    'findings.json': { meta: { review: { repo: 'other/repo' } }, issues: [] }
  });
  assert.equal(core.loadScratchArtifacts(5, { cwd: base, repo: 'mine/repo' }).findings, null);
});

test('D1: loadLivePr path uses staged scratch artifacts only for the matching repository', () => {
  const { buildLivePrReportFromFetchedData } = require('../packages/cli/server');
  const { base } = makeScratch(9, {
    'pr-meta.json': { number: 9, url: 'https://github.com/other/repo/pull/9' },
    'layers.json': { contracts: [{ path: 'stale-contract.ts', category: 'api', additions: 1, deletions: 0, summary: 's' }] }
  });
  const prev = process.cwd();
  process.chdir(base);
  try {
    const report = buildLivePrReportFromFetchedData({
      repo: 'mine/repo',
      prNumInt: 9,
      prMeta: { title: 'T', url: 'https://github.com/mine/repo/pull/9', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), body: '' },
      diffText: DUP_DIFF,
      hydrated: { overviewMeta: null, findingThreads: {}, generalComments: [] }
    });
    assert.ok(!JSON.stringify(report.LAYERS || {}).includes('stale-contract.ts'));
  } finally {
    process.chdir(prev);
  }
});

/* ---------- L2: help text matches real resolution order ---------- */

test('L2: crv --help lists the repo resolution order that resolveRepoConfig implements', () => {
  const { spawnSync } = require('node:child_process');
  const out = spawnSync('node', [path.join(__dirname, '../packages/cli/bin/crv.js'), '--help'], { encoding: 'utf8' }).stdout;
  const order = out.slice(out.indexOf('DEFAULT REPO RESOLUTION ORDER'));
  const iLocal = order.indexOf('.crvrc.json');
  const iGit = order.indexOf('git remote');
  const iGlobal = order.indexOf('~/.config/crv/config.json');
  assert.ok(iLocal > -1 && iGit > -1 && iGlobal > -1);
  assert.ok(iLocal < iGit && iGit < iGlobal, 'local config, then git remote, then global config');
});

test('L2: resolveRepoConfig really prefers git remote over global config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-cwd-'));
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/git/remote.git'], { cwd });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.config', 'crv'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'crv', 'config.json'), JSON.stringify({ defaultRepo: 'global/cfg' }));
    const r = core.resolveRepoConfig({ cwd, env: {} });
    assert.equal(r.repo, 'git/remote');
  } finally {
    process.env.HOME = prevHome;
  }
});
