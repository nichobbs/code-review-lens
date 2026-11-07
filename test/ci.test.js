'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../packages/core');
const { runCiCommand, parseCiArgs, scrubAgentEnv } = require('../packages/cli/ci');

const REPO = 'acme/widgets';
const HEAD = 'a'.repeat(40);

/** In-memory fake of the GitHub issue-comment + review endpoints behind `gh`. */
function fakeGh(initialComments = [], { failReviewWith422Once = false } = {}) {
  const state = { comments: [...initialComments], reviews: [], calls: [], nextId: 1000, rejected: 0 };
  async function gh(args, stdin) {
    state.calls.push({ args, stdin });
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
    if (/pulls\/\d+\/reviews/.test(a) && method === 'POST') {
      if (failReviewWith422Once && state.rejected === 0) {
        state.rejected++;
        throw new Error('HTTP 422: Unprocessable Entity (line must be part of the diff)');
      }
      state.reviews.push(JSON.parse(stdin));
      return '{}';
    }
    throw new Error(`unexpected gh call: ${a}`);
  }
  return { gh, state };
}

const spoofed = (body) => ({ id: 5, user: { login: 'mallory' }, body });
const botComment = (id, body) => ({ id, user: { login: 'github-actions[bot]' }, body });

const LAYERS_CLEAN = { contracts: [{}], flows: [{}, {}], testMatrix: [{ file: 'a.test.js', cases: [{ behavior: 'ok', hollow: false }] }] };
const LAYERS_HOLLOW = {
  contracts: [],
  flows: [],
  testMatrix: [{ file: 'a.test.js', cases: [{ behavior: 'does nothing |<b>', hollow: true }, { behavior: 'ok', hollow: false }] }]
};

const DIFF = [
  'diff --git a/src/handler.ts b/src/handler.ts',
  '--- a/src/handler.ts',
  '+++ b/src/handler.ts',
  '@@ -10,4 +10,8 @@ export async function run(member) {',
  '   if (member.status === "CLOSED") return;',
  '+  await repo.updateStatus(member.id, "CLOSED");',
  '+  return { status: "CLOSED" };',
  ' }'
].join('\n');

function findings(issues) {
  return {
    meta: {
      title: 'PR #7: demo',
      subtitle: '1 file',
      prUrl: `https://github.com/${REPO}/pull/7`,
      headCommit: HEAD,
      storageKey: 'acme-widgets-pr7',
      review: { repo: 'someone/else', pr: 999, base: 'b'.repeat(40), head: 'c'.repeat(40), agent: 'x', model: 'y', lenses: ['correctness'] },
      summary: '**What it does.** Demo.\n\n**Coverage.** One lens.',
      summaryPoints: ['correctness: ran']
    },
    issues
  };
}

const issue = (id, sev, extra = {}) => ({
  id,
  sev,
  cat: 'correctness',
  verify: 'CONFIRMED',
  loc: 'src/handler.ts:11',
  title: `Finding ${id}`,
  impact: '**Breaks:** thing.\n\n**Because:** `src/handler.ts:11` is wrong.\n\n**Reach:** all.',
  fix: '**Do:** fix it.\n\n**Check:** test it.',
  ...extra
});

function stageScratch({ layers = LAYERS_CLEAN, findingsJson = null, threads = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-ci-'));
  fs.writeFileSync(path.join(dir, 'pr-meta.json'), JSON.stringify({ baseRefOid: 'b'.repeat(40), headRefOid: HEAD, url: `https://github.com/${REPO}/pull/7` }));
  fs.writeFileSync(path.join(dir, 'layers.json'), JSON.stringify(layers));
  fs.writeFileSync(path.join(dir, 'github-threads.json'), JSON.stringify(threads));
  fs.writeFileSync(path.join(dir, 'diff.patch'), DIFF);
  if (findingsJson) fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findingsJson));
  return dir;
}

const quiet = async (fn) => {
  const log = console.log;
  const warn = console.warn;
  const err = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = err;
  }
};

/* ---------- sticky comment ---------- */

test('findStickyComment only matches the bot, never a spoofed marker from another author', () => {
  const marker = '<!-- crv-meta: {"v":1} -->';
  assert.equal(core.findStickyComment([spoofed(marker)]), null);
  assert.equal(core.findStickyComment([botComment(1, 'no marker here')]), null);
  assert.equal(core.findStickyComment([spoofed(marker), botComment(3, marker), botComment(2, marker)]).id, 3);
});

