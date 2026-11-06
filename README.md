# Code Review Lens (`crv` — Agentic PR Review Workbench)

A human-in-the-loop PR Review Workbench designed for the era of AI-authored code. It combines a 14-lens AI review skill (`crv-code-review`) with a **4-Layer Human-Leverage Review UI** backed by **native GitHub Pull Request comments and review threads**.

## Architecture & Packages

- **[packages/core](./packages/core/index.js)**
  - [github-comments.js](./packages/core/github-comments.js): Serializes and parses `<!-- crv-meta: {...} -->` sticky PR overview comments and `<!-- crv-finding: {...} -->` inline PR review thread comments, plus builds the GitHub Pull Request Review API payload (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`).
  - [diff-classifier.js](./packages/core/diff-classifier.js): Classifies unified git diffs into the 4 human-leverage layers (`contracts`, `flows`, `tests` Behavioral Test Matrix, and `config`) and extracts inline diff slices around `path:line`.
  - [findings-compiler.js](./packages/core/findings-compiler.js): Compiles `crv-code-review` `findings.json` into the interactive 4-Layer Workbench report.
  - [repo-config.js](./packages/core/repo-config.js) & [agent-runner.js](./packages/core/agent-runner.js): Generic repository resolution (`--repo`, `CRV_DEFAULT_REPO`, `.crvrc.json`, `git remote origin`) and AI agent CLI orchestration (`agy`, `claude`, `gemini`, `codex`).
- **[packages/ui](./packages/ui/index.html)**
  - [workbench.js](./packages/ui/workbench.js) & [workbench.css](./packages/ui/workbench.css): Interactive 4-Layer Workbench UI featuring:
    1. **Layer 1: Intent, Architecture & Verification Summary** (Mermaid system architecture diagram + 14-lens verification coverage + 1-click triage presets).
    2. **Layer 2: Verified Risk Findings Rack** (inline diff slices around `path:line`, `🚫 Block` / `💬 Comment` / `🔇 Dismiss` triage controls, keyboard shortcuts `j`/`k`/`b`/`m`/`x`, and human reviewer notes).
    3. **Layer 3: Public Contracts, Schemas & Story-Ordered Flows** (OpenAPI specs, Pub/Sub event schemas, feature flags, ADRs, and story-ordered production flows).
    4. **Layer 4: Behavioral Test Matrix** (summarizes tested scenarios and assertion counts, flags hollow/mock-only assertions, and collapses raw `.test.ts` boilerplate by default).
- **[packages/cli](./packages/cli/bin/crv.js)**
  - [server.js](./packages/cli/server.js): Local HTTP server and `gh api` bridge that loads live PRs from GitHub, invokes AI coding agents for 14-lens reviews, and publishes curated reviews directly to GitHub.
- **[.agents/skills/crv-code-review](./.agents/skills/crv-code-review/SKILL.md)**
  - Bundled 14-lens AI review skill (`correctness`, `adversarial`, `security`, `data`, `contract`, `infra`, `performance`, `tests`, `standards`, `operability`, `docs`, `structure`, `architecture`, `ai-harness`) with fresh-context verification.
- **[packages/extension](./packages/extension/manifest.json)**
  - Manifest V3 Chrome Extension that injects an **🛡️ Agent Workbench** button onto `https://github.com/*/*/pull/*`, scans PR comments for `<!-- crv-finding -->` threads, and opens the Side Panel alongside GitHub.

---

## Quick Start

### 1. Install CLI & Bundled Skill
```bash
npm link
crv install-skill --global
```

Optionally install as a GitHub CLI (`gh`) extension:
```bash
cd gh-crv && gh extension install .
```

### 2. Configure Default Repo & AI Agent
```bash
# Set a default repository (or run inside any git checkout with a GitHub origin remote)
crv repo owner/repo --global

# Detect installed AI coding CLIs (agy, claude, gemini, codex) and set your preferred agent
crv agent agy --global
```

### 3. Review Any Pull Request
```bash
# Fetch & open any PR in the 4-Layer Workbench UI (auto-opens browser)
crv pr 1230

# Run the 14-lens AI review skill via your configured agent and open the Workbench
crv pr 1230 --analyze

# Start with the bundled demo report
crv demo
```

### 4. Load the Chrome Extension (Unpacked)
1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `packages/extension`.
4. Visit any GitHub PR (`https://github.com/*/*/pull/*`) to use the injected **🛡️ Agent Workbench** button and Side Panel.

## Security

PR content is untrusted input. See [docs/security.md](./docs/security.md) for the agent sandboxing guidance, marker
authenticity rules (`CRV_TRUSTED_REVIEWERS`), local-server protections (loopback `Host`, per-session token,
`CRV_EXTENSION_IDS`, `--allow-approve`) and the open GitHub rendering question for the extension.

Development: `npm run ci` (lint, extension-sync check, tests), `npm run sync-extension` after editing `packages/ui`.
