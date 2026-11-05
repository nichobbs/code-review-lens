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
  parseUnifiedDiff,
  buildLayersFromParsedDiff,
  hydrateFromGitHubComments,
  parsePaginatedGhJson,
  fetchPrDiffWithFallback,
  resolveRepoConfig
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
    const shortMatch = /^([^/]+\/[^#]+)#(\d+)$/.exec(String(prInput));
    const resolvedCfg = resolveRepoConfig({ explicitRepo: repo || (shortMatch && shortMatch[1]) });
    const activeRepo = resolvedCfg.repo || null;
    const targetPr = shortMatch ? shortMatch[2] : String(prInput).replace(/^#/, '');
    const isFullUrl = /^https?:\/\//i.test(String(prInput));
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
      'number,title,body,url,baseRefName,baseRefOid,headRefName,headRefOid,files,reviews,comments,statusCheckRollup'
    ]);
    prMeta = JSON.parse(prMetaRaw);
    fs.writeFileSync(path.join(absScratch, 'pr-meta.json'), JSON.stringify(prMeta, null, 2));

    const urlMatch = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prMeta.url || '');
    const resolvedRepo = (urlMatch ? urlMatch[1] : null) || activeRepo;
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

    if (resolvedRepo && prNum) {
      try {
        const issueComments = parsePaginatedGhJson(
          runGh(['api', `repos/${resolvedRepo}/issues/${prNum}/comments`, '--paginate', '--slurp']) || '[]'
        );
        const reviewComments = parsePaginatedGhJson(
          runGh(['api', `repos/${resolvedRepo}/pulls/${prNum}/comments`, '--paginate', '--slurp']) || '[]'
        );
        hydratedThreads = hydrateFromGitHubComments(issueComments, reviewComments);
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

  const layers = buildLayersFromParsedDiff(parsedFiles, [], { prMeta, reuseCandidates });

  fs.writeFileSync(path.join(absScratch, 'layers.json'), JSON.stringify(layers, null, 2));
  fs.writeFileSync(path.join(absScratch, 'github-threads.json'), JSON.stringify(hydratedThreads, null, 2));

  const totalCases = layers.testMatrix.reduce((acc, f) => acc + f.cases.length, 0);
  const hollowCases = layers.testMatrix.reduce(
    (acc, f) => acc + f.cases.filter((c) => c.hollow || c.mockOnly || c.tautology || c.internalMock).length,
    0
  );
  const testLines = layers.testMatrix.reduce((acc, f) => acc + f.collapsedLines, 0);
  const signals = layers.attentionSignals || {};

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
        hydratedCrvFindings: Object.keys(hydratedThreads.findingThreads || {}).length,
        generalGitHubComments: (hydratedThreads.generalComments || []).length
      },
      null,
      2
    )
  );
}

main();
