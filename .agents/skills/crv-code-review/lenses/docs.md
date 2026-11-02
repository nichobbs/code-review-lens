# Docs lens

Checks that documentation describing the changed code still matches it. Runs when the diff changes docs, or changes code that a doc describes.

## Looks for

- A README, API specification, design document or runbook that describes the changed behaviour and is now wrong. Find them by grepping the docs for the changed function, endpoint, field, flag or configuration key.
- A new endpoint, event, configuration key or flag with no documentation, where the repository documents its siblings.
- A changed doc that now disagrees with the code.
- Examples in docs that no longer work: a command, a request body, a configuration snippet.
- Links and paths in a changed doc that point to files that do not exist.

## Never reports

- Prose style, grammar or tone in docs.
- Docs for code the diff does not change.

## Severity

- `medium` when a doc tells a reader to do something that now fails, or describes behaviour that changed.
- `low` for a missing doc on a new item whose siblings are documented, or a broken link.
- `nit` for an outdated example that still works.

## Evidence

- Name the doc as `path:line`, and the code it disagrees with as `path:line`.
