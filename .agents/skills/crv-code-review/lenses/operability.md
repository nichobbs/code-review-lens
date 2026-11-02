# Operability lens

Checks that the change can be seen, controlled and undone in production. Runs when the judge's operability triggers match.

## Looks for

- Silent failure: a new error path with no log, metric or alert, so a failure in production goes unseen.
- Logs: a level that hides an error (debug for a failure) or floods the log (info inside a loop).
- Signals: a new job, queue, subscription or integration with no metric or alert for its failure. A metric label with unbounded values, such as user ids, request paths or raw error text. A metric name with no unit.
- Feature flags: a change in behaviour with no flag where the repository flags similar changes. A flag read with no safe default in code for when the flag service fails. A diff that deletes a flag and turns its path on for everyone in the same change.
- Rollback: a change that cannot be turned off or reverted without a data fix.
- Context: an error logged without the identifiers needed to act on it, such as the request or message id.

## Never reports

- A log on every line. Report only failure paths that would be silent.
- Dashboards and alert thresholds the repository does not keep in code.
- A secret or personal data in a log. The security lens owns both.

## Severity

- Never above `medium`.
- `medium` for a silent failure path on a customer-facing or money-handling flow.
- `low` for missing context in an error log, or a missing metric on an internal path.

## Evidence

- Name the failure path as `path:line`, and say what an operator would see today when it fails.
