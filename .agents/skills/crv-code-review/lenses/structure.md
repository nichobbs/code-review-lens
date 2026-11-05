# Structure lens

Checks how the change is built: reuse, design patterns, one source of truth for shared values, and code smells. Runs on code changes. Advisory: never above `low`.

Read `references/patterns.md` before this lens runs. Find callers and copies with grep, never with a language server. Use these words exactly: module, interface, seam, adapter, and the pattern names in `references/patterns.md`.

## Looks for

Run the four checks in this order.

1. **Reuse before new.** Inspect `attentionSignals.reuseCandidates` and `attentionSignals.addedSymbols` in `<scratch>/layers.json` first. For each client, helper, error type, interceptor or config loader the diff adds, grep the repository for one that already does the job (or check whether the diff defines the same helper in two files). If one exists, the finding is to use it, with its path. When a repository standard already covers reuse, leave it to the standards lens.
2. **Pattern fit.** Match the diff against the shapes in `references/patterns.md`. Recommend a pattern only when the shape is in the diff, and one of these holds: the repository already uses that pattern for a sibling case, which you name as the precedent; the shape occurs three or more times; or two copies already change together by hand, which you show from `git log`. Apply the deletion test: a module whose removal would only move its calls into its callers adds nothing. A new seam needs two adapters, and a test fake counts as one.
3. **One source of truth.** For each literal the diff adds or changes (an environment variable name, a topic or subscription name, a bucket or collection name, a URL, a timeout, a flag key, an enum value, a schema field), grep the repository for the same literal. Report when another copy exists and both copies must agree for the system to work: a second copy of a value the repository defines once, or a hard-coded value the repository loads from config. When the diff changes one copy and leaves another, hand the finding to the correctness lens. When a repository standard says where configuration lives, leave the finding to the standards lens.
4. **Smells.** Report the smells that `references/patterns.md` lists as visible in a diff hunk, when the trigger matches and no exception applies. Report the others only after reading the files around the change, and say in `reasoning` that you did. Prefix every smell with "possible".

## Never reports

- A pattern because it is good practice in general. No shape in the diff, or no precedent and no repetition, means no finding.
- A literal that appears twice for different reasons, such as the same text as a log message and as a topic name.
- Anything a repository standard endorses. The standard wins.
- Structure the diff does not add or make worse.
- Interface shape, which module owns a fact, and seams across modules. The architecture lens owns them; hand a copied value whose owner is another module to it.

## Severity

- Low at most, because a structure finding fails nothing today. It makes a later change harder.
- `low`: a second copy of a shared value, an existing equivalent the diff duplicates, or business logic inside a handler where the repository keeps it behind a port elsewhere.
- `low`: a pattern recommendation with a named precedent, or a smell with a concrete cost.
- When a repository standard states the rule, the standards lens reports the breach as `medium`.
- `nit`: a smell that only affects reading.

## Evidence

- `loc` is the line in the diff.
- Reuse and pattern findings name the precedent as `path:line`.
- One-source-of-truth findings name every copy as `path:line`, and say what breaks when the copies differ.
