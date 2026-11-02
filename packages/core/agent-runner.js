'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const KNOWN_AGENTS = {
  agy: {
    id: 'agy',
    name: 'Antigravity CLI (agy)',
    bin: 'agy',
    buildInteractiveArgs: (prompt, skillDir) => ['--add-dir', skillDir, '-i', prompt],
    buildHeadlessArgs: (prompt, skillDir) => ['--add-dir', skillDir, '--mode', 'accept-edits', '-p', prompt]
  },
  claude: {
    id: 'claude',
    name: 'Claude Code CLI (claude)',
    bin: 'claude',
    buildInteractiveArgs: (prompt, skillDir) => ['--add-dir', skillDir, prompt],
    buildHeadlessArgs: (prompt, skillDir) => [
      '--add-dir',
      skillDir,
      '--allowedTools',
      'Bash,Read,Write,Edit,Glob,Grep',
      '-p',
      prompt
    ]
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI (gemini)',
    bin: 'gemini',
    buildInteractiveArgs: (prompt) => [prompt],
    buildHeadlessArgs: (prompt) => ['-p', prompt]
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI (codex)',
    bin: 'codex',
    buildInteractiveArgs: (prompt) => [prompt],
    buildHeadlessArgs: (prompt) => ['exec', prompt]
  }
};

function isBinaryOnPath(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(cmd, [bin], { encoding: 'utf8', timeout: 2000 });
    return res.status === 0 && Boolean((res.stdout || '').trim());
  } catch (e) {
    return false;
  }
}

function detectAvailableAgents() {
  const available = [];
  for (const spec of Object.values(KNOWN_AGENTS)) {
    if (isBinaryOnPath(spec.bin)) {
      available.push({ id: spec.id, name: spec.name, bin: spec.bin });
    }
  }
  return available;
}

function readAgentFromConfigFiles(cwd) {
  const candidates = [
    { path: path.join(cwd, '.crvrc.json'), source: '.crvrc.json' },
    { path: path.join(cwd, 'crv.config.json'), source: 'crv.config.json' },
    { path: path.join(os.homedir(), '.config', 'crv', 'config.json'), source: '~/.config/crv/config.json' }
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(c.path, 'utf8'));
        const agent = (parsed.defaultAgent || parsed.agent || '').trim().toLowerCase();
        if (agent && KNOWN_AGENTS[agent]) {
          return { agent, source: c.source };
        }
      } catch (e) {}
    }
  }
  return null;
}

/**
 * Resolves which AI Agent CLI to use in priority order:
 * 1. Explicit `--agent` flag or UI selection (`options.explicitAgent`)
 * 2. Environment variable (`CRV_AGENT`)
 * 3. Config file (`.crvrc.json` or `~/.config/crv/config.json` `defaultAgent`)
 * 4. First installed agent CLI on PATH (`agy`, `claude`, `gemini`, `codex`)
 */
function resolveAgentConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const available = detectAvailableAgents();

  const explicit = String(options.explicitAgent || '').trim().toLowerCase();
  if (explicit && KNOWN_AGENTS[explicit]) {
    return {
      agent: explicit,
      spec: KNOWN_AGENTS[explicit],
      source: 'explicit (--agent / UI)',
      available
    };
  }

  const envAgent = String(env.CRV_AGENT || '').trim().toLowerCase();
  if (envAgent && KNOWN_AGENTS[envAgent]) {
    return {
      agent: envAgent,
      spec: KNOWN_AGENTS[envAgent],
      source: 'env:CRV_AGENT',
      available
    };
  }

  const fileCfg = readAgentFromConfigFiles(cwd);
  if (fileCfg) {
    return {
      agent: fileCfg.agent,
      spec: KNOWN_AGENTS[fileCfg.agent],
      source: fileCfg.source,
      available
    };
  }

  if (available.length > 0) {
    const first = available[0];
    return {
      agent: first.id,
      spec: KNOWN_AGENTS[first.id],
      source: `auto-detected on PATH (${first.bin})`,
      available
    };
  }

  return {
    agent: null,
    spec: null,
    source: 'none',
    available: []
  };
}

function saveDefaultAgentConfig(agentId, options = {}) {
  const norm = String(agentId || '').trim().toLowerCase();
  if (!KNOWN_AGENTS[norm]) {
    throw new Error(
      `Unknown agent "${agentId}". Supported agents: ${Object.keys(KNOWN_AGENTS).join(', ')}`
    );
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
  existing.defaultAgent = norm;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n');
  return { agent: norm, name: KNOWN_AGENTS[norm].name, configPath: targetPath };
}

function buildReviewSkillPrompt({ repo, pr, scratchDir, skillDir, headless }) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const findingsPath = path.join(scratchDir, 'findings.json');
  const lines = [
    `Review PR #${pr} in ${repo} using the crv-code-review skill at ${skillMdPath}.`,
    `The PR metadata (pr-meta.json), unified diff (diff.patch), 4-Layer map (layers.json), and GitHub threads (github-threads.json) are already prepared in ${scratchDir}.`,
    headless
      ? `Run non-interactively: pick the triggered lenses from ${path.join(skillDir, 'references/judge.md')}, apply each lens from ${path.join(skillDir, 'lenses')} to the diff, verify high/medium findings, and write the final ${findingsPath} following the exact schema in ${path.join(skillDir, 'references/findings.md')}.`
      : `Follow ${skillMdPath} starting at Step 2 using the prepared files in ${scratchDir}, show the lens pick table, and write ${findingsPath}.`
  ];
  return lines.join('\n');
}

module.exports = {
  KNOWN_AGENTS,
  detectAvailableAgents,
  resolveAgentConfig,
  saveDefaultAgentConfig,
  buildReviewSkillPrompt
};