test('upsertStickyComment creates once, then updates in place (idempotent)', async () => {
  const { gh, state } = fakeGh();
  const r1 = await core.upsertStickyComment({ gh, repo: REPO, pr: 7, body: '<!-- crv-meta: {"v":1} -->\nfirst' });
  const r2 = await core.upsertStickyComment({ gh, repo: REPO, pr: 7, body: '<!-- crv-meta: {"v":1} -->\nsecond' });
  const r3 = await core.upsertStickyComment({ gh, repo: REPO, pr: 7, body: '<!-- crv-meta: {"v":1} -->\nsecond' });
  assert.equal(r1.action, 'created');
  assert.equal(r2.action, 'updated');
  assert.equal(r3.action, 'updated');
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /second/);
});

test('upsertStickyComment never edits another author\'s comment that carries a crv marker', async () => {
  const { gh, state } = fakeGh([spoofed('<!-- crv-meta: {"v":1} -->\nattacker')]);
  const res = await core.upsertStickyComment({ gh, repo: REPO, pr: 7, body: '<!-- crv-meta: {"v":1} -->\nmine' });
  assert.equal(res.action, 'created');
  assert.equal(state.comments.length, 2);
  assert.match(state.comments[0].body, /attacker/);
});

test('upsertStickyComment validates the target before calling gh', async () => {
  const { gh, state } = fakeGh();
  await assert.rejects(() => core.upsertStickyComment({ gh, repo: '../etc', pr: 7, body: 'x' }), /Invalid repository/);
  await assert.rejects(() => core.upsertStickyComment({ gh, repo: REPO, pr: '7; rm', body: 'x' }), /Invalid PR/);
  assert.equal(state.calls.length, 0);
});

test('the sticky body stays under the GitHub cap, escapes hostile text, and hydrates as trusted when authored by the bot', () => {
  const hard = core.hardRuleFindings(LAYERS_HOLLOW);
  assert.equal(hard.length, 1);
  const huge = { ...LAYERS_HOLLOW, testMatrix: [{ file: 'x'.repeat(70000), cases: [{ behavior: 'y', hollow: true }] }] };
  const report = core.buildCiReport({ repo: REPO, pr: 7, prMeta: { headRefOid: HEAD, baseRefOid: 'b'.repeat(40) } });
  const body = core.renderStickyBody(report, core.renderTier1Summary({ layers: huge, hard: core.hardRuleFindings(huge) }));
  assert.ok(body.length <= 65536);

  const small = core.renderStickyBody(report, core.renderTier1Summary({ layers: LAYERS_HOLLOW, hard }));
  assert.ok(!small.includes('<b>'), 'raw HTML from test names must be escaped');
  assert.match(small, /does nothing \\\|&lt;b>/);

  const asBot = core.hydrateFromGitHubComments([botComment(1, small)], [], { trustedAuthors: ['github-actions[bot]'] });
  assert.equal(asBot.overviewMeta.repo, REPO);
  const asOther = core.hydrateFromGitHubComments([{ id: 2, user: { login: 'mallory' }, body: small }], [], { trustedAuthors: ['github-actions[bot]'] });
  assert.equal(asOther.overviewMeta, null);
});

test('hardRuleFindings flags only zero-assertion tests', () => {
  assert.deepEqual(core.hardRuleFindings(LAYERS_CLEAN), []);
  assert.deepEqual(core.hardRuleFindings({}), []);
  assert.equal(core.hardRuleFindings(LAYERS_HOLLOW)[0].rule, 'hollow-test');
});

/* ---------- filtering and payload ---------- */

test('filterFindings applies floor, cap, ordering, refuted and already-posted rules', () => {
  const issues = [
    issue('N1', 'nit'),
    issue('M1', 'medium'),
    issue('H1', 'high'),
    issue('M2', 'medium', { verify: 'REFUTED' }),
    issue('L1', 'low'),
    issue('M3', 'medium'),
    issue('M4', 'medium')
  ];
  const { kept, stats } = core.filterFindings(issues, { minSeverity: 'medium', maxFindings: 2, existingThreadIds: ['M3'] });
  assert.deepEqual(kept.map((f) => f.id), ['H1', 'M1']);
  assert.deepEqual(stats, { belowFloor: 2, overCap: 1, alreadyPosted: 1, refuted: 1 });
});

test('the CI review is always a COMMENT review, even for high severity findings', () => {
  const report = core.buildCiReport({ repo: REPO, pr: 7, prMeta: { headRefOid: HEAD, baseRefOid: 'b'.repeat(40) } });
  const payload = core.buildCiReviewPayload(report, [issue('H1', 'high')], {});
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.threadUpdates, undefined);
  assert.ok(!/REQUEST_CHANGES|APPROVE/.test(JSON.stringify(payload.event)));
});

