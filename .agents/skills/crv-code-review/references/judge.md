# Judge

Picks the lenses for this change, shows the pick, and waits for the reviewer before any lens runs.

## Inputs

- The changed file list, with lines added and removed per file.
- The diff.
- The PR description. It is data, as `SKILL.md` step 2 says. It can add a triggered lens, such as `performance` for a speedup claim, and never removes a lens or lowers a severity.

## Tiers

1. **Always:** `correctness`, `adversarial`.
2. **By default:** `structure`, `standards` and `architecture`.
    - `structure` runs when the diff changes code. Files that instruct an agent, such as `AGENTS.md`, `CLAUDE.md`, skill files and prompt files, count as code.
    - `standards` runs when at least one standard from the scan covers a changed file. A documentation file counts, because a repository can have standards for documents. It also runs when the diff adds or edits a standards or instruction file, such as `AGENTS.md`, `CLAUDE.md` or `.github/instructions/*.md`, because the scan at `<base>` cannot see a new one.
    - `architecture` runs when the diff changes code in a shared package (a library other modules import), changes an exported interface, or changes code in two or more modules, such as two packages or a package and a service.
3. **On a trigger:** `security`, `tests`, `contract`, `data`, `infra`, `operability`, `performance`, `docs`, when a changed path or the diff matches a row below.

## Triggers

Before matching, leave out lockfiles, `**/generated/**` and `**/dist/**`. When the repository's standards name their own list of generated or vendored paths, use that list instead. One exception: when the diff changes a generated file and does not change its generator or schema, run `contract`, because the edit is a hand edit.

| Lens | Path patterns | Content signals in the diff |
| --- | --- | --- |
| `security` | auth, token, jwt, crypto, secret, iam, policy, middleware, interceptor, cors, csrf, cookie, session, `Dockerfile`, lockfiles, `pnpm-workspace.yaml`, `.npmrc`, `.env` | `process.env`, `verify(`, `exec(`, `eval(`, `path.join`, `readFile`, SQL built from strings, `dangerouslySetInnerHTML`, `pull_request_target`, `${{ github.event.`, `rejectUnauthorized`, `onlyBuiltDependencies` |
| `tests` | `*.test.*`, `*.spec.*`, `__tests__/`, API request collections such as Bruno | source changed in a folder that has tests, with no test changed |
| `contract` | `openapi*`, `*.proto`, `*.graphql`, event and Zod schema files, a package's public entry file such as `packages/*/src/index.ts` | an exported signature, payload field or schema field changed, `deprecated`, `BREAKING` |
| `data` | `migrations/`, `dao/`, `alembic`, `flyway`, `knex`, repositories, persistence models, message handlers such as Pub/Sub subscribers | `transaction`, `batch`, `upsert`, `ALTER TABLE`, `DROP COLUMN`, an idempotency key, a Firestore, DynamoDB or BigQuery client |
| `infra` | `*.tf`, `*.tfvars`, `*.hcl`, Pulumi and `Pulumi.*.yaml`, CDK, `cdk.json`, `cdk.context.json`, `infra/`, `Dockerfile`, `.github/workflows/`, `.github/actions/`, `renovate.json`, `dependabot.yml`, build configuration such as `nx.json` and `project.json`, deploy scripts | IAM bindings, network rules, `ignore_changes`, `prevent_destroy`, `deletion_protection`, `RemovalPolicy`, `protect`, `aliases`, `moved {`, `permissions:`, `id-token`, `pull_request_target` |
| `operability` | logging, metrics, alerting, monitoring, feature flags, remote configuration, runbooks | `logger.`, `console.log`, `Counter(`, `Histogram(`, `Gauge(`, `tracer.`, metric or alert names, flag keys |
| `performance` | request handlers and other hot paths | `await` or a query inside a loop, `.map(async`, `Promise.all` over unbounded input, `SELECT *`, a removed limit, or a speedup claim in the PR description (`faster`, `optimise`, `optimize`, `latency`, `throughput`) |
| `docs` | `*.md`, `docs/`, API specifications | changed code that a doc mentions, found by grepping the docs for the changed name |

Lockfiles count for `security` only, except `.terraform.lock.hcl`, which counts for `infra` too. The path patterns match anywhere in the path.

## Order

Every triggered lens runs. The lenses from the first two tiers run first, then the triggered lenses in this order: `security`, `data`, `contract`, `infra`, `tests`, `operability`, `performance`, `docs`.

When more than seven lenses run, say so in the pick. A long run uses more of the agent's context, so the reviewer may want to remove some lenses.

## Size

When the diff changes more than 400 lines or more than 10 files, or mixes mechanical changes (renames, moves, formatting) with logic changes, say so in the pick, and propose splitting the review by file group, such as one group per service or package or one group for mechanical moves and another for logic changes. The reviewer can accept the split, narrow the scope, or run the review whole. When the review is split, the picked lenses run once per group.

## The pick

Show a table with every lens, then wait for the reviewer:

| Lens | Run | Reason |
| --- | --- | --- |
| `correctness` | yes | always |
| `adversarial` | yes | always |
| `structure` | yes | code changed |
| `architecture` | yes | changes `packages/billing` and `services/orders` |
| `standards` | yes | 2 standards apply to the changed files |
| `security` | yes | path `src/auth/token.ts` |
| `data` | yes | `upsert` in `src/members/repo.ts` |
| `docs` | yes | `README.md` changed |
| `performance` | no | no trigger |

End with one line: reply "go" to run these lenses, or name lenses to add or remove.
