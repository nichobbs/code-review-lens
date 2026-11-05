#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const pkg = require('../../../package.json');
const {
  loadReportFile,
  loadLivePrFromGitHub,
  syncReportWithGitHub,
  buildStandaloneHtml,
  createWorkbenchServer
} = require('../server');
const {
  resolveRepoConfig,
  saveDefaultRepoConfig,
  resolveAgentConfig,
  saveDefaultAgentConfig,
  buildReviewSkillPrompt
} = require('../../core');

function printHelp() {
  console.log(`
crv v${pkg.version} — Human-in-the-loop Agentic PR Review Workbench (Code ReView)

USAGE:
  crv pr <number | owner/repo#number | url> [options]   Fetch & decompose any live GitHub PR into 4 Layers
  crv analyze <pr> [--agent agy|claude] [-m <model>]    Stage PR diff & invoke AI agent CLI with crv-code-review
  crv review [findings.json | report.html] [options]    Open Workbench on a saved findings.json or HTML report
  crv export-html [findings.json] --out <file.html>     Compile a standalone 4-Layer HTML review artifact
  crv repo [owner/repo] [--global]                      Inspect or set the default GitHub repository
  crv agent [agy|claude|gemini|codex] [-m <model>] [-g] Inspect or set the default AI agent harness, model & effort
  crv model [model-name | default] [--global]           Inspect or set the default model (e.g. claude-opus-4-6)
  crv effort [low|medium|high|xhigh|max|default] [-g]   Inspect or set the default reasoning effort
  crv install-skill [--global | --dir <path>]           Install the 13-lens crv-code-review AI skill
  crv demo [options]                                    Launch Workbench with bundled demo fixture

OPTIONS:
  --repo <owner/repo>     Override target GitHub repository for this command
  --agent <name>          AI agent CLI harness to use (agy, claude, gemini, codex)
  -m, --model <model>     Model to pass to the AI agent CLI (e.g. claude-opus-4-6, sonnet, gemini-2.5-pro)
  --effort <level>        Reasoning effort for agy/claude (low, medium, high, xhigh, max)
  --analyze               Run the full 13-lens AI agent review before opening the Workbench
  --headless              Run the AI agent non-interactively (-p mode) when analyzing
  --interactive           Force interactive agent session when running with --analyze
  --diff <diff.patch>     Attach unified diff file to extract inline code slices & Layer 4 Test Matrix
  --out <path.html>       Output file path for export-html
  --sync                  Hydrate existing <!-- crv-finding --> & <!-- crv-meta --> threads from GitHub
  --publish               Enable live GitHub PR review publishing from the Workbench UI
  --port <number>         Preferred local server port (default: 4320; auto-increments if busy)
  --no-open               Do not automatically open the Workbench URL in your browser
  -g, --global            Save repo/agent/model config to ~/.config/crv/config.json or install skill globally
  -v, --version           Print version
  -h, --help              Print this help message

DEFAULT REPO RESOLUTION ORDER:
  1. --repo <owner/repo> flag or owner/repo#number
  2. CRV_DEFAULT_REPO or GH_REPO environment variable (or .env file)
  3. .crvrc.json in current directory or ~/.config/crv/config.json
  4. git remote origin of the current working directory
`.trim());
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    port: 4320,
    publish: false,
    sync: false,
    global: false,
    open: true,
    analyze: false,
    headless: false,
    interactive: false,
    help: false,
    version: false,
    repo: null,
    agent: null,
    model: null,
    effort: null,
    skillDir: null,
    reportPath: null,
    diffPath: null,
    outPath: null
  };

  let cmd = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help' || a === 'help') flags.help = true;
    else if (a === '-v' || a === '--version' || a === 'version') flags.version = true;
    else if (a === '--publish') flags.publish = true;
    else if (a === '--sync') flags.sync = true;
    else if (a === '--analyze') flags.analyze = true;
    else if (a === '--headless') flags.headless = true;
    else if (a === '--interactive' || a === '-i') flags.interactive = true;
    else if (a === '--open') flags.open = true;
    else if (a === '--no-open') flags.open = false;
    else if (a === '--global' || a === '-g') flags.global = true;
    else if (a === '--port' && args[i + 1]) flags.port = Number(args[++i]);
    else if ((a === '--repo' || a === '-R') && args[i + 1]) flags.repo = args[++i];
    else if (a === '--agent' && args[i + 1]) flags.agent = args[++i];
    else if ((a === '--model' || a === '-m') && args[i + 1]) flags.model = args[++i];
    else if (a === '--effort' && args[i + 1]) flags.effort = args[++i];
    else if (a === '--dir' && args[i + 1]) flags.skillDir = args[++i];
    else if (a === '--report' && args[i + 1]) flags.reportPath = args[++i];
    else if (a === '--diff' && args[i + 1]) flags.diffPath = args[++i];
    else if (a === '--out' && args[i + 1]) flags.outPath = args[++i];
    else if (!a.startsWith('-')) {
      if (!cmd) cmd = a;
      else if (!flags.reportPath) flags.reportPath = a;
    }
  }
  return { cmd: cmd || 'demo', flags };
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function installSkill(flags) {
  const sourceSkillDir = path.resolve(__dirname, '../../../.agents/skills/crv-code-review');
  const sourceCoreDir = path.resolve(__dirname, '../../core');
  if (!fs.existsSync(sourceSkillDir)) {
    throw new Error(`Bundled skill directory not found at ${sourceSkillDir}`);
  }

  let targetSkillDir;
  if (flags.skillDir) {
    targetSkillDir = path.resolve(flags.skillDir, 'crv-code-review');
  } else if (flags.global) {
    targetSkillDir = path.join(os.homedir(), '.gemini', 'antigravity', 'skills', 'crv-code-review');
  } else {
    targetSkillDir = path.resolve(process.cwd(), '.agents', 'skills', 'crv-code-review');
  }

  copyDirRecursive(sourceSkillDir, targetSkillDir);
  // Vendor a self-contained copy of @crv/core into <skill>/scripts/lib/core so prepare_pr.mjs works anywhere
  const vendoredCoreTarget = path.join(targetSkillDir, 'scripts', 'lib', 'core');
  copyDirRecursive(sourceCoreDir, vendoredCoreTarget);

  console.log(`✓ Installed "crv-code-review" skill (13 lenses + references + self-contained scripts) to:\n  ${targetSkillDir}`);
  return targetSkillDir;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {}
}

