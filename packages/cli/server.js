'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const {
  REVIEW_THREADS_GRAPHQL_QUERY,
  hydrateFromGitHubComments,
  mergeGraphqlReviewThreads,
  parsePaginatedGhJson,
  parseUnifiedDiff,
  extractDiffSlice,
  buildLayersFromParsedDiff,
  synthesizeUnifiedDiffFromFiles,
  tryLocalGitDiff,
  fetchPrDiffWithFallback,
  checkFindingsShape,
  compileFindingsToWorkbenchReport,
  resolveRepoConfig,
  saveDefaultRepoConfig,
  resolveAgentConfig,
  saveDefaultAgentConfig,
  isValidRepoSlug,
  parsePrNumber,
  resolveTrustedAuthors,
  foldCommentsIntoBody,
  capComment
} = require('../core');
const { sanitizeReport } = require('../ui/sanitize.js');

const UI_DIR = path.resolve(__dirname, '../ui');
const DEFAULT_FIXTURE = path.resolve(__dirname, '../../fixtures/pr1230-report.json');

const MAX_REPORT_BYTES = 50 * 1024 * 1024;

/**
 * Extracts a report object from a Workbench `.json`, a raw `findings.json`, or a standalone
 * Workbench `.html` export (embedded `crv-findings` / `__CRV_INITIAL_REPORT__` JSON).
 *
 * Reports may come from a colleague, CI or an agent, so they are untrusted: HTML-bearing fields of
 * pre-compiled reports are sanitised, and no report content is ever executed (no `vm`, no `eval`).
 */
function loadReportFile(filePath, options = {}) {
  const resolved = path.resolve(filePath || DEFAULT_FIXTURE);
  if (fs.statSync(resolved).size > MAX_REPORT_BYTES) {
    throw new Error(`Report file ${path.basename(resolved)} exceeds ${MAX_REPORT_BYTES} bytes`);
  }
  const content = fs.readFileSync(resolved, 'utf8');
  if (resolved.endsWith('.json')) {
    return reportFromParsedJson(JSON.parse(content), resolved, options);
  }

  const initMatch = /window\.__CRV_INITIAL_REPORT__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(content);
  if (initMatch) {
    return sanitizeReport(JSON.parse(initMatch[1]));
  }
  const findingsMatch = /<script type="application\/json" id="crv-findings">([\s\S]*?)<\/script>/.exec(content);
  if (findingsMatch) {
    return reportFromParsedJson(JSON.parse(findingsMatch[1]), resolved, options);
  }
  throw new Error(
    `Unsupported report file ${path.basename(resolved)}: expected a Workbench/findings .json or a crv standalone .html export. ` +
      'Legacy single-file HTML reports are no longer parsed because that required executing report content; re-export from findings.json.'
  );
}

function reportFromParsedJson(parsed, resolved, options) {
  if (parsed && Array.isArray(parsed.issues) && !Array.isArray(parsed.DATA)) {
    let diffText = options.diffText || '';
    if (!diffText && options.diffPath && fs.existsSync(options.diffPath)) {
      diffText = fs.readFileSync(options.diffPath, 'utf8');
    } else if (!diffText) {
      const siblingDiff = path.join(path.dirname(resolved), 'diff.patch');
      if (fs.existsSync(siblingDiff)) {
        diffText = fs.readFileSync(siblingDiff, 'utf8');
      }
    }
    const warnings = checkFindingsShape(parsed);
    if (warnings.length) {
      console.warn(`SHAPE: ${warnings.length} problem(s) in ${path.basename(resolved)}:\n  ${warnings.join('\n  ')}`);
    }
    const dir = path.dirname(resolved);
    const readSibling = (name, given) => {
      if (given) return given;
      const sibling = path.join(dir, name);
      if (!fs.existsSync(sibling) || fs.statSync(sibling).size > MAX_REPORT_BYTES) return null;
      try {
        return JSON.parse(fs.readFileSync(sibling, 'utf8'));
      } catch (e) {
        return null;
      }
    };
    const prMeta = readSibling('pr-meta.json', options.prMeta);
    const layers = readSibling('layers.json', options.layers);
    // The compiler escapes agent text itself, so its output is already inside the allow-list.
    return compileFindingsToWorkbenchReport(parsed, { diffText, prMeta, layers, outPath: options.outPath });
  }
  return sanitizeReport(parsed);
}

/**
 * Calls `gh` CLI asynchronously without shell interpolation so HTTP requests never block the event loop.
 */
function spawnGhAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    const maxBuffer = options.maxBuffer || 25 * 1024 * 1024;
    let totalBytes = 0;

    child.stdout.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= maxBuffer) stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function extractGhErrorMessage(res) {
  const stderr = (res.stderr || '').trim();
  const stdout = (res.stdout || '').trim();
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      const details = Array.isArray(parsed.errors)
        ? parsed.errors.map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e))).join('; ')
        : '';
      if (details) {
        return `${stderr || parsed.message || 'gh api error'}: ${details}`;
      }
      if (parsed.message && !stderr.includes(parsed.message)) {
        return `${stderr} (${parsed.message})`.trim();
      }
    } catch (e) {}
  }
  return stderr || stdout || 'gh api failed';
}

