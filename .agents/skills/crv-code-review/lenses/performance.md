# Performance lens

Checks loops, queries, network calls and hot paths, only where the diff changes them. Runs when the judge's performance triggers match. Ground every check in the **expected load** established in Step 2 (for example, single-user CLI/script vs. multi-user request path).

## Looks for

- Work inside loops: a query, network call, file read or `await` for each item where one batched call would do at the expected load.
- Unbounded growth: a list, cache, queue or `Promise.all` over input with no maximum size.
- Large reads: a whole table, collection or file when a filter or a page would do, or a removed limit or page size.
- Hot paths: new work on a path that runs for every request, such as creating a client or reading configuration on each call.
- Timeouts: a call with no timeout, or a timeout longer than the caller's own budget.

## Never reports

- Small optimisations with no measurable cost at the expected data size or operating load (such as in-memory iteration over a bounded config list or single-user CLI arguments).
- A scale limit already documented with a bounded `// shortcut: <ceiling>, <upgrade>` comment when today's data size and expected load stay below `<ceiling>`.
- Code the diff does not change.

## Severity

- `high` when the change makes a request path time out, or runs out of memory, at today's data size, and `Breaks` names the size.
- `medium` for a cost that grows with data and reaches a limit within the expected growth.
- `low` for a cost that is real but small.

## Evidence

- Name the loop or call as `path:line`, and the size of the input it runs over, or say that the size is unknown.
