'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const vm = require('vm');
const {
  hydrateFromGitHubComments,
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
  saveDefaultAgentConfig
} = require('../core');

const UI_DIR = path.resolve(__dirname, '../ui');
const DEFAULT_FIXTURE = path.resolve(__dirname, '../../fixtures/pr1230-report.json');

/**
 * Extracts a report object from a Workbench `.json`, a raw `crv-code-review` `findings.json`,
 * or a `crv-code-review` `.html` file.
 */
function loadReportFile(filePath, options = {}) {
  const resolved = path.resolve(filePath || DEFAULT_FIXTURE);
  const content = fs.readFileSync(resolved, 'utf8');
  if (resolved.endsWith('.json')) {
    const parsed = JSON.parse(content);
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
      return compileFindingsToWorkbenchReport(parsed, { diffText, outPath: options.outPath });
    }
    return parsed;
  }
  // Check if HTML has embedded <script id="crv-findings"> or window.__CRV_INITIAL_REPORT__
  const initMatch = /window\.__CRV_INITIAL_REPORT__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(content);
  if (initMatch) {
    return JSON.parse(initMatch[1]);
  }
  // Parse crv-code-review single-file HTML report
  const lines = content.split('\n');
  const dataLineIdx = lines.findIndex((l) => l.startsWith('const DATA=['));
  if (dataLineIdx === -1) {
    throw new Error(`Could not find const DATA=[...] in ${resolved}`);
  }
  const scriptBlock = lines.slice(dataLineIdx, dataLineIdx + 2).join('\n');
  const sandbox = {};
  vm.runInNewContext(
    scriptBlock +
      '\n;globalThis.__out = { DATA, SEV, ORDER, KEY, SUMMARY, STAT, REV, PR, XMETA, REVIEW, LENSES };',
    sandbox
  );
  return sandbox.__out;
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

/**
 * Calls `gh api` safely via spawnSync (no shell interpolation).
 */
function runGhApi(args, inputStr) {
  const res = spawnSync('gh', ['api', ...args], {
    input: inputStr,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || 'gh api failed').trim());
  }
  return res.stdout;
}