async function runGhApiAsync(args, inputStr) {
  const res = await spawnGhAsync(['api', ...args], {
    input: inputStr,
    maxBuffer: 20 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error(extractGhErrorMessage(res));
  }
  return res.stdout;
}

function formatMissingRepoError(prNum) {
  const prExample = prNum || 1230;
  return [
    `No GitHub repository could be detected for PR #${prExample} (current directory is not a git repository and no default repo is configured).`,
    '',
    'How to fix this (choose any option):',
    `  1. Set a default repo for this directory:   crv repo <owner/repo>`,
    `  2. Set a global default repo for your user: crv repo <owner/repo> --global`,
    `  3. Pass the repo on the command line:       crv pr ${prExample} --repo <owner/repo>`,
    `  4. Use the shorthand or full GitHub URL:    crv pr <owner/repo>#${prExample}`,
    `  5. Set an environment variable:             export CRV_DEFAULT_REPO=<owner/repo>`
  ].join('\n');
}

function formatGhError(rawErr, repo, prNum) {
  const msg = String(rawErr || '').trim();
  if (/not a git repository/i.test(msg)) {
    return formatMissingRepoError(prNum);
  }
  if (/Could not resolve to a PullRequest/i.test(msg) || /no pull requests found/i.test(msg)) {
    return [
      `Pull Request #${prNum} was not found in repository "${repo}".`,
      '',
      'How to fix this:',
      `  • Check the PR number or pass a different repository: crv pr ${prNum} --repo <owner/repo>`,
      `  • Or change your default repository:                  crv repo <owner/repo>`
    ].join('\n');
  }
  if (/auth login/i.test(msg) || /HTTP 401/i.test(msg)) {
    return `${msg}\n\nHow to fix this:\n  • Authenticate GitHub CLI by running: gh auth login`;
  }
  return msg;
}

async function listRecentPrsAsync(explicitRepo, limit = 10) {
  const resolved = resolveRepoConfig({ explicitRepo });
  if (!resolved.repo) {
    throw new Error(
      'No default repository configured. Enter "owner/repo" above and click "Save as Default", or run "crv repo <owner/repo>" in your terminal.'
    );
  }
  const res = await spawnGhAsync(
    [
      'pr',
      'list',
      '--repo',
      resolved.repo,
      '--state',
      'all',
      '--limit',
      String(limit),
      '--json',
      'number,title,state,author,updatedAt,url'
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(formatGhError(res.stderr || res.stdout || 'gh pr list failed', resolved.repo));
  }
  return JSON.parse(res.stdout || '[]');
}

function buildLivePrReportFromFetchedData({ repo, prNumInt, prMeta, diffText, hydrated }) {
  const baseCwd = process.cwd().replace(/[\\/]\.crv-skills(?:[\\/]crv-code-review(?:[\\/][^\\/]+)?)?$/, '');
  if (!diffText) {
    const diffCandidates = [
      path.resolve(baseCwd, `.crv-skills/crv-code-review/${prNumInt}/diff.patch`)
    ];
    const stagedDiffPath = diffCandidates.find((p) => fs.existsSync(p));
    if (stagedDiffPath) {
      diffText = fs.readFileSync(stagedDiffPath, 'utf8');
    }
  }

  // Check if we have a saved findings.json in .crv-skills/crv-code-review/<pr>/findings.json matching this repo
  const scratchDir = path.resolve(baseCwd, `.crv-skills/crv-code-review/${prNumInt}`);
  const scratchFindingsPath = path.join(scratchDir, 'findings.json');
  const scratchLayersPath = path.join(scratchDir, 'layers.json');
  let stagedLayers = null;
  if (fs.existsSync(scratchLayersPath)) {
    try {
      stagedLayers = JSON.parse(fs.readFileSync(scratchLayersPath, 'utf8'));
    } catch (e) {}
  }
  if (fs.existsSync(scratchFindingsPath)) {
    const findingsJson = JSON.parse(fs.readFileSync(scratchFindingsPath, 'utf8'));
    const findingsRepo = findingsJson?.meta?.review?.repo || findingsJson?.REVIEW?.repo || '';
    if (!findingsRepo || !repo || String(findingsRepo).toLowerCase() === String(repo).toLowerCase()) {
      const compiled = compileFindingsToWorkbenchReport(findingsJson, {
        diffText,
        prMeta,
        layers: stagedLayers
      });
      compiled.GITHUB_STATE = hydrated;
      return compiled;
    }
  }

  // If loading the bundled demo fixture PR and its repo matches, enrich and return it
  if (fs.existsSync(DEFAULT_FIXTURE)) {
    const fixtureReport = loadReportFile(DEFAULT_FIXTURE);
    if (
      fixtureReport?.REVIEW?.pr === prNumInt &&
      String(fixtureReport?.REVIEW?.repo || '').toLowerCase() === String(repo || '').toLowerCase()
    ) {
      fixtureReport.GITHUB_STATE = hydrated;
      return fixtureReport;
    }
  }

  const parsedFiles = parseUnifiedDiff(diffText);
  const autoIssues = [];

  // Reconstruct any existing CRV findings previously published to GitHub PR comments
  for (const ft of Object.values(hydrated?.findingThreads || {})) {
    const loc = ft.meta?.loc || (ft.path ? `${ft.path}:${ft.line || 1}` : '');
    const inferredState = ft.state || (ft.isResolved ? 'fixed' : 'open');
    autoIssues.push({
      id: ft.id,
      sev: ft.meta?.sev || 'medium',
      cat: ft.meta?.cat || 'github-crv',
      verify: ft.meta?.verify || 'CONFIRMED',
      suggestedTriage: inferredState === 'fixed' || inferredState === 'dropped' ? 'dismiss' : ft.action || 'comment',
      status:
        inferredState !== 'open' || ft.isResolved
          ? {
              state: inferredState,
              note: ft.isResolved ? 'Marked resolved on GitHub PR review thread.' : `Thread state: ${inferredState}`
            }
          : undefined,
      loc,
      title: ft.title || `Finding ${ft.id}`,
      impact: `**Breaks:** Published CRV finding thread on GitHub by \`@${ft.author}\`.\n\n**Because:** ${ft.note || 'See GitHub review thread.'}\n\n**Reach:** Inline thread at \`${loc || 'PR'}\`.`,
      fix: `**Do:** Address or reply to finding \`${ft.id}\` at \`${loc || 'PR'}\`.\n\n**Check:** Re-run \`crv-code-review\` to verify resolution.`
    });
  }

  let threadIdx = 1;
  for (const gc of hydrated?.generalComments || []) {
    if (!gc.path) continue;
    const loc = `${gc.path}:${gc.line || 1}`;
    autoIssues.push({
      id: `GH${threadIdx++}`,
      sev: 'medium',
      cat: 'github-thread',
      verify: 'CONFIRMED',
      earlier: [{ who: gc.author, loc, url: gc.url }],
      loc,
      title: `Existing GitHub thread by @${gc.author} on ${path.basename(gc.path)}`,
      impact: `**Breaks:** Existing review thread raised on GitHub by \`@${gc.author}\`.\n\n**Because:** ${(gc.body || '').replace(/\s+/g, ' ').slice(0, 260)}\n\n**Reach:** Inline thread at \`${loc}\`.`,
      fix: `**Do:** Inspect thread at \`${loc}\` or run the 14-lens \`crv-code-review\` agent skill for full verification.\n\n**Check:** Resolve thread on GitHub once addressed.`
    });
  }

  // Flag any hollow or mock-only tests automatically from Layer 4
  const preLayers = buildLayersFromParsedDiff(parsedFiles, [], { prMeta });
  let testIdx = 1;
  for (const tm of preLayers.testMatrix) {
    for (const c of tm.cases) {
      if (c.hollow || c.mockOnly) {
        const loc = `${tm.file}:1`;
        autoIssues.push({
          id: `T${testIdx++}`,
          sev: 'low',
          cat: 'tests',
          verify: 'CONFIRMED',
          loc,
          title: `${c.hollow ? 'Zero-assertion (hollow)' : 'Mock-only'} test: "${c.behavior.slice(0, 55)}"`,
          impact: `**Breaks:** Test case \`${c.behavior}\` in \`${tm.file}\` ${c.hollow ? 'contains 0 assertions' : 'only asserts mock calls (toHaveBeenCalled*)'}.\n\n**Because:** Automated Layer 4 Behavioral Test Matrix scan detected \`assertions: ${c.assertions}\`.\n\n**Reach:** Suite \`${tm.suite}\`.`,
          fix: `**Do:** Assert the returned value or state transition rather than ${c.hollow ? 'ignoring the result' : 'only checking mock invocation'}.\n\n**Check:** Reverting the production branch in the tested module causes this test to fail.`
        });
      }
    }
  }

  const mermaidSummary = [
    'flowchart LR',
    `  subgraph PR["PR #${prNumInt} (${parsedFiles.length} files)"]`,
    `    C["Contracts & Schemas (${preLayers.contracts.length})"]`,
    `    F["Production Flows (${preLayers.flows.length} groups)"]`,
    `    T["Behavioral Test Matrix (${preLayers.testMatrix.length} files)"]`,
    '  end',
    '  C --> F --> T'
  ].join('\n');

  const syntheticFindings = {
    meta: {
      title: `PR #${prNumInt}: ${prMeta.title}`,
      subtitle: `${prMeta.changedFiles || parsedFiles.length} files, +${prMeta.additions || 0} -${prMeta.deletions || 0}`,
      prUrl: prMeta.url,
      headCommit: prMeta.headRefOid,
      storageKey: `${repo.replace('/', '-')}-pr${prNumInt}`,
      review: {
        repo,
        pr: prNumInt,
        base: prMeta.baseRefOid,
        head: prMeta.headRefOid,
        agent: 'CRV Live Diff Analyzer',
        model: '4-Layer Pre-Scan (Run crv-code-review skill for full 14-lens deep review)',
        lenses: ['contract-classifier', 'flow-grouper', 'test-matrix']
      },
      summary: [
        `**What it does.** Live 4-Layer decomposition for \`${repo}#${prNumInt}\` (${prMeta.headRefName} → ${prMeta.baseRefName}).`,
        '```mermaid\n' + mermaidSummary + '\n```',
        (prMeta.body || '').trim()
          ? `### Author PR Description\n\n${prMeta.body.trim().slice(0, 1200)}`
          : '',
        `**Coverage.** Pre-scanned ${parsedFiles.length} changed files into ${preLayers.contracts.length} contract file(s), ${preLayers.flows.length} production flow group(s), and ${preLayers.testMatrix.length} test file(s). Ask Antigravity in chat: \`Review ${prMeta.url} with crv-code-review\` to run the full 14-lens + verifier agent analysis.`
      ]
        .filter(Boolean)
        .join('\n\n'),
      summaryPoints: [
        `contracts: ${preLayers.contracts.length} contract/schema file(s) detected`,
        `flows: ${preLayers.flows.length} production flow group(s) detected`,
        `tests: ${preLayers.testMatrix.length} test file(s) collapsed into Behavioral Test Matrix`,
        `github-threads: ${autoIssues.length} pre-scan item(s) surfaced`
      ]
    },
    issues: autoIssues
  };

  const compiled = compileFindingsToWorkbenchReport(syntheticFindings, {
    diffText,
    prMeta,
    layers: stagedLayers
  });
  compiled.GITHUB_STATE = hydrated;
  return compiled;
}

function parsePrTargetInput(prInput, explicitRepo) {
  const raw = String(prInput || '').trim();
  let repo = null;
  let prNumber = raw;

  const urlMatch = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(raw);
  const shortMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(raw);
  if (urlMatch) {
    repo = urlMatch[1];
    prNumber = urlMatch[2];
  } else if (shortMatch) {
    repo = shortMatch[1];
    prNumber = shortMatch[2];
  } else {
    prNumber = raw.replace(/^#/, '');
    repo = resolveRepoConfig({ explicitRepo }).repo;
  }

  const prNumInt = parsePrNumber(prNumber);
  if (!prNumInt) {
    throw new Error(
      `Invalid PR identifier "${prInput}". Expected a PR number (e.g. 1230), owner/repo#number, or full GitHub PR URL.`
    );
  }
  if (repo && !isValidRepoSlug(repo)) {
    throw new Error(`Invalid repository "${repo}". Expected "owner/repo".`);
  }
  if (!repo) {
    throw new Error(formatMissingRepoError(prNumInt));
  }
  return { repo, prNumInt };
}

let trustedAuthorsPromise = null;

/**
 * Logins whose `crv-*` markers are trusted: authenticated gh user + configured reviewers + bots.
 * Resolved once per process (async, non-blocking). `override` lets tests/embedders inject a list.
 */
async function getTrustedAuthors(override) {
  if (override) return override;
  if (!trustedAuthorsPromise) {
    trustedAuthorsPromise = (async () => {
      let ghLogin = null;
      try {
        const res = await spawnGhAsync(['api', 'user', '--jq', '.login']);
        if (res.status === 0) ghLogin = res.stdout.trim() || null;
      } catch (e) {}
      return resolveTrustedAuthors({ ghLogin }).logins;
    })();
  }
  return trustedAuthorsPromise;
}

async function resolvePrDiffAsync({ repo, prNumInt, prMeta, initialDiffRes }) {
  if (initialDiffRes && initialDiffRes.status === 0 && initialDiffRes.stdout) {
    return initialDiffRes.stdout;
  }
  const localDiff = tryLocalGitDiff({
    repo,
    pr: prNumInt,
    baseRefOid: prMeta && (prMeta.baseRefOid || prMeta.base),
    headRefOid: prMeta && (prMeta.headRefOid || prMeta.head),
    baseRefName: prMeta && prMeta.baseRefName
  });
  if (localDiff && localDiff.trim()) {
    return localDiff;
  }
  if (repo && prNumInt) {
    try {
      const filesRaw = await runGhApiAsync([
        `repos/${repo}/pulls/${prNumInt}/files?per_page=100`,
        '--paginate',
        '--slurp'
      ]);
      const apiFiles = parsePaginatedGhJson(filesRaw);
      const synthesized = synthesizeUnifiedDiffFromFiles(apiFiles, (prMeta && prMeta.files) || []);
      if (synthesized.trim()) return synthesized;
    } catch (e) {}
  }
  if (prMeta && Array.isArray(prMeta.files) && prMeta.files.length > 0) {
    return synthesizeUnifiedDiffFromFiles([], prMeta.files);
  }
  return '';
}

/**
 * Async version of `loadLivePrFromGitHub` for non-blocking HTTP routes.
 */
async function loadLivePrFromGitHubAsync(prInput, explicitRepo, ctx = {}) {
  let { repo, prNumInt } = parsePrTargetInput(prInput, explicitRepo);
  const repoArgs = ['--repo', repo];

  const [metaRes, diffRes] = await Promise.all([
    spawnGhAsync(
      [
        'pr',
        'view',
        String(prNumInt),
        ...repoArgs,
        '--json',
        'number,title,body,url,state,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles'
      ],
      { maxBuffer: 15 * 1024 * 1024 }
    ),
    spawnGhAsync(['pr', 'diff', String(prNumInt), ...repoArgs], { maxBuffer: 50 * 1024 * 1024 })
  ]);

  if (metaRes.status !== 0) {
    throw new Error(formatGhError(metaRes.stderr || metaRes.stdout || `Failed to view PR #${prNumInt}`, repo, prNumInt));
  }
  const prMeta = JSON.parse(metaRes.stdout);
  if (!repo && prMeta.url) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(prMeta.url);
    if (m) repo = m[1];
  }
  const diffText = await resolvePrDiffAsync({ repo, prNumInt, prMeta, initialDiffRes: diffRes });

  let hydrated = { overviewMeta: null, findingThreads: {}, generalComments: [] };
  try {
    const [issueRaw, reviewRaw] = await Promise.all([
      runGhApiAsync([`repos/${repo}/issues/${prNumInt}/comments`, '--paginate', '--slurp']),
      runGhApiAsync([`repos/${repo}/pulls/${prNumInt}/comments`, '--paginate', '--slurp'])
    ]);
    hydrated = hydrateFromGitHubComments(
      parsePaginatedGhJson(issueRaw || '[]'),
      parsePaginatedGhJson(reviewRaw || '[]'),
      { trustedAuthors: await getTrustedAuthors(ctx.trustedAuthors), currentHead: prMeta.headRefOid }
    );
  } catch (e) {}

  const compiled = buildLivePrReportFromFetchedData({
    repo,
    prNumInt,
    prMeta,
    diffText,
    hydrated
  });
  await syncReportWithGitHubAsync(compiled, ctx);
  return compiled;
}

/**
 * Enriches a report with live diff slices and existing GitHub PR comments (async `gh`, never blocks the event loop).
 */
async function syncReportWithGitHubAsync(report, ctx = {}) {
  const repo = report?.REVIEW?.repo;
  const pr = report?.REVIEW?.pr;
  if (!repo || !pr) return { synced: false, reason: 'Missing repo or PR number in report.REVIEW' };

  try {
    const [issueCommentsRaw, reviewCommentsRaw, diffRes] = await Promise.all([
      runGhApiAsync([`repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp']),
      runGhApiAsync([`repos/${repo}/pulls/${pr}/comments`, '--paginate', '--slurp']),
      spawnGhAsync(['pr', 'diff', String(pr), '--repo', repo], { maxBuffer: 50 * 1024 * 1024 })
    ]);
    const issueComments = parsePaginatedGhJson(issueCommentsRaw || '[]');
    const reviewComments = parsePaginatedGhJson(reviewCommentsRaw || '[]');
    const hydrated = hydrateFromGitHubComments(issueComments, reviewComments, {
      trustedAuthors: await getTrustedAuthors(ctx.trustedAuthors),
      currentHead: report?.REVIEW?.head
    });
    try {
      const [owner, name] = String(repo).split('/');
      if (owner && name && Object.keys(hydrated.findingThreads || {}).length > 0) {
        const gqlOut = await runGhApiAsync([
          'graphql',
          '-f',
          `query=${REVIEW_THREADS_GRAPHQL_QUERY}`,
          '-F',
          `owner=${owner}`,
          '-F',
          `name=${name}`,
          '-F',
          `pr=${pr}`
        ]);
        mergeGraphqlReviewThreads(hydrated, gqlOut);
      }
    } catch (e) {}

    const diffText = await resolvePrDiffAsync({
      repo,
      prNumInt: pr,
      prMeta: { baseRefOid: report?.REVIEW?.base, headRefOid: report?.REVIEW?.head },
      initialDiffRes: diffRes
    });

    if (diffText) {
      const parsedFiles = parseUnifiedDiff(diffText);
      for (const finding of report.DATA || []) {
        if (!finding.diffSlice && finding.loc) {
          finding.diffSlice = extractDiffSlice(parsedFiles, finding.loc);
        }
      }
    }

    report.GITHUB_STATE = hydrated;
    return { synced: true, hydrated };
  } catch (err) {
    return { synced: false, reason: err.message };
  }
}

function formatReportPageTitle(report) {
  if (!report) return 'Agentic PR Review Workbench';
  const urlMatch = /github\.com\/([^/]+\/([^/]+))\/pull\/(\d+)/i.exec(report.PR?.url || '');
  const rawRepo = report.REVIEW?.repo || (urlMatch ? urlMatch[1] : '');
  const repoShort = rawRepo ? rawRepo.split('/').pop() : urlMatch ? urlMatch[2] : '';
  const rawTitle = String(report.XMETA?.title || '').trim();
  const titlePrMatch = /^PR\s*#(\d+)/i.exec(rawTitle);
  const labelPrMatch = /#(\d+)/.exec(report.PR?.label || '');
  const prNum =
    report.REVIEW?.pr ||
    (urlMatch ? urlMatch[3] : '') ||
    (titlePrMatch ? titlePrMatch[1] : '') ||
    (labelPrMatch ? labelPrMatch[1] : '');
  const cleanTitle = rawTitle.replace(/^PR\s*#\d+\s*[:—–-]\s*/i, '').trim();

  const prefixParts = [];
  if (prNum) prefixParts.push(`#${prNum}`);
  if (repoShort) prefixParts.push(repoShort);
  const prefix = prefixParts.join(' · ');

  if (prefix && cleanTitle) return `${prefix} — ${cleanTitle}`;
  if (prefix) return `${prefix} — CRV Workbench`;
  return rawTitle || 'Agentic PR Review Workbench';
}

const CSP_META_RE = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/;

/** Content-Security-Policy for the Workbench. `scriptSrc` is `'self'` when served, hashes when inlined. */
function buildCsp(scriptSrc = "'self'", { header = false } = {}) {
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    ...(header ? ["frame-ancestors 'none'"] : [])
  ].join('; ');
}

/**
 * Builds a single-file standalone HTML version of the 4-Layer Workbench.
 * Inline scripts are allow-listed by SHA-256 in the CSP so injected markup cannot execute.
 */
function buildStandaloneHtml(report) {
  const css = fs.readFileSync(path.join(UI_DIR, 'workbench.css'), 'utf8');
  const mermaidJs = fs.readFileSync(path.join(UI_DIR, 'vendor/mermaid.min.js'), 'utf8');
  const sanitizeJs = fs.readFileSync(path.join(UI_DIR, 'sanitize.js'), 'utf8');
  const workbenchJs = fs.readFileSync(path.join(UI_DIR, 'workbench.js'), 'utf8');
  const template = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');

  const escapeJsonForScript = (obj) =>
    JSON.stringify(obj)
      .replace(/<\/script/gi, '<\\/script')
      .replace(/<!--/g, '<\\!--')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  const safeJson = escapeJsonForScript(report);
  const rawFindingsPayload = report.rawFindings || {
    meta: {
      title: report.XMETA?.title || '',
      subtitle: report.XMETA?.subtitle || '',
      prUrl: report.PR?.url || report.SUMMARY?.prUrl || '',
      headCommit: report.PR?.head || report.SUMMARY?.headCommit || '',
      storageKey: report.KEY || '',
      review: report.REVIEW || {},
      summaryPoints: report.SUMMARY?.points || []
    },
    issues: report.DATA || []
  };
  const safeRawFindings = escapeJsonForScript(rawFindingsPayload);
  const safePageTitle = formatReportPageTitle(report)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const inlineScripts = [
    `window.__CRV_INITIAL_REPORT__ = ${safeJson};`,
    `\n${mermaidJs}\n`,
    `\n${sanitizeJs}\n`,
    `\n${workbenchJs}\n`
  ];
  const hashes = inlineScripts
    .map((code) => `'sha256-${crypto.createHash('sha256').update(code, 'utf8').digest('base64')}'`)
    .join(' ');

  const html = template
    .replace('<title>Agentic PR Review Workbench</title>', () => `<title>${safePageTitle}</title>`)
    .replace('<link rel="stylesheet" href="./workbench.css">', () => `<style>\n${css}\n</style>`)
    .replace(
      '<script src="./vendor/mermaid.min.js"></script>',
      () =>
        `<script type="application/json" id="crv-findings">${safeRawFindings}</script>\n<script>${inlineScripts[0]}</script>\n<script>${inlineScripts[1]}</script>`
    )
    .replace('<script src="./sanitize.js"></script>', () => `<script>${inlineScripts[2]}</script>`)
    .replace('<script src="./workbench.js"></script>', () => `<script>${inlineScripts[3]}</script>`);
  return html.replace(CSP_META_RE, (_, open, close) => `${open}${buildCsp(hashes)}${close}`);
}

function isAllowedCorsOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  return (
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  );
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CRV-Token');
  }
}

/**
 * Validates that a mutating HTTP request originates from localhost, 127.0.0.1,
 * a Chrome extension, or a non-browser local client (no Origin/Sec-Fetch-Site).
 */
function isAllowedLocalOrigin(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    const originHeader = String(req.headers.origin || '');
    if (!originHeader.startsWith('chrome-extension://')) {
      return false;
    }
  }
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
    );
  } catch (e) {
    return false;
  }
}

/**
 * Reads and parses a JSON request body with a strict byte limit.
 */
function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        const err = new Error(`Request body exceeded maximum size of ${maxBytes} bytes`);
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw || '{}'));
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * DNS-rebinding defence: only answer when the Host header names the loopback interface (and our port).
 * A rebound attacker hostname never matches.
 */
