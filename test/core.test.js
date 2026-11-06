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
  parsePaginatedGhJson,
  classifyFilePath,
  inferFlowName,
  parseUnifiedDiff,
  buildLayersFromParsedDiff,
  extractShortcutsFromHunks,
  parseCodeowners,
  matchCodeowners,
  analyzeSpecAlignment,
  extractDiffSlice,
  synthesizeUnifiedDiffFromFiles,
  fetchPrDiffWithFallback,
  checkFindingsShape,
  compileFindingsToWorkbenchReport,
  parseGitHubRepoSlug,
  resolveRepoConfig,
  saveDefaultRepoConfig,
  resolveAgentConfig,
  saveDefaultAgentConfig
} = require('../packages/core');

const { loadReportFile, buildStandaloneHtml, createWorkbenchServer } = require('../packages/cli/server');
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
      },
      {
        id: 6001,
        path: 'services/loyalty/member-services/src/functions/close-account/service-handler.ts',
        line: 70,
        body: 'Human reviewer question on line 70',
        user: { login: 'teammate' },
        html_url: 'https://github.com/pr/1230#discussion_r6001'
      },
      {
        id: 6002,
        in_reply_to_id: 6001,
        body: 'Good catch, will update.',
        user: { login: 'author' },
        created_at: '2026-10-30T03:00:00Z'
      }
    ]
  );

  assert.equal(hydrated.overviewMeta.commentId, 101);
  assert.ok(hydrated.findingThreads.H1);
  assert.equal(hydrated.findingThreads.H1.action, 'block');
  assert.equal(hydrated.findingThreads.H1.replies.length, 1);
  assert.equal(hydrated.findingThreads.H1.replies[0].body, 'Fixed in commit abc1234!');
  assert.equal(hydrated.generalComments.length, 1);
  assert.equal(hydrated.generalComments[0].author, 'teammate');
  assert.equal(hydrated.generalComments[0].line, 70);
  assert.equal(hydrated.generalComments[0].replies.length, 1);
  assert.equal(hydrated.generalComments[0].replies[0].body, 'Good catch, will update.');
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
  assert.ok(html.includes('id="guidePanel"'));
  assert.ok(html.includes('id="guideToggleBtn"'));
  assert.ok(html.includes('Where Humans Add Maximum Leverage'));
  assert.ok(html.includes('until-found'));
  assert.match(html, /<title>#1230 · [\w-]+ — /);
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
  assert.ok(compiled.LAYERS.contracts[0].diffSummary.includes('/v1/member/close'));
  assert.deepEqual(compiled.LAYERS.contracts[0].linkedFindings, []);
  assert.equal(compiled.LAYERS.flows.length, 1);
  assert.deepEqual(compiled.LAYERS.flows[0].findings, ['H1']);
  assert.deepEqual(compiled.LAYERS.flows[0].linkedFindings, ['H1']);
  assert.ok(compiled.LAYERS.flows[0].title);
  assert.ok(compiled.LAYERS.flows[0].description);
  assert.equal(compiled.LAYERS.testMatrix.length, 1);
  assert.equal(compiled.LAYERS.testMatrix[0].cases.length, 3);
  assert.equal(compiled.LAYERS.testMatrix[0].scenarios.length, 3);
  assert.equal(compiled.LAYERS.testMatrix[0].totalCases, 3);
  assert.equal(compiled.LAYERS.testMatrix[0].assertionsCount, 2);
  assert.ok(compiled.LAYERS.testMatrix[0].rawDiff.includes('closes active member'));
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
  assert.ok(Array.isArray(prepOut.triggeredLenses));
  assert.ok(prepOut.triggeredLenses.includes('correctness'));
  assert.ok(prepOut.triggeredLenses.includes('contract'));
  assert.ok(prepOut.triggeredLenses.includes('tests'));
  assert.ok(fs.existsSync(path.join(tmpDir, 'review-pack.md')));
  const reviewPackText = fs.readFileSync(path.join(tmpDir, 'review-pack.md'), 'utf8');
  assert.match(reviewPackText, /Pre-Computed Judge Lens Pick/);
  assert.match(reviewPackText, /L12 \+  await repo\.updateStatus/);

  // Export standalone HTML and verify extract_findings.py recovers sampleFindings losslessly
  const htmlPath = path.join(tmpDir, 'pr1230-workbench.html');
  fs.writeFileSync(htmlPath, buildStandaloneHtml(compiled));
  const extractedPath = path.join(tmpDir, 'extracted-findings.json');
  const extractScript = path.join(__dirname, '../.agents/skills/crv-code-review/scripts/extract_findings.py');
  const extractStdout = execFileSync('python3', [extractScript, htmlPath, extractedPath], { encoding: 'utf8' });
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

  // 8. Agent harness & model resolution chain + CLI argument construction
  const savedAgent = saveDefaultAgentConfig('agy', {
    cwd: tmpRepoDir,
    model: 'claude-opus-4-6',
    effort: 'high'
  });
  assert.equal(savedAgent.agent, 'agy');
  assert.equal(savedAgent.model, 'claude-opus-4-6');
  assert.equal(savedAgent.effort, 'high');

  const resolvedFromFile = resolveAgentConfig({ cwd: tmpRepoDir, env: {} });
  assert.equal(resolvedFromFile.agent, 'agy');
  assert.equal(resolvedFromFile.model, 'claude-opus-4-6');
  assert.equal(resolvedFromFile.effort, 'high');

  const agyInteractiveArgs = resolvedFromFile.spec.buildInteractiveArgs('Prompt', '/skills', {
    model: resolvedFromFile.model,
    effort: resolvedFromFile.effort
  });
  assert.deepEqual(agyInteractiveArgs, [
    '--add-dir',
    '/skills',
    '--model',
    'claude-opus-4-6',
    '--effort',
    'high',
    '-i',
    'Prompt'
  ]);

  const resolvedOverride = resolveAgentConfig({
    cwd: tmpRepoDir,
    explicitAgent: 'claude',
    explicitModel: 'sonnet',
    env: { CRV_MODEL: 'opus' }
  });
  assert.equal(resolvedOverride.agent, 'claude');
  assert.equal(resolvedOverride.model, 'sonnet');
});

