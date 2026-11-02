# Architecture lens

Looks for deepening opportunities: places where a module's interface makes its callers carry knowledge the module should hold. Runs when the judge's architecture rule matches. Advisory: every finding is a design candidate and never counts as a blocker.

Read `references/deepening.md` before this lens runs. Use its words exactly: module, interface, depth, seam, adapter, locality.

## Looks for

Start from the history, then read the modules the diff touches in full, then run the checks.

1. **History.** Run `git log --oneline <base>..<head>` and `git log --stat <base>..<head>`. Count the fix commits and the files they touch. A file that most fix commits touch marks a rule split across modules. Run `git log --oneline -15 -- <file>` for each module the diff changes, to see its churn on the default branch.
2. **Two ways in.** Two entry points to one behaviour, such as a method and an exported function, or two methods that act on the same data. Raw values a caller passes that the module could derive itself, so a caller can pass the wrong one.
3. **Rules in comments.** A doc comment or README line that tells callers what not to combine or what to call first. The interface allows the wrong use, so every caller enforces the rule by hand.
4. **Facts in the wrong module.** A wiring file, such as a stack definition, a composition root or a config map, that restates facts another module owns: constants that copy a module's defaults, overrides keyed by another module's fields, or one call per module that each new module must remember. The fact belongs with the module that sets it.
5. **Seams.** Apply the deletion test to each new interface, wrapper or registry. A seam with one adapter is hypothetical, and a test fake counts as the second adapter. A shared package that holds the config of one resource type has a seam in the wrong place.
6. **Test surface.** Tests that cross a fake or a free helper instead of the interface callers use. The interface is the test surface.

## Never reports

- A refactor with no friction in the diff, its history or its callers. Name the friction or drop the candidate.
- Anything an ADR or a repository standard decided, unless the friction is real. Then name the ADR.
- Naming, style and smells. The structure lens owns them.

## Severity

- Every candidate has `sev` set to `struct` and lands in the Design group. It never counts as a blocker.
- `strength`: `Strong` when the friction shows in the diff or its history and the change removes it. `Worth exploring` when the gain depends on another change. `Speculative` when it rests on one example.
- `scope`: `This PR` only when the change stays inside what the PR already touches. Otherwise `Separate ticket`, `Follow-up` or `Optional`.
- A verified defect outside the diff is never a candidate. Record it in `meta.outside` with its `path:line` and a suggested ticket.

## Evidence

- `loc` is the main file of the candidate, as `path:line`.
- `impact` uses the five labels: Breaks is the friction, Because is the mechanism, Reach is who meets it.
- `fix`: Do says what moves where; Check names the test that proves it through the interface.
- `reasoning` lists every file involved, with `path:line`, and the history evidence.
- `mermaid` holds a before and after flowchart, as in `references/deepening.md`.