function isAllowedHostHeader(hostHeader, boundPort) {
  const raw = String(hostHeader || '');
  const m = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(raw);
  if (!m || !LOOPBACK_HOSTS.has(m[1].toLowerCase())) return false;
  return !boundPort || !m[2] || Number(m[2]) === boundPort;
}

const REVIEW_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES']);
const MAX_REVIEW_COMMENTS = 200;
const MAX_REVIEW_BODY = 60000;

/**
 * Validates and re-builds the body POSTed to GitHub so only known fields reach the API.
 * APPROVE is refused unless the server was started with `allowApprove`.
 */
function validateReviewPayload(payload, { allowApprove = false } = {}) {
  const fail = (msg) => {
    const err = new Error(`Invalid review payload: ${msg}`);
    err.statusCode = 400;
    return err;
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('expected an object');
  const event = payload.event === undefined ? 'COMMENT' : String(payload.event);
  if (event === 'APPROVE' ? !allowApprove : !REVIEW_EVENTS.has(event)) {
    throw fail(`event "${event}" is not allowed${event === 'APPROVE' ? ' (start with --allow-approve)' : ''}`);
  }
  const body = payload.body === undefined ? '' : payload.body;
  if (typeof body !== 'string' || body.length > MAX_REVIEW_BODY) throw fail('body must be a string under 60000 chars');
  const out = { event, body };
  if (payload.commit_id !== undefined) {
    if (typeof payload.commit_id !== 'string' || !/^[0-9a-f]{7,40}$/i.test(payload.commit_id)) throw fail('commit_id must be a git sha');
    out.commit_id = payload.commit_id;
  }
  const comments = payload.comments === undefined ? [] : payload.comments;
  if (!Array.isArray(comments) || comments.length > MAX_REVIEW_COMMENTS) throw fail('comments must be an array of at most 200 items');
  out.comments = comments.map((c, i) => {
    if (!c || typeof c !== 'object') throw fail(`comments[${i}] must be an object`);
    if (typeof c.path !== 'string' || !c.path || c.path.length > 500 || c.path.includes('\0')) throw fail(`comments[${i}].path invalid`);
    if (!Number.isInteger(c.line) || c.line < 1) throw fail(`comments[${i}].line invalid`);
    if (typeof c.body !== 'string' || c.body.length > MAX_REVIEW_BODY) throw fail(`comments[${i}].body invalid`);
    const side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    return { path: c.path, line: c.line, side, body: c.body };
  });
  return out;
}

/**
 * Moves inline comment lines that are outside the PR diff hunks onto a valid line (or folds them into the
 * review body) using the report's `diffSlice` data, so GitHub does not reject the whole review with HTTP 422.
 * Runs BEFORE `validateReviewPayload` so validation sees the final payload. Does not mutate its input.
 */
function alignInlineCommentsToHunks(payload, report) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = { ...payload };
  if (out.commit_id !== undefined && !/^[0-9a-f]{40}$/i.test(String(out.commit_id).trim())) {
    delete out.commit_id;
  }
  if (!Array.isArray(out.comments) || !Array.isArray(report?.DATA)) return out;
  const validInline = [];
  const foldedOut = [];
  for (const c of out.comments) {
    if (!c || typeof c !== 'object') {
      validInline.push(c); // left for validateReviewPayload to reject
      continue;
    }
    const matchIssue = report.DATA.find(
      (d) =>
        d.loc === `${c.path}:${c.line}` ||
        (typeof c.body === 'string' && c.body.includes(`"id":"${d.id}"`)) ||
        (d.diffSlice && d.diffSlice.path === c.path)
    );
    if (matchIssue && matchIssue.diffSlice && Array.isArray(matchIssue.diffSlice.lines)) {
      const rightLines = matchIssue.diffSlice.lines.map((l) => l.newNumber).filter((n) => Number.isFinite(n));
      if (rightLines.length === 0) foldedOut.push(c);
      else if (rightLines.includes(c.line)) validInline.push(c);
      else validInline.push({ ...c, line: rightLines[0] });
    } else if (matchIssue && 'diffSlice' in matchIssue && !matchIssue.diffSlice) {
      foldedOut.push(c);
    } else {
      validInline.push(c);
    }
  }
  out.comments = validInline;
  if (foldedOut.length > 0) {
    const extra = foldedOut.map((c) => `#### \u{1F4C4} \`${c.path}:${c.line}\`\n\n${c.body}`).join('\n\n---\n\n');
    out.body = capComment(`${out.body || ''}\n\n---\n### Findings Outside Diff Hunks\n\n${extra}`.trim());
  }
  return out;
}