test('postReviewWithFallback folds inline comments into the body on a 422, and rethrows other errors', async () => {
  const { gh, state } = fakeGh([], { failReviewWith422Once: true });
  const payload = { event: 'COMMENT', body: 'hi', commit_id: HEAD, comments: [{ path: 'a.js', line: 3, side: 'RIGHT', body: 'finding' }] };
  const res = await core.postReviewWithFallback({ gh, repo: REPO, pr: 7, payload });
  assert.equal(res.mode, 'folded-into-body');
  assert.equal(state.reviews.length, 1);
  assert.deepEqual(state.reviews[0].comments, []);
  assert.equal(state.reviews[0].commit_id, undefined);
  assert.match(state.reviews[0].body, /finding/);

  const boom = async () => {
    throw new Error('HTTP 500');
  };
  await assert.rejects(() => core.postReviewWithFallback({ gh: boom, repo: REPO, pr: 7, payload }), /500/);
});

/* ---------- CLI commands (stubbed gh) ---------- */

test('ci-comment writes one sticky comment and fails only when asked to on hard rules', async () => {
  const dir = stageScratch({ layers: LAYERS_HOLLOW });
  const { gh, state } = fakeGh();
  const base = ['7', '--repo', REPO, '--scratch', dir];

  assert.equal(await quiet(() => runCiCommand('ci-comment', base, { gh })), 0);
  assert.equal(await quiet(() => runCiCommand('ci-comment', [...base, '--fail-on-hard-rules'], { gh })), 1);
  assert.equal(state.comments.length, 1, 'still exactly one comment after two runs');
  assert.match(state.comments[0].body, /Hard-rule findings \(1\)/);

  const clean = stageScratch({ layers: LAYERS_CLEAN });
  assert.equal(await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', clean, '--fail-on-hard-rules'], { gh: fakeGh().gh })), 0);
});

test('ci-comment --dry-run posts nothing', async () => {
  const dir = stageScratch();
  const { gh, state } = fakeGh();
  await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', dir, '--dry-run'], { gh }));
  assert.equal(state.comments.length, 0);
  assert.ok(state.calls.every((c) => !c.args.includes('POST') && !c.args.includes('PATCH')));
});

test('ci-review posts one COMMENT review using repo/pr/head from the workflow, not from agent output, then ci-comment reports the counts', async () => {
  const dir = stageScratch({ findingsJson: findings([issue('H1', 'high'), issue('L1', 'low'), issue('M1', 'medium', { loc: 'src/handler.ts:11' })]) });
  const { gh, state } = fakeGh();

  assert.equal(await quiet(() => runCiCommand('ci-review', ['7', '--repo', REPO, '--scratch', dir, '--min-severity', 'medium'], { gh })), 0);
  assert.equal(state.reviews.length, 1);
  const review = state.reviews[0];
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, HEAD, 'head comes from pr-meta.json, not the agent\'s own meta');
  const posted = state.calls.find((c) => c.args.some((x) => /pulls\/\d+\/reviews/.test(x)));
  assert.ok(posted.args.some((x) => x === `repos/${REPO}/pulls/7/reviews`), 'target comes from the CLI args, not the agent\'s meta');
  const allText = JSON.stringify(review);
  assert.match(allText, /H1/);
  assert.match(allText, /M1/);
  assert.ok(!/Finding L1/.test(allText), 'below-floor finding is not posted');

  await quiet(() => runCiCommand('ci-comment', ['7', '--repo', REPO, '--scratch', dir], { gh }));
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /2 finding\(s\) posted as non-blocking comments/);
});

test('ci-review skips findings that already have a trusted thread and posts nothing when none remain', async () => {
  const dir = stageScratch({
    findingsJson: findings([issue('H1', 'high')]),
    threads: { findingThreads: { H1: { id: 'H1', commentId: 1 } } }
  });
  const { gh, state } = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-review', ['7', '--repo', REPO, '--scratch', dir], { gh })), 0);
  assert.equal(state.reviews.length, 0);
});

test('ci-review with no findings.json is a clean no-op', async () => {
  const dir = stageScratch();
  const { gh, state } = fakeGh();
  assert.equal(await quiet(() => runCiCommand('ci-review', ['7', '--repo', REPO, '--scratch', dir], { gh })), 0);
  assert.equal(state.calls.length, 0);
});

test('CLI arguments are validated', () => {
  assert.throws(() => parseCiArgs(['7', '--min-severity', 'urgent']), /min-severity/);
  assert.throws(() => parseCiArgs(['7', '--max-findings', '1000']), /max-findings/);
  assert.throws(() => parseCiArgs(['7', '--bogus']), /Unknown/);
  assert.equal(parseCiArgs(['7', '--repo', REPO]).minSeverity, 'medium');
});