function listenWithFallback(server, startPort, maxAttempts = 10, onListening) {
  let port = startPort;
  let attempts = 0;

  const tryListen = () => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
        attempts++;
        port++;
        tryListen();
      } else {
        console.error(`Failed to start Workbench server: ${err.message}`);
        process.exit(1);
      }
    });
    server.listen(port, '127.0.0.1', () => onListening(port));
  };

  tryListen();
}

function runAgentAnalysisOnPr(targetPr, flags) {
  const resolvedRepo = resolveRepoConfig({ explicitRepo: flags.repo });
  const agentCfg = resolveAgentConfig({
    explicitAgent: flags.agent,
    explicitModel: flags.model,
    explicitEffort: flags.effort
  });

  if (!agentCfg.spec) {
    throw new Error(
      'No supported AI agent CLI found on PATH (checked: agy, claude, gemini, codex).\nInstall Antigravity CLI (agy) or Claude Code (claude), or set CRV_AGENT.'
    );
  }

  // Extract PR number and repo
  const urlMatch = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(String(targetPr));
  const shortMatch = /^([^/]+\/[^#]+)#(\d+)$/.exec(String(targetPr));
  const repo = (urlMatch && urlMatch[1]) || (shortMatch && shortMatch[1]) || resolvedRepo.repo;
  const prNum = (urlMatch && urlMatch[2]) || (shortMatch && shortMatch[2]) || String(targetPr).replace(/^#/, '');

  if (!repo) {
    // Trigger the standard friendly missing-repo error
    loadLivePrFromGitHub(targetPr, null);
  }

  const scratchDir = path.resolve(process.cwd(), `.crv-skills/crv-code-review/${prNum}`);
  const skillDir = path.resolve(__dirname, '../../../.agents/skills/crv-code-review');
  const prepScript = path.join(skillDir, 'scripts', 'prepare_pr.mjs');

  console.log(`\n1/2 Staging PR #${prNum} (${repo}) into ${scratchDir}...`);
  const prepRes = spawnSync('node', [prepScript, String(prNum), scratchDir, '--repo', repo], {
    stdio: 'inherit'
  });
  if (prepRes.status !== 0) {
    throw new Error(`Failed to stage PR #${prNum} via prepare_pr.mjs`);
  }

  const useHeadless = Boolean(flags.headless || (flags.analyze && !flags.interactive));
  const prompt = buildReviewSkillPrompt({
    repo,
    pr: prNum,
    scratchDir,
    skillDir,
    headless: useHeadless,
    agentName: agentCfg.spec.name,
    modelName: agentCfg.model || undefined
  });

  const modelOpts = { model: agentCfg.model, effort: agentCfg.effort };
  const agentArgs = useHeadless
    ? agentCfg.spec.buildHeadlessArgs(prompt, skillDir, modelOpts)
    : agentCfg.spec.buildInteractiveArgs(prompt, skillDir, modelOpts);

  const modelBadge = agentCfg.model ? `, model: ${agentCfg.model}` : '';
  const effortBadge = agentCfg.effort ? `, effort: ${agentCfg.effort}` : '';
  console.log(
    `\n2/2 Launching ${agentCfg.spec.name} (${agentCfg.source}${modelBadge}${effortBadge}) to run 13-lens crv-code-review skill...\n`
  );
  spawnSync(agentCfg.spec.bin, agentArgs, { stdio: 'inherit' });
}

function main() {
  const { cmd, flags } = parseArgs(process.argv);

  if (flags.version) {
    console.log(pkg.version);
    return;
  }

  if (flags.help) {
    printHelp();
    return;
  }

  if (cmd === 'install-skill') {
    installSkill(flags);
    return;
  }

  if (cmd === 'agent' || cmd === 'model' || cmd === 'effort') {
    const isModelCmd = cmd === 'model';
    const isEffortCmd = cmd === 'effort';
    const targetAgent = isModelCmd || isEffortCmd ? flags.agent : flags.reportPath || flags.agent;
    const targetModel = isModelCmd ? flags.reportPath || flags.model : flags.model;
    const targetEffort = isEffortCmd ? flags.reportPath || flags.effort : flags.effort;

    if (targetAgent || targetModel !== null || targetEffort !== null) {
      const saved = saveDefaultAgentConfig(targetAgent, {
        global: flags.global,
        model: targetModel,
        effort: targetEffort
      });
      console.log(`✓ Saved AI configuration to ${saved.configPath}:`);
      if (saved.agent) console.log(`  Agent harness:  ${saved.agent} (${saved.name})`);
      console.log(`  Default model:  ${saved.model || '(harness default)'}`);
      console.log(`  Default effort: ${saved.effort || '(harness default)'}`);
      return;
    }

    const resolved = resolveAgentConfig({
      explicitAgent: flags.agent,
      explicitModel: flags.model,
      explicitEffort: flags.effort
    });
    console.log(
      resolved.agent
        ? `Active AI Agent CLI: ${resolved.agent} — ${resolved.spec.name} (source: ${resolved.source})`
        : 'No AI agent CLI detected on PATH.'
    );
    console.log(
      `Active AI Model:     ${resolved.model || '(harness default)'} (source: ${resolved.modelSource})`
    );
    console.log(
      `Reasoning Effort:    ${resolved.effort || '(harness default)'} (source: ${resolved.effortSource})`
    );
    if (resolved.available.length) {
      console.log(
        `Available Harnesses: ${resolved.available
          .map((a) => `${a.id} [examples: ${(a.exampleModels || []).join(', ')}]`)
          .join(' | ')}`
      );
    }
    return;
  }

  if (cmd === 'repo' || cmd === 'config') {
    if (flags.reportPath) {
      const saved = saveDefaultRepoConfig(flags.reportPath, { global: flags.global });
      console.log(`✓ Saved default repository "${saved.repo}" to ${saved.configPath}`);
      return;
    }
    const resolved = resolveRepoConfig({ explicitRepo: flags.repo });
    console.log(
      resolved.repo
        ? `Default repository: ${resolved.repo} (source: ${resolved.source})`
        : 'No default repository configured (set CRV_DEFAULT_REPO, run inside a git repo, or run "crv repo owner/name").'
    );
    return;
  }

  if (cmd === 'export-html') {
    const report = loadReportFile(flags.reportPath, { diffPath: flags.diffPath, outPath: flags.outPath });
    const html = buildStandaloneHtml(report);
    const out = path.resolve(
      flags.outPath || path.join(__dirname, '../../../dist/pr1230-workbench.html')
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(`✓ Exported standalone 4-Layer PR Workbench HTML (${(html.length / 1024 / 1024).toFixed(2)} MB) to:\n  ${out}`);
    return;
  }

  let report;
  const isDirectPrShortcut =
    /^\d+$/.test(cmd) || /^[^/]+\/[^#]+#\d+$/.test(cmd) || /^https:\/\/github\.com\//.test(cmd);

  if (
    cmd === 'pr' ||
    cmd === 'analyze' ||
    isDirectPrShortcut ||
    (flags.reportPath &&
      (/^\d+$/.test(flags.reportPath) ||
        /^[^/]+\/[^#]+#\d+$/.test(flags.reportPath) ||
        /^https:\/\/github\.com\//.test(flags.reportPath)))
  ) {
    const targetPr = isDirectPrShortcut ? cmd : flags.reportPath;
    if (!targetPr) {
      console.error('Usage: crv pr <number | owner/repo#number | url> [--repo owner/repo] [--analyze]');
      process.exit(1);
    }
    if (cmd === 'analyze' || flags.analyze) {
      runAgentAnalysisOnPr(targetPr, flags);
    }
    const resolved = resolveRepoConfig({ explicitRepo: flags.repo });
    if (resolved.repo || /^https?:\/\//i.test(targetPr) || /^[^/]+\/[^#]+#\d+$/.test(targetPr)) {
      console.log(
        `Fetching PR ${targetPr}${resolved.repo ? ` (${resolved.repo} via ${resolved.source})` : ''} via gh cli...`
      );
    }
    report = loadLivePrFromGitHub(targetPr, flags.repo || resolved.repo);
  } else {
    report = loadReportFile(flags.reportPath, { diffPath: flags.diffPath });
    if (flags.sync) {
      console.log('Syncing PR comments & diff slices from GitHub via gh cli...');
      const syncRes = syncReportWithGitHub(report);
      console.log(syncRes.synced ? '✓ Synced with GitHub PR threads.' : `ℹ Skipped live sync (${syncRes.reason})`);
    }
  }

  const resolvedRepo = resolveRepoConfig({ explicitRepo: flags.repo, reportRepo: report?.REVIEW?.repo });

  const { server } = createWorkbenchServer({
    report,
    publish: flags.publish,
    explicitRepo: flags.repo
  });

  listenWithFallback(server, flags.port, 10, (boundPort) => {
    const url = `http://127.0.0.1:${boundPort}`;
    console.log(`\n🛡️  Agentic PR Review Workbench running at: ${url}`);
    console.log(
      `   Repo:     ${resolvedRepo.repo || 'auto'} (resolved from: ${resolvedRepo.source})`
    );
    console.log(`   PR:       ${report.XMETA?.title || 'PR Review'}`);
    console.log(`   Findings: ${(report.DATA || []).length} (${flags.publish ? 'LIVE GitHub publish enabled' : 'Dry-run mode; pass --publish for live GitHub POST'})\n`);
    if (flags.open) {
      openBrowser(url);
    }
  });
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message || err}\n`);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
}
