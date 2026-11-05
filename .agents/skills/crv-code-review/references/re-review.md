# Re-review

Checks an earlier review against the code after the author pushed changes. The job is to give each earlier finding a state. A re-review is not a new review from scratch.

Run it when the reviewer names an earlier report, asks to re-review a PR that has one in the scratch folder, or when `<scratch>/github-threads.json` contains prior `<!-- crv-finding -->` threads on the PR.

## 1. Recover the earlier findings & GitHub triage state

1. **From the previous HTML/JSON report** (when available):
   ```bash
   python3 <skill>/scripts/extract_findings.py <previous-report.html> <scratch>/previous-findings.json
   ```
   Both `build_report.py` and `crv export-html` embed `<script type="application/json" id="crv-findings">`, so `extract_findings.py` recovers the exact `findings.json` losslessly.
2. **From GitHub PR comments (`<scratch>/github-threads.json`)**:
   `scripts/prepare_pr.mjs` automatically hydrates all `<!-- crv-meta -->` and `<!-- crv-finding -->` comments from the PR into `<scratch>/github-threads.json`:
   - `findingThreads[id].action`: shows whether the human reviewer triaged the finding as `block`, `comment`, or `dismiss`.
   - `findingThreads[id].note`: the human reviewer's custom note posted to GitHub.
   - `findingThreads[id].replies`: replies posted directly on the GitHub review thread by the PR author or teammates (`author`, `body`, `createdAt`, `url`).
   No manual copy-pasting from browser `localStorage` is needed when comments were published via the Workbench.

## 2. Find the range

- `<reviewed>` is `meta.headCommit` in the earlier findings, `meta.revision.headCommit` for a later revision, or `overviewMeta.head` from `github-threads.json`. When none exists, take the last commit before the report file's time, and say in the summary that you inferred it.
- `<head>` is the PR's current head commit.
- Read what changed: `git log --format='%h %s' <reviewed>..<head>` and `git diff -M <reviewed> <head>`. `-M` shows renames as renames.

## 3. Give each earlier finding a state

Read the code at `<head>`, plus any author replies in `<scratch>/github-threads.json`, and set `status.state` with a `path:line` in `status.evidence`:

- `fixed`: this PR's own commits remove the failure.
- `external`: the failure is gone, but the change came from the base branch. Check with `git diff --name-only <base>...<head>`. When the file that removed the failure is not in that list, the state is `external`.
- `partial`: some of the failure remains. `status.note` says which part.
- `rebutted`: the author argued against the finding (in a GitHub thread reply or review comment), and the argument does not hold. Quote the author in `status.dev`, with `who`, `when` and `where`, and say where the argument fails in `status.dev.verdict`.
- `dropped`: either a human reviewer dismissed the finding (`action: "dismiss"`) or the author's argument holds. Say why in `status.dev.verdict`, so nobody raises it again.
- `open`: nothing changed.

## 4. Review only what is new

Run the judge (`SKILL.md` step 4), the picked lenses (step 5) and triage (step 6) on `git diff <reviewed> <head>` only. A finding in that range gets `isNew: true` and an id in its own series: `R1`, `R2`. Add no new `nit` findings, because a re-review should not grow the list with small points.

## 5. Carry the findings over

- Keep each earlier finding's `id`, `sev`, `verify`, `earlier`, `title`, `impact` and `fix`. The author works from that list. Change a severity only on new evidence, and say why in `status.note`.
- Never delete an earlier finding. A closed finding stays in the Resolved group as the record.
- Set `meta.revision`: `reviewedAt`, `reviewedCommit` (`<reviewed>`), `headCommit` (`<head>`), `commits` (one line each), and `summary`. The summary leads with the counts per state, then what the author changed, then what still blocks.
- Add `-r<N>` to `meta.storageKey`. The builder sets the result from the highs that are still open.

## 6. Build the revision

```bash
crv export-html <scratch>/findings.json --diff <scratch>/diff.patch --out .crv-skills/crv-code-review/pr<N>-workbench-r<N>.html
```

Or with the classic flight-strip builder:

```bash
python3 <skill>/scripts/build_report.py <scratch>/findings.json --revise <previous-report.html>
```
