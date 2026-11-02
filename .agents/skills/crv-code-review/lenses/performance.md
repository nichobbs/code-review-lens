# Performance lens

Checks loops, queries, network calls and hot paths, only where the diff changes them. Runs when the judge's performance triggers match.

## Looks for

- Work inside loops: a query, network call, file read or `await` for each item where one batched call would do.
- Unbounded growth: a list, cache, queue or `Promise.all` over input with no maximum size.
- Large reads: a whole table, collection or file when a filter or a page would do, or a removed limit or page size.
- Hot paths: new work on a path that runs for every request, such as creating a client or reading configuration on each call.
- Timeouts: a call with no timeout, or a timeout longer than the caller's own budget.

## Never reports

- Small optimisations with no measurable cost at the expected data size.
- Code the diff does not change.

## Severity

- `high` when the change makes a request path time out, or runs out of memory, at today's data size, and `Breaks` names the size.
- `medium` for a cost that grows with data and reaches a limit within the expected growth.
- `low` for a cost that is real but small.

## Evidence

- Name the loop or call as `path:line`, and the size of the input it runs over, or say that the size is unknown.
