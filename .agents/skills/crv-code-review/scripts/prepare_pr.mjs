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
  resolveRepoConfig
} = require(corePath);

function runGh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
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
  let hydratedThreads = { overviewMeta: null, findingThreads: {}, generalComments: [] };

  if (diffPath) {
    diffText = fs.readFileSync(path.resolve(diffPath), 'utf8');
    const targetDiff = path.join(absScratch, 'diff.patch');
    if (path.resolve(diffPath) !== targetDiff) {
      fs.writeFileSync(targetDiff, diffText);
    }
  } else {
    const resolvedCfg = resolveRepoConfig({ explicitRepo: repo });
    const activeRepo = resolvedCfg.repo || null;
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
      String(prInput),
      ...repoArgs,
      '--json',
      'number,title,body,url,baseRefName,baseRefOid,headRefName,headRefOid,files,reviews,comments,statusCheckRollup'
    ]);
    const prMeta = JSON.parse(prMetaRaw);
    fs.writeFileSync(path.join(absScratch, 'pr-meta.json'), JSON.stringify(prMeta, null, 2));

    diffText = runGh(['pr', 'diff', String(prInput), ...repoArgs]);
    fs.writeFileSync(path.join(absScratch, 'diff.patch'), diffText);

    const urlMatch = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prMeta.url || '');
    const resolvedRepo = (urlMatch ? urlMatch[1] : null) || activeRepo;
    const prNum = prMeta.number || (urlMatch ? urlMatch[2] : prInput);

    if (resolvedRepo && prNum) {
      try {
        const issueComments = JSON.parse(
          runGh(['api', `repos/${resolvedRepo}/issues/${prNum}/comments`, '--paginate']) || '[]'
        );
        const reviewComments = JSON.parse(
          runGh(['api', `repos/${resolvedRepo}/pulls/${prNum}/comments`, '--paginate']) || '[]'
        );
        hydratedThreads = hydrateFromGitHubComments(issueComments, reviewComments);
      } catch (err) {
        hydratedThreads.syncWarning = err.message;
      }
    }
  }

  const parsedFiles = parseUnifiedDiff(diffText);
  const layers = buildLayersFromParsedDiff(parsedFiles, []);

  fs.writeFileSync(path.join(absScratch, 'layers.json'), JSON.stringify(layers, null, 2));
  fs.writeFileSync(path.join(absScratch, 'github-threads.json'), JSON.stringify(hydratedThreads, null, 2));

  const totalCases = layers.testMatrix.reduce((acc, f) => acc + f.cases.length, 0);
  const hollowCases = layers.testMatrix.reduce(
    (acc, f) => acc + f.cases.filter((c) => c.hollow || c.mockOnly).length,
    0
  );
  const testLines = layers.testMatrix.reduce((acc, f) => acc + f.collapsedLines, 0);

  console.log(
    JSON.stringify(
      {
        scratchDir: absScratch,
        filesTotal: parsedFiles.length,
        contractsCount: layers.contracts.length,
        flowsCount: layers.flows.length,
        testFilesCount: layers.testMatrix.length,
        testLinesCollapsed: testLines,
        testCasesExtracted: totalCases,
        hollowOrMockOnlyCases: hollowCases,
        configFilesCount: layers.config.length,
        hydratedCrvFindings: Object.keys(hydratedThreads.findingThreads || {}).length,
        generalGitHubComments: (hydratedThreads.generalComments || []).length
      },
      null,
      2
    )
  );
}

main();
