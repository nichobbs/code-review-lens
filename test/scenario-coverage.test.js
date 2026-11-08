'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../packages/core');
const { runCiCommand, parseCiArgs } = require('../packages/cli/ci');

const REPO = 'acme/widgets';
const HEAD = 'a'.repeat(40);

/* ---------- helpers (self-contained: a stubbed `gh` and a staged scratch dir) ---------- */

function fakeGh() {
  const state = { comments: [], nextId: 1 };
  async function gh(args, stdin) {
    const a = args.join(' ');
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    if (/issues\/\d+\/comments/.test(a) && method === 'GET') return JSON.stringify([state.comments]);
    if (/issues\/\d+\/comments/.test(a) && method === 'POST') {
      const c = { id: state.nextId++, user: { login: 'github-actions[bot]' }, body: JSON.parse(stdin).body };
      state.comments.push(c);
      return JSON.stringify(c);
    }
    const patch = /issues\/comments\/(\d+)/.exec(a);
    if (patch && method === 'PATCH') {
      const c = state.comments.find((x) => String(x.id) === patch[1]);
      c.body = JSON.parse(stdin).body;
      return JSON.stringify(c);
    }
    throw new Error(`unexpected gh call: ${a}`);
  }
  return { gh, state };
}

const quiet = async (fn) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
};

const TESTS = {
  contracts: [],
  flows: [],
  testMatrix: [
    {
      file: 'src/offline.test.ts',
      suite: 'offline redemption',
      cases: [
        { behavior: '[LUP-204-SC-1] member sees the offline barcode', hollow: false },
        { behavior: '[LUP-204-SC-2] shows retry on timeout', hollow: true },
        { behavior: '[LUP-999-SC-1] belongs to another story', hollow: false }
      ]
    }
  ]
};

function stage(layers = TESTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-scn-'));
  fs.writeFileSync(path.join(dir, 'pr-meta.json'), JSON.stringify({ baseRefOid: 'b'.repeat(40), headRefOid: HEAD, url: `https://github.com/${REPO}/pull/7` }));
  fs.writeFileSync(path.join(dir, 'layers.json'), JSON.stringify(layers));
  fs.writeFileSync(path.join(dir, 'github-threads.json'), '{}');
  fs.writeFileSync(path.join(dir, 'diff.patch'), '');
  return dir;
}

function scenariosFile(json) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crv-scf-')), 'scenarios.json');
  fs.writeFileSync(f, typeof json === 'string' ? json : JSON.stringify(json));
  return f;
}

const THREE = { storyKey: 'LUP-204', scenarios: ['SC-1', 'SC-2', { id: 'SC-3', title: 'Third' }] };

/* ---------- matching function ---------- */

test('extractScenarioTags understands the tag variants and normalises them', () => {
  assert.deepEqual(core.extractScenarioTags('[LUP-204-SC-1] a'), ['LUP-204-SC-1']);
  assert.deepEqual(core.extractScenarioTags('lup-204_sc-2 b'), ['LUP-204-SC-2']);
  assert.deepEqual(core.extractScenarioTags('[LUP-204 SC3]'), ['LUP-204-SC-3']);
  assert.deepEqual(core.extractScenarioTags('[LUP-204-SC-1] and [LUP-204-SC-1]'), ['LUP-204-SC-1', 'LUP-204-SC-1']);
  assert.deepEqual(core.extractScenarioTags('SC-1 without a story key'), []);
  assert.deepEqual(core.extractScenarioTags(null), []);
});

test('parseScenarioInput accepts the three shapes and reports duplicates and unusable entries', () => {
  const a = core.parseScenarioInput(THREE);
  assert.deepEqual(a.scenarios.map((s) => s.tag), ['LUP-204-SC-1', 'LUP-204-SC-2', 'LUP-204-SC-3']);
  assert.equal(a.scenarios[2].title, 'Third');

  const b = core.parseScenarioInput({ stories: [{ key: 'LUP-1', scenarios: ['SC-1'] }, { storyKey: 'LUP-2', scenarios: [{ id: 'sc2' }] }] });
  assert.deepEqual(b.scenarios.map((s) => s.tag), ['LUP-1-SC-1', 'LUP-2-SC-2']);

  const c = core.parseScenarioInput(['LUP-3-SC-1', { storyKey: 'LUP-3', id: 'SC-2' }, 'LUP-3-SC-1', 'nonsense', { id: 'SC-9' }]);
  assert.deepEqual(c.scenarios.map((s) => s.tag), ['LUP-3-SC-1', 'LUP-3-SC-2']);
  assert.deepEqual(c.duplicates, ['LUP-3-SC-1']);
  assert.equal(c.invalid.length, 2, 'text with no story key and an id with no story key are unusable');
});