const MAX_THREAD_UPDATES = 100;

/**
 * Thread follow-ups (reply + resolve/unresolve) are only honoured for threads that exist in the loaded report's
 * trusted `GITHUB_STATE.findingThreads`. The comment id, thread id and target come from server state, never from
 * the client, so a request cannot reply to or resolve arbitrary comments.
 */
function validateThreadUpdates(raw, report) {
  if (!Array.isArray(raw)) return [];
  const threads = report?.GITHUB_STATE?.findingThreads || {};
  const out = [];
  for (const u of raw.slice(0, MAX_THREAD_UPDATES)) {
    if (!u || typeof u !== 'object') continue;
    const known = Object.prototype.hasOwnProperty.call(threads, String(u.id)) ? threads[String(u.id)] : null;
    if (!known || !Number.isSafeInteger(Number(known.commentId)) || Number(u.commentId) !== Number(known.commentId)) continue;
    const resolutionAction = u.resolutionAction === 'resolve' || u.resolutionAction === 'unresolve' ? u.resolutionAction : null;
    const threadId = typeof known.threadId === 'string' && /^[A-Za-z0-9_=-]{1,200}$/.test(known.threadId) ? known.threadId : null;
    out.push({
      id: String(u.id),
      commentId: Number(known.commentId),
      threadId,
      body: typeof u.body === 'string' ? u.body.slice(0, MAX_REVIEW_BODY) : '',
      resolutionAction,
      state: typeof u.state === 'string' ? u.state.slice(0, 40) : undefined,
      action: typeof u.action === 'string' ? u.action.slice(0, 40) : undefined,
      head: typeof u.head === 'string' ? u.head.slice(0, 64) : undefined
    });
  }
  return out;
}