async function runGhApiAsync(args, inputStr) {
  const res = await spawnGhAsync(['api', ...args], {
    input: inputStr,
    maxBuffer: 20 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || 'gh api failed').trim());
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

/**
 * Lists recent PRs from a GitHub repository via `gh pr list`.
 */
function listRecentPrs(explicitRepo, limit = 10) {
  const resolved = resolveRepoConfig({ explicitRepo });
  if (!resolved.repo) {
    throw new Error(
      'No default repository configured. Enter "owner/repo" above and click "Save as Default", or run "crv repo <owner/repo>" in your terminal.'
    );
  }
  const repoArgs = ['--repo', resolved.repo];
  const res = spawnSync(
    'gh',
    [
      'pr',
      'list',
      ...repoArgs,
      '--state',
      'all',
      '--limit',
      String(limit),
      '--json',
      'number,title,state,author,updatedAt,url'
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(formatGhError(res.stderr || res.stdout || 'gh pr list failed', resolved.repo));
  }
  return JSON.parse(res.stdout || '[]');
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
  const scratchCandidates = [
    path.resolve(baseCwd, `.crv-skills/crv-code-review/${prNumInt}/findings.json`)
  ];
  const scratchFindingsPath = scratchCandidates.find((p) => fs.existsSync(p));
  if (scratchFindingsPath) {
    const findingsJson = JSON.parse(fs.readFileSync(scratchFindingsPath, 'utf8'));
    const findingsRepo = findingsJson?.meta?.review?.repo || findingsJson?.REVIEW?.repo || '';
    if (!findingsRepo || !repo || String(findingsRepo).toLowerCase() === String(repo).toLowerCase()) {
      const compiled = compileFindingsToWorkbenchReport(findingsJson, { diffText, prMeta });
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
    autoIssues.push({
      id: ft.id,
      sev: ft.meta?.sev || 'medium',
      cat: ft.meta?.cat || 'github-crv',
      verify: ft.meta?.verify || 'CONFIRMED',
      suggestedTriage: ft.action || 'comment',
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

  const compiled = compileFindingsToWorkbenchReport(syntheticFindings, { diffText });
  compiled.GITHUB_STATE = hydrated;
  return compiled;
}

function parsePrTargetInput(prInput, explicitRepo) {
  const raw = String(prInput || '').trim();
  let repo = null;
  let prNumber = raw;

  const urlMatch = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(raw);
  const shortMatch = /^([^/]+\/[^#]+)#(\d+)$/.exec(raw);
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

  const prNumInt = Number(prNumber);
  if (!prNumInt) {
    throw new Error(
      `Invalid PR identifier "${prInput}". Expected a PR number (e.g. 1230), owner/repo#number, or full GitHub PR URL.`
    );
  }
  if (!repo) {
    throw new Error(formatMissingRepoError(prNumInt));
  }
  return { repo, prNumInt };
}

/**
 * Loads any PR live from GitHub (`gh pr view` + `gh pr diff` + `gh api` comments),
 * combining existing `.crv-skills/crv-code-review/<pr>/findings.json` (if present) or
 * generating an immediate 4-Layer decomposition + automated test/thread findings.
 */
function loadLivePrFromGitHub(prInput, explicitRepo) {
  let { repo, prNumInt } = parsePrTargetInput(prInput, explicitRepo);
  const repoArgs = ['--repo', repo];

  const metaRes = spawnSync(
    'gh',
    [
      'pr',
      'view',
      String(prNumInt),
      ...repoArgs,
      '--json',
      'number,title,body,url,state,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles'
    ],
    { encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 }
  );
  if (metaRes.status !== 0) {
    throw new Error(formatGhError(metaRes.stderr || metaRes.stdout || `Failed to view PR #${prNumInt}`, repo, prNumInt));
  }
  const prMeta = JSON.parse(metaRes.stdout);
  if (!repo && prMeta.url) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(prMeta.url);
    if (m) repo = m[1];
  }

  let diffText = '';
  try {
    const fetchedDiff = fetchPrDiffWithFallback({
      pr: prNumInt,
      repo,
      prMeta
    });
    diffText = fetchedDiff.diffText;
  } catch (e) {}

  let hydrated = { overviewMeta: null, findingThreads: {}, generalComments: [] };
  try {
    const issueComments = parsePaginatedGhJson(
      runGhApi([`repos/${repo}/issues/${prNumInt}/comments`, '--paginate', '--slurp']) || '[]'
    );
    const reviewComments = parsePaginatedGhJson(
      runGhApi([`repos/${repo}/pulls/${prNumInt}/comments`, '--paginate', '--slurp']) || '[]'
    );
    hydrated = hydrateFromGitHubComments(issueComments, reviewComments);
  } catch (e) {}

  return buildLivePrReportFromFetchedData({
    repo,
    prNumInt,
    prMeta,
    diffText,
    hydrated,
    syncFn: syncReportWithGitHub
  });
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
async function loadLivePrFromGitHubAsync(prInput, explicitRepo) {
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
      parsePaginatedGhJson(reviewRaw || '[]')
    );
  } catch (e) {}

  const compiled = buildLivePrReportFromFetchedData({
    repo,
    prNumInt,
    prMeta,
    diffText,
    hydrated,
    syncFn: null
  });
  await syncReportWithGitHubAsync(compiled);
  return compiled;
}

/**
 * Enriches a report with live diff slices & existing GitHub PR comments using `gh`.
 */
function syncReportWithGitHub(report) {
  const repo = report?.REVIEW?.repo;
  const pr = report?.REVIEW?.pr;
  if (!repo || !pr) return { synced: false, reason: 'Missing repo or PR number in report.REVIEW' };

  try {
    const issueCommentsRaw = runGhApi([`repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp']);
    const reviewCommentsRaw = runGhApi([`repos/${repo}/pulls/${pr}/comments`, '--paginate', '--slurp']);
    const issueComments = parsePaginatedGhJson(issueCommentsRaw || '[]');
    const reviewComments = parsePaginatedGhJson(reviewCommentsRaw || '[]');
    const hydrated = hydrateFromGitHubComments(issueComments, reviewComments);

    let diffText = '';
    try {
      const fetchedDiff = fetchPrDiffWithFallback({
        pr,
        repo,
        prMeta: {
          baseRefOid: report?.REVIEW?.base,
          headRefOid: report?.REVIEW?.head
        }
      });
      diffText = fetchedDiff.diffText;
    } catch (e) {}

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

/**
 * Async version of `syncReportWithGitHub` for non-blocking HTTP routes.
 */
async function syncReportWithGitHubAsync(report) {
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
    const hydrated = hydrateFromGitHubComments(issueComments, reviewComments);

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

/**
 * Builds a single-file standalone HTML version of the upgraded 4-Layer Workbench.
 */
function buildStandaloneHtml(report) {
  const css = fs.readFileSync(path.join(UI_DIR, 'workbench.css'), 'utf8');
  const mermaidJs = fs.readFileSync(path.join(UI_DIR, 'vendor/mermaid.min.js'), 'utf8');
  const workbenchJs = fs.readFileSync(path.join(UI_DIR, 'workbench.js'), 'utf8');
  const template = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');

  const safeJson = JSON.stringify(report).replace(/<\/script/gi, '<\\/script');
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
  const safeRawFindings = JSON.stringify(rawFindingsPayload).replace(/<\/script/gi, '<\\/script');

  return template
    .replace('<link rel="stylesheet" href="./workbench.css">', `<style>\n${css}\n</style>`)
    .replace(
      '<script src="./vendor/mermaid.min.js"></script>',
      `<script type="application/json" id="crv-findings">${safeRawFindings}</script>\n<script>window.__CRV_INITIAL_REPORT__ = ${safeJson};</script>\n<script>\n${mermaidJs}\n</script>`
    )
    .replace('<script src="./workbench.js"></script>', `<script>\n${workbenchJs}\n</script>`);
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

function createWorkbenchServer(options = {}) {
  let report = options.report || loadReportFile(options.reportPath);
  const allowLivePublish = Boolean(options.publish);
  const lastSubmittedPath =
    options.lastSubmittedPath || path.join(os.tmpdir(), 'crv-last-submitted-review.json');
  const sseClients = new Set();

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
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Reject cross-origin POST requests to protect local state and GitHub credentials
    if (req.method === 'POST' && !isAllowedLocalOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden cross-origin request' }));
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
        const resolved = resolveRepoConfig({
          explicitRepo: repo || options.explicitRepo,
          reportRepo: report?.REVIEW?.repo
        });
        report = await loadLivePrFromGitHubAsync(prInput, resolved.repo);
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
      const result = await syncReportWithGitHubAsync(report);
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
        fs.writeFileSync(
          lastSubmittedPath,
          JSON.stringify({ repo, pr, submittedAt: new Date().toISOString(), payload }, null, 2)
        );

        if (allowLivePublish && repo && pr) {
          const out = await runGhApiAsync(
            ['--method', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'],
            JSON.stringify(payload)
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, mode: 'gh-api-live', response: JSON.parse(out) }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              mode: `dry-run (saved to ${lastSubmittedPath}; pass --publish for live GitHub POST)`,
              savedTo: lastSubmittedPath
            })
          );
        }
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
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
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  return { server, report, broadcastEvent };
}

module.exports = {
  loadReportFile,
  listRecentPrs,
  listRecentPrsAsync,
  loadLivePrFromGitHub,
  loadLivePrFromGitHubAsync,
  syncReportWithGitHub,
  syncReportWithGitHubAsync,
  buildStandaloneHtml,
  createWorkbenchServer
};
