# Contract lens

Checks changes to anything other code depends on: exported functions and types, HTTP APIs, events, message payloads, schemas and configuration keys. Runs when the judge's contract triggers match.

## Looks for

- A removed or renamed field, a changed type, a new required field, or a changed meaning in a payload, schema or response.
- A changed signature, return type or thrown error on an exported function or type.
- Consumers: grep the repository for every consumer of the changed contract, and check each one the diff does not update.
- Versioning: a breaking change with no new version, no deprecation path, or no mention in the PR.
- Separate deploys: a consumer deployed on its own schedule must handle both the old and the new shape during a rollout.
- Defaults: a new optional field whose absence changes behaviour for old producers.
- Generated files: a hand edit to a generated file, which has a "do not edit" header or sits in a generated path, in a diff that does not change its generator or schema. The next generation run undoes the edit.

## Never reports

- Internal functions with no consumer outside their module.
- Additive changes that old consumers ignore safely.

## Severity

- `high` when a consumer in this repository breaks and the diff does not update it, or a payload change reaches a consumer deployed on its own schedule.
- `medium` for a breaking change that the PR handles inside this repository, when a consumer the review cannot see may still break: the PR does not state the change, or gives no deprecation path.
- `low` for an additive change with no documentation of the new field.

## Evidence

- Name each affected consumer as `path:line`.
- Show the old and the new shape of the changed field.
