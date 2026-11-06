'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Strict `owner/repo` check (no path traversal, no `..`, no whitespace). */
function isValidRepoSlug(slug) {
  if (typeof slug !== 'string' || !REPO_SLUG_RE.test(slug)) return false;
  return slug.split('/').every((part) => part !== '.' && part !== '..');
}

/** Positive integer PR number (accepts numeric strings). */
function parsePrNumber(value) {
  const n = typeof value === 'number' ? value : /^\d{1,9}$/.test(String(value).trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Parses a GitHub `owner/repo` slug from a git remote URL (HTTPS or SSH) or plain `owner/repo` string.
 */
function parseGitHubRepoSlug(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Match https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
  const urlMatch = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?(?:\/.*)?$/i.exec(trimmed);
  if (urlMatch) return isValidRepoSlug(urlMatch[1]) ? urlMatch[1] : null;

  // Match plain owner/repo or owner/repo#number
  const slugMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#\d+)?$/.exec(trimmed);
  if (slugMatch) return isValidRepoSlug(slugMatch[1]) ? slugMatch[1] : null;

  return null;
}

/**
 * Reads `.env` file in `cwd` if present and returns key-value pairs without mutating process.env.
 */
function readDotEnv(cwd) {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return {};
  try {
    const out = {};
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2].replace(/^['"]|['"]$/g, '').trim();
      out[m[1]] = val;
    }
    return out;
  } catch (e) {
    return {};
  }
}

/**
 * Reads `.crvrc.json` or `crv.config.json` in `cwd` (walking up to git root) or `~/.config/crv/config.json`.
 */
function readConfigFiles(cwd) {
  const candidates = [
    { path: path.join(cwd, '.crvrc.json'), source: '.crvrc.json' },
    { path: path.join(cwd, 'crv.config.json'), source: 'crv.config.json' },
    { path: path.join(os.homedir(), '.config', 'crv', 'config.json'), source: '~/.config/crv/config.json' }
  ];

  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(c.path, 'utf8'));
        const repo = parseGitHubRepoSlug(parsed.defaultRepo || parsed.repo);
        if (repo) {
          return { repo, source: c.source, configPath: c.path, raw: parsed };
        }
      } catch (e) {}
    }
  }
  return null;
}

/**
 * Detects `owner/repo` from the git repository in `cwd` via `git config --get remote.origin.url`.
 */
function detectGitRemoteRepo(cwd) {
  try {
    const res = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000
    });
    if (res.status === 0 && res.stdout) {
      const slug = parseGitHubRepoSlug(res.stdout.trim());
      if (slug) return slug;
    }
  } catch (e) {}
  return null;
}

/**
 * Resolves the active GitHub repository (`owner/repo`) using the priority order:
 * 1. Explicit `options.explicitRepo` (`--repo` CLI flag or UI override)
 * 2. Environment variable (`CRV_DEFAULT_REPO` or `GH_REPO`)
 * 3. `.env` file in working directory (`CRV_DEFAULT_REPO` or `GH_REPO`)
 * 4. Local config file (`.crvrc.json`, `crv.config.json`, or `~/.config/crv/config.json`)
 * 5. Git remote of the current working directory (`git config --get remote.origin.url`)
 * 6. Report metadata fallback (`options.reportRepo`)
 */
function resolveRepoConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;

  const explicit = parseGitHubRepoSlug(options.explicitRepo);
  if (explicit) {
    return { repo: explicit, source: 'explicit (--repo / UI)' };
  }

  const envRepo = parseGitHubRepoSlug(env.CRV_DEFAULT_REPO || env.GH_REPO);
  if (envRepo) {
    const varName = env.CRV_DEFAULT_REPO ? 'env:CRV_DEFAULT_REPO' : 'env:GH_REPO';
    return { repo: envRepo, source: varName };
  }

  const dotEnv = readDotEnv(cwd);
  const dotEnvRepo = parseGitHubRepoSlug(dotEnv.CRV_DEFAULT_REPO || dotEnv.GH_REPO);
  if (dotEnvRepo) {
    return { repo: dotEnvRepo, source: '.env' };
  }

  const fileCfg = readConfigFiles(cwd);
  if (fileCfg) {
    return { repo: fileCfg.repo, source: fileCfg.source };
  }

  if (options.detectGit !== false) {
    const gitRepo = detectGitRemoteRepo(cwd);
    if (gitRepo) {
      return { repo: gitRepo, source: 'git remote (origin)' };
    }
  }

  const fallback = parseGitHubRepoSlug(options.reportRepo);
  if (fallback) {
    return { repo: fallback, source: 'active report metadata' };
  }

  return { repo: null, source: 'none' };
}

/**
 * Saves `defaultRepo` to `.crvrc.json` in `cwd` (or `~/.config/crv/config.json` when `global: true`).
 */
function saveDefaultRepoConfig(repoSlug, options = {}) {
  const valid = parseGitHubRepoSlug(repoSlug);
  if (!valid) {
    throw new Error(`Invalid GitHub repository "${repoSlug}". Expected "owner/repo" or a GitHub URL.`);
  }
  const cwd = options.cwd || process.cwd();
  const targetPath = options.global
    ? path.join(os.homedir(), '.config', 'crv', 'config.json')
    : path.join(cwd, '.crvrc.json');

  let existing = {};
  if (fs.existsSync(targetPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(targetPath, 'utf8')) || {};
    } catch (e) {}
  }
  existing.defaultRepo = valid;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n');
  return { repo: valid, configPath: targetPath, path: targetPath };
}

/**
 * Logins whose `<!-- crv-* -->` PR comment markers are honoured (see hydrateFromGitHubComments).
 * Sources: the authenticated `gh` user (`options.ghLogin`), `CRV_TRUSTED_REVIEWERS` (comma separated),
 * `trustedReviewers` in the USER-level `~/.config/crv/config.json`, and `github-actions[bot]`.
 * The checkout's own `.crvrc.json` is deliberately NOT consulted: it belongs to the repo under review.
 */
function resolveTrustedAuthors(options = {}) {
  const env = options.env || process.env;
  const logins = new Set(['github-actions[bot]']);
  const sources = ['default bot'];
  const add = (list, src) => {
    let added = false;
    for (const l of list) {
      const v = String(l || '').trim().toLowerCase();
      if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/.test(v)) {
        logins.add(v);
        added = true;
      }
    }
    if (added) sources.push(src);
  };
  if (options.ghLogin) add([options.ghLogin], 'gh user');
  add(String(env.CRV_TRUSTED_REVIEWERS || '').split(','), 'env:CRV_TRUSTED_REVIEWERS');
  try {
    const userCfg = path.join(options.homeDir || os.homedir(), '.config', 'crv', 'config.json');
    if (fs.existsSync(userCfg)) {
      const parsed = JSON.parse(fs.readFileSync(userCfg, 'utf8')) || {};
      if (Array.isArray(parsed.trustedReviewers)) add(parsed.trustedReviewers, '~/.config/crv/config.json');
    }
  } catch (e) {}
  return { logins: Array.from(logins), sources };
}

/** Sync lookup of the authenticated gh user (CLI/skill use; the server uses an async variant). */
function detectGhLogin() {
  try {
    const res = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 5000 });
    const login = res.status === 0 ? String(res.stdout || '').trim() : '';
    return login || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  isValidRepoSlug,
  parsePrNumber,
  resolveTrustedAuthors,
  detectGhLogin,
  parseGitHubRepoSlug,
  detectGitRemoteRepo,
  resolveRepoConfig,
  saveDefaultRepoConfig
};