test('parseScenarioInput caps the number of scenarios', () => {
  const many = { storyKey: 'LUP-1', scenarios: Array.from({ length: 2000 }, (_, i) => `SC-${i + 1}`) };
  assert.equal(core.parseScenarioInput(many).scenarios.length, 500);
});

test('matchScenarioCoverage: covered, no test, hollow-only, unknown tags, no test matrix', () => {
  const r = core.matchScenarioCoverage(core.parseScenarioInput(THREE), TESTS.testMatrix);
  assert.equal(r.total, 3);
  assert.deepEqual(r.covered, ['LUP-204-SC-1']);
  assert.deepEqual(r.uncovered, [
    { tag: 'LUP-204-SC-2', reason: 'hollow-only' },
    { tag: 'LUP-204-SC-3', reason: 'no-test' }
  ]);
  assert.deepEqual(r.unknownTags.map((u) => u.tag), ['LUP-999-SC-1']);
  assert.equal(r.testCounts['LUP-204-SC-1'], 1);

  const none = core.matchScenarioCoverage(core.parseScenarioInput(THREE), []);
  assert.equal(none.covered.length, 0);
  assert.ok(none.uncovered.every((u) => u.reason === 'no-test'));
  assert.equal(core.matchScenarioCoverage(core.parseScenarioInput(THREE), undefined).total, 3);
});

test('matchScenarioCoverage: a tag in the suite name counts, several tests count once, duplicates are reported', () => {
  const parsed = core.parseScenarioInput({ storyKey: 'LUP-5', scenarios: ['SC-1', 'SC-2', 'SC-1'] });
  const matrix = [
    { file: 'a.test.ts', suite: '[LUP-5-SC-1] whole suite', cases: [{ behavior: 'x', hollow: false }] },
    { file: 'b.test.ts', suite: 's', cases: [{ behavior: '[LUP-5-SC-2] a', hollow: false }, { behavior: '[LUP-5-SC-2] b', hollow: false }] }
  ];
  const r = core.matchScenarioCoverage(parsed, matrix);
  assert.equal(r.total, 2);
  assert.deepEqual(r.covered, ['LUP-5-SC-1', 'LUP-5-SC-2']);
  assert.equal(r.testCounts['LUP-5-SC-2'], 2);
  assert.deepEqual(r.duplicates, ['LUP-5-SC-1']);
});

test('loadScenarioFile enforces a size cap, valid JSON and at least one usable scenario', () => {
  assert.equal(core.loadScenarioFile(scenariosFile(THREE)).scenarios.length, 3);
  assert.throws(() => core.loadScenarioFile(scenariosFile('{ not json')), /not valid JSON/);
  assert.throws(() => core.loadScenarioFile(scenariosFile({ storyKey: 'LUP-1', scenarios: ['nonsense'] })), /no usable scenarios/);
  assert.throws(() => core.loadScenarioFile(scenariosFile('x'.repeat(core.MAX_SCENARIO_FILE_BYTES + 1))), /exceeds/);
  assert.throws(() => core.loadScenarioFile(os.tmpdir()), /not a file/);
});

/* ---------- flags ---------- */

