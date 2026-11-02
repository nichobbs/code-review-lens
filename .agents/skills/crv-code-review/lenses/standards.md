# Standards lens

Checks the changed lines against the repository's documented standards, as found by the standards scan. Runs when at least one standard from the scan covers a changed file.

## Looks for

- A changed line that breaks a rule in a standard whose scope covers its file.
- When two standards disagree, the one nearer to the changed file wins.
- When a standard points to another document whose rules apply to the changed code, read that document and apply it too.
- A changed standard or instruction file, such as `AGENTS.md`, `CLAUDE.md` or `.github/instructions/*.md`, that weakens an existing rule without saying why.
- A new rule too vague to check, such as "write clean code", with no scope, invariant or fix. A rule that applies to every file, such as "flag secrets in any file", is fine.

## Never reports

- A rule the diff cannot show evidence for, such as the commit message format or which commands to run.
- A breach of an existing rule too vague to check, such as "write clean code" or "keep functions small".
- Code the diff does not add or change.
- A preference that no standard states. Other lenses own those.

## Severity

- A rule breach is `medium`. A breach of a naming, formatting or style rule is `low`.
- Never above `medium`. When the breach also breaks behaviour, the correctness lens reports that as its own finding.

## Evidence

- Quote the rule exactly, with its file and line.
- Set `guide` to the rule id and the file name, or to the file name when the rule has no id.
- `loc` is the changed line that breaks the rule.
