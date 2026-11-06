#!/usr/bin/env node
/**
 * prepare_pr.mjs — Pre-processes a PR or diff for `crv-code-review`:
 * 1. Fetches PR metadata, unified diff (`diff.patch`), and GitHub PR comments (unless `--diff` is passed).
 * 2. Classifies every changed file into the 4 Human-Leverage Layers (`contracts`, `flows`, `tests`, `config`)
 *    and extracts the Behavioral Test Matrix (with `assertions`, `hollow`, and `mockOnly` flags) to `<scratch>/layers.json`.
 * 3. Hydrates existing `<!-- crv-meta -->` and `<!-- crv-finding -->` GitHub PR threads to `<scratch>/github-threads.json`
 *    so re-reviews (`r2`, `r3`) inherit human reviewer triage (`dismiss`, `block`, `comment`) and author replies.
 *
 * Usage:
 *   node <skill>/scripts/prepare_pr.mjs <pr-number-or-url> <scratch-dir> [--repo owner/repo]
 *   node <skill>/scripts/prepare_pr.mjs --diff <diff.patch> <scratch-dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const vendoredCorePath = path.resolve(scriptDir, './lib/core/index.js');
const monorepoCorePath = path.resolve(scriptDir, '../../../../packages/core/index.js');
const corePath = fs.existsSync(vendoredCorePath) ? vendoredCorePath : monorepoCorePath;
const {
  REVIEW_THREADS_GRAPHQL_QUERY,
  parseUnifiedDiff,
  buildLayersFromParsedDiff,
  parseCodeowners,
  matchCodeowners,
  hydrateFromGitHubComments,
  mergeGraphqlReviewThreads,
  parsePaginatedGhJson,
  fetchPrDiffWithFallback,
  resolveRepoConfig,
  isValidRepoSlug,
  parsePrNumber,
  resolveTrustedAuthors,
  detectGhLogin
} = require(corePath);

function runGh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `gh ${args.join(' ')} failed`).trim());
  }
  return res.stdout;
}

function parseCli(argv) {
  const args = argv.slice(2);
  let diffPath = null;
  let prInput = null;
  let scratchDir = null;
  let repo = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--diff' && args[i + 1]) {
      diffPath = args[++i];
    } else if (a === '--repo' && args[i + 1]) {
      repo = args[++i];
    } else if (!prInput && !diffPath) {
      prInput = a;
    } else if (!scratchDir) {
      scratchDir = a;
    }
  }
  return { diffPath, prInput, scratchDir, repo };
}

function scanRepoStandards(cwd) {
  const candidates = [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    '.cursorrules',
    '.github/copilot-instructions.md'
  ];
  const found = [];
  for (const rel of candidates) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) {
      found.push({ path: rel, scope: 'repo-wide' });
    }
  }
  return found;
}

function pickTriggeredLenses(parsedFiles, prMeta, standardsList = []) {
  const nonGenerated = (parsedFiles || []).filter(
    (f) => !/(^|\/)(?:dist|generated|node_modules)\/|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/i.test(f.path)
  );
  const paths = nonGenerated.map((f) => f.path);
  const addedContent = nonGenerated
    .flatMap((f) => (f.hunks || []).flatMap((h) => (h.lines || []).filter((l) => l.type === 'add').map((l) => l.content)))
    .join('\n');
  const prBodyAndTitle = `${prMeta?.title || ''}\n${prMeta?.body || ''}`;

  const pick = [
    { lens: 'correctness', run: true, reason: 'always' },
    { lens: 'adversarial', run: true, reason: 'always' }
  ];

  const hasCode = nonGenerated.some((f) => f.layer === 'flows' || f.layer === 'contracts');
  pick.push({
    lens: 'structure',
    run: hasCode,
    reason: hasCode ? 'code changed' : 'no production code changed'
  });

  const touchesStandardsFile = paths.some((p) => /(^|\/)(?:AGENTS|CLAUDE|CONTRIBUTING)\.md$|\.cursorrules$|\.github\/instructions\//i.test(p));
  const runStandards = standardsList.length > 0 || touchesStandardsFile;
  pick.push({
    lens: 'standards',
    run: runStandards,
    reason: runStandards
      ? touchesStandardsFile
        ? 'standards/instruction file changed'
        : `${standardsList.length} repo standard(s) apply`
      : 'no repo standards files detected'
  });

  const topDirs = new Set(
    nonGenerated
      .filter((f) => f.layer === 'flows' || f.layer === 'contracts')
      .map((f) => f.path.split('/').slice(0, 2).join('/'))
  );
  const runArch = topDirs.size >= 2 || nonGenerated.some((f) => f.layer === 'contracts');
  pick.push({
    lens: 'architecture',
    run: runArch,
    reason: runArch ? `touches ${topDirs.size} module(s) / contracts` : 'single module change'
  });

  const triggerRules = [
    {
      lens: 'security',
      pathRe: /(?:auth|token|jwt|crypto|secret|iam|policy|middleware|interceptor|cors|csrf|cookie|session|Dockerfile|pnpm-workspace\.yaml|\.npmrc|\.env)/i,
      contentRe: /\b(?:process\.env|verify\(|exec\(|execSync\(|spawn\(|spawnSync\(|eval\(|dangerouslySetInnerHTML|pull_request_target|rejectUnauthorized)\b/
    },
    {
      lens: 'ai-harness',
      pathRe: /(?:SKILL\.md|AGENTS\.md|CLAUDE\.md|\.cursorrules|\.agents\/|\.claude\/|prompts\/|mcp|agent-runner)/i,
      contentRe: /\b(?:generateText|streamText|chat\.completions|response_format|systemPrompt|system_prompt|invoke_subagent|define_subagent|call_mcp_tool|BypassSandbox)\b/
    },
    {
      lens: 'data',
      pathRe: /(?:migrations\/|dao\/|alembic|flyway|knex|repository|persistence|pubsub|subscriber)/i,
      contentRe: /\b(?:transaction|upsert|ALTER\s+TABLE|DROP\s+COLUMN|idempotency|Firestore|DynamoDB|BigQuery)\b/i
    },
    {
      lens: 'contract',
      pathRe: /(?:openapi|\.proto$|\.graphql$|schema|contract|packages\/[^/]+\/index\.js$)/i,
      contentRe: /\b(?:module\.exports|export\s+(?:interface|type|function|const)|deprecated|BREAKING)\b/
    },
    {
      lens: 'infra',
      pathRe: /(?:\.tf$|\.tfvars$|\.hcl$|Pulumi|cdk\.json|infra\/|Dockerfile|\.github\/workflows\/|\.github\/actions\/|renovate\.json|dependabot\.yml)/i,
      contentRe: /\b(?:ignore_changes|prevent_destroy|deletion_protection|RemovalPolicy|id-token|pull_request_target)\b/
    },
    {
      lens: 'tests',
      pathRe: /(?:\.test\.|\.spec\.|__tests__\/|^test\/)/i,
      contentRe: null
    },
    {
      lens: 'operability',
      pathRe: /(?:logger|metrics|alert|monitor|feature-flag|runbook)/i,
      contentRe: /\b(?:logger\.|Counter\(|Histogram\(|Gauge\(|tracer\.)\b/
    },
    {
      lens: 'performance',
      pathRe: /(?:handler|worker|queue|batch|stream|cache)/i,
      contentRe: /\b(?:Promise\.all\(|SELECT\s+\*|\.map\(\s*async)\b/i,
      prRe: /\b(?:faster|optimi[sz]e|latency|throughput|speedup|perf)\b/i
    },
    {
      lens: 'docs',
      pathRe: /(?:^README\.md$|^docs\/|openapi)/i,
      contentRe: null
    }
  ];

  for (const rule of triggerRules) {
    const matchedPath = rule.pathRe ? paths.find((p) => rule.pathRe.test(p)) : null;
    const matchedContent = !matchedPath && rule.contentRe ? rule.contentRe.exec(addedContent) : null;
    const matchedPr = !matchedPath && !matchedContent && rule.prRe ? rule.prRe.exec(prBodyAndTitle) : null;
    if (matchedPath) {
      pick.push({ lens: rule.lens, run: true, reason: `path \`${matchedPath}\`` });
    } else if (matchedContent) {
      pick.push({ lens: rule.lens, run: true, reason: `diff signal \`${matchedContent[0]}\`` });
    } else if (matchedPr) {
      pick.push({ lens: rule.lens, run: true, reason: `PR description \`${matchedPr[0]}\`` });
    } else {
      pick.push({ lens: rule.lens, run: false, reason: 'no trigger' });
    }
  }

  return pick;
}

function formatLineNumberedDiff(parsedFiles, maxTotalChars = 28000) {
  const chunks = [];
  let usedChars = 0;
  // Prioritize contracts and flows first so production code always gets full line-numbered hunks
  const ordered = [
    ...(parsedFiles || []).filter((f) => f.layer === 'contracts'),
    ...(parsedFiles || []).filter((f) => f.layer === 'flows'),
    ...(parsedFiles || []).filter((f) => f.layer === 'config'),
    ...(parsedFiles || []).filter((f) => f.layer === 'tests')
  ];

  for (const f of ordered) {
    if (f.layer === 'tests' && usedChars > maxTotalChars * 0.7) {
      chunks.push(
        `### [TEST FILE COLLAPSED INTO LAYER 4 MATRIX] ${f.path} (+${f.additions}/-${f.deletions}) — read diff.patch only if needed`
      );
      continue;
    }
    const fileLines = [`### ${f.path} [${f.layer}: ${f.category}] (+${f.additions}/-${f.deletions})`];
    for (const h of f.hunks || []) {
      fileLines.push(h.header);
      for (const l of h.lines || []) {
        if (l.type === 'add') {
          fileLines.push(`L${l.newNumber} +${l.content}`);
        } else if (l.type === 'del') {
          fileLines.push(`DEL(${l.oldNumber}) -${l.content}`);
        } else {
          fileLines.push(`L${l.newNumber}  ${l.content}`);
        }
      }
    }
    const block = fileLines.join('\n');
    chunks.push(block);
    usedChars += block.length;
  }
  return chunks.join('\n\n');
}
function main() {
  const { diffPath, prInput, scratchDir, repo } = parseCli(process.argv);
  if ((!diffPath && !prInput) || !scratchDir) {
    console.error(
      'Usage:\n  node prepare_pr.mjs <pr> <scratch-dir> [--repo owner/repo]\n  node prepare_pr.mjs --diff <diff.patch> <scratch-dir>'
    );
    process.exit(1);
  }

  const absScratch = path.resolve(scratchDir);
  fs.mkdirSync(absScratch, { recursive: true });

  let diffText = '';
  let diffSource = 'diff-file';
  let prMeta = null;
  let hydratedThreads = { overviewMeta: null, findingThreads: {}, generalComments: [] };

  if (diffPath) {
    diffText = fs.readFileSync(path.resolve(diffPath), 'utf8');
    const targetDiff = path.join(absScratch, 'diff.patch');
    if (path.resolve(diffPath) !== targetDiff) {
      fs.writeFileSync(targetDiff, diffText);
    }
  } else {
    const shortMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(String(prInput));
    if (repo && !isValidRepoSlug(repo)) {
      console.error(`❌ Invalid --repo "${repo}". Expected owner/repo.`);
      process.exit(1);
    }
    const resolvedCfg = resolveRepoConfig({ explicitRepo: repo || (shortMatch && shortMatch[1]) });
    const activeRepo = resolvedCfg.repo || null;
    const targetPr = shortMatch ? shortMatch[2] : String(prInput).replace(/^#/, '');
    const isFullUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/i.test(String(prInput));
    if (!isFullUrl && !parsePrNumber(targetPr)) {
      console.error(`❌ Invalid PR "${prInput}". Expected a number, owner/repo#number, or a https://github.com/<owner>/<repo>/pull/<n> URL.`);
      process.exit(1);
    }
    if (!isFullUrl && !activeRepo) {
      console.error(
        [
          `❌ No GitHub repository could be detected for PR "${prInput}".`,
          'How to fix this:',
          '  1. Set a default repo:  crv repo <owner/repo>',
          '  2. Pass --repo:         node prepare_pr.mjs <pr> <scratch> --repo <owner/repo>',
          '  3. Pass the full URL:   node prepare_pr.mjs https://github.com/<owner>/<repo>/pull/<pr> <scratch>'
        ].join('\n')
      );
      process.exit(1);
    }
    const repoArgs = !isFullUrl && activeRepo ? ['--repo', activeRepo] : [];
    const prMetaRaw = runGh([
      'pr',
      'view',
      String(targetPr),
      ...repoArgs,
      '--json',
      'number,title,state,body,url,baseRefName,baseRefOid,headRefName,headRefOid,files,reviews,comments,statusCheckRollup'
    ]);
    prMeta = JSON.parse(prMetaRaw);
    fs.writeFileSync(path.join(absScratch, 'pr-meta.json'), JSON.stringify(prMeta, null, 2));

    const urlMatch = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prMeta.url || '');
    const candidateRepo = (urlMatch ? urlMatch[1] : null) || activeRepo;
    const resolvedRepo = isValidRepoSlug(candidateRepo) ? candidateRepo : null;
    const prNum = prMeta.number || (urlMatch ? urlMatch[2] : targetPr);

    const fetchedDiff = fetchPrDiffWithFallback({
      pr: targetPr,
      repo: resolvedRepo,
      repoArgs,
      prMeta,
      onFallback: (errMsg) => {
        if (/too_large|HTTP 406|exceeded the maximum number of lines/i.test(errMsg)) {
          console.error(
            `ℹ PR #${prNum} diff exceeded GitHub's 20,000-line REST diff limit (HTTP 406); falling back to local git / per-file PR API...`
          );
        }
      }
    });
    diffText = fetchedDiff.diffText;
    diffSource = fetchedDiff.source;
    fs.writeFileSync(path.join(absScratch, 'diff.patch'), diffText);

    if (!diffText.trim()) {
      console.error(
        `⚠️  Warning: PR #${prNum} in ${resolvedRepo} ("${prMeta.title || ''}", state: ${prMeta.state || 'UNKNOWN'}) has an empty diff (0 changed lines). If you meant a different repository, run inside that repo or pass --repo <owner/repo>.`
      );
    }

    if (resolvedRepo && prNum) {
      try {
        const issueComments = parsePaginatedGhJson(
          runGh(['api', `repos/${resolvedRepo}/issues/${prNum}/comments`, '--paginate', '--slurp']) || '[]'
        );
        const reviewComments = parsePaginatedGhJson(
          runGh(['api', `repos/${resolvedRepo}/pulls/${prNum}/comments`, '--paginate', '--slurp']) || '[]'
        );
        // crv markers are only honoured from the gh user, CRV_TRUSTED_REVIEWERS / user config reviewers and bots.
        const trust = resolveTrustedAuthors({ ghLogin: detectGhLogin() });
        hydratedThreads = hydrateFromGitHubComments(issueComments, reviewComments, {
          trustedAuthors: trust.logins,
          currentHead: prMeta.headRefOid
        });
        hydratedThreads.trustedAuthors = trust.logins;
        const [owner, name] = String(resolvedRepo).split('/');
        if (owner && name && Object.keys(hydratedThreads.findingThreads || {}).length > 0) {
          try {
            const gqlOut = runGh([
              'api',
              'graphql',
              '-f',
              `query=${REVIEW_THREADS_GRAPHQL_QUERY}`,
              '-F',
              `owner=${owner}`,
              '-F',
              `name=${name}`,
              '-F',
              `pr=${prNum}`
            ]);
            mergeGraphqlReviewThreads(hydratedThreads, gqlOut);
          } catch (e) {}
        }
      } catch (err) {
        hydratedThreads.syncWarning = err.message;
      }
    }
  }

  const parsedFiles = parseUnifiedDiff(diffText);

  // Scan repo for existing helpers matching newly added symbols (AI near-duplicate utility detection)
  const reuseCandidates = [];
  const allAdded = [];
  for (const f of parsedFiles) {
    if (Array.isArray(f.addedSymbols)) {
      allAdded.push(...f.addedSymbols);
    }
  }
  const uniqueNames = [...new Set(allAdded.map((s) => s.name).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)))].slice(
    0,
    20
  );
  if (uniqueNames.length > 0) {
    const pattern = `(function|const|class|def)\\s+(${uniqueNames.join('|')})\\b`;
    const grepRes = spawnSync('git', ['grep', '-n', '-E', pattern], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024
    });
    if (grepRes && grepRes.status === 0 && grepRes.stdout) {
      const matchesByName = new Map();
      for (const line of grepRes.stdout.split(/\r?\n/)) {
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const [, matchPath, matchLine, matchText] = m;
        if (/(^|\/)(?:test|tests|__tests__)\/|\.test\.|\.spec\./i.test(matchPath)) continue;
        for (const symName of uniqueNames) {
          if (new RegExp(`\\b${symName}\\b`).test(matchText)) {
            if (!matchesByName.has(symName)) matchesByName.set(symName, []);
            matchesByName.get(symName).push(`${matchPath}:${matchLine}`);
          }
        }
      }
      for (const sym of allAdded) {
        const existing = (matchesByName.get(sym.name) || []).filter(
          (loc) => !loc.startsWith(`${sym.path}:`)
        );
        if (existing.length > 0) {
          reuseCandidates.push({
            name: sym.name,
            addedIn: `${sym.path}:${sym.line}`,
            existingMatches: existing.slice(0, 5),
            kind: 'repo-match'
          });
        }
      }
    }
  }

  // Discover CODEOWNERS if present in the repo
  let codeownersText = '';
  for (const cand of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const absCand = path.resolve(process.cwd(), cand);
    if (fs.existsSync(absCand)) {
      codeownersText = fs.readFileSync(absCand, 'utf8');
      break;
    }
  }
  const codeownersRules = codeownersText ? parseCodeowners(codeownersText) : [];

  // Compute Caller Blast Radius for modified contract files
  const IGNORED_CONTRACT_STEMS = new Set([
    'index',
    'models',
    'schema',
    'types',
    'contract',
    'contracts',
    'skill',
    'agents',
    'claude',
    'readme',
    'config',
    'package'
  ]);
  const callerBlastRadius = {};
  for (const f of parsedFiles) {
    if (f.layer !== 'contracts' || /\.md$/i.test(f.path)) continue;
    const baseStem = path.basename(f.path).replace(/\.[a-z0-9]+$/i, '');
    const contractSyms = (f.addedSymbols || []).map((s) => s.name);
    const searchTokens = [...new Set([...contractSyms, baseStem])].filter(
      (t) =>
        /^[A-Za-z0-9_][A-Za-z0-9_-]{3,}$/.test(t) &&
        !IGNORED_CONTRACT_STEMS.has(t.toLowerCase())
    );
    if (searchTokens.length === 0) continue;
    const tokPattern = searchTokens
      .slice(0, 6)
      .map((t) => (/^[A-Za-z0-9_]+$/.test(t) ? `\\b${t}\\b` : t))
      .join('|');
    const cGrep = spawnSync('git', ['grep', '-l', '-E', '-e', tokPattern], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 2 * 1024 * 1024
    });
    if (cGrep && cGrep.status === 0 && cGrep.stdout) {
      const callerFiles = cGrep.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && l !== f.path && !/(^|\/)(?:test|tests|__tests__)\/|\.test\.|\.spec\./i.test(l))
        .slice(0, 8);
      if (callerFiles.length > 0) {
        const callers = callerFiles.map((cp) => {
          const owners = codeownersRules.length ? matchCodeowners(cp, codeownersRules) : [];
          return { path: cp, owners };
        });
        callerBlastRadius[f.path] = {
          symbols: searchTokens.slice(0, 4),
          callers,
          unownedCallersCount: codeownersRules.length ? callers.filter((c) => c.owners.length === 0).length : 0
        };
      }
    }
  }

  const standardsScan = scanRepoStandards(process.cwd());
  const lensPick = pickTriggeredLenses(parsedFiles, prMeta, standardsScan);
  const triggeredLenses = lensPick.filter((l) => l.run).map((l) => l.lens);

  let recentGitLog = '';
  try {
    const logRes = spawnSync('git', ['log', '--stat', '-5', '--no-color'], {
      encoding: 'utf8',
      timeout: 3000
    });
    if (logRes && logRes.status === 0 && logRes.stdout) {
      recentGitLog = logRes.stdout.trim();
    }
  } catch (e) {}

  const layers = buildLayersFromParsedDiff(parsedFiles, [], {
    prMeta,
    reuseCandidates,
    codeownersRules,
    callerBlastRadius
  });
  layers.standardsScan = standardsScan;
  layers.lensPick = lensPick;
  layers.triggeredLenses = triggeredLenses;

  fs.writeFileSync(path.join(absScratch, 'layers.json'), JSON.stringify(layers, null, 2));
  fs.writeFileSync(path.join(absScratch, 'github-threads.json'), JSON.stringify(hydratedThreads, null, 2));

  // Pre-build both <scratch>/lenses-bundle.md and a single-read <scratch>/review-pack.md
  // containing PR metadata, 4-Layer summary, pre-computed lens pick, triggered lenses, and line-numbered diff.
  try {
    const skillRoot = path.resolve(scriptDir, '..');
    const refFiles = ['references/judge.md', 'references/findings.md', 'references/verifier.md'];
    const lensesDir = path.join(skillRoot, 'lenses');
    const lensFiles = fs.existsSync(lensesDir)
      ? fs
          .readdirSync(lensesDir)
          .filter((n) => n.endsWith('.md'))
          .sort()
          .map((n) => `lenses/${n}`)
      : [];
    const bundleParts = [];
    for (const rel of [...refFiles, ...lensFiles]) {
      const full = path.join(skillRoot, rel);
      if (fs.existsSync(full)) {
        bundleParts.push(`<!-- ==================== ${rel} ==================== -->\n` + fs.readFileSync(full, 'utf8'));
      }
    }
    if (bundleParts.length > 0) {
      fs.writeFileSync(path.join(absScratch, 'lenses-bundle.md'), bundleParts.join('\n\n'));
    }

    // Build single-read <scratch>/review-pack.md with ONLY triggered lenses + line-numbered diff
    const triggeredLensDocs = [];
    for (const lensName of triggeredLenses) {
      const p = path.join(skillRoot, 'lenses', `${lensName}.md`);
      if (fs.existsSync(p)) {
        triggeredLensDocs.push(`### Lens: ${lensName}\n` + fs.readFileSync(p, 'utf8'));
      }
    }
    const findingsDocPath = path.join(skillRoot, 'references', 'findings.md');
    const findingsDoc = fs.existsSync(findingsDocPath) ? fs.readFileSync(findingsDocPath, 'utf8') : '';
    const pickTableMd = [
      '| Lens | Run | Reason |',
      '| --- | --- | --- |',
      ...lensPick.map((r) => `| \`${r.lens}\` | ${r.run ? 'yes' : 'no'} | ${r.reason} |`)
    ].join('\n');

    const reviewPack = [
      `# Pre-Staged Review Pack`,
      ``,
      `## 1. PR Metadata & Commits`,
      `- **PR:** #${prMeta?.number || prInput || 'branch'} — ${prMeta?.title || '(branch diff)'}`,
      `- **URL:** ${prMeta?.url || ''}`,
      `- **Base → Head:** \`${prMeta?.baseRefName || 'base'}\` (\`${prMeta?.baseRefOid || ''}\`) → \`${prMeta?.headRefName || 'head'}\` (\`${prMeta?.headRefOid || ''}\`)`,
      `- **Description:**\n${prMeta?.body || '(none)'}`,
      ``,
      `## 2. Pre-Computed Standards Scan & Recent Git History`,
      `- **Standards Files Applying to Changed Files:** ${
        standardsScan.length ? standardsScan.map((s) => `\`${s.path}\` (${s.scope})`).join(', ') : 'None (0 repo standards files)'
      }`,
      recentGitLog ? `### Recent 5 Commits (\`git log --stat -5\`)\n\`\`\`text\n${recentGitLog}\n\`\`\`` : '',
      ``,
      `## 3. Pre-Computed 4-Layer Breakdown & Attention Signals`,
      `- **Contracts (${layers.contracts.length}):** ${layers.contracts.map((c) => `\`${c.path}\` (${c.summary})`).join(', ') || 'none'}`,
      `- **Flows (${layers.flows.length}):** ${layers.flows.map((f) => `${f.name}: ${f.files.map((p) => `\`${p}\``).join(', ')}`).join(' | ') || 'none'}`,
      `- **Test Matrix (${layers.testMatrix.length} files):** ${
        layers.testMatrix
          .map(
            (tm) =>
              `\`${tm.file}\` (${tm.totalCases} cases, ${tm.assertionsCount} assertions, status: ${tm.status})`
          )
          .join(', ') || 'none'
      }`,
      `- **Attention Signals:** \`${JSON.stringify(layers.attentionSignals || {})}\``,
      ``,
      `## 4. Pre-Computed Judge Lens Pick (${triggeredLenses.length}/${lensPick.length} Triggered)`,
      pickTableMd,
      ``,
      `## 5. Triggered Lens Rules (${triggeredLenses.join(', ')})`,
      triggeredLensDocs.join('\n\n'),
      ``,
      `## 6. Findings Output Schema & Writing Rules`,
      findingsDoc,
      ``,
      `## 7. Line-Numbered Unified Diff (Every \`L<num>\` prefix is the exact \`<head>\` line number for \`loc: "<path>:<num>"\`)`,
      '```diff',
      formatLineNumberedDiff(parsedFiles),
      '```'
    ];

    // Check if an earlier findings.json or published GitHub crv-finding threads exist -> stage Re-Review context
    const existingFindingsPath = path.join(absScratch, 'findings.json');
    const prevFindingsPath = path.join(absScratch, 'previous-findings.json');
    let previousFindings = null;
    if (fs.existsSync(existingFindingsPath)) {
      try {
        previousFindings = JSON.parse(fs.readFileSync(existingFindingsPath, 'utf8'));
        fs.writeFileSync(prevFindingsPath, JSON.stringify(previousFindings, null, 2));
      } catch (e) {}
    } else if (fs.existsSync(prevFindingsPath)) {
      try {
        previousFindings = JSON.parse(fs.readFileSync(prevFindingsPath, 'utf8'));
      } catch (e) {}
    }

    const ghThreadList = Object.values(hydratedThreads.findingThreads || {});
    if (previousFindings || ghThreadList.length > 0) {
      const reReviewDocPath = path.join(skillRoot, 'references', 're-review.md');
      const reReviewDoc = fs.existsSync(reReviewDocPath) ? fs.readFileSync(reReviewDocPath, 'utf8') : '';
      const reviewedCommit =
        previousFindings?.meta?.revision?.headCommit ||
        previousFindings?.meta?.headCommit ||
        previousFindings?.meta?.review?.head ||
        hydratedThreads?.overviewMeta?.head ||
        '';
      const currentHead = prMeta?.headRefOid || '';
      let incrementalCommits = '';
      let incrementalDiff = '';
      if (reviewedCommit && currentHead && reviewedCommit !== currentHead) {
        const logRes = spawnSync('git', ['log', '--format=%h %s', `${reviewedCommit}..${currentHead}`], {
          encoding: 'utf8',
          timeout: 5000
        });
        if (logRes.status === 0 && logRes.stdout) {
          incrementalCommits = logRes.stdout.trim();
        }
        const incDiffRes = spawnSync('git', ['diff', '-M', reviewedCommit, currentHead], {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 10 * 1024 * 1024
        });
        if (incDiffRes.status === 0 && incDiffRes.stdout) {
          incrementalDiff = formatLineNumberedDiff(parseUnifiedDiff(incDiffRes.stdout), 14000);
        }
      }

      const earlierItems = (previousFindings?.issues || []).length
        ? previousFindings.issues.map((iss) => {
            const ghT = hydratedThreads.findingThreads?.[iss.id];
            return {
              id: iss.id,
              sev: iss.sev,
              verify: iss.verify,
              loc: iss.loc,
              title: iss.title,
              impact: iss.impact,
              fix: iss.fix,
              ghAction: ghT?.action || null,
              ghIsResolved: Boolean(ghT?.isResolved),
              ghNote: ghT?.note || '',
              ghReplies: ghT?.replies || []
            };
          })
        : ghThreadList.map((ghT) => ({
            id: ghT.id,
            sev: ghT.meta?.sev || 'medium',
            verify: ghT.meta?.verify || 'CONFIRMED',
            loc: ghT.meta?.loc || `${ghT.path || ''}:${ghT.line || 1}`,
            title: ghT.title,
            ghAction: ghT.action,
            ghIsResolved: Boolean(ghT.isResolved),
            ghNote: ghT.note || '',
            ghReplies: ghT.replies || []
          }));

      reviewPack.push(
        '',
        `## 8. Re-Review Mode (Earlier Findings & GitHub Threads Detected)`,
        `- **Earlier Reviewed Commit (\`<reviewed>\`):** \`${reviewedCommit || 'unknown'}\``,
        `- **Current Head Commit (\`<head>\`):** \`${currentHead || 'HEAD'}\``,
        `- **IMPORTANT:** Keep every earlier finding below in \`issues\` with its exact original \`id\` (\`H1\`, \`M1\`, etc.) and set \`status: { "state": "fixed" | "partial" | "open" | "rebutted" | "dropped" | "external", "note": "...", "evidence": "<path>:<line>" }\`. Publishing in the Workbench will automatically reply to and resolve/reopen each matching GitHub PR review thread by \`id\`! Any brand-new defect introduced in \`<reviewed>..<head>\` gets \`"isNew": true\` and ID \`R1\`, \`R2\`, etc.`,
        incrementalCommits ? `### Commits Since Last Review (\`${reviewedCommit.slice(0, 8)}..${currentHead.slice(0, 8)}\`)\n\`\`\`text\n${incrementalCommits}\n\`\`\`` : '',
        incrementalDiff ? `### Incremental Diff (\`${reviewedCommit.slice(0, 8)}..${currentHead.slice(0, 8)}\`)\n\`\`\`diff\n${incrementalDiff}\n\`\`\`` : '',
        `### Earlier Findings & GitHub Thread Replies`,
        '```json',
        JSON.stringify(earlierItems, null, 2),
        '```',
        reReviewDoc
      );
    }

    fs.writeFileSync(path.join(absScratch, 'review-pack.md'), reviewPack.filter(Boolean).join('\n'));
  } catch (e) {}

  const totalCases = layers.testMatrix.reduce((acc, f) => acc + f.cases.length, 0);
  const hollowCases = layers.testMatrix.reduce(
    (acc, f) => acc + f.cases.filter((c) => c.hollow || c.mockOnly || c.tautology || c.internalMock).length,
    0
  );
  const testLines = layers.testMatrix.reduce((acc, f) => acc + f.collapsedLines, 0);
  const signals = layers.attentionSignals || {};
  const shortcuts = signals.shortcuts || [];
  const specAlignment = signals.specAlignment || {};

  console.log(
    JSON.stringify(
      {
        scratchDir: absScratch,
        diffSource,
        filesTotal: parsedFiles.length,
        contractsCount: layers.contracts.length,
        flowsCount: layers.flows.length,
        testFilesCount: layers.testMatrix.length,
        testLinesCollapsed: testLines,
        testCasesExtracted: totalCases,
        hollowOrMockOnlyCases: hollowCases,
        configFilesCount: layers.config.length,
        removedGuardsCount: (signals.removedGuards || []).length,
        stealthChangesCount: (signals.stealthChanges || []).length,
        reuseCandidatesCount: (signals.reuseCandidates || []).length,
        shortcutsCount: shortcuts.length,
        rotRiskShortcutsCount: shortcuts.filter((s) => s.rotRisk).length,
        negativeSpaceViolationsCount: (specAlignment.negativeSpaceViolations || []).length,
        triggeredLenses,
        hydratedCrvFindings: Object.keys(hydratedThreads.findingThreads || {}).length,
        generalGitHubComments: (hydratedThreads.generalComments || []).length
      },
      null,
      2
    )
  );
}

main();
