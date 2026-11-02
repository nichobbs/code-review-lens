# Correctness lens

Checks that the changed code does what the change says it does. Runs on every review.

## Looks for

- Logic: a wrong condition, steps in the wrong order, an off-by-one, the wrong variable.
- Edge cases: empty input, null or undefined, zero, very large values, missing keys, an empty list. A truthiness check (`!val`) where `0`, `""` or `false` is a valid value.
- Error handling: an error that is swallowed, retried with no limit, or returned with the wrong status. A `catch` that returns a default value or success, even when it logs. Exceptions: a comment that documents a not-found contract, or a named helper whose job is to ignore the error.
- Sibling parity: a new branch, handler or endpoint next to an existing sibling. Check that it runs the same validation, authorisation and guards as the sibling.
- Removed guards: a guard, retry, timeout or workaround that the diff deletes and does not move. Check what the callers still rely on.
- Promises: a promise that is not awaited, returned or caught, so its error is lost and the handler can finish before the work does.
- Callers: grep for the callers of each changed function, and check that each still gets what it expects.
- Intent: the PR description or linked ticket says what should change. A change that does something else, or only part of it, is a finding. So is a write, network call or configuration change in a change described as a refactor or as read-only. Exceptions: logging, metrics, cache invalidation, and effects that the feature clearly needs.
- A value kept in two places where the diff changes one copy and leaves the other. The structure lens hands this case to this lens.

## Never reports

- Naming, style or structure. Other lenses own those.
- A guess about intent when there is no description or ticket to compare against.

## Severity

- `high` when a realistic input produces a wrong result, a crash or lost data, and `Breaks` names that input.
- `medium` when the wrong result needs an unusual input, or the effect is contained.
- `low` for a defensive gap that no input reaches today.

## Evidence

- Trace the path from the input to the wrong result, and cite each step as `path:line`.
- For a caller finding, name the caller as `path:line`.
