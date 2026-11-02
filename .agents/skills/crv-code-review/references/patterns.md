# Patterns and smells

The structure lens reads this file. Pattern names follow the refactoring.guru catalogue (https://refactoring.guru/design-patterns). Smell names follow Fowler, *Refactoring*, second edition, grouped as refactoring.guru groups them (https://refactoring.guru/refactoring/smells).

## Shapes and the patterns that fit them

Recommend a pattern only when its shape is in the diff, and one of these holds: the repository already uses the pattern for a sibling case, the shape occurs three or more times, or two copies already change together by hand. Two similar call sites alone are not enough.

| Shape in the diff | Pattern | Group |
| --- | --- | --- |
| `if (kind === ...) new A() else new B()` in three or more places | Factory Method | Creational |
| A family of related clients or configs per provider or partner | Abstract Factory | Creational |
| A constructor or function with many optional parameters, or an object assembled over many steps | Builder, or an options object with defaults | Creational |
| Module-level state that must be the only instance | Singleton, usually reported as a misuse | Creational |
| Code that wraps a third-party interface to fit the application | Adapter | Structural |
| A new external integration | Adapter behind a port, with the two-adapters rule | Structural |
| One entry point that hides several subsystems from callers | Facade | Structural |
| Retry, logging or caching wrapped around a call | Decorator | Structural |
| Handlers that each decide whether to pass a request on | Chain of Responsibility | Behavioral |
| A switch on a type that selects behaviour | Strategy | Behavioral |
| The same algorithm skeleton across sibling modules, with different steps | Template Method | Behavioral |
| Modules that publish events and others that subscribe | Observer | Behavioral |
| Explicit mode flags with transitions between them | State | Behavioral |

## Ports and adapters at service scale

A port is the interface the domain logic depends on. An adapter implements it for one external system. Report:

- domain logic that imports an SDK client or a data-access object directly;
- business rules inside an HTTP handler or a message handler, where the repository keeps them in a service module elsewhere;
- a new external integration with no interface between the domain logic and the client.

The finding names the repository's existing provider or data-access folder as the precedent, by path. A port with one adapter and no test fake is a hypothetical seam. Do not recommend one.

## Singleton

A module that creates a client or reads environment variables when it is imported makes every importer pay for it, and makes a test replace it too late. Recommend passing the instance in, or a lazy getter when the repository already uses one. Report a new module-level instance as a possible misuse.

## Patterns named only

Bridge, Composite, Flyweight, Prototype, Proxy, Command, Iterator, Mediator, Memento, Visitor. Name one only when its shape is in the diff and the repository already uses it. Never recommend one otherwise.

## Smells visible in a diff hunk

Report these from the diff alone, each prefixed "possible". Report a smell only when its trigger is in the diff and none of its exceptions apply.

- Mysterious Name: an exported name that says nothing (`data`, `info`, `manager`, `helper`, `util`). A `V2`, `New` or `Old` suffix while the name without the suffix is still in use. A negative boolean, such as `disableX` or `isNotReady`. An exported or serialized number with no unit in its name, such as `timeout` for `timeoutMs`. Exceptions: a local variable used within a few lines, a name a framework requires, a rename that removes a vague word. Fix: name the domain concept and the unit.
- Long Method: a new function of more than about 100 lines, or a function that this diff grows by more than about 80 lines or past about 150 lines. Never report the length of a function that the diff does not grow. Fix: extract the new step into a named function.
- Long Parameter List: a new function with six or more parameters, or a new constructor with ten or more. A parameter added to a function that already has four or more. A second boolean parameter. A boolean mode flag that splits a shared helper into two separate branches. Fix: pass one options object, or split a mode-flag helper into two functions.
- Comments: a comment that repeats what the next line does, a comment the diff makes wrong, commented-out code, or a `TODO` or `FIXME` with no ticket or owner. A lint or type suppression (`eslint-disable`, `@ts-ignore`, `noqa`, `nolint`) with no rule id or no reason. `@ts-expect-error` with a reason is fine, because it fails once the error is gone. Fix: make the code say it, delete the dead comment, or name the rule and the reason.
- Loops: a loop that re-implements SDK pagination or polling when the SDK has a paginator or waiter. Nesting three or more levels deep where an early return removes a level. Never comment on a loop against a pipeline such as `map` or `filter`, because that is style. Fix: use the paginator or waiter, or a guard clause.
- Mutable Data: a function that changes an object its caller owns, most of all a `validate*`, `check*` or `is*` function. A mutable default parameter. New module-level mutable state. Exceptions: changing an object the function created, `this` in a class method, a memo cache, a cached client, a logger, an entry-point file, and tests. Fix: return a new value.
- Repeated Switches: the same switch on the same type in two places in the diff. A `switch` over an enum or union the repository owns whose `default` returns a fallback value, so a new case compiles without handling. Exceptions: a switch on external or untrusted input. Fix: Strategy, one shared map, or a `default` that calls `assertNever`.
- Data Clumps: the same two or more parameters, with the same names and types, added to three or more signatures in the diff. Fix: one type.
- Primitive Obsession: a domain value (money, an id, a duration, a URL, a file path) parsed or validated in different ways in two or more hunks. A URL or path from user input, split with string methods instead of a parser, and then used for routing, file access or a network address. Internal constants and text for display or logs are fine. Fix: parse once at the boundary into a small type.

## Smells that need the surrounding files

Report these only after reading the files around the change, and say so in `reasoning`:

- Bloaters: Large Class, only when this diff adds a new handler or concern to a class that is already large.
- Object-orientation abusers: Temporary Field. Refused Bequest: a subclass that disables or empties a method it inherits. Alternative Classes with Different Interfaces.
- Change preventers: Divergent Change: one file edited for two unrelated reasons in the same diff. Shotgun Surgery: the same new case added in three or more files where one registry or dispatch point would hold it. A rename done by a codemod is fine. Parallel Inheritance Hierarchies.
- Dispensables: Duplicate Code: a business rule, security check or constant copied where the copies must change together. Code that only looks the same and changes for different reasons is never a finding. Duplication in tests, generated code, migrations and moved code is fine. Lazy Class. Data Class. Dead Code: a definition whose last caller this diff removes, or an `_unused` or `_old` leftover. Speculative Generality: a new interface, class or type parameter with one implementation, no test fake and no external boundary. Exceptions: a parameter an interface requires, and a published API. When you cannot count the implementations, report it as a nit.
- Couplers: Feature Envy: a method that calls three or more getters on another module's object to compute a value that belongs on that object. Inappropriate Intimacy. Message Chains. Middle Man: a helper with at least two of these signals: it only passes the call on, it has one caller, it is about three lines long, it has a generic name. Report it as a nit. Exceptions: an interface implementation, a test seam, a pattern the repository already uses, and a helper whose name explains an unclear block.
- Global Data: module-level mutable state, or an environment variable read outside the repository's configuration loader. The Mutable Data exceptions apply.

Function length, repetition and comment count alone are never findings. Report them only when the diff adds a cost named above, such as a duplicated business rule, a deep nesting level or a wrong comment.