test('ci-comment parses --scenarios and --fail-on-uncovered-scenarios, and rejects inconsistent use', () => {
  const f = parseCiArgs(['7', '--repo', REPO, '--scenarios', 'scenarios.json', '--fail-on-uncovered-scenarios']);
  assert.equal(f.scenarios, 'scenarios.json');
  assert.equal(f.failOnUncoveredScenarios, true);
  const d = parseCiArgs(['7', '--repo', REPO]);
  assert.equal(d.scenarios, null);
  assert.equal(d.failOnUncoveredScenarios, false, 'the hard rule is off by default');
  assert.throws(() => parseCiArgs(['7', '--fail-on-uncovered-scenarios']), /needs --scenarios/);
  assert.throws(() => parseCiArgs(['7', '--scenarios']), /needs a path/);
  assert.throws(() => parseCiArgs(['7', '--scenarios', '--dry-run']), /needs a path/);
});

/* ---------- rendering ---------- */

test('the pre-scan summary shows a scenarios row, the gaps and unknown tags only when scenarios were supplied', () => {
  const coverage = core.matchScenarioCoverage(core.parseScenarioInput(THREE), TESTS.testMatrix);
  const withRow = core.renderTier1Summary({ layers: TESTS, hard: [], scenarioCoverage: coverage });
  assert.match(withRow, /\| Scenarios \| covered by tagged tests changed in this PR \| 1 of 3 \|/);
  assert.match(withRow, /`LUP-204-SC-2` \(only zero-assertion tests\)/);
  assert.match(withRow, /`LUP-204-SC-3`/);
  assert.match(withRow, /not in the supplied list \(1\):\*\* `LUP-999-SC-1`/);
  assert.match(withRow, /several PRs/);

  const without = core.renderTier1Summary({ layers: TESTS, hard: [] });
  assert.ok(!/Scenarios/.test(without), 'no scenarios input = no row');
});

test('the pre-scan summary stays clean when every scenario is covered', () => {
  const parsed = core.parseScenarioInput({ storyKey: 'LUP-204', scenarios: ['SC-1'] });
  const out = core.renderTier1Summary({ layers: TESTS, hard: [], scenarioCoverage: core.matchScenarioCoverage(parsed, TESTS.testMatrix) });
  assert.match(out, /1 of 1/);
  assert.ok(!/without a tagged test/.test(out));
});

test('scenario ids from the input are escaped in the comment', () => {
  const cov = { total: 1, covered: [], uncovered: [{ tag: 'A|<b>x', reason: 'no-test' }], unknownTags: [], duplicates: [], invalid: [] };
  const out = core.renderTier1Summary({ layers: TESTS, hard: [], scenarioCoverage: cov });
  assert.ok(!out.includes('<b>'), 'html is not passed through');
});

/* ---------- ci-comment end to end ---------- */

test('ci-comment adds the scenarios row from --scenarios, from CRV_SCENARIOS_FILE, and omits it otherwise', async () => {
  const file = scenariosFile(THREE);

  const flagRun = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', stage(), '--scenarios', file], { gh: flagRun.gh })), 0);
  assert.match(flagRun.state.comments[0].body, /1 of 3/);

  const envRun = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', stage()], { gh: envRun.gh, env: { CRV_SCENARIOS_FILE: file } })), 0);
  assert.match(envRun.state.comments[0].body, /1 of 3/);

  const plain = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', stage()], { gh: plain.gh, env: {} })), 0);
  assert.ok(!/Scenarios/.test(plain.state.comments[0].body));
});

test('uncovered scenarios never fail the check by default; --fail-on-uncovered-scenarios does, and still posts the comment', async () => {
  const file = scenariosFile(THREE);
  const dir = stage();

  const lenient = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', dir, '--scenarios', file], { gh: lenient.gh })), 0);
  assert.ok(!/uncovered-scenario/.test(lenient.state.comments[0].body), 'without the flag, gaps are informational and never listed as hard-rule findings');

  const strict = fakeGh();
  assert.equal(
    await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', dir, '--scenarios', file, '--fail-on-uncovered-scenarios'], { gh: strict.gh })),
    1
  );
  assert.equal(strict.state.comments.length, 1, 'the comment is still posted');
  assert.match(strict.state.comments[0].body, /uncovered-scenario/);

  const covered = scenariosFile({ storyKey: 'LUP-204', scenarios: ['SC-1'] });
  assert.equal(
    await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', dir, '--scenarios', covered, '--fail-on-uncovered-scenarios'], { gh: fakeGh().gh })),
    0
  );
});

