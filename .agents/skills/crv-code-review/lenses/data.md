# Data lens

Checks changes to stored data and to code that writes it: schemas, migrations, backfills, persistence models, and handlers that write for each message. Runs when the judge's data triggers match.

## Looks for

- Old data: records written before this change that the new code reads. A new required field with no default for them.
- Idempotency: a migration, backfill or message handler that must be safe to run twice, and is not.
- Ordering: messages or writes that can arrive out of order, and code that assumes they cannot.
- Rollback: whether the previous version of the code can still read the data after the change.
- Locks and duration: a migration that locks a large table, or runs for a long time during a deploy.
- Transactions: several writes that must succeed together and are not in one transaction or batch.

## Never reports

- Changes that touch no stored data and no code that writes it.
- Query performance. The performance lens owns it.

## Severity

- `high` when realistic traffic or a re-run loses, duplicates or corrupts stored data, and `Breaks` names the sequence.
- `medium` when rollback or old data breaks only in an unusual case, or the damage can be repaired.
- `low` for a missing guard that no data reaches today.

## Evidence

- Name the store, the collection or table, and the field.
- For ordering and idempotency, write the sequence of events with `path:line` for each write.
