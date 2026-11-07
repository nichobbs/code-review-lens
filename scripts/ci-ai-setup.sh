#!/usr/bin/env bash
# Install/authentication seam for the tier 2 (LLM) job. SOURCE this file, then call `crv_ai_setup`.
#
# Return codes: 0 = harness ready, 10 = harness not available/authenticated here (caller skips cleanly), other = error.
#
# IMPORTANT: no credential mechanics are invented here. How the team's harness (agy / gemini-argon-4) authenticates
# in CI is an open question for the platform team; see docs/ci.md "agy auth options". Until the TODO(platform-team)
# markers below are filled in, tier 2 reports "skipped" and the PR still gets the tier 1 pre-scan.

crv_ai_setup() {
  local runner="${CRV_AI_RUNNER:-none}" bin
  case "$runner" in
    agy) bin=agy ;;
    claude) bin=claude ;;
    gemini) bin=gemini ;;
    codex) bin=codex ;;
    *) echo "crv: unknown AI runner '$runner'" >&2; return 1 ;;
  esac

  if ! command -v "$bin" >/dev/null 2>&1; then
    # TODO(platform-team): install the harness here (or provide it on a self-hosted runner image).
    echo "crv: '$bin' is not installed on this runner; nothing to install is configured yet." >&2
    return 10
  fi

  if [ "${CRV_AI_AUTH_MODE:-token}" = "token" ]; then
    # TODO(platform-team): map CRV_AI_TOKEN to the credential mechanism the harness actually supports
    # (env var, credential file, workload identity exchange). Do not guess; leave this unset until it is known.
    :
  fi
  return 0
}