function createWorkbenchServer(options = {}) {
  let report = options.report || loadReportFile(options.reportPath);
  // Publishing is OFF unless explicitly requested (--publish); --dry-run / --no-publish force it off.
  const allowLivePublish = options.dryRun ? false : Boolean(options.publish);
  const allowApprove = Boolean(options.allowApprove);
  let lastSubmittedPath = options.lastSubmittedPath || null;
  /** Private (0700) per-process directory: never a predictable, world-writable /tmp path. */
  function getLastSubmittedPath() {
    if (!lastSubmittedPath) {
      lastSubmittedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crv-')), 'last-submitted-review.json');
    }
    return lastSubmittedPath;
  }
  const sessionToken = options.sessionToken || crypto.randomBytes(24).toString('hex');
  const extensionIds = new Set(
    (options.extensionIds || String(process.env.CRV_EXTENSION_IDS || '').split(',')).map((x) => String(x).trim()).filter(Boolean)
  );
  const sseClients = new Set();

  function hasValidToken(req, url) {
    const supplied = Buffer.from(String(req.headers['x-crv-token'] || url.searchParams.get('token') || ''));
    const expected = Buffer.from(sessionToken);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  function broadcastEvent(eventName, payload) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isAllowedHostHeader(req.headers.host, server.address() && server.address().port)) {
      sendJson(res, 421, { ok: false, error: 'Misdirected request: unexpected Host header' });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Reject cross-origin POST requests to protect local state and GitHub credentials
    if (req.method === 'POST' && !isAllowedLocalOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden cross-origin request' });
      return;
    }

    // Every API route except health/session needs the per-session token (Origin alone is not authentication).
    const isApi = url.pathname.startsWith('/api/');
    const isOpenRoute = url.pathname === '/api/health' || url.pathname === '/api/session';
    if (isApi && !isOpenRoute && !hasValidToken(req, url)) {
      sendJson(res, 401, { ok: false, error: 'Missing or invalid X-CRV-Token' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      // Token hand-off for the browser extension only, and only for explicitly configured extension ids.
      const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(String(req.headers.origin || ''));
      if (m && extensionIds.has(m[1])) {
        sendJson(res, 200, { ok: true, token: sessionToken });
      } else {
        sendJson(res, 403, { ok: false, error: 'Set CRV_EXTENSION_IDS to the extension id to enable token hand-off' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          status: 'online',
          activeRepo: report?.REVIEW?.repo || null,
          activePr: report?.REVIEW?.pr || null,
          title: report?.XMETA?.title || null
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/report') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/github/repo-config') {
      const resolved = resolveRepoConfig({
        explicitRepo: url.searchParams.get('repo') || options.explicitRepo,
        reportRepo: report?.REVIEW?.repo
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...resolved }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/github/agent-config') {
      const resolved = resolveAgentConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          agent: resolved.agent,
          agentName: resolved.spec ? resolved.spec.name : null,
          source: resolved.source,
          model: resolved.model,
          modelSource: resolved.modelSource,
          effort: resolved.effort,
          effortSource: resolved.effortSource,
          available: resolved.available
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/github/agent-config') {
      try {
        const { agent, model, effort, global: isGlobal } = await readJsonBody(req);
        const saved = saveDefaultAgentConfig(agent, {
          global: Boolean(isGlobal),
          model,
          effort
        });
        const resolved = resolveAgentConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, saved, ...resolved }));
      } catch (err) {
        res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/github/repo-config') {
      try {
        const { repo, global: isGlobal } = await readJsonBody(req);
        const saved = saveDefaultRepoConfig(repo, { global: Boolean(isGlobal) });
        const resolved = resolveRepoConfig({ reportRepo: report?.REVIEW?.repo });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, saved, ...resolved }));
      } catch (err) {
        res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/github/list-prs') {
      const resolved = resolveRepoConfig({
        explicitRepo: url.searchParams.get('repo') || options.explicitRepo,
        reportRepo: report?.REVIEW?.repo
      });
      if (!resolved.repo) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: false,
            error:
              'No default repository configured. Set one above, run inside a git repo, set CRV_DEFAULT_REPO, or run "crv repo owner/name".'
          })
        );
        return;
      }
      try {
        const prs = await listRecentPrsAsync(resolved.repo, 10);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, repo: resolved.repo, source: resolved.source, prs }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/github/load-pr') {
      try {
        const { prInput, repo } = await readJsonBody(req);
        if (repo && !isValidRepoSlug(repo)) {
          const err = new Error(`Invalid repository "${repo}". Expected "owner/repo".`);
          err.statusCode = 400;
          throw err;
        }
        const resolved = resolveRepoConfig({
          explicitRepo: repo || options.explicitRepo,
          reportRepo: report?.REVIEW?.repo
        });
        report = await loadLivePrFromGitHubAsync(prInput, resolved.repo, { trustedAuthors: options.trustedAuthors });
        broadcastEvent('report-updated', { repo: report?.REVIEW?.repo, pr: report?.REVIEW?.pr });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, report, resolvedRepo: report?.REVIEW?.repo || resolved.repo }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/github/sync') {
      const result = await syncReportWithGitHubAsync(report, { trustedAuthors: options.trustedAuthors });
      if (result.synced) {
        broadcastEvent('report-updated', { repo: report?.REVIEW?.repo, pr: report?.REVIEW?.pr });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/github/submit-review') {
      try {
        const { repo, pr, payload } = await readJsonBody(req);
        const activeRepo = report?.REVIEW?.repo;
        const activePr = report?.REVIEW?.pr;
        if (!activeRepo || !activePr) {
          const err = new Error('No active PR report loaded; load a PR before submitting a review.');
          err.statusCode = 409;
          throw err;
        }
        if (repo !== activeRepo || parsePrNumber(pr) !== Number(activePr)) {
          const err = new Error(`Refusing to submit: target ${repo}#${pr} is not the active report (${activeRepo}#${activePr}).`);
          err.statusCode = 409;
          throw err;
        }
        // 1. Align inline comment lines to the diff hunks (avoids HTTP 422), 2. then validate the FINAL payload.
        const { threadUpdates: rawThreadUpdates, ...reviewInput } =
          payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { __invalid: payload };
        const safePayload = validateReviewPayload(
          '__invalid' in reviewInput ? payload : alignInlineCommentsToHunks(reviewInput, report),
          { allowApprove }
        );
        const threadUpdates = validateThreadUpdates(rawThreadUpdates, report);
        const savePath = getLastSubmittedPath();
        fs.writeFileSync(
          savePath,
          JSON.stringify({ repo, pr, submittedAt: new Date().toISOString(), payload: safePayload, threadUpdates }, null, 2),
          { mode: 0o600 }
        );

        if (allowLivePublish) {
          const reviewsPath = `repos/${activeRepo}/pulls/${activePr}/reviews`;
          const post = (body) => runGhApiAsync(['--method', 'POST', reviewsPath, '--input', '-'], JSON.stringify(body));
          const isUnprocessable = (e) => /HTTP 422|Unprocessable|could not be resolved|must be part of the diff/i.test(String((e && e.message) || ''));
          let mode = 'gh-api-live';
          let out = '{}';
          const shouldPostReview = safePayload.comments.length > 0 || Boolean(safePayload.body) || threadUpdates.length === 0;
          if (shouldPostReview) {
            try {
              out = await post(safePayload);
            } catch (firstErr) {
              if (!isUnprocessable(firstErr)) throw firstErr;
              // Retry 1: REQUEST_CHANGES on your own PR is rejected: downgrade to COMMENT (never escalates) and drop the commit pin.
              const downgraded = { ...safePayload, event: 'COMMENT' };
              delete downgraded.commit_id;
              try {
                out = await post(downgraded);
                mode = 'gh-api-live (downgraded event to COMMENT for self-review)';
              } catch (secondErr) {
                if (!isUnprocessable(secondErr) || downgraded.comments.length === 0) throw secondErr;
                // Retry 2: one inline comment outside the diff rejects the whole review: fold comments into the body.
                out = await post(foldCommentsIntoBody(downgraded));
                mode = 'gh-api-live-fallback-body (folded inline threads into review summary)';
              }
            }
          }

          // Follow-up replies and GraphQL resolve/unresolve, only for threads that exist in the loaded (trusted) report.
          let repliedCount = 0;
          let resolvedCount = 0;
          let reopenedCount = 0;
          for (const upd of threadUpdates) {
            const existingThread = report?.GITHUB_STATE?.findingThreads?.[upd.id] || {};
            const lastUpd = existingThread.lastUpdate || null;
            const isDuplicateReply =
              lastUpd && lastUpd.state === upd.state && lastUpd.action === upd.action && lastUpd.head && upd.head && lastUpd.head === upd.head;

            if (!isDuplicateReply && upd.body) {
              try {
                await runGhApiAsync(
                  ['--method', 'POST', `repos/${activeRepo}/pulls/${activePr}/comments/${upd.commentId}/replies`, '--input', '-'],
                  JSON.stringify({ body: upd.body })
                );
                repliedCount++;
              } catch (e) {}
            }

            if (upd.threadId && upd.resolutionAction) {
              const mutationName = upd.resolutionAction === 'resolve' ? 'resolveReviewThread' : 'unresolveReviewThread';
              const shouldMutate = upd.resolutionAction === 'resolve' ? existingThread.isResolved !== true : existingThread.isResolved !== false;
              if (shouldMutate) {
                try {
                  await runGhApiAsync([
                    'graphql',
                    '-f',
                    `query=mutation($threadId: ID!) { ${mutationName}(input: { threadId: $threadId }) { thread { id isResolved } } }`,
                    '-F',
                    `threadId=${upd.threadId}`
                  ]);
                  if (upd.resolutionAction === 'resolve') resolvedCount++;
                  else reopenedCount++;
                } catch (e) {}
              }
            }
          }

          if (repliedCount > 0 || resolvedCount > 0 || reopenedCount > 0) {
            const bits = [];
            if (repliedCount > 0) bits.push(`${repliedCount} thread repl${repliedCount === 1 ? 'y' : 'ies'}`);
            if (resolvedCount > 0) bits.push(`${resolvedCount} resolved`);
            if (reopenedCount > 0) bits.push(`${reopenedCount} reopened`);
            mode += ` + ${bits.join(', ')}`;
          }

          try {
            await syncReportWithGitHubAsync(report);
            broadcastEvent('report-updated', { repo: report?.REVIEW?.repo, pr: report?.REVIEW?.pr });
          } catch (e) {}

          sendJson(res, 200, { ok: true, mode, savedTo: savePath, repliedCount, resolvedCount, reopenedCount, response: JSON.parse(out || '{}') });
        } else {
          sendJson(res, 200, {
            ok: true,
            mode: `dry-run (saved to ${savePath}; pass --publish for live GitHub POST)`,
            savedTo: savePath
          });
        }
      } catch (err) {
        sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
      }
      return;
    }

    // Static UI assets with strict directory boundary check
    const relativeReqPath = (url.pathname === '/' ? 'index.html' : url.pathname).replace(/^\/+/, '');
    const filePath = path.resolve(UI_DIR, relativeReqPath);
    const isInsideUiDir = filePath === UI_DIR || filePath.startsWith(UI_DIR + path.sep);
    if (!isInsideUiDir || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    const baseHeaders = {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    if (ext === '.html') {
      const html = fs
        .readFileSync(filePath, 'utf8')
        .replace(/(<meta name="crv-session-token" content=")[^"]*(">)/, (_, o, c) => `${o}${sessionToken}${c}`);
      res.writeHead(200, {
        ...baseHeaders,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': buildCsp("'self'", { header: true })
      });
      res.end(html);
      return;
    }
    res.writeHead(200, baseHeaders);
    fs.createReadStream(filePath).pipe(res);
  });

  return { server, report, broadcastEvent, sessionToken };
}

module.exports = {
  loadReportFile,
  listRecentPrsAsync,
  loadLivePrFromGitHubAsync,
  syncReportWithGitHubAsync,
  parsePrTargetInput,
  formatMissingRepoError,
  isAllowedHostHeader,
  validateReviewPayload,
  alignInlineCommentsToHunks,
  validateThreadUpdates,
  buildCsp,
  buildStandaloneHtml,
  createWorkbenchServer,
  isAllowedCorsOrigin
};