test('--fail-on-hard-rules is independent of uncovered scenarios', async () => {
  const dir = stage();
  const file = scenariosFile(THREE);
  const { gh } = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', dir, '--scenarios', file, '--fail-on-uncovered-scenarios'], { gh })), 1);
  // Uncovered scenarios alone (SC-2 has no tagged test here) do not trip --fail-on-hard-rules:
  const hollowOnly = stage({ contracts: [], flows: [], testMatrix: [{ file: 'a.test.ts', cases: [{ behavior: '[LUP-204-SC-1] x', hollow: false }] }] });
  const ok = scenariosFile({ storyKey: 'LUP-204', scenarios: ['SC-1', 'SC-2'] });
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', hollowOnly, '--scenarios', ok, '--fail-on-hard-rules'], { gh: fakeGh().gh })), 0);
});

test('a bad scenarios file fails ci-comment loudly instead of silently dropping the row', async () => {
  await assert.rejects(
    () => quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', stage(), '--scenarios', scenariosFile('{ nope')], { gh: fakeGh().gh })),
    /not valid JSON/
  );
});

/* ---------- comment tidy-up (#14) ---------- */

const REPORT = (data = []) => ({ DATA: data, REVIEW: { repo: REPO, pr: 7, base: '', head: HEAD, agent: 'crv CI pre-scan', model: '' }, PR: { label: 'PR #7', url: '' } });

test('the pre-scan-only sticky comment has no triage table and no empty summary block', () => {
  const body = core.renderStickyBody(REPORT(), core.renderTier1Summary({ layers: TESTS, hard: [] }), {});
  assert.ok(!/Triage Status/.test(body));
  assert.ok(!/Architecture & Coverage Summary/.test(body));
  assert.ok(!/<details>/.test(body));
  assert.match(body, /Automated pre-scan/);
});

test('a comment with AI findings still shows the triage counts and the published findings', () => {
  const data = [{ id: 'M1', sev: 'medium', cat: 'correctness', verify: 'CONFIRMED', loc: 'src/a.ts:3', title: 'Something is wrong' }];
  const body = core.renderStickyBody(REPORT(data), core.renderTier1Summary({ layers: TESTS, hard: [] }), { M1: { action: 'comment', note: '' } });
  assert.match(body, /Triage Status/);
  assert.match(body, /Comment \/ Nit\*\* \| \*\*1\*\*/);
  assert.match(body, /Curated Findings Published to PR Threads/);
});

test('the crv-meta marker is identical with and without the tidy-up, and the Workbench layout is unchanged', () => {
  const marker = (body) => {
    const meta = core.parseOverviewComment(body);
    delete meta.updatedAt;
    return meta;
  };
  const report = REPORT();
  const tidy = core.serializeOverviewComment(report, {}, 'summary', { omitEmpty: true });
  const full = core.serializeOverviewComment(report, {}, 'summary');
  assert.deepEqual(marker(tidy), marker(full));
  assert.match(full, /Triage Status/, 'default (Workbench) layout keeps the triage table');

  const withSummary = { ...report, SUMMARY: { html: '<p>Real <strong>content</strong></p>' } };
  assert.match(core.serializeOverviewComment(withSummary, {}, '', { omitEmpty: true }), /Architecture & Coverage Summary/, 'real summary content is kept');
});

/* ---------- workflow wiring ---------- */

test('the reusable workflow exposes both inputs, defaults the hard rule off and passes values through env only', () => {
  const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/crv-review.yml'), 'utf8');
  assert.match(text, /scenarios-file:[\s\S]*?default: ''/);
  assert.match(text, /fail-on-uncovered-scenarios:[\s\S]*?default: false/);
  assert.match(text, /SCENARIOS_FILE: \$\{\{ inputs\.scenarios-file \}\}/);
  assert.match(text, /FAIL_ON_UNCOVERED: \$\{\{ inputs\.fail-on-uncovered-scenarios \}\}/);
  assert.match(text, /args\+=\(--scenarios "\$SCENARIOS_FILE"\)/);
  assert.match(text, /CRV_SCENARIOS_FILE: \$\{\{ inputs\.scenarios-file \}\}/);
});
