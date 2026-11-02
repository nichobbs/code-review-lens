# Adversarial lens

Tries to break the change with hostile timing, repeated delivery and failure partway through. Runs on every review.

## Looks for

- Races: two requests or two workers that change the same state at the same time. A check followed by a write with no lock or condition (time of check to time of use).
- Duplicate delivery: a message, webhook or request handled twice. Look for an idempotency key or a conditional write, committed in the same transaction as the state change. Check what happens when the same key arrives with a different payload.
- Lost messages: a message handler that catches an error and returns normally. The message is acked, so it is lost with no retry and no dead-letter.
- Retries: a retry with no limit, no backoff or no timeout. A retry around a call that is not safe to repeat.
- Partial failure: a step that fails after an earlier step already changed state, with nothing that undoes or resumes the work. A remote write that succeeds when its response is lost, so the caller retries a write that already happened.
- Resources: a connection, file handle, timer, listener, stream or background task with no owner, no way to cancel it, or no cleanup on every error path. Exceptions: a client created once for the life of the process, such as a module-level Firestore or Pub/Sub client, a resource returned to the caller, and a short script.
- Abuse: a feature used in a way the author did not expect, such as a negative quantity, a replayed token, the id of someone else's record, or a very large page size.
- STRIDE, as questions for each changed entry point: can a caller pretend to be someone else, change data in transit, deny they acted, read data they should not, exhaust the service with a realistic request, or gain rights they should not have.

## Never reports

- A race with no realistic interleaving in this system. Name the two actors and the timing, or drop it.
- Injection, authentication and secrets. The security lens owns them.

## Severity

- `high` when a realistic sequence loses or duplicates data, charges twice, or leaves state inconsistent, and `Breaks` names the sequence.
- `medium` when the sequence needs unusual timing, or a retry or re-run repairs the damage.
- `low` for a resource leak that no load reaches today.

## Evidence

- Write the sequence as numbered steps with both actors, each step with `path:line`.
- For duplicate delivery, name what redelivers: a queue, a webhook provider, a client retry.