test('createWorkbenchServer serves API, blocks cross-origin CSRF POSTs, and prevents static path traversal', async () => {
  const { PassThrough } = require('node:stream');
  const report = loadReportFile(path.join(__dirname, '../fixtures/pr1230-report.json'));
  const tmpSubmitPath = path.join(os.tmpdir(), `crv-test-submit-${Date.now()}.json`);
  const { server } = createWorkbenchServer({ report, lastSubmittedPath: tmpSubmitPath, dryRun: true });

  function invokeServer({ method = 'GET', url = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
      const req = new PassThrough();
      req.method = method;
      req.url = url;
      req.headers = { host: '127.0.0.1:4320', ...headers };

      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      res.writeHead = (statusCode, hdrs = {}) => {
        res.statusCode = statusCode;
        res.headers = { ...res.headers, ...hdrs };
        return res;
      };
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('finish', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: async () => text,
          json: async () => JSON.parse(text)
        });
      });
      res.on('error', reject);

      server.emit('request', req, res);
      if (body !== null) {
        req.write(body);
      }
      req.end();
    });
  }

  try {
    // 1. GET /api/report
    const repRes = await invokeServer({ method: 'GET', url: '/api/report' });
    assert.equal(repRes.status, 200);
    const repData = await repRes.json();
    assert.equal(repData.REVIEW.pr, 1230);

    // 2. Reject cross-origin POST (CSRF protection)
    const csrfRes = await invokeServer({
      method: 'POST',
      url: '/api/github/submit-review',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.com'
      },
      body: JSON.stringify({ repo: 'acme/repo', pr: 1230, payload: {} })
    });
    assert.equal(csrfRes.status, 403);

    // 3. Allow Chrome Extension and localhost POSTs
    const extRes = await invokeServer({
      method: 'POST',
      url: '/api/github/submit-review',
      headers: {
        'content-type': 'application/json',
        origin: 'chrome-extension://abcdefghijklmnop'
      },
      body: JSON.stringify({ repo: 'acme/repo', pr: 1230, payload: { event: 'COMMENT' } })
    });
    assert.equal(extRes.status, 200);
    const extJson = await extRes.json();
    assert.equal(extJson.ok, true);
    assert.equal(extJson.savedTo, tmpSubmitPath);

    // 4. Static asset serving & path traversal check
    const indexRes = await invokeServer({ method: 'GET', url: '/' });
    assert.equal(indexRes.status, 200);
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('id="resizer"'));
    assert.ok(indexHtml.includes('id="guidePanel"'));

    const traversalRes = await invokeServer({ method: 'GET', url: '/..%2f..%2fpackage.json' });
    assert.equal(traversalRes.status, 404);
  } finally {
    if (fs.existsSync(tmpSubmitPath)) fs.unlinkSync(tmpSubmitPath);
  }
});

