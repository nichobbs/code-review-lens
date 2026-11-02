# Security lens

Checks the change for ways an attacker or a careless caller reaches data or actions they should not. Runs when the judge's security triggers match.

## Looks for

- Injection: input that reaches a query, a shell command, a file path (`path.join`, `readFile`), a template or `eval` without parameters or escaping. A deserializer that can build any object from its input.
- Workflow injection: free text from an event, such as `${{ github.event.pull_request.title }}`, a body, a comment or `head.ref`, placed straight into a `run:` step. SHA fields are safe. The fix passes the value through `env:`.
- Authentication: a new entry point with no identity check, a token that is not verified, a verification that ignores the audience, issuer or expiry.
- Authorisation: a caller that reaches another user's record or an admin action, such as an id taken from the request and used without an ownership check.
- Missing input that passes: an auth or tenant check that allows the request when the token or the tenant is absent. TLS verification turned off, such as `rejectUnauthorized: false`.
- Secrets and personal data: a key, token or personal field in code, logs, error messages, URLs or test fixtures. A log line, error or response that includes a whole request, its headers, a config object or `process.env`.
- Cryptography: a weak algorithm, a hard-coded key, or randomness from a non-cryptographic source for a security value.
- Configuration: a permission, CORS rule or network rule wider than the change needs, or a debug setting left on. A suppression of a security rule (`noqa`, `eslint-disable`, `checkov:skip`, `trivy:ignore`) with no reason for that line.
- Dependencies: a new package, or a version change, with a known vulnerability or from an unexpected source. A new `onlyBuiltDependencies` entry, which lets a package run install scripts, with no reason given.

## Never reports

- Denial of service, rate limiting, and memory or CPU exhaustion, unless the change creates a specific, cheap way to trigger it.
- Generic input validation with no path to a harmful use.
- An open redirect with no proven impact.
- Races and duplicate delivery. The adversarial lens owns them.

## Severity

- `high` when an unauthenticated or low-privileged caller can read or change data they should not, and `Breaks` names the request that does it.
- `high` when a secret or personal data is exposed in code, a log, an error message, a response, a URL or a test fixture, and `Breaks` names where it appears and who can read it.
- `medium` when the attack needs an existing foothold, or the data is low value.
- `low` for a hardening gap with no path that reaches it today.

## Evidence

- Trace the input from its entry point to the place it is used, each step as `path:line`.
- For a secret, give its `path:line` and the kind of secret. Never copy the secret into the finding.