test('ci-analyze requires an agent and a valid repo before doing anything', async () => {
  await assert.rejects(() => runCiCommand('ci-analyze', ['7', '--repo', REPO]), /--agent is required/);
  await assert.rejects(() => runCiCommand('ci-analyze', ['7', '--repo', 'nope', '--agent', 'claude']), /--repo owner\/name/);
});

test('the agent never receives GitHub or OIDC tokens', () => {
  const env = scrubAgentEnv({
    PATH: '/bin',
    GH_TOKEN: 'x',
    GITHUB_TOKEN: 'y',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'z',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
    CRV_AI_TOKEN: 'needed-by-the-harness'
  });
  assert.deepEqual(Object.keys(env).sort(), ['CRV_AI_TOKEN', 'PATH']);
});

/* ---------- workflow guard rails ---------- */

const WORKFLOWS = path.join(__dirname, '../.github/workflows');
const wf = (name) => fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

test('crv workflows follow the security rules (pull_request only, least privilege, no expression interpolation in shell)', () => {
  for (const name of ['crv-review.yml', 'crv-self-review.yml']) {
    const text = wf(name);
    assert.ok(!/pull_request_target/.test(text.replace(/^\s*#.*$/gm, '')), `${name}: must not use pull_request_target`);
    assert.match(text, /permissions:\s*\n\s+contents: read\s*\n\s+pull-requests: write/, `${name}: least-privilege permissions`);
    assert.ok(!/(contents|issues|actions|id-token|checks|statuses):\s*write/.test(text), `${name}: no extra write scopes`);
  }

  // No `${{ ... }}` may appear inside any `run:` block: values reach shell through env only.
  const lines = wf('crv-review.yml').split('\n');
  let blockIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0 && line.trim() && indent <= blockIndent) blockIndent = -1;
    if (blockIndent >= 0) assert.ok(!line.includes('${{'), `crv-review.yml:${i + 1}: expression inside a run block: ${line.trim()}`);
    if (/^\s*run:\s*[|>]/.test(line)) blockIndent = indent;
    else if (/^\s*run:\s*\S/.test(line)) assert.ok(!line.includes('${{'), `crv-review.yml:${i + 1}: expression in run: ${line.trim()}`);
  });
});

test('the reusable workflow skips forks, drafts and Dependabot, and tier 2 is advisory and opt-in', () => {
  const text = wf('crv-review.yml');
  assert.match(text, /head\.repo\.full_name == github\.repository/);
  assert.match(text, /draft == false/);
  assert.match(text, /github\.actor != 'dependabot\[bot\]'/);
  assert.match(text, /ai-runner:[\s\S]*?default: none/);
  assert.match(text, /tier2:[\s\S]*?continue-on-error: true/);
  assert.match(text, /cancel-in-progress: true/);
  assert.match(text, /CRV_ALLOW_UNRESTRICTED_HEADLESS=1/);
});

test('the self-review caller runs the tooling from the base branch, not the PR head', () => {
  const text = wf('crv-self-review.yml');
  assert.match(text, /crv-ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
});

test('the AI setup seam reports "not configured" (10) instead of inventing credential handling', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '../scripts/ci-ai-setup.sh');
  const res = spawnSync('bash', ['-c', `. "${script}"; CRV_AI_RUNNER=agy PATH=/nonexistent crv_ai_setup; echo rc=$?`], { encoding: 'utf8' });
  assert.match(res.stdout, /rc=10/);
  const bad = spawnSync('bash', ['-c', `. "${script}"; CRV_AI_RUNNER=wat crv_ai_setup; echo rc=$?`], { encoding: 'utf8' });
  assert.match(bad.stdout, /rc=1/);
});

/* ---------- CI bootstrap guards (an older crv must never hang a runner) ---------- */

test('an unknown ci-* command fails fast instead of falling through to the interactive Workbench server', () => {
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, [path.join(__dirname, '../packages/cli/bin/crv.js'), 'ci-bogus', '11'], {
    encoding: 'utf8',
    timeout: 15000
  });
  assert.equal(res.error, undefined, 'must exit on its own, not time out');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown CI command "ci-bogus"/);
  assert.ok(!/running at http/.test(res.stdout), 'must not start the Workbench server');
});

test('the reusable workflow checks the pinned tooling has the ci-* commands before using them', () => {
  const text = wf('crv-review.yml');
  assert.match(text, /id: tooling[\s\S]*?crv-tool\/packages\/cli\/ci\.js/);
  assert.match(text, /tooling_ready: \$\{\{ steps\.tooling\.outputs\.ready \}\}/);
  assert.match(text, /Post or update the sticky overview comment\s*\n\s+if: steps\.tooling\.outputs\.ready == 'true'\s*\n\s+timeout-minutes: 3/);
  assert.match(text, /needs\.tier1\.outputs\.tooling_ready == 'true'/);
});
