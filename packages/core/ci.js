'use strict';

/**
 * CI automation helpers (pure logic + an injectable `gh` runner, so everything is unit-testable).
 *
 * Two tiers:
 *  - Tier 1 (no LLM): deterministic 4-layer pre-scan summarised in ONE sticky `<!-- crv-meta -->` comment.
 *  - Tier 2 (LLM): findings from a headless agent run, posted as ONE `COMMENT` review (never block/approve).
 *
 * Trust model: the sticky comment is only ever updated in place when it was authored by the Actions bot
 * (`github-actions[bot]`). A comment carrying a crv marker from any other author is never touched, and
 * PR #6's trusted-author logic only honours markers from the bot when hydrating.
 */

const {
  serializeOverviewComment,
  buildGitHubReviewPayload,
  foldCommentsIntoBody,
  capComment,
  parsePaginatedGhJson,
  mdCell
} = require('./github-comments');
const { isValidRepoSlug, parsePrNumber } = require('./repo-config');

const BOT_LOGIN = 'github-actions[bot]';
const STICKY_MARKER_RE = /<!--\s*crv-meta:/;

/** Higher = more severe. `struct`/`nit`/`ci` are the workbench's non-defect severities. */
const SEVERITY_RANK = { high: 4, medium: 3, low: 2, struct: 2, nit: 1, ci: 1 };

function severityRank(sev) {
  return SEVERITY_RANK[String(sev || '').toLowerCase()] || 0;
}

function assertTarget(repo, pr) {
  if (!isValidRepoSlug(repo)) throw new Error(`Invalid repository "${repo}" (expected owner/name)`);
  const n = parsePrNumber(pr);
  if (!n) throw new Error(`Invalid PR number "${pr}"`);
  return n;
}

/* ---------- Tier 1: deterministic hard rules + summary ---------- */

/**
 * Deterministic, LLM-free rules. These are the only things a required status check should ever fail on.
 * Today: zero-assertion ("hollow") tests found in the Layer 4 behavioural test matrix.
 */
function hardRuleFindings(layers) {
  const out = [];
  for (const tm of (layers && layers.testMatrix) || []) {
    for (const c of tm.cases || []) {
      if (c && c.hollow) {
        out.push({ rule: 'hollow-test', file: tm.file || '', detail: String(c.behavior || '').slice(0, 120) });
      }
    }
  }
  return out;
}

function countOf(x) {
  return Array.isArray(x) ? x.length : 0;
}

function summarizeLayers(layers) {
  const sig = (layers && layers.attentionSignals) || {};
  return {
    contracts: countOf(layers && layers.contracts),
    flows: countOf(layers && layers.flows),
    testFiles: countOf(layers && layers.testMatrix),
    removedGuards: countOf(sig.removedGuards),
    stealthChanges: countOf(sig.stealthChanges),
    shortcuts: countOf(sig.shortcuts),
    negativeSpaceViolations: countOf(sig.specAlignment && sig.specAlignment.negativeSpaceViolations)
  };
}

function oneLine(s, max = 200) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Markdown body for the Tier 1 section of the sticky comment. All dynamic text is escaped/length-capped. */
function renderTier1Summary({ layers, hard = [], aiStatus = '', posted = null, headSha = '' }) {
  const s = summarizeLayers(layers);
  const lines = [
    '**Automated pre-scan** (deterministic, no LLM). The AI review, when enabled, is advisory; a human triages every finding in the Workbench.',
    '',
    '| Layer | Signal | Count |',
    '| :--- | :--- | :---: |',
    `| Contracts | public contract / schema files changed | ${s.contracts} |`,
    `| Flows | production flow files changed | ${s.flows} |`,
    `| Tests | test files in the behavioural matrix | ${s.testFiles} |`,
    `| Attention | removed guards / stealth changes | ${s.removedGuards} / ${s.stealthChanges} |`,
    `| Attention | deliberate shortcuts | ${s.shortcuts} |`,
    `| Spec | negative-space violations | ${s.negativeSpaceViolations} |`,
    ''
  ];

  if (hard.length) {
    lines.push(`### Hard-rule findings (${hard.length})`, '');
    for (const h of hard.slice(0, 20)) {
      lines.push(`- \`${mdCell(h.rule)}\` in \`${mdCell(h.file)}\`: ${mdCell(h.detail)}`);
    }
    if (hard.length > 20) lines.push(`- ...and ${hard.length - 20} more`);
    lines.push('');
  } else {
    lines.push('No hard-rule findings.', '');
  }

  if (posted) {
    lines.push(
      `**AI review:** ${posted.posted} finding(s) posted as non-blocking comments` +
        ` (severity floor \`${oneLine(posted.minSeverity, 20)}\`; ${posted.belowFloor} below floor, ${posted.overCap} over cap, ${posted.alreadyPosted} already posted).`,
      ''
    );
  } else if (aiStatus) {
    lines.push(`**AI review:** ${oneLine(aiStatus, 300)}`, '');
  }
  if (headSha) lines.push(`<sub>Reviewed commit \`${oneLine(headSha, 40)}\`</sub>`);
  return lines.join('\n').trim();
}

