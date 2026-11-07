'use strict';

/**
 * `crv ci-*` subcommands: non-interactive entry points for the reusable GitHub Actions workflow.
 *
 *   crv ci-comment <pr> --repo o/r [--scratch dir] [--ai-status text] [--fail-on-hard-rules] [--dry-run]
 *       Tier 1. Posts/updates ONE sticky crv-meta comment from the staged pre-scan (and tier 2 results if present).
 *   crv ci-analyze <pr> --repo o/r --agent <agy|claude|gemini|codex> [--model m] [--effort e] [--fast] [--scratch dir]
 *       Tier 2a. Stages the PR and runs the headless skill. Never starts the Workbench server.
 *   crv ci-review  <pr> --repo o/r [--scratch dir] [--min-severity medium] [--max-findings 15] [--dry-run]
 *       Tier 2b. Posts one COMMENT-only review from the agent's findings.json.
 *
 * Repo and PR always come from the CLI arguments (set by the workflow), never from agent output.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const core = require('../core');
const { validateReviewPayload } = require('./server');

const DEFAULT_AGY_MODEL = 'gemini-argon-4';

function parseCiArgs(argv) {
  const flags = {
    pr: null,
    repo: null,
    scratch: null,
    aiStatus: '',
    failOnHardRules: false,
    dryRun: false,
    minSeverity: 'medium',
    maxFindings: 15,
    agent: null,
    model: null,
    effort: null,
    fast: false,
    timeoutMinutes: 20
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo' || a === '-R') flags.repo = next();
    else if (a === '--scratch') flags.scratch = next();
    else if (a === '--ai-status') flags.aiStatus = next() || '';
    else if (a === '--fail-on-hard-rules') flags.failOnHardRules = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--min-severity') flags.minSeverity = next();
    else if (a === '--max-findings') flags.maxFindings = Number(next());
    else if (a === '--agent') flags.agent = next();
    else if (a === '--model' || a === '-m') flags.model = next();
    else if (a === '--effort') flags.effort = next();
    else if (a === '--fast') flags.fast = true;
    else if (a === '--timeout-minutes') flags.timeoutMinutes = Number(next());
    else if (!a.startsWith('-') && !flags.pr) flags.pr = a;
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  if (!['high', 'medium', 'low', 'struct', 'nit'].includes(flags.minSeverity)) {
    throw new Error(`--min-severity must be one of high, medium, low, struct, nit (got "${flags.minSeverity}")`);
  }
  if (!Number.isInteger(flags.maxFindings) || flags.maxFindings < 0 || flags.maxFindings > 100) {
    throw new Error('--max-findings must be an integer between 0 and 100');
  }
  return flags;
}

/** Runs `gh` without a shell. Resolves stdout; rejects with stderr+stdout on a non-zero exit. */
function defaultGh(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0) return resolve(stdout);
      reject(new Error((Buffer.concat(err).toString('utf8') || stdout || `gh exited ${code}`).trim()));
    });
    child.stdin.end(stdin || '');
  });
}

/**
 * The agent only needs the already-staged files, so it never receives the GitHub tokens or the OIDC request
 * credentials: a prompt-injected agent cannot use them to act on the repository.
 */
function scrubAgentEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_RUNTIME_TOKEN)$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function resolveScratch(flags, prNum) {
  return path.resolve(flags.scratch || path.join(process.cwd(), '.crv-skills', 'crv-code-review', String(prNum)));
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function loadScratch(scratch) {
  return {
    prMeta: readJsonIfExists(path.join(scratch, 'pr-meta.json')) || {},
    layers: readJsonIfExists(path.join(scratch, 'layers.json')) || {},
    threads: readJsonIfExists(path.join(scratch, 'github-threads.json')) || {},
    findings: readJsonIfExists(path.join(scratch, 'findings.json')),
    diffText: readTextIfExists(path.join(scratch, 'diff.patch')),
    result: readJsonIfExists(path.join(scratch, 'ci-review-result.json'))
  };
}

function appendGithubOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value).replace(/[\r\n]/g, ' ')}\n`);
}

/** Compiles the agent's findings.json. repo/pr/head come from the workflow, never from the agent's own meta. */
function compileAgentFindings({ findings, diffText, prMeta, layers, repo, pr, agentLabel, model }) {
  const report = core.compileFindingsToWorkbenchReport(findings, { diffText, prMeta, layers });
  report.REVIEW = {
    ...(report.REVIEW || {}),
    repo,
    pr,
    base: prMeta.baseRefOid || '',
    head: prMeta.headRefOid || '',
    agent: agentLabel || (report.REVIEW && report.REVIEW.agent) || 'AI agent',
    model: model || (report.REVIEW && report.REVIEW.model) || ''
  };
  return report;
}

async function ciComment(argv, deps = {}) {
  const flags = parseCiArgs(argv);
  const gh = deps.gh || defaultGh;
  const prNum = core.parsePrNumber(flags.pr);
  if (!prNum) throw new Error('Usage: crv ci-comment <pr> --repo owner/repo [--scratch dir]');
  const scratch = resolveScratch(flags, prNum);
  const s = loadScratch(scratch);
  const hard = core.hardRuleFindings(s.layers);

  // Tier 2 results (if a previous ci-review ran in this scratch dir) feed the sticky comment's counts.
  let findings = [];
  let posted = null;
  if (s.result && s.findings && Array.isArray(s.result.postedIds)) {
    const report = compileAgentFindings({
      findings: s.findings,
      diffText: s.diffText,
      prMeta: s.prMeta,
      layers: s.layers,
      repo: flags.repo,
      pr: prNum
    });
    const ids = new Set(s.result.postedIds.map(String));
    findings = (report.DATA || []).filter((d) => ids.has(String(d.id)));
    posted = { ...s.result.stats, posted: findings.length, minSeverity: s.result.minSeverity };
  }

  const report = core.buildCiReport({
    repo: flags.repo,
    pr: prNum,
    prMeta: s.prMeta,
    findings,
    agent: posted ? 'crv CI + AI review' : 'crv CI pre-scan',
    model: (s.result && s.result.model) || ''
  });
  const triage = {};
  for (const f of findings) triage[f.id] = { action: 'comment', note: '' };
  const body = core.renderStickyBody(
    report,
    core.renderTier1Summary({ layers: s.layers, hard, aiStatus: flags.aiStatus, posted, headSha: s.prMeta.headRefOid }),
    triage
  );

  const res = await core.upsertStickyComment({ gh, repo: flags.repo, pr: prNum, body, dryRun: flags.dryRun });
  appendGithubOutput('hard_findings', hard.length, deps.env);
  console.log(`crv ci-comment: sticky comment ${res.action}; ${hard.length} hard-rule finding(s).`);
  if (flags.dryRun) console.log(body);
  if (flags.failOnHardRules && hard.length) {
    console.error(`crv ci-comment: failing because ${hard.length} hard-rule finding(s) exist (--fail-on-hard-rules).`);
    return 1;
  }
  return 0;
}

async function ciReview(argv, deps = {}) {
  const flags = parseCiArgs(argv);
  const gh = deps.gh || defaultGh;
  const prNum = core.parsePrNumber(flags.pr);
  if (!prNum) throw new Error('Usage: crv ci-review <pr> --repo owner/repo [--scratch dir]');
  if (!core.isValidRepoSlug(flags.repo)) throw new Error('--repo owner/name is required');
  const scratch = resolveScratch(flags, prNum);
  const s = loadScratch(scratch);
  if (!s.findings || !Array.isArray(s.findings.issues)) {
    console.log('crv ci-review: no findings.json from the agent; nothing to post.');
    return 0;
  }

  const warnings = core.checkFindingsShape(s.findings);
  if (warnings.length) console.warn(`crv ci-review: ${warnings.length} shape warning(s):\n  ${warnings.slice(0, 10).join('\n  ')}`);

  const report = compileAgentFindings({
    findings: s.findings,
    diffText: s.diffText,
    prMeta: s.prMeta,
    layers: s.layers,
    repo: flags.repo,
    pr: prNum,
    agentLabel: deps.agentLabel || process.env.CRV_AGENT || '',
    model: process.env.CRV_MODEL || ''
  });
  const existingThreadIds = Object.keys((s.threads && s.threads.findingThreads) || {});
  const { kept, stats } = core.filterFindings(report.DATA, {
    minSeverity: flags.minSeverity,
    maxFindings: flags.maxFindings,
    existingThreadIds
  });

  const result = { postedIds: kept.map((f) => f.id), stats, minSeverity: flags.minSeverity, model: report.REVIEW.model };
  if (!flags.dryRun) fs.writeFileSync(path.join(scratch, 'ci-review-result.json'), JSON.stringify(result, null, 2));
  appendGithubOutput('posted_findings', kept.length, deps.env);

  if (!kept.length) {
    console.log(`crv ci-review: no findings at or above "${flags.minSeverity}" to post (${JSON.stringify(stats)}).`);
    return 0;
  }

  const note = `Automated review (${kept.length} finding(s), severity floor \`${flags.minSeverity}\`). Non-blocking: a human decides what to act on.`;
  const built = core.buildCiReviewPayload({ ...report, DATA: kept }, kept, { summaryNote: note });
  const payload = validateReviewPayload(built, { allowApprove: false });

  if (flags.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const res = await core.postReviewWithFallback({ gh, repo: flags.repo, pr: prNum, payload });
  console.log(`crv ci-review: posted ${kept.length} finding(s) as one COMMENT review (${res.mode}).`);
  return 0;
}

/** Stages the PR then runs the headless skill. Exit status 0 only when the agent wrote findings.json. */
async function ciAnalyze(argv, deps = {}) {
  const flags = parseCiArgs(argv);
  const env = deps.env || process.env;
  const prNum = core.parsePrNumber(flags.pr);
  if (!prNum) throw new Error('Usage: crv ci-analyze <pr> --repo owner/repo --agent <name>');
  if (!core.isValidRepoSlug(flags.repo)) throw new Error('--repo owner/name is required');
  if (!flags.agent) throw new Error('--agent is required (agy, claude, gemini, codex)');

  const explicitModel =
    flags.model || (flags.agent === 'agy' && !String(env.CRV_MODEL || '').trim() ? DEFAULT_AGY_MODEL : undefined);
  const agentCfg = core.resolveAgentConfig({
    explicitAgent: flags.agent,
    explicitModel,
    explicitEffort: flags.effort || (flags.fast ? 'low' : undefined),
    env
  });
  if (!agentCfg.spec) throw new Error(`Agent "${flags.agent}" is not available on PATH.`);

  const scratch = resolveScratch(flags, prNum);
  const skillDir = path.resolve(__dirname, '../../.agents/skills/crv-code-review');
  fs.mkdirSync(scratch, { recursive: true });
  const gi = path.join(path.dirname(path.dirname(scratch)), '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');

  const prep = spawnSync('node', [path.join(skillDir, 'scripts', 'prepare_pr.mjs'), String(prNum), scratch, '--repo', flags.repo], {
    stdio: 'inherit'
  });
  if (prep.status !== 0) throw new Error(`Failed to stage PR #${prNum} via prepare_pr.mjs`);

  const prompt = core.buildReviewSkillPrompt({
    repo: flags.repo,
    pr: String(prNum),
    scratchDir: scratch,
    skillDir,
    headless: true,
    agentName: agentCfg.spec.name,
    modelName: agentCfg.model || undefined
  });
  const effort = flags.effort || (flags.fast ? 'low' : agentCfg.effort || 'medium');
  const args = agentCfg.spec.buildHeadlessArgs(prompt, skillDir, { model: agentCfg.model, effort, scratchDir: scratch });
  console.log(`crv ci-analyze: running ${agentCfg.spec.name}${agentCfg.model ? ` (model ${agentCfg.model})` : ''}, effort ${effort}.`);

  const run = spawnSync(agentCfg.spec.bin, args, {
    stdio: 'inherit',
    env: scrubAgentEnv(env),
    timeout: Math.max(1, flags.timeoutMinutes) * 60 * 1000
  });
  if (run.error || run.status !== 0) {
    console.error(`crv ci-analyze: agent did not finish cleanly (${run.error ? run.error.message : `exit ${run.status}`}).`);
    return 2;
  }
  if (!fs.existsSync(path.join(scratch, 'findings.json'))) {
    console.error('crv ci-analyze: agent finished but wrote no findings.json.');
    return 2;
  }
  return 0;
}

const COMMANDS = { 'ci-comment': ciComment, 'ci-review': ciReview, 'ci-analyze': ciAnalyze };

function isCiCommand(cmd) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, cmd);
}

async function runCiCommand(cmd, argv, deps) {
  return COMMANDS[cmd](argv, deps);
}

module.exports = { isCiCommand, runCiCommand, parseCiArgs, compileAgentFindings, scrubAgentEnv, DEFAULT_AGY_MODEL };
