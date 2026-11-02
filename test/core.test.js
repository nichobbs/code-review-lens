'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  serializeFindingComment,
  parseFindingComment,
  serializeOverviewComment,
  parseOverviewComment,
  buildGitHubReviewPayload,
  hydrateFromGitHubComments,
  classifyFilePath,
  inferFlowName,
  parseUnifiedDiff,
  extractDiffSlice,
  checkFindingsShape,
  compileFindingsToWorkbenchReport,
  parseGitHubRepoSlug,
  resolveRepoConfig,
  saveDefaultRepoConfig
} = require('../packages/core');

const { loadReportFile, buildStandaloneHtml } = require('../packages/cli/server');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

test('GitHub inline finding comment round-trips crv-finding metadata & human note', () => {
  const finding = {
    id: 'H1',
    sev: 'high',
    cat: 'correctness, security',
    verify: 'CONFIRMED',
    loc: 'services/loyalty/member-services/src/functions/close-account/service-handler.ts:53',
    title: 'POST /v1/member/close lets a DISABLED member overwrite their ban with CLOSED',
    impact: '<p><strong>Breaks:</strong> Banned member can close and re-onboard.</p>',
    fix: '<p><strong>Do:</strong> Throw <code>AccessDeniedError</code> when status is DISABLED.</p>',
    mermaid: 'flowchart LR\n  A --> B'
  };

  const body = serializeFindingComment(
    finding,
    { action: 'block', note: 'Confirmed blocker — let us guard DISABLED before line 70.' },
    { head: 'f5d2bc057b', pr: 1230 }
  );

  assert.match(body, /<!-- crv-finding:/);
  assert.match(body, /```mermaid/);

  const parsed = parseFindingComment(body);
  assert.ok(parsed);
  assert.equal(parsed.meta.id, 'H1');
  assert.equal(parsed.meta.action, 'block');
  assert.equal(parsed.meta.verify, 'CONFIRMED');
  assert.equal(parsed.note, 'Confirmed blocker — let us guard DISABLED before line 70.');
});

test('GitHub sticky overview comment round-trips crv-meta & hydrateFromGitHubComments links replies', () => {
  const report = loadReportFile(path.join(__dirname, '../fixtures/pr1230-report.json'));
  const triageMap = {
    H1: { action: 'block', note: 'Must fix before merge', done: true },
    M1: { action: 'comment', note: 'Throw NotFoundError on missing membership', done: true },
    L1: { action: 'dismiss', note: '', done: true }
  };

  const overviewBody = serializeOverviewComment(report, triageMap, 'Reviewed with Agentic Workbench.');
  const parsedOverview = parseOverviewComment(overviewBody);
  assert.ok(parsedOverview);
  assert.equal(parsedOverview.pr, 1230);
  assert.equal(parsedOverview.counts.block, 1);
  assert.equal(parsedOverview.counts.comment, 1);
  assert.equal(parsedOverview.counts.dismiss, 1);

  const reviewPayload = buildGitHubReviewPayload(report, triageMap, {
    summaryNote: 'Blocking on H1.'
  });
  assert.equal(reviewPayload.event, 'REQUEST_CHANGES');
  assert.equal(reviewPayload.comments.length, 2); // H1 + M1 only (L1 dismissed!)
  assert.equal(
    reviewPayload.comments[0].path,
    'services/loyalty/member-services/src/functions/close-account/service-handler.ts'
  );
  assert.equal(reviewPayload.comments[0].line, 53);

  // Hydrate from simulated GitHub API responses
  const hydrated = hydrateFromGitHubComments(
    [{ id: 101, body: overviewBody, user: { login: 'reviewer' }, html_url: 'https://github.com/pr/1230#issuecomment-101' }],
    [
      {
        id: 5001,
        path: reviewPayload.comments[0].path,
        line: 53,
        body: reviewPayload.comments[0].body,
        user: { login: 'reviewer' },
        html_url: 'https://github.com/pr/1230#discussion_r5001'
      },
      {
        id: 5002,
        in_reply_to_id: 5001,
        body: 'Fixed in commit abc1234!',
        user: { login: 'colleague' },
        created_at: '2026-10-30T02:00:00Z'
      }
    ]
  );

  assert.equal(hydrated.overviewMeta.commentId, 101);
  assert.ok(hydrated.findingThreads.H1);
  assert.equal(hydrated.findingThreads.H1.action, 'block');
  assert.equal(hydrated.findingThreads.H1.replies.length, 1);
  assert.equal(hydrated.findingThreads.H1.replies[0].body, 'Fixed in commit abc1234!');
});

test('4-Layer diff classifier & Behavioral Test Matrix extractor work on unified diffs', () => {
  assert.equal(
    classifyFilePath('services/loyalty/member-services/src/functions/close-account/close-account.openapi-spec.ts').layer,
    'contracts'
  );
  assert.equal(
    classifyFilePath('services/loyalty/member-services/test/functions/onboard/service-handler.test.ts').layer,
    'tests'
  );
  assert.equal(
    classifyFilePath('services/loyalty/member-services/src/functions/close-account/service-handler.ts').layer,
    'flows'
  );

  const sampleDiff = [
    'diff --git a/services/loyalty/test/onboard.test.ts b/services/loyalty/test/onboard.test.ts',
    '@@ -10,3 +10,12 @@ describe("OnboardServiceHandler", () => {',
    '+  it("reactivates CLOSED member", async () => {',
    '+    const res = await handler.execute(req);',
    '+    expect(res.status).toBe(200);',
    '+    expect(mockHubspot.update).toHaveBeenCalled();',
    '+  });'
  ].join('\n');

  const files = parseUnifiedDiff(sampleDiff);
  assert.equal(files.length, 1);
  assert.equal(files[0].layer, 'tests');
  assert.equal(files[0].testMatrix.length, 1);
  assert.equal(files[0].testMatrix[0].behavior, 'reactivates CLOSED member');
  assert.equal(files[0].testMatrix[0].assertions, 2);

  const slice = extractDiffSlice(files, 'services/loyalty/test/onboard.test.ts:12');
  assert.ok(slice);
  assert.equal(slice.targetLine, 12);
});

test('Standalone HTML export embeds report, styles, and Mermaid runtime cleanly', () => {
  const report = loadReportFile(path.join(__dirname, '../fixtures/pr1230-report.json'));
  const html = buildStandaloneHtml(report);
  assert.ok(html.includes('window.__CRV_INITIAL_REPORT__'));
  assert.ok(html.includes('id="crv-findings"'));
  assert.ok(html.includes('closedby="any"'));
  assert.ok(html.includes('Layer 4: Behavioral Test Matrix'));
});

test('crv-code-review findings.json compiler & prepare_pr.mjs / extract_findings.py round-trip', () => {
  const sampleFindings = {
    meta: {
      title: 'PR #1230: Account closure & re-onboarding',
      subtitle: '3 files, +40 -5',
      prUrl: 'https://github.com/acme/loyalty-platform/pull/1230',
      headCommit: 'f5d2bc057b',
      storageKey: 'loyalty-platform-pr1230',
      review: {
        repo: 'acme/loyalty-platform',
        pr: 1230,
        base: 'aaaa1111',
        head: 'f5d2bc057b',
        agent: 'Antigravity',
        model: 'gemini',
        lenses: ['correctness', 'security', 'tests']
      },
      summary: '**What it does.** Adds account closure.\n\n```mermaid\nflowchart LR\n  A[Client] --> B[CloseHandler]\n```\n\n**Coverage.** Three lenses ran.',
      summaryPoints: ['correctness: ran, 1 finding', 'tests: ran, no findings']
    },
    issues: [
      {
        id: 'H1',
        sev: 'high',
        cat: 'correctness, security',
        verify: 'CONFIRMED',
        loc: 'services/loyalty/src/close-account/service-handler.ts:14',
        title: 'DISABLED member can overwrite ban with CLOSED',
        impact: '**Breaks:** Banned member closes account.\n\n**Because:** `service-handler.ts:14` only checks CLOSED.\n\n**Reach:** Every DISABLED member.',
        fix: '**Do:** Reject DISABLED before updating.\n\n**Check:** Test with DISABLED member.'
      }
    ]
  };

  const sampleDiff = [
    'diff --git a/services/loyalty/src/close-account/close-account.openapi-spec.ts b/services/loyalty/src/close-account/close-account.openapi-spec.ts',
    '@@ -1,3 +1,6 @@',
    '+export const closeAccountSpec = {',
    '+  path: "/v1/member/close"',
    '+};',
    'diff --git a/services/loyalty/src/close-account/service-handler.ts b/services/loyalty/src/close-account/service-handler.ts',
    '@@ -10,4 +10,8 @@ export async function closeAccount(member) {',
    '   if (member.status === "CLOSED") return;',
    '+  // Missing DISABLED check here',
    '+  await repo.updateStatus(member.id, "CLOSED");',
    '+  return { status: "CLOSED" };',
    ' }',
    'diff --git a/services/loyalty/test/close-account.test.ts b/services/loyalty/test/close-account.test.ts',
    '@@ -1,4 +1,16 @@ describe("closeAccount", () => {',
    '+  it("closes active member", async () => {',
    '+    const res = await closeAccount({ id: "1", status: "ACTIVE" });',
    '+    expect(res.status).toBe("CLOSED");',
    '+  });',
    '+  it("hollow test with no assertions", async () => {',
    '+    await closeAccount({ id: "2", status: "CLOSED" });',
    '+  });',
    '+  it("mock-only test", async () => {',
    '+    await closeAccount({ id: "3", status: "ACTIVE" });',
    '+    expect(mockRepo.updateStatus).toHaveBeenCalled();',
    '+  });'
  ].join('\n');

  const warnings = checkFindingsShape(sampleFindings);
  assert.equal(warnings.length, 0);

  const compiled = compileFindingsToWorkbenchReport(sampleFindings, { diffText: sampleDiff });
  assert.equal(compiled.XMETA.verdict, 'Blockers found');
  assert.equal(compiled.DATA.length, 1);
  assert.ok(compiled.DATA[0].diffSlice);
  assert.equal(compiled.DATA[0].diffSlice.targetLine, 14);
  assert.equal(compiled.LAYERS.contracts.length, 1);
  assert.equal(compiled.LAYERS.flows.length, 1);
  assert.deepEqual(compiled.LAYERS.flows[0].findings, ['H1']);
  assert.equal(compiled.LAYERS.testMatrix.length, 1);
  assert.equal(compiled.LAYERS.testMatrix[0].cases.length, 3);
  assert.equal(compiled.LAYERS.testMatrix[0].cases[0].hollow, false);
  assert.equal(compiled.LAYERS.testMatrix[0].cases[1].hollow, true);
  assert.equal(compiled.LAYERS.testMatrix[0].cases[2].mockOnly, true);

  // Test prepare_pr.mjs and extract_findings.py integration
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-skill-test-'));
  const diffFile = path.join(tmpDir, 'diff.patch');
  fs.writeFileSync(diffFile, sampleDiff);

  const prepScript = path.join(__dirname, '../.agents/skills/crv-code-review/scripts/prepare_pr.mjs');
  const prepOut = JSON.parse(execFileSync('node', [prepScript, '--diff', diffFile, tmpDir], { encoding: 'utf8' }));
  assert.equal(prepOut.contractsCount, 1);
  assert.equal(prepOut.flowsCount, 1);
  assert.equal(prepOut.testCasesExtracted, 3);
  assert.equal(prepOut.hollowOrMockOnlyCases, 2);

  // Export standalone HTML and verify extract_findings.py recovers sampleFindings losslessly
  const htmlPath = path.join(tmpDir, 'pr1230-workbench.html');
  fs.writeFileSync(htmlPath, buildStandaloneHtml(compiled));
  const extractedPath = path.join(tmpDir, 'extracted-findings.json');
  const extractScript = path.join(__dirname, '../.agents/skills/crv-code-review/scripts/extract_findings.py');
  const extractStdout = execFileSync('/usr/bin/python3', [extractScript, htmlPath, extractedPath], { encoding: 'utf8' });
  assert.match(extractStdout, /mode:exact/);
  const recovered = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
  assert.equal(recovered.issues[0].id, 'H1');
  assert.equal(recovered.meta.review.pr, 1230);
});

test('Generic repo-config resolution chain (CLI/UI -> env -> .env -> .crvrc.json -> git remote) & generic flow names', () => {
  assert.equal(parseGitHubRepoSlug('https://github.com/acme/payments-service.git'), 'acme/payments-service');
  assert.equal(parseGitHubRepoSlug('git@github.com:acme/payments-service.git'), 'acme/payments-service');
  assert.equal(parseGitHubRepoSlug('acme/payments-service#42'), 'acme/payments-service');

  const tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-repo-cfg-'));

  // 1. Explicit flag wins over everything
  assert.deepEqual(
    resolveRepoConfig({
      cwd: tmpRepoDir,
      explicitRepo: 'acme/explicit-repo',
      env: { CRV_DEFAULT_REPO: 'acme/env-repo' }
    }),
    { repo: 'acme/explicit-repo', source: 'explicit (--repo / UI)' }
  );

  // 2. Environment variable (CRV_DEFAULT_REPO or GH_REPO)
  assert.deepEqual(
    resolveRepoConfig({
      cwd: tmpRepoDir,
      env: { CRV_DEFAULT_REPO: 'acme/env-repo' }
    }),
    { repo: 'acme/env-repo', source: 'env:CRV_DEFAULT_REPO' }
  );

  // 3. .env file in working directory
  fs.writeFileSync(path.join(tmpRepoDir, '.env'), 'CRV_DEFAULT_REPO=acme/dotenv-repo\n');
  assert.deepEqual(
    resolveRepoConfig({ cwd: tmpRepoDir, env: {} }),
    { repo: 'acme/dotenv-repo', source: '.env' }
  );
  fs.unlinkSync(path.join(tmpRepoDir, '.env'));

  // 4. .crvrc.json in working directory via saveDefaultRepoConfig
  const saved = saveDefaultRepoConfig('acme/local-config-repo', { cwd: tmpRepoDir });
  assert.equal(saved.repo, 'acme/local-config-repo');
  const resolvedLocal = resolveRepoConfig({ cwd: tmpRepoDir, env: {} });
  assert.equal(resolvedLocal.repo, 'acme/local-config-repo');
  assert.match(resolvedLocal.source, /\.crvrc\.json$/);
  fs.unlinkSync(saved.path);

  // 5. Git remote origin fallback
  execFileSync('git', ['init'], { cwd: tmpRepoDir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/git-origin-repo.git'], { cwd: tmpRepoDir });
  assert.deepEqual(
    resolveRepoConfig({ cwd: tmpRepoDir, env: {} }),
    { repo: 'acme/git-origin-repo', source: 'git remote (origin)' }
  );

  // 6. Generic flow inference across different repo structures
  assert.equal(inferFlowName('packages/checkout/src/controllers/refund/handler.ts'), 'Feature / Handler: refund');
  assert.equal(inferFlowName('apps/web-portal/src/checkout.ts'), 'apps/web-portal');
  assert.equal(inferFlowName('src/auth/login.ts'), 'src/auth');

  // 7. CLI --help, --version, and install-skill self-contained vendor test
  const cliBin = path.join(__dirname, '../packages/cli/bin/crv.js');
  const helpOut = execFileSync('node', [cliBin, '--help'], { encoding: 'utf8' });
  assert.match(helpOut, /crv install-skill/);
  assert.match(helpOut, /crv-code-review/);

  const skillDestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-skill-install-'));
  const installOut = execFileSync('node', [cliBin, 'install-skill', '--dir', skillDestRoot], { encoding: 'utf8' });
  assert.match(installOut, /Installed "crv-code-review" skill/);
  const installedPrep = path.join(skillDestRoot, 'crv-code-review', 'scripts', 'prepare_pr.mjs');
  const installedCore = path.join(skillDestRoot, 'crv-code-review', 'scripts', 'lib', 'core', 'index.js');
  assert.ok(fs.existsSync(installedPrep));
  assert.ok(fs.existsSync(installedCore));
});
