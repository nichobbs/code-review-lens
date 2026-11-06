# Security model & operating guidance

crv reads **untrusted input**: PR diffs, descriptions, comments, linked tickets, agent output and report files. This page
lists what is enforced in code and what the operator still has to do.

## 1. Running the AI agent (`crv analyze`, `--analyze`)

The agent reads attacker-controllable text, so prompt injection must be assumed possible.

| Agent | Headless (`--headless` / default with `--analyze`) | Interactive (`--interactive`) |
| --- | --- | --- |
| `claude` | Allowed. Tool list is least-privilege: `Read, Glob, Grep`, `Bash(git show/grep/log/diff/cat-file:*)`, the skill's `scripts/*`, and `Write/Edit` only inside `.crv-skills/crv-code-review/<pr>/`. No general Bash, no network tools. | Agent prompts for each approval. |
| `agy`, `gemini`, `codex` | **Refused** unless `CRV_ALLOW_UNRESTRICTED_HEADLESS=1` (they cannot be tool-restricted from the CLI). | Agent prompts for approvals. |

Recommended hardening, in order of value:

1. Run reviews inside a disposable container / devcontainer / VM that holds **no credentials** other than a read-only
   GitHub token. A review needs the diff (already staged by `prepare_pr.mjs`), not your cloud or SSH keys.
2. Review in a separate checkout or `git worktree`, not the repo you develop in.
3. Never run `--headless` in CI on pull requests from forks with secrets available.
4. `--model` / `--effort` values are validated (`[A-Za-z0-9._:/\[\]-]`, no leading dash; effort is `low|medium|high|xhigh|max`).

## 2. Marker authenticity (`<!-- crv-finding -->`, `<!-- crv-meta -->`)

Anyone who can comment on a PR can type a marker. Markers are therefore honoured only when the comment author is in the
trusted list (deny-by-default):

* the authenticated `gh` user,
* `CRV_TRUSTED_REVIEWERS=alice,bob` (env) or `"trustedReviewers": [...]` in **`~/.config/crv/config.json`**
  (the checkout's own `.crvrc.json` is deliberately ignored: it belongs to the repo under review),
* `github-actions[bot]`.

Markers from other authors stay visible as plain comments and are listed in `untrustedMarkers`. Marker JSON is
whitelisted field-by-field (unknown keys such as injected `impact` HTML are dropped; ids/enums are validated). Markers
recorded against a different head commit get `stale: true`.

## 3. Rendering

* All HTML-bearing report fields pass through `packages/ui/sanitize.js` (allow-list) on load and at render time.
* The UI ships a CSP (`default-src 'none'; script-src 'self'`; hash-based for the standalone export) and Mermaid runs with
  `securityLevel: 'strict'` (no click callbacks / raw HTML labels).
* Report files are only parsed as JSON. No report content is ever executed (the old `vm.runInNewContext` HTML import
  was removed; legacy single-file HTML reports must be re-exported from `findings.json`).

## 4. Local server

* Binds `127.0.0.1` only; the `Host` header must be loopback (blocks DNS rebinding).
* Every `/api/*` route except `/api/health` needs the per-session token (`X-CRV-Token` header or `?token=` for SSE).
  The token is injected into the served `index.html`; it is not printed or stored.
* The extension can fetch the token from `GET /api/session` **only** if its id is pinned:
  `CRV_EXTENSION_IDS=<extension id>[,<id>]`. Without it the extension still works from page scraping, and the
  "Open full workbench" tab (served by the server) is the authoritative path.
* `POST /api/github/submit-review` only targets the repo/PR of the loaded report, whitelists the review event
  (`COMMENT`, `REQUEST_CHANGES`; `APPROVE` needs `--allow-approve`), re-builds the payload from known fields only, and on
  a 422 (comment outside the diff) retries with the inline comments folded into the review body.
* The "last submitted review" dry-run file lives in a private `mkdtemp` directory (`0700`, file `0600`).

## 5. Open question: does GitHub render `<!-- ... -->` markers into `.comment-body`?  (UNVERIFIED)

The extension content script scans `.comment-body` `innerHTML` and `textarea[name="comment[body]"]`. We believe, but have
not verified, that GitHub's markdown pipeline **removes HTML comments from rendered output**, in which case:

* rendered `.comment-body` nodes never contain markers, and
* the `textarea` path only exists for comments the signed-in user can edit, i.e. **their own**.

If true, scraping can only ever discover the viewer's own markers and the "multi-reviewer" claim does not hold for the
extension. The code now treats scraped markers as trusted only when authored by the signed-in user (which is also what
makes the scraping path safe), and the workbench prefers the local server's `gh api` data when it holds the same PR.

Test plan to settle it (needs a real GitHub PR, ~10 minutes):

1. Post `<!-- crv-finding: {"id":"T1","action":"comment"} -->` as user A on a PR; view as user B (different browser profile).
2. In B's devtools: `[...document.querySelectorAll('.comment-body')].some(e => e.innerHTML.includes('crv-finding'))`.
3. In A's session, check whether the edit `textarea` contains the marker and whether any other user's comment has a `textarea`.
4. Record the result here; if rendered output strips markers, replace scraping with a `gh api`/GraphQL fetch through the
   local server (already the preferred path) and drop the content-script marker scan.