/** Report object understood by `serializeOverviewComment` / `buildGitHubReviewPayload`. */
function buildCiReport({ repo, pr, prMeta = {}, findings = [], agent = 'crv CI', model = '' }) {
  return {
    DATA: findings,
    REVIEW: {
      repo,
      pr,
      base: prMeta.baseRefOid || '',
      head: prMeta.headRefOid || '',
      agent,
      model
    },
    PR: { label: `PR #${pr}`, url: prMeta.url || '' }
  };
}

function renderStickyBody(report, summaryMd, triage = {}) {
  return capComment(serializeOverviewComment(report, triage, summaryMd));
}

/* ---------- Sticky comment: find + idempotent upsert ---------- */

/** Latest comment authored by the bot that carries a `crv-meta` marker. Others are never matched. */
function findStickyComment(comments, botLogins = [BOT_LOGIN]) {
  const bots = new Set(botLogins.map((l) => l.toLowerCase()));
  let found = null;
  for (const c of comments || []) {
    const login = String(c && c.user && c.user.login || '').toLowerCase();
    if (!bots.has(login)) continue;
    if (typeof c.body !== 'string' || !STICKY_MARKER_RE.test(c.body)) continue;
    if (!found || Number(c.id) > Number(found.id)) found = c;
  }
  return found;
}

/**
 * Creates or updates the single sticky comment. `gh(args, stdin)` resolves to stdout and rejects on failure.
 * Running it twice with the same body leaves exactly one comment.
 */
async function upsertStickyComment({ gh, repo, pr, body, dryRun = false }) {
  const n = assertTarget(repo, pr);
  const raw = await gh(['api', `repos/${repo}/issues/${n}/comments`, '--paginate', '--slurp']);
  const existing = findStickyComment(parsePaginatedGhJson(raw || '[]'));
  if (dryRun) return { action: existing ? 'would-update' : 'would-create', id: existing ? existing.id : null };
  const payload = JSON.stringify({ body });
  if (existing) {
    await gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], payload);
    return { action: 'updated', id: existing.id };
  }
  await gh(['api', '--method', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-'], payload);
  return { action: 'created', id: null };
}

/* ---------- Tier 2: filtering + review payload ---------- */

/**
 * Applies the severity floor, skips findings that already have a trusted thread, drops refuted findings,
 * sorts most severe first and caps the count.
 */
function filterFindings(issues, { minSeverity = 'medium', maxFindings = 15, existingThreadIds = [] } = {}) {
  const floor = severityRank(minSeverity);
  const existing = new Set(existingThreadIds.map(String));
  const stats = { belowFloor: 0, overCap: 0, alreadyPosted: 0, refuted: 0 };
  const eligible = [];
  (issues || []).forEach((f, idx) => {
    if (!f || !f.id) return;
    if (String(f.verify || '').toUpperCase() === 'REFUTED') return void stats.refuted++;
    if (existing.has(String(f.id))) return void stats.alreadyPosted++;
    if (severityRank(f.sev) < floor) return void stats.belowFloor++;
    eligible.push({ f, idx });
  });
  eligible.sort((a, b) => severityRank(b.f.sev) - severityRank(a.f.sev) || a.idx - b.idx);
  const cap = Math.max(0, Number(maxFindings) || 0);
  const kept = eligible.slice(0, cap).map((e) => e.f);
  stats.overCap = Math.max(0, eligible.length - kept.length);
  return { kept, stats };
}

/**
 * Builds the single review. The event is forced to COMMENT: the automation never requests changes and never
 * approves, whatever the findings say. Existing-thread replies are not attempted here (findings that already
 * have a thread are filtered out upstream), so `threadUpdates` is dropped.
 */
function buildCiReviewPayload(report, kept, { summaryNote = '' } = {}) {
  const triage = {};
  for (const f of kept) triage[f.id] = { action: 'comment', note: '' };
  const payload = buildGitHubReviewPayload({ ...report, DATA: kept }, triage, { event: 'COMMENT', summaryNote });
  const { threadUpdates, ...rest } = payload;
  return { ...rest, event: 'COMMENT' };
}

function isUnprocessable(err) {
  return /\b422\b|Unprocessable/i.test(String(err && err.message || err));
}

/**
 * POSTs the review. GitHub rejects the whole review (422) if any inline comment targets a line outside the
 * diff; fall back to the same review with every inline comment folded into the body.
 */
async function postReviewWithFallback({ gh, repo, pr, payload }) {
  const n = assertTarget(repo, pr);
  const url = `repos/${repo}/pulls/${n}/reviews`;
  const args = ['api', '--method', 'POST', url, '--input', '-'];
  try {
    await gh(args, JSON.stringify(payload));
    return { mode: 'inline', inline: payload.comments.length };
  } catch (err) {
    if (!isUnprocessable(err)) throw err;
    const { commit_id, ...unpinned } = foldCommentsIntoBody(payload);
    await gh(args, JSON.stringify(unpinned));
    return { mode: 'folded-into-body', inline: 0 };
  }
}

module.exports = {
  BOT_LOGIN,
  SEVERITY_RANK,
  severityRank,
  hardRuleFindings,
  summarizeLayers,
  renderTier1Summary,
  buildCiReport,
  renderStickyBody,
  findStickyComment,
  upsertStickyComment,
  filterFindings,
  buildCiReviewPayload,
  postReviewWithFallback
};
