'use strict';

/**
 * Scratch-directory artifacts (`.crv-skills/crv-code-review/<pr>/`) written by `prepare_pr.mjs`
 * and by the review agent: `diff.patch`, `pr-meta.json`, `layers.json`, `findings.json`.
 *
 * One place resolves the directory and reads the files, and only trusts them for the repository
 * they were staged for: a PR number alone does not identify a PR, so a `layers.json` left over
 * from `other/repo#5` must never be merged into `mine/repo#5`.
 */

const fs = require('fs');
const path = require('path');

const MAX_SCRATCH_FILE_BYTES = 50 * 1024 * 1024;
const SCRATCH_SUFFIX_RE = /[\\/]\.crv-skills(?:[\\/]crv-code-review(?:[\\/][^\\/]+)?)?$/;

/**
 * Project root for scratch directories. Strips `.crv-skills[/crv-code-review[/<pr>]]` when the CLI is invoked
 * from inside the scratch tree, so scratch folders never nest.
 */
function resolveScratchBase(cwd = process.cwd()) {
  return path.resolve(String(cwd).replace(SCRATCH_SUFFIX_RE, ''));
}

function getScratchDir(prNum, cwd = process.cwd()) {
  return path.resolve(resolveScratchBase(cwd), '.crv-skills', 'crv-code-review', String(prNum));
}

/** Reads and parses a JSON file; `null` when it is missing, oversized or malformed. */
function readJsonFileSafe(file, maxBytes = MAX_SCRATCH_FILE_BYTES) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readTextFileSafe(file, maxBytes = MAX_SCRATCH_FILE_BYTES) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function repoFromUrl(url) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

function sameRepo(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Loads the staged artifacts for a PR.
 *
 * Returns `{ dir, diffText, prMeta, layers, findings, evidenceRepo, mismatch }`. When `repo` is given:
 * - `prMeta`, `layers` and `diffText` are returned only if the staged data names that repository
 *   (via `pr-meta.json` url/repo, or the findings' `meta.review.repo`); otherwise they are empty.
 * - `findings` is returned when its recorded repo matches, or when it records none (older files).
 * - `mismatch` is true when the staged data positively names a different repository.
 */
function loadScratchArtifacts(prNum, options = {}) {
  const dir = getScratchDir(prNum, options.cwd);
  const repo = options.repo || '';

  const prMeta = readJsonFileSafe(path.join(dir, 'pr-meta.json'));
  const layers = readJsonFileSafe(path.join(dir, 'layers.json'));
  const findings = readJsonFileSafe(path.join(dir, 'findings.json'));
  const diffText = readTextFileSafe(path.join(dir, 'diff.patch'));

  const findingsRepo = String(findings?.meta?.review?.repo || findings?.REVIEW?.repo || '');
  const metaRepo = repoFromUrl(prMeta?.url) || String(prMeta?.repo || '').toLowerCase();
  const evidenceRepo = metaRepo || findingsRepo.toLowerCase();

  if (!repo) {
    return { dir, diffText, prMeta, layers, findings, evidenceRepo, mismatch: false };
  }

  const verified = sameRepo(evidenceRepo, repo);
  const mismatch = Boolean(evidenceRepo) && !verified;
  const findingsOk = findingsRepo ? sameRepo(findingsRepo, repo) : !mismatch;
  return {
    dir,
    diffText: verified ? diffText : '',
    prMeta: verified ? prMeta : null,
    layers: verified ? layers : null,
    findings: findingsOk ? findings : null,
    evidenceRepo,
    mismatch
  };
}

module.exports = {
  resolveScratchBase,
  getScratchDir,
  readJsonFileSafe,
  loadScratchArtifacts
};