test('Large PR (>20,000 lines HTTP 406 PullRequest.diff too_large) fallback via local git & per-file API', () => {
  // 1. parsePaginatedGhJson handles single page, --slurp nested pages, and concatenated pages
  assert.deepEqual(parsePaginatedGhJson('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(parsePaginatedGhJson('[[{"id":1}],[{"id":2}]]'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(parsePaginatedGhJson('[{"id":1}]\n[{"id":2}]'), [{ id: 1 }, { id: 2 }]);

  // 2. synthesizeUnifiedDiffFromFiles + parseUnifiedDiff preserves hunks AND omitted-patch stats
  const apiFiles = [
    {
      filename: 'services/hub/src/openapi-spec.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: '@@ -1,3 +1,4 @@\n-export const v = "1.0";\n+export const v = "2.0";\n+export const path = "/v2/hub";'
    },
    {
      filename: 'services/hub/test/hub.test.ts',
      status: 'added',
      additions: 5,
      deletions: 0,
      patch: '@@ -0,0 +1,5 @@\n+describe("Hub", () => {\n+  it("returns v2", () => {\n+    expect(v).toBe("2.0");\n+  });\n+});'
    },
    {
      // Giant lockfile where GitHub omits `patch` and causes `gh pr diff` HTTP 406
      filename: 'package-lock.json',
      status: 'modified',
      additions: 21500,
      deletions: 4200
    }
  ];

  const synthesized = synthesizeUnifiedDiffFromFiles(apiFiles);
  const parsed = parseUnifiedDiff(synthesized);
  assert.equal(parsed.length, 3);
  const layers = buildLayersFromParsedDiff(parsed, []);
  assert.equal(layers.contracts.length, 1);
  assert.equal(layers.testMatrix.length, 1);
  assert.equal(layers.testMatrix[0].cases.length, 1);
  assert.equal(layers.testMatrix[0].cases[0].behavior, 'returns v2');
  assert.equal(layers.config.length, 1);
  assert.equal(layers.config[0].path, 'package-lock.json');
  assert.equal(layers.config[0].additions, 21500);
  assert.equal(layers.config[0].deletions, 4200);

  // 3. fetchPrDiffWithFallback falls back to gh-pr-files-api when gh pr diff returns HTTP 406
  const http406Err =
    'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)\nPullRequest.diff too_large';
  let fallbackLogged = '';

  const fallbackApiResult = fetchPrDiffWithFallback({
    pr: 1480,
    repo: 'acme/cx-integration-hub',
    prMeta: {
      number: 1480,
      url: 'https://github.com/acme/cx-integration-hub/pull/1480',
      baseRefOid: 'aaaa1111',
      headRefOid: 'bbbb2222'
    },
    onFallback: (msg) => {
      fallbackLogged = msg;
    },
    spawnSyncFn: (bin, args) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'diff') {
        return { status: 1, stdout: '', stderr: http406Err };
      }
      if (bin === 'git') {
        // Simulate running outside the git repo
        return { status: 128, stdout: '', stderr: 'not a git repository' };
      }
      if (bin === 'gh' && args[0] === 'api' && args[1].includes('/pulls/1480/files')) {
        return { status: 0, stdout: JSON.stringify([apiFiles]), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected call' };
    }
  });

  assert.match(fallbackLogged, /PullRequest\.diff too_large/);
  assert.equal(fallbackApiResult.source, 'gh-pr-files-api');
  assert.equal(parseUnifiedDiff(fallbackApiResult.diffText).length, 3);

  // 4. fetchPrDiffWithFallback uses local-git-diff when inside the git repo with commits present
  const fallbackGitResult = fetchPrDiffWithFallback({
    pr: 1480,
    repo: 'acme/cx-integration-hub',
    prMeta: {
      number: 1480,
      baseRefOid: 'aaaa1111',
      headRefOid: 'bbbb2222'
    },
    spawnSyncFn: (bin, args) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'diff') {
        return { status: 1, stdout: '', stderr: http406Err };
      }
      if (bin === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      if (bin === 'git' && args[0] === 'cat-file') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (bin === 'git' && args[0] === 'diff') {
        return { status: 0, stdout: synthesized, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(fallbackGitResult.source, 'local-git-diff');
  assert.equal(parseUnifiedDiff(fallbackGitResult.diffText).length, 3);
});

test('AI-era Human Attention Signals: removedGuards, tautology, internalMock, stealthChanges, reuseCandidates, suggestion & Human Focus', () => {
  // 1. Verify 14th lens (ai-harness.md) exists
  const aiHarnessLensPath = path.join(
    __dirname,
    '../.agents/skills/crv-code-review/lenses/ai-harness.md'
  );
  assert.ok(fs.existsSync(aiHarnessLensPath));
  assert.equal(classifyFilePath('.agents/skills/crv-code-review/SKILL.md').layer, 'contracts');
  assert.equal(
    classifyFilePath('.agents/skills/crv-code-review/SKILL.md').category,
    'AI Harness / Prompt Contract'
  );

  // 2. Parse a diff with a removed auth guard, duplicate added helper, internal seam mock, and oracle tautology
  const aiDiff = [
    'diff --git a/services/billing/src/refund-handler.ts b/services/billing/src/refund-handler.ts',
    '@@ -10,6 +10,9 @@ export async function issueRefund(req) {',
    '-  if (!isAuthorized(req.user)) throw new ForbiddenError("Unauthorized");',
    '-  const payload = RefundSchema.strict().parse(req.body);',
    '+  const payload = req.body ?? {};',
    '+  return { ok: true, amount: payload.amount ?? 0 };',
    ' }',
    '+export function formatRefundCurrency(cents) {',
    '+  return `$${(cents / 100).toFixed(2)}`;',
    '+}',
    'diff --git a/services/billing/src/invoice-handler.ts b/services/billing/src/invoice-handler.ts',
    '@@ -1,3 +1,6 @@',
    '+export function formatRefundCurrency(cents) {',
    '+  return `$${(cents / 100).toFixed(2)}`;',
    '+}',
    'diff --git a/services/auth/src/permissions.ts b/services/auth/src/permissions.ts',
    '@@ -5,3 +5,4 @@ export function checkRole(u) {',
    '+  if (u.bypass) return true;',
    ' }',
    'diff --git a/services/billing/test/refund-handler.test.ts b/services/billing/test/refund-handler.test.ts',
    '@@ -1,3 +1,15 @@',
    '+jest.mock("../src/refund-repo");',
    '+describe("issueRefund", () => {',
    '+  it("tautology test", () => {',
    '+    expect(true).toBe(true);',
    '+  });',
    '+  it("internal seam mock test", () => {',
    '+    expect(mockRefundRepo.save).toHaveBeenCalled();',
    '+  });',
    '+});'
  ].join('\n');

  const parsed = parseUnifiedDiff(aiDiff);
  assert.equal(parsed.length, 4);

  const layers = buildLayersFromParsedDiff(parsed, [], {
    prMeta: {
      title: 'feat(billing): update refund and invoice handlers',
      body: 'Updates refund-handler and invoice-handler formatting.'
    }
  });

  // Removed guards detected in refund-handler.ts
  assert.ok(layers.attentionSignals);
  assert.equal(layers.attentionSignals.removedGuards.length, 2);
  assert.equal(layers.attentionSignals.removedGuards[0].category, 'auth-permission-check');
  assert.equal(layers.attentionSignals.removedGuards[1].category, 'schema-validation');

  // Near-duplicate utility added across two files in the same diff
  assert.equal(layers.attentionSignals.reuseCandidates.length, 1);
  assert.equal(layers.attentionSignals.reuseCandidates[0].name, 'formatRefundCurrency');
  assert.equal(layers.attentionSignals.reuseCandidates[0].kind, 'duplicate-in-diff');

  // Stealth change: services/auth/src/permissions.ts modified without mention in PR title/body
  assert.equal(layers.attentionSignals.stealthChanges.length, 1);
  assert.equal(layers.attentionSignals.stealthChanges[0].path, 'services/auth/src/permissions.ts');

  // Behavioral Test Matrix: tautology and internalMock detected
  assert.equal(layers.testMatrix.length, 1);
  const testCases = layers.testMatrix[0].cases;
  assert.equal(testCases.length, 2);
  assert.equal(testCases[0].tautology, true);
  assert.equal(testCases[0].status, 'tautology');
  assert.equal(testCases[1].internalMock, true);
  assert.equal(testCases[1].status, 'internal-mock');

  // 3. Verify `**Human Focus.**`, `suggestion`, and `fixPrompt` compile and serialize to GitHub comments
  const findingsWithHumanFocus = {
    meta: {
      title: 'PR #99: Billing refund refactor',
      summary:
        '**What it does.** Updates refund handler.\n\n**Human Focus.**\n- Confirm whether `isAuthorized` was intentionally removed at `refund-handler.ts:10`.\n\n**Coverage.** 14 lenses checked.',
      review: { repo: 'acme/billing', pr: 99, head: '12345678' }
    },
    issues: [
      {
        id: 'H1',
        sev: 'high',
        cat: 'security, correctness',
        verify: 'CONFIRMED',
        loc: 'services/billing/src/refund-handler.ts:12',
        title: 'Removed isAuthorized guard lets unauthenticated callers issue refunds',
        impact: '**Breaks:** Anyone can trigger refunds.\n\n**Because:** `refund-handler.ts:12` deleted `isAuthorized`.\n\n**Reach:** Public endpoint.',
        fix: '**Do:** Restore `if (!isAuthorized(req.user)) throw new ForbiddenError()`.\n\n**Check:** Unauthenticated test returns 403.',
        suggestion: '  if (!isAuthorized(req.user)) throw new ForbiddenError("Unauthorized");\n  const payload = RefundSchema.strict().parse(req.body);',
        fixPrompt: 'Restore the removed isAuthorized and RefundSchema.strict().parse guards in services/billing/src/refund-handler.ts:12.'
      }
    ]
  };

  const compiled = compileFindingsToWorkbenchReport(findingsWithHumanFocus, { diffText: aiDiff });
  assert.match(compiled.SUMMARY.html, /<h3>Human Focus<\/h3>/);
  assert.equal(compiled.DATA[0].suggestion.includes('ForbiddenError'), true);
  assert.equal(compiled.DATA[0].fixPrompt.includes('RefundSchema.strict()'), true);

  const ghComment = serializeFindingComment(compiled.DATA[0], { action: 'block' }, { head: '12345678', pr: 99 });
  assert.match(ghComment, /```suggestion\n {2}if \(!isAuthorized\(req\.user\)\)/);
});

test('Shortcuts Ledger, Spec/Negative-Space Alignment, CODEOWNERS & Caller Blast Radius, Lean Cuttable Lines, and ESL Slop Linter', () => {
  const diff = [
    'diff --git a/packages/api/src/user-contract.ts b/packages/api/src/user-contract.ts',
    '@@ -1,4 +1,9 @@',
    ' export interface UserContract {',
    '   id: string;',
    '+  // shortcut: <1000 active sessions, migrate to Redis cluster when concurrent users exceed 1000',
    '+  sessionCache?: Record<string, string>;',
    '+  // TODO: clean up legacy token field later',
    '+  legacyToken?: string;',
    ' }',
    'diff --git a/packages/legacy-auth/src/session.ts b/packages/legacy-auth/src/session.ts',
    '@@ -10,3 +10,4 @@ export function verifyLegacySession(t) {',
    '+  return Boolean(t);',
    ' }',
    'diff --git a/packages/api/test/user-contract.test.ts b/packages/api/test/user-contract.test.ts',
    '@@ -1,3 +1,8 @@',
    '+describe("UserContract session cache", () => {',
    '+  it("caches active session when user logs in", () => {',
    '+    expect(createSession("u1").id).toBe("u1");',
    '+  });',
    '+});'
  ].join('\n');

  const parsed = parseUnifiedDiff(diff);
  const shortcuts = extractShortcutsFromHunks(parsed);
  assert.equal(shortcuts.length, 2);
  const bounded = shortcuts.find((s) => s.kind === 'shortcut');
  const unbounded = shortcuts.find((s) => s.kind === 'todo');
  assert.ok(bounded);
  assert.equal(bounded.hasTrigger, true);
  assert.equal(bounded.rotRisk, false);
  assert.ok(unbounded);
  assert.equal(unbounded.hasTrigger, false);
  assert.equal(unbounded.rotRisk, true);

  // CODEOWNERS parsing & matching (including /* single-level wildcard, **/ zero-dir glob, and inline comments)
  const codeownersRules = parseCodeowners([
    '# Core owners',
    '/packages/api/ @platform-team @api-leads # inline comment',
    '/packages/legacy-auth/ @security-team',
    '/packages/* @root-pkg-owner',
    'packages/**/index.js @index-owner'
  ].join('\n'));
  assert.deepEqual(matchCodeowners('packages/api/src/user-contract.ts', codeownersRules), [
    '@platform-team',
    '@api-leads'
  ]);
  assert.deepEqual(matchCodeowners('packages/top.js', codeownersRules), ['@root-pkg-owner']);
  assert.deepEqual(matchCodeowners('packages/index.js', codeownersRules), ['@index-owner']);

  // Spec & Negative-Space Alignment + Caller Blast Radius
  const prMeta = {
    title: 'feat(api): add sessionCache to UserContract',
    body: [
      '## Summary',
      'Adds bounded in-memory session cache with `Given/When/Then` and `WHEN ... SHALL` support.',
      'Repo precedent: follows `packages/api/src/token-contract.ts`.',
      '',
      '## Acceptance Criteria',
      '- WHEN user logs in, the system SHALL cache active session in memory',
      '- Given an expired token, When session is queried, Then return 401 unauthorized',
      '',
      '## Out of scope',
      '- Do not touch `test` runner or packages/legacy-auth.'
    ].join('\n')
  };

  const layers = buildLayersFromParsedDiff(parsed, [], {
    prMeta,
    codeownersRules,
    callerBlastRadiusByPath: {
      'packages/api/src/user-contract.ts': {
        callers: [
          { path: 'apps/web/src/auth.ts', owners: ['@web-team'] },
          { path: 'apps/mobile/src/login.ts', owners: [] }
        ],
        unownedCallersCount: 1
      }
    }
  });

  // Verify shortcuts & specAlignment in attentionSignals
  assert.equal(layers.attentionSignals.shortcuts.length, 2);
  const spec = layers.attentionSignals.specAlignment;
  assert.ok(spec);
  assert.equal(spec.outOfScope.length, 1);
  assert.equal(spec.negativeSpaceViolations.length, 1);
  assert.equal(spec.negativeSpaceViolations[0].path, 'packages/legacy-auth/src/session.ts');
  assert.equal(spec.repoPrecedents.length, 1);
  assert.equal(spec.specClauses.length, 2);
  assert.equal(spec.specClauses[0].covered, true);
  assert.equal(spec.specClauses[1].covered, false);

  // Verify contract owners & callerBlastRadius in Layer 3
  assert.equal(layers.contracts.length, 1);
  assert.deepEqual(layers.contracts[0].owners, ['@platform-team', '@api-leads']);
  assert.equal(layers.contracts[0].callerBlastRadius.callers.length, 2);
  assert.equal(layers.contracts[0].callerBlastRadius.unownedCallersCount, 1);

  // Verify LeanSavedLines total & ESL Slop Linter in findings-compiler
  const findingsWithLeanAndSlop = {
    meta: {
      title: 'PR #101: Add session cache',
      summary: '**What it does.** This is paramount and not a simple map, but a session cache.\n\n**Coverage.** 14 lenses checked.'
    },
    issues: [
      {
        id: 'M1',
        sev: 'medium',
        cat: 'structure',
        verify: 'CONFIRMED',
        leanSavedLines: 42,
        loc: 'packages/api/src/user-contract.ts:3',
        title: 'Pass-through wrapper adds 42 lines without changing shape',
        impact: '**Breaks:** Callers must maintain two identical interfaces (verified: packages/api/src/user-contract.ts:3).\n\n**Because:** `UserContract` duplicates `SessionRecord`.\n\n**Reach:** 2 callers.',
        fix: '**Do:** Delete the pass-through wrapper.\n\n**Check:** `npm test` passes.'
      },
      {
        id: 'L1',
        sev: 'low',
        cat: 'readability',
        loc: 'packages/api/src/user-contract.ts:5',
        title: 'This load-bearing module is not a cache, but a session store',
        impact: '**Breaks:** Confuses readers with a single pane of glass.\n\n**Because:** Naming mixes cache and store.\n\n**Reach:** Local file.',
        fix: '**Do:** Rename field.\n\n**Check:** Build succeeds.'
      }
    ]
  };

  const warnings = checkFindingsShape(findingsWithLeanAndSlop);
  assert.equal(warnings.some((w) => w.includes('paramount')), true);
  assert.equal(warnings.some((w) => w.includes('meta.summary: contains "not X, but Y"')), true);
  assert.equal(warnings.some((w) => w.includes('load-bearing')), true);
  assert.equal(warnings.some((w) => w.includes('single pane of glass')), true);
  assert.equal(warnings.some((w) => w.includes('L1: contains "not X, but Y"')), true);

  const report = compileFindingsToWorkbenchReport(findingsWithLeanAndSlop, {
    diffText: diff,
    prMeta,
    layers
  });
  assert.equal(report.SUMMARY.leanSavedLinesTotal, 42);
  assert.equal(report.LAYERS.leanSavedLinesTotal, 42);
  assert.equal(report.DATA[0].leanSavedLines, 42);
  assert.deepEqual(report.LAYERS.contracts[0].owners, ['@platform-team', '@api-leads']);
  assert.equal(report.LAYERS.contracts[0].callerBlastRadius.callers.length, 2);
});

