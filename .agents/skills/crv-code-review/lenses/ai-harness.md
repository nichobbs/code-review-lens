# AI Harness (`ai-harness`)

Prompts, agent skill files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`), MCP tool schemas, and LLM SDK calls (`generateText`, `streamText`, `chat.completions`, structured output schemas) are executable control flow. Review them with the same rigor as production handlers.

## Indirect prompt injection & untrusted context interpolation

- Interpolating untrusted external strings (PR bodies, issue comments, webhook payloads, user documents, scraped web pages, tool stdout, database rows) directly into a system prompt or developer instruction block without structural separation or explicit data framing.
- Instructing an agent to read untrusted repository files, tickets, or comments without stating that those inputs are data and cannot override instructions, skip steps, or invoke privileged tools.
- Passing raw model text output directly into `exec`, `spawn` with `shell: true`, `eval`, SQL queries, HTML `innerHTML`, or file paths without schema validation and path containment.

## Tool & subagent over-privilege

- Granting an agent, skill, or MCP tool broad write, shell, network, or secret-read permissions (`BypassSandbox: true`, `EnableWriteTools: true`, unrestricted `bash`, wildcard `allowed-tools`) when its task is read-only analysis or bounded to a specific directory.
- Defining an MCP tool or function-calling schema where destructive parameters (file deletion, production deploys, database writes, external POSTs) lack explicit confirmation gates, path allowlists, or dry-run defaults.
- Subagent or loop orchestration that can recurse or retry without a bounded iteration cap (`maxSteps`, `maxTurns`, `maxRetries`) or token/cost budget.

## Structured output & parser fragility

- Parsing LLM output with brittle regexes (`JSON.parse(text.match(/\{[\s\S]*\}/)[0])`) instead of provider-enforced structured outputs (`response_format`, `Output.object`, Zod/JSON Schema) when the SDK and model support structured output.
- Defining a structured output schema that makes every field optional or uses loose `z.any()` / `additionalProperties: true` when downstream code dereferences those fields unconditionally.
- Missing fallback or error handling when the model returns a refusal, hits `finish_reason: "length"` (truncated JSON), or fails schema validation.

## Context window & token amplification

- Dumping unbounded lists, full repository diffs, raw log files, or unpaginated query results into a prompt or tool response without truncation, chunking, or line/byte caps.
- Tool schemas with vague descriptions or overlapping responsibilities that force the model to guess which tool to call or retry in a loop.

## Severity

- `high`: indirect prompt injection that can trigger tool execution, file mutation, or data exfiltration; LLM output passed to a shell, SQL, or filesystem sink without validation; unbounded agent/tool loop that can execute destructive actions.
- `medium`: structured output truncation or refusal that crashes the caller; unbounded context injection that will exceed model limits on realistic production inputs; tool or skill granted write/network privileges it does not need.
- `low` or `nit`: ambiguous prompt wording, redundant instructions, or missing parameter descriptions in a tool schema.

Skip model choice opinions, temperature tuning preferences, or prompt phrasing changes that do not alter control flow, safety boundaries, or parser contracts.
