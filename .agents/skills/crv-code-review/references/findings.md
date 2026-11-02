# Findings

Every lens writes findings in one shape. After the last lens, the review triages them, writes one `findings.json`, and builds one report from it.

## Finding shape

| Field | Content |
| --- | --- |
| `id` | Severity letter and number, given after triage: `H1`, `M1`, `L1`, `N1` |
| `sev` | `high`, `medium`, `low` or `nit`; `struct` for a design candidate |
| `verify` | `high` and `medium` only, set in triage: `CONFIRMED` or `PLAUSIBLE` |
| `cat` | The lens that raised it, or two lenses joined by `, ` |
| `loc` | `path:line` at the head commit |
| `title` | The outcome as a fact, under 90 characters |
| `impact` | Three paragraphs: `**Breaks:**`, `**Because:**`, `**Reach:**` |
| `fix` | Two paragraphs: `**Do:**`, `**Check:**` |
| `reasoning` | Optional. The evidence, the code read, the alternatives. Collapsed in the report |
| `earlier` | Optional. One object per earlier review thread or PR comment that raised the same point: `who` (the author login GitHub shows, such as `Copilot`), `loc` (the thread's `path:line`, or empty for a PR comment) and `url` (its `html_url`). The report marks the finding "Also raised by" that reviewer |
| `guide` | Standards findings only. The rule id and the file |
| `mermaid` | Optional flowchart source, four or five nodes, for a high finding; a Before and After flowchart for a design candidate |
| `strength` | Design candidates only: `Strong`, `Worth exploring` or `Speculative` |
| `scope` | Design candidates only: `This PR`, `Separate ticket`, `Follow-up` or `Optional` |
| `deps` | Design candidates only: `in-process`, `local-substitutable`, `remote-owned` or `external` |

The five labels:

- **Breaks:** what fails, and for whom. One or two sentences.
- **Because:** the mechanism, with `path:line`.
- **Reach:** when it applies, and where it stops applying.
- **Do:** one action.
- **Check:** how the author knows it worked, such as a test that fails before the fix and passes after.

## Severity

Severity states what happens if the pull request merges as it is and the finding is true. Every level uses this one measure. Two other facts sit beside the severity and never change it:

- the cost of the fix, which goes in `Do`
- the verifier result, which goes in `verify`

### `high`: merging causes a failure in normal use

A finding is `high` when merging causes at least one of these, on an input or sequence that happens in normal use:

- a supported input gets a wrong result, a crash or a timeout, where `<base>` handled it
- stored data is lost, duplicated or corrupted
- a caller reads or changes data, or runs an action, that they are not allowed to
- a secret or personal data is exposed in a response, a log, an error message, a URL or the repository
- the build, the deploy or the test suite breaks
- a consumer outside the diff breaks, such as another service, another team's code, or a client that deploys on its own schedule

The test: `Breaks` names the input or sequence, and who sees the failure.

### `medium`: a failure is possible, or would go unseen

A finding is `medium` when it fails the `high` test and at least one of these holds:

- the failure needs an unusual input or unusual timing
- a retry, a re-run or a rollback repairs the damage, and no data is lost
- nobody would detect the failure: changed behaviour with no test, a test that cannot fail, or a new error path with no log, metric or alert on a customer-facing or money-handling flow
- the change breaks a rule in the repository's documented standards, other than a naming, formatting or style rule

The test: `Breaks` names how the change fails, or how the failure goes unseen.

### `low`: nothing fails today, and a named gap makes a later change or a diagnosis harder

Examples: a guard that no input reaches today, a missing unhappy-path test, an error log with no request id, a breach of a naming, formatting or style rule, and a missing doc on a new item whose siblings have one.

The test: `Breaks` names the later change, or the diagnosis, that the gap makes harder.

### `nit`: the finding affects reading only

A `nit` has no effect on behaviour, tests, operations or a documented rule. It is never a change request.

### What the author does

| Level | The author | Blocker |
| --- | --- | --- |
| `high` | fixes it before merge | yes, unless `verify` is `PLAUSIBLE` |
| `medium` | fixes it before merge, or replies with a reason | no |
| `low` | fixes it now, or raises a follow-up | no |
| `nit` | may ignore it | no |

### Highest severity per lens

A lens never reports above its maximum. When a lens finds a failure above its maximum, the lens that owns that failure reports it. For example, the standards lens leaves broken behaviour to the correctness lens.

| Lens | Highest severity |
| --- | --- |
| `correctness` | `high` |
| `adversarial` | `high` |
| `security` | `high` |
| `data` | `high` |
| `contract` | `high` |
| `infra` | `high` |
| `performance` | `high` |
| `tests` | `high` for a committed `.only`, otherwise `medium` |
| `standards` | `medium` |
| `operability` | `medium` |
| `docs` | `medium` |
| `structure` | `low` |
| `architecture` | `struct` |

### Severity rules

- How sure a lens sounds never changes a severity.
- When two lenses report the same defect, the merged finding takes the higher severity.
- `struct` marks a design candidate. It is not a level on this scale.

## Design candidates

The architecture lens writes design candidates. Each has `sev` `struct`, an id `D1`, `D2` in strength order, and the `strength`, `scope` and `deps` fields. They describe the cost of the next change, so they sit in their own Design group, ordered by strength, and never count as blockers. `references/deepening.md` defines the fields.

## Outside this change

A verified defect that the diff does not touch is never a finding. When a lens finds one while reading, record it in `meta.outside`, an array of objects with `loc` (`path:line`), `text` (what is wrong, in one or two sentences) and `ticket` (the suggested next step, such as "Raise a ticket now"). The Overview lists them under Outside this change.

Set `sev` to `high` on an outside item when it passes the `high` test in production today, for example when it exposes a secret or personal data, or loses or corrupts data. The Overview shows a `high` item in a warning block at its top, and the coverage note names it. Leave `sev` out for every other outside item. An outside item never counts as a blocker, because the result follows only what the diff adds.

## Never report

- Approvals, CODEOWNERS, required reviewers, labels, the PR title, unresolved threads. The PR page shows them and the merge gate enforces them.
- Anything a linter, formatter, type checker or CI already enforces.
- Issues in code the diff does not add or change.
- A claim you cannot point at with `path:line` at the head commit.

## Triage

After the last lens, in this order:

1. **Merge duplicates.** Two findings with the same location and the same mechanism become one finding, and `cat` names both lenses. The merged finding takes the higher of the two severities, and keeps the `earlier` entries of both. Two different defects on one line stay two findings.
2. **Verify each finding.** Run `references/verifier.md` once, on every `high` and `medium` together. The verifier works in a fresh context and tries to disprove each finding. It looks for a path where the claim fails: a guard further up, a caller that never passes the bad value, a schema or type check, or a test that covers the case. It returns one of three results, and triage applies it:
   - `CONFIRMED`: the trigger is in the diff, no exception applies, and a concrete input or sequence reaches the failure. Keep the severity, and set `verify` to `CONFIRMED`.
   - `PLAUSIBLE`: the trigger is in the diff, but the failure depends on a caller, configuration or input you could not verify. Keep the severity, and set `verify` to `PLAUSIBLE`. Say what you could not verify in `Reach`. A `PLAUSIBLE` finding never counts as a blocker. The report shows it as Unverified, and the coverage note names it, so a person decides.
   - `REFUTED`: a quoted `path:line` shows the claim is wrong, a guard or caller already handles the case, the diff already fixes it, or the point is style only. Drop the finding, and record a dropped `high` in the coverage note. A finding you can neither confirm nor refute is `PLAUSIBLE`.
3. **Check severity and evidence.** Set severity with the tests in Severity above. The cost of the fix and how sure the lens sounds never change it. Every `high` and `medium` names a concrete input or sequence in `Breaks`, cites a `path:line` in the diff or reached from it in `Because`, and states one action in `Do`. Drop a finding that rests on a function or variable name alone. Drop a finding that a linter, formatter, type checker or CI job in the repository already enforces.
4. **Assign ids** by severity, ordered by impact within each band. Keep at most five `nit` findings. Drop the rest, and give their number in the coverage note.

## Writing rules

These rules come from the `no-ai-slop` skill by Peter Yang (MIT licence, notice below). Check every finding against them before writing `findings.json`.

1. Active voice. Name the actor: "the handler drops the event", never "the event is dropped".
2. Concrete over abstract: `path:line`, numbers, names, the mechanism. A sentence that could move to another PR unchanged is filler. Cut it.
3. One word per concept, within a finding and across the report.
4. No contrast setups ("not X, but Y"), no colon reveals, no throat-clearing openers, no claims that something is important, no asides that tell the reader what matters, no summary endings.
5. No unnamed authority, such as "best practice says" or "experts agree". Name the standard, the doc or the line, or cut the claim.
6. None of the words in the list below.
7. Em dashes only where they read better than a comma or a full stop.
8. Bold only for the five labels.

```text
delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge,
paradigm shift, game changer, tapestry, realm, beacon, multifaceted, meticulous, intricate,
paramount, transformative, elevate, embark, supercharge, harness, ever-evolving
```

## The report file

`findings.json` holds `meta` and `issues`. `meta.summary` holds what the PR does and the coverage note described in `SKILL.md`. `meta.summaryPoints` holds one line per lens: ran with a finding count, skipped, or dropped, with the reason.

`meta.review` records what produced the review, so a rating can be traced to the exact lens text. It holds `repo` (`owner/name`), `pr`, `base` and `head` (the commit SHAs from `baseRefOid` and `headRefOid`), `agent` and `model` (as the agent reports them) and `lenses` (the lenses that ran). The builder adds `lensHash`, a SHA-256 of the lens and reference files.

## The result

The review never approves a pull request. A person approves and merges it. `build_report.py` computes the result from the findings in `findings.json`, so no text an agent writes decides it.

A finding is open when it has no `status`, or its `status.state` is `partial`, `rebutted` or `open`. A blocker is an open `high` finding whose `verify` is not `PLAUSIBLE`. The result is:

- `Blockers found` when there is one or more blocker
- `No blockers` when there is no blocker and one or more open finding
- `No findings` when there is no open finding

Do not write `meta.verdict` or `meta.verdictTone`. The builder ignores them.

```json
{
  "meta": {
    "title": "PR #123: Retry payment webhook",
    "subtitle": "8 files, +210 -40",
    "prUrl": "https://github.com/acme/example-repo/pull/123",
    "headCommit": "0123456789abcdef0123456789abcdef01234567",
    "storageKey": "example-repo-pr123",
    "review": {"repo": "acme/example-repo", "pr": 123, "base": "fedcba9876543210fedcba9876543210fedcba98", "head": "0123456789abcdef0123456789abcdef01234567", "agent": "Claude Code", "model": "example-model", "lenses": ["correctness", "adversarial", "architecture"]},
    "summary": "**What it does.** Adds a retry to the payment webhook handler.\n\n**Coverage.** Five lenses ran in sequence in one agent. Each high was checked by the agent that raised it. Nobody checked the payment provider's retry schedule.",
    "summaryPoints": [
      "correctness: ran, no findings",
      "adversarial: ran, 1 finding",
      "architecture: ran, 1 candidate",
      "docs: skipped, no doc describes the changed code"
    ],
    "outside": [
      {"loc": "src/refunds/handler.ts:88", "sev": "high", "text": "The refund handler has the same write-before-record order, so a retried refund pays out twice.", "ticket": "Raise a ticket now"}
    ]
  },
  "issues": [
    {
      "id": "H1",
      "sev": "high",
      "cat": "adversarial",
      "verify": "CONFIRMED",
      "earlier": [{"who": "Copilot", "loc": "src/webhook/handler.ts:42", "url": "https://github.com/acme/example-repo/pull/123#discussion_r1"}],
      "loc": "src/webhook/handler.ts:42",
      "title": "A retried webhook credits the account twice",
      "impact": "**Breaks:** A payment provider retry credits the member's account a second time.\n\n**Because:** `handler.ts:42` writes the credit before it records the event id, so a retry after a timeout finds no record and writes again.\n\n**Reach:** Every retry that arrives after the credit is written and before the event id is stored.",
      "fix": "**Do:** Record the event id and write the credit in one transaction, and skip the credit when the id already exists.\n\n**Check:** A test that delivers the same event twice ends with one credit.",
      "reasoning": "The handler acknowledges the webhook only after both writes, so the provider retries on any timeout between them."
    },
    {
      "id": "D1",
      "sev": "struct",
      "cat": "architecture",
      "loc": "src/webhook/handler.ts:12",
      "title": "The payment module records processed events itself",
      "strength": "Strong",
      "scope": "Follow-up",
      "deps": "local-substitutable",
      "impact": "**Breaks:** Each new webhook handler must remember to record its event id, and two handlers already forget.\n\n**Because:** `handler.ts:12` and `refunds/handler.ts:20` each call the event store directly.\n\n**Reach:** Every handler added to the payment module.",
      "fix": "**Do:** Move the record-and-skip step into the payment module, so handlers receive only new events.\n\n**Check:** A test that sends one event twice through the module sees one handler call.",
      "reasoning": "`git log` shows 3 of the 5 branch commits fix duplicate handling in a handler.",
      "mermaid": "flowchart LR\n  subgraph Before\n    W[webhook] --> H[handler]\n    H --> S[event store]\n  end\n  subgraph After\n    W2[webhook] --> P[payment module]\n    P --> S2[event store]\n    P --> H2[handler]\n  end\n  Before ~~~ After"
    }
  ]
}
```

Build it with:

```bash
/usr/bin/python3 <skill>/scripts/build_report.py findings.json pr123-review.html
```

A bare file name goes to `.crv-skills/crv-code-review/` under the current working directory, and the builder creates `.crv-skills/.gitignore` with `*` when it does not exist. A path with a folder is used as given. The builder prints `SHAPE:` warnings when a finding is missing one of the five labels, or when an open `high` or `medium` finding with no `status` has no `verify`.

## Licence notice

The writing rules above are adapted from the `no-ai-slop` skill.

```text
MIT License

Copyright (c) 2026 Peter Yang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
