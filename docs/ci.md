# Automating crv in CI

crv can review every internal pull request automatically, in two tiers. The design keeps crv's core rule: a human
decides what matters. Automation posts **non-blocking** output and never requests changes or approves.

| Tier | Needs an AI credential | What it does |
| :--- | :---: | :--- |
| 1. Pre-scan | No | Runs the deterministic 4-layer scan (contracts, flows, test matrix, attention signals, CODEOWNERS blast radius) and keeps **one sticky `<!-- crv-meta -->` comment** up to date. Optionally fails the check on deterministic hard rules only (zero-assertion tests). |
| 2. AI review | Yes (opt-in) | Runs the 14-lens skill headless, then posts **one `COMMENT` review** with the findings at or above a severity floor. Advisory: a failure never fails the PR. |

Tier 2 is **off by default** (`ai-runner: none`). Whether the team's harness (`agy`, model `gemini-argon-4`) can
authenticate inside CI is unresolved; see [agy auth options](#agy-auth-options). Tier 1 works today.

## Setup

In the repository that should be reviewed, add `.github/workflows/crv.yml`:

```yaml
name: crv
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    uses: nichobbs/code-review-lens/.github/workflows/crv-review.yml@<full-commit-sha>
    with:
      crv-ref: <same full commit sha>      # the tooling that runs; pin it
      # fail-on-hard-rules: true           # optional: make hollow tests fail the check
      # ai-runner: agy                     # tier 2, only once auth is solved
      # ai-model: gemini-argon-4           # default for agy; confirm the exact id with the platform team
    secrets:
      CRV_TOOL_TOKEN: ${{ secrets.CRV_TOOL_TOKEN }}   # only if code-review-lens is private to another org/repo
      # AI_RUNNER_TOKEN: ${{ secrets.AI_RUNNER_TOKEN }}
```

Notes for callers in other repositories (for example `cx-integration-hub` or `one-lens`):

- Call it from a `pull_request` workflow. Do not call it from `pull_request_target`.
- Do not define a `concurrency` group named `crv-review-*` in the caller; the reusable workflow owns that prefix.
- The called workflow can only reduce the caller's permissions, so the caller must grant `pull-requests: write`.
- This repository dogfoods it in `.github/workflows/crv-self-review.yml`, with `crv-ref` set to the PR's **base** SHA so
  a pull request cannot change the code that reviews it.
- The One Lens repository's current pipeline file only contains `echo` placeholders. Replace its crv step with this
  workflow; One Lens can then read the sticky comment's `crv-meta` counts instead of inventing a crv status.

### Inputs

| Input | Default | Purpose |
| :--- | :--- | :--- |
| `crv-repository`, `crv-ref` | this repo, `main` | Where the tooling comes from. Pin a SHA. |
| `ai-runner` | `none` | `none`, `agy`, `claude`, `gemini`, `codex`. |
| `ai-model` | empty | Empty means the harness default (`gemini-argon-4` for `agy`). |
| `ai-runs-on` | `ubuntu-latest` | Runner labels for tier 2 (for example a self-hosted label). |
| `ai-auth-mode` | `token` | `token` needs the `AI_RUNNER_TOKEN` secret; `ambient` assumes the runner is already authenticated. |
| `effort`, `fast` | `low`, `true` | Reasoning effort and the single-pass review pack. |
| `min-severity` | `medium` | Severity floor for posted findings. |
| `max-findings` | `15` | Cap on posted findings. |
| `max-diff-bytes` | `200000` | Tier 2 is skipped above this diff size. |
| `fail-on-hard-rules` | `false` | Fail the check on deterministic hard rules. Never on AI findings. |

## What runs

```text
pull_request (same-repo, not draft, not Dependabot)
  tier1: checkout PR (data only) + checkout tooling at crv-ref
         prepare_pr.mjs -> layers.json, diff.patch, pr-meta.json, github-threads.json
         crv ci-comment  -> create-or-update ONE bot-authored sticky comment
  tier2 (only if ai-runner != none, diff small enough, credentials present):
         crv ci-analyze  -> headless skill run; the agent gets no GitHub tokens
         crv ci-review   -> one COMMENT review (severity floor, cap, 422 fallback)
         crv ci-comment  -> sticky comment now shows the AI counts
```

The `crv ci-*` commands can also be run locally with `--dry-run` to preview the output without posting.

### Re-reviews on new pushes

`prepare_pr.mjs` hydrates earlier threads using the trusted-author rules (the bot is trusted by default), and the skill's
re-review flow uses them. `crv ci-review` never posts a second thread for a finding id that already has a trusted
thread, so pushing again does not duplicate comments. It does not reply to or resolve old threads; that stays a human
step in the Workbench.

## Security model

- **Trigger:** `pull_request` only, same-repository PRs only (fork PRs get nothing and receive no secrets), drafts and
  Dependabot skipped. Internal-only usage assumed.
- **Token:** `contents: read` and `pull-requests: write`. Actions are pinned to SHAs (`npm run lint` enforces it).
- **No shell interpolation:** every PR-controlled string reaches scripts through `env:`, never `${{ }}` inside `run:`.
  `test/ci.test.js` fails if an expression appears in a run block.
- **Tooling is not PR code:** the tooling is checked out at `crv-ref` into a separate directory. The PR is checked out
  as data and nothing in it is executed.
- **Marker authenticity:** the sticky comment is only updated when authored by `github-actions[bot]`; a spoofed
  `crv-meta` from another user is ignored and never overwritten. Hydration trusts bot markers only (PR #6).
- **Repo and PR come from the workflow**, never from the agent's `findings.json`, so a manipulated agent cannot redirect
  where the review is posted. The payload goes through the same validator as the Workbench.
- **No verdicts:** event is always `COMMENT`. There is no `REQUEST_CHANGES` or `APPROVE` path.
- **Agent isolation:** `ci-analyze` stages the PR first, then starts the agent without `GH_TOKEN`, `GITHUB_TOKEN` or the
  OIDC request variables, so a prompt-injected agent cannot act on the repository.

### Why the unrestricted-headless opt-in is acceptable here

`claude` runs with crv's read-only tool allow-list. `agy`, `gemini` and `codex` cannot restrict their tools, so crv
refuses headless runs for them unless `CRV_ALLOW_UNRESTRICTED_HEADLESS=1`. The workflow sets it **only** inside the tier 2
step, which means: an ephemeral runner, same-repo PRs only, no GitHub tokens in the agent's environment, and no
other secrets in the job. The remaining exposure is the AI credential itself (and anything on the runner), which is why
the credential should be narrow, short-lived, and ideally not a personal identity. If those conditions cannot be met,
do not enable tier 2 for `agy`; use `claude`, or run tier 2 locally.

## Cost and noise controls

- Tier 2 is opt-in and skipped above `max-diff-bytes`.
- `fast: true` and `effort: low` by default; raise them per repository.
- `concurrency` cancels superseded runs; drafts and bots never run.
- A severity floor and a finding cap bound what is posted; already-posted findings are not repeated.
- Tier 1 costs seconds and no tokens.

## agy auth options

**This is a list of questions for the platform team, not a statement of what the enterprise supports.** The repository
deliberately contains no credential mechanics: `scripts/ci-ai-setup.sh` has `TODO(platform-team)` markers where they
belong, and tier 2 reports "skipped" until they are filled in. Options, with trade-offs:

1. **Service account or API key as `AI_RUNNER_TOKEN`.** Simplest if the harness accepts a non-interactive token.
   Needs a non-personal identity with the narrowest quota and rotation. Weakest option against prompt injection, since
   the agent process holds the secret.
2. **Workload identity federation from GitHub OIDC.** Only possible if `gemini-argon-4` is served through a platform that
   accepts a federated identity (for example a cloud model endpoint or an internal gateway). No long-lived secret. Needs
   `id-token: write`, which this workflow does not request today; adding it is a deliberate, reviewed change, and the
   agent must not receive the OIDC request variables (`ci-analyze` already strips them).
3. **Self-hosted runner with a dedicated, non-personal identity** (`ai-runs-on: <label>`, `ai-auth-mode: ambient`).
   Auth lives on the runner, not in GitHub secrets. Needs runner hardening and ephemerality (one job per runner),
   otherwise a prompt-injected agent could reach whatever the runner can.
4. **Do not run tier 2 in CI.** Keep tier 1 in CI and run `crv analyze <pr>` locally, then publish from the Workbench
   (`crv pr <n> --publish`). Zero new credentials; loses the "automatic" part, and a human is already in the loop.

Questions to ask: Is there a headless, non-interactive auth path for `agy`? Is `gemini-argon-4` reachable via an
OIDC-federated or gateway endpoint? Who owns a non-personal identity and its quota? What is the egress policy for
runners? What is the exact model id?

## Files

| File | Role |
| :--- | :--- |
| `.github/workflows/crv-review.yml` | Reusable workflow (`workflow_call`) |
| `.github/workflows/crv-self-review.yml` | crv reviewing its own PRs |
| `packages/core/ci.js` | Sticky-comment, filtering and review-payload logic (gh injected, unit-tested) |
| `packages/cli/ci.js` | `crv ci-comment`, `crv ci-analyze`, `crv ci-review` |
| `scripts/ci-ai-setup.sh` | Install/auth seam for tier 2 (TODOs for the platform team) |
