'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const KNOWN_AGENTS = {
  agy: {
    id: 'agy',
    name: 'Antigravity CLI (agy)',
    bin: 'agy',
    exampleModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    buildInteractiveArgs: (prompt, skillDir, opts = {}) => {
      const args = ['--add-dir', skillDir];
      if (opts.model) args.push('--model', opts.model);
      if (opts.effort) args.push('--effort', opts.effort);
      args.push('-i', prompt);
      return args;
    },
    buildHeadlessArgs: (prompt, skillDir, opts = {}) => {
      const args = ['--add-dir', skillDir, '--mode', 'accept-edits'];
      if (opts.model) args.push('--model', opts.model);
      if (opts.effort) args.push('--effort', opts.effort);
      args.push('-p', prompt);
      return args;
    }
  },
  claude: {
    id: 'claude',
    name: 'Claude Code CLI (claude)',
    bin: 'claude',
    exampleModels: ['opus', 'sonnet', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    buildInteractiveArgs: (prompt, skillDir, opts = {}) => {
      const args = ['--add-dir', skillDir];
      if (opts.model) args.push('--model', opts.model);
      if (opts.effort) args.push('--effort', opts.effort);
      args.push(prompt);
      return args;
    },
    buildHeadlessArgs: (prompt, skillDir, opts = {}) => {
      const args = ['--add-dir', skillDir, '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep'];
      if (opts.model) args.push('--model', opts.model);
      if (opts.effort) args.push('--effort', opts.effort);
      args.push('-p', prompt);
      return args;
    }
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI (gemini)',
    bin: 'gemini',
    exampleModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    buildInteractiveArgs: (prompt, _skillDir, opts = {}) => {
      const args = [];
      if (opts.model) args.push('--model', opts.model);
      args.push(prompt);
      return args;
    },
    buildHeadlessArgs: (prompt, _skillDir, opts = {}) => {
      const args = [];
      if (opts.model) args.push('--model', opts.model);
      args.push('-p', prompt);
      return args;
    }
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI (codex)',
    bin: 'codex',
    exampleModels: ['o3', 'o4-mini', 'gpt-4.1'],
    buildInteractiveArgs: (prompt, _skillDir, opts = {}) => {
      const args = [];
      if (opts.model) args.push('--model', opts.model);
      args.push(prompt);
      return args;
    },
    buildHeadlessArgs: (prompt, _skillDir, opts = {}) => {
      const args = ['exec'];
      if (opts.model) args.push('--model', opts.model);
      args.push(prompt);
      return args;
    }
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
      available.push({
        id: spec.id,
        name: spec.name,
        bin: spec.bin,
        exampleModels: spec.exampleModels
      });
    }
  }
  return available;
}

function readAgentConfigFiles(cwd) {
  const candidates = [
    { path: path.join(cwd, '.crvrc.json'), source: '.crvrc.json' },
    { path: path.join(cwd, 'crv.config.json'), source: 'crv.config.json' },
    { path: path.join(os.homedir(), '.config', 'crv', 'config.json'), source: '~/.config/crv/config.json' }
  ];
  let foundAgent = null;
  let foundAgentSource = null;
  let foundModel = null;
  let foundModelSource = null;
  let foundEffort = null;
  let foundEffortSource = null;

  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(c.path, 'utf8')) || {};
        if (!foundAgent) {
          const agent = (parsed.defaultAgent || parsed.agent || '').trim().toLowerCase();
          if (agent && KNOWN_AGENTS[agent]) {
            foundAgent = agent;
            foundAgentSource = c.source;
          }
        }
        if (!foundModel) {
          const model = (parsed.defaultModel || parsed.model || '').trim();
          if (model) {
            foundModel = model;
            foundModelSource = c.source;
          }
        }
        if (!foundEffort) {
          const effort = (parsed.defaultEffort || parsed.effort || '').trim();
          if (effort) {
            foundEffort = effort;
            foundEffortSource = c.source;
          }
        }
      } catch (e) {}
    }
  }
  return {
    agent: foundAgent,
    agentSource: foundAgentSource,
    model: foundModel,
    modelSource: foundModelSource,
    effort: foundEffort,
    effortSource: foundEffortSource
  };
}

/**
 * Resolves which AI Agent CLI and Model to use in priority order:
 * 1. Explicit `--agent` / `--model` / `--effort` flags or UI selection
 * 2. Environment variables (`CRV_AGENT`, `CRV_MODEL`, `CRV_EFFORT`)
 * 3. Config file (`.crvrc.json` or `~/.config/crv/config.json`: `defaultAgent`, `defaultModel`, `defaultEffort`)
 * 4. First installed agent CLI on PATH (`agy`, `claude`, `gemini`, `codex`) and its default model
 */
function resolveAgentConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const available = detectAvailableAgents();
  const fileCfg = readAgentConfigFiles(cwd);

  // Resolve Model
  let model = null;
  let modelSource = 'harness-default';
  const explicitModel = String(options.explicitModel || '').trim();
  const envModel = String(env.CRV_MODEL || '').trim();
  if (explicitModel) {
    model = explicitModel;
    modelSource = 'explicit (--model / UI)';
  } else if (envModel) {
    model = envModel;
    modelSource = 'env:CRV_MODEL';
  } else if (fileCfg.model) {
    model = fileCfg.model;
    modelSource = fileCfg.modelSource;
  }

  // Resolve Effort
  let effort = null;
  let effortSource = 'harness-default';
  const explicitEffort = String(options.explicitEffort || '').trim();
  const envEffort = String(env.CRV_EFFORT || '').trim();
  if (explicitEffort) {
    effort = explicitEffort;
    effortSource = 'explicit (--effort)';
  } else if (envEffort) {
    effort = envEffort;
    effortSource = 'env:CRV_EFFORT';
  } else if (fileCfg.effort) {
    effort = fileCfg.effort;
    effortSource = fileCfg.effortSource;
  }

  // Resolve Agent Harness
  const explicitAgent = String(options.explicitAgent || '').trim().toLowerCase();
  if (explicitAgent && KNOWN_AGENTS[explicitAgent]) {
    return {
      agent: explicitAgent,
      spec: KNOWN_AGENTS[explicitAgent],
      source: 'explicit (--agent / UI)',
      model,
      modelSource,
      effort,
      effortSource,
      available
    };
  }

  const envAgent = String(env.CRV_AGENT || '').trim().toLowerCase();
  if (envAgent && KNOWN_AGENTS[envAgent]) {
    return {
      agent: envAgent,
      spec: KNOWN_AGENTS[envAgent],
      source: 'env:CRV_AGENT',
      model,
      modelSource,
      effort,
      effortSource,
      available
    };
  }

  if (fileCfg.agent) {
    return {
      agent: fileCfg.agent,
      spec: KNOWN_AGENTS[fileCfg.agent],
      source: fileCfg.agentSource,
      model,
      modelSource,
      effort,
      effortSource,
      available
    };
  }

  if (available.length > 0) {
    const first = available[0];
    return {
      agent: first.id,
      spec: KNOWN_AGENTS[first.id],
      source: `auto-detected on PATH (${first.bin})`,
      model,
      modelSource,
      effort,
      effortSource,
      available
    };
  }

  return {
    agent: null,
    spec: null,
    source: 'none',
    model,
    modelSource,
    effort,
    effortSource,
    available: []
  };
}

function saveDefaultAgentConfig(agentId, options = {}) {
  const norm = agentId ? String(agentId).trim().toLowerCase() : null;
  if (norm && !KNOWN_AGENTS[norm]) {
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

  if (norm) {
    existing.defaultAgent = norm;
  }
  if (options.model !== undefined && options.model !== null) {
    const m = String(options.model).trim();
    if (m === 'default' || m === 'none' || m === 'reset' || m === '') {
      delete existing.defaultModel;
    } else {
      existing.defaultModel = m;
    }
  }
  if (options.effort !== undefined && options.effort !== null) {
    const e = String(options.effort).trim();
    if (e === 'default' || e === 'none' || e === 'reset' || e === '') {
      delete existing.defaultEffort;
    } else {
      existing.defaultEffort = e;
    }
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n');
  const activeAgent = norm || existing.defaultAgent || null;
  return {
    agent: activeAgent,
    name: activeAgent && KNOWN_AGENTS[activeAgent] ? KNOWN_AGENTS[activeAgent].name : null,
    model: existing.defaultModel || null,
    effort: existing.defaultEffort || null,
    configPath: targetPath
  };
}

function buildReviewSkillPrompt({ repo, pr, scratchDir, skillDir, headless, agentName, modelName }) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const findingsPath = path.join(scratchDir, 'findings.json');
  const bundlePath = path.join(scratchDir, 'lenses-bundle.md');
  const provenanceNote =
    agentName || modelName
      ? `Record meta.review.agent as "${agentName || 'AI Agent'}"${modelName ? ` and meta.review.model as "${modelName}"` : ''} in ${findingsPath}.`
      : '';
  const lines = [
    `Review PR #${pr} in ${repo} using the crv-code-review skill at ${skillMdPath}.`,
    `The PR metadata (pr-meta.json), unified diff (diff.patch), 4-Layer map (layers.json), GitHub threads (github-threads.json), and pre-bundled lenses/references (${bundlePath}) are already prepared in ${scratchDir}.`,
    provenanceNote,
    headless
      ? `FAST HEADLESS MODE:
1. Read ${path.join(scratchDir, 'pr-meta.json')}, ${path.join(scratchDir, 'layers.json')}, ${path.join(scratchDir, 'diff.patch')}, and ${bundlePath} (which bundles judge.md, findings.md, verifier.md, and all 14 lens files so you do not need to read each lens file separately).
2. Evaluate all triggered lenses in a single pass and verify high/medium findings directly against <head> in the SAME turn and context.
3. DO NOT call invoke_subagent or spawn background tasks in headless mode (async subagents will stall single-turn -p CLI execution), and DO NOT write separate intermediate lens-<name>.json files.
4. Write the final ${findingsPath} directly following the exact schema in references/findings.md and finish.`
      : `Follow ${skillMdPath} starting at Step 2 using the prepared files in ${scratchDir} (you may read ${bundlePath} to load all lenses and references in one read), show the lens pick table, and write ${findingsPath}.`
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = {
  KNOWN_AGENTS,
  detectAvailableAgents,
  resolveAgentConfig,
  saveDefaultAgentConfig,
  buildReviewSkillPrompt
};
