'use strict';

/**
 * GitHub PR Comments as Backing Database (`crv-meta` & `crv-finding`)
 *
 * Allows the PR Review Workbench to:
 * 1. Publish curated findings as native inline GitHub PR review comments with hidden
 *    `<!-- crv-finding: {...} -->` metadata markers.
 * 2. Publish/update a sticky PR overview comment with `<!-- crv-meta: {...} -->`.
 * 3. Reconstruct Workbench triage state & multi-reviewer collaboration history directly
 *    from GitHub's PR review threads and issue comments.
 */

const CRV_META_REGEX = /<!--\s*crv-meta:\s*(\{[\s\S]*?\})\s*-->/;
const CRV_FINDING_REGEX = /<!--\s*crv-finding:\s*(\{[\s\S]*?\})\s*-->/;
const CRV_FINDING_UPDATE_REGEX = /<!--\s*crv-finding-update:\s*(\{[\s\S]*?\})\s*-->/;

const RESOLVED_STATES = new Set(['fixed', 'external', 'dropped']);

const REVIEW_THREADS_GRAPHQL_QUERY = `
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 30) {
            nodes {
              databaseId
              body
              createdAt
              url
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

const SEVERITY_BADGES = {
  high: '🔴 **HIGH**',
  medium: '🟠 **MEDIUM**',
  low: '🔵 **LOW**',
  struct: '🟢 **DESIGN**',
  nit: '🟣 **NIT**',
  ci: '⚪ **CI**'
};

const TRIAGE_LABELS = {
  block: 'Blocking (Must Fix)',
  comment: 'Comment / Non-blocking',
  dismiss: 'Dismissed (False Positive / Skip)',
  pending: 'Untriaged'
};

function stripHtmlToMarkdown(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseLoc(loc) {
  if (!loc) return { path: '', line: null };
  const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(String(loc).trim());
  if (!match) return { path: String(loc).trim(), line: null };
  return {
    path: match[1],
    line: Number(match[2]),
    endLine: match[3] ? Number(match[3]) : null
  };
}

const MAX_COMMENT_CHARS = 60000; // GitHub rejects bodies over 65536; keep headroom

/** Marker JSON lives inside an HTML comment: `<`/`>` must never appear raw (a `-->` would end it early). */
function markerJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Escapes text for use inside a Markdown table cell. */
function mdCell(s) {
  return oneLine(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

function capComment(body, limit = MAX_COMMENT_CHARS) {
  const text = String(body);
  if (text.length <= limit) return text;
  const note = '\n\n_…truncated by Agentic PR Review Workbench (GitHub comment size limit)._';
  return text.slice(0, limit - note.length) + note;
}

/**
 * Serializes a single finding + human triage state into a GitHub inline review comment body.
 */
function serializeFindingComment(finding, triage = {}, reviewMeta = {}) {
  const action = triage.action || 'comment';
  const humanNote = (triage.note || '').trim();
  const sevBadge = SEVERITY_BADGES[finding.sev] || `**${String(finding.sev).toUpperCase()}**`;
  const verifyTag = finding.verify ? ` · \`${finding.verify}\`` : '';
  const actionTag = action === 'block' ? ' · 🚫 **Blocking**' : ' · 💬 **Comment**';

  const metadata = {
    v: 1,
    id: finding.id,
    sev: finding.sev,
    cat: finding.cat || '',
    verify: finding.verify || '',
    action,
    loc: finding.loc || '',
    title: finding.title || '',
    head: reviewMeta.head || '',
    pr: reviewMeta.pr || null,
    updatedAt: new Date().toISOString()
  };

  const lines = [
    `<!-- crv-finding: ${markerJson(metadata)} -->`,
    `### ${sevBadge} \`${oneLine(finding.id)}\` — ${oneLine(finding.title)}${verifyTag}${actionTag}`,
    ''
  ];

  if (humanNote) {
    lines.push(`> **Reviewer Note:** ${humanNote.replace(/\n/g, '\n> ')}`, '');
  }

  const impactMd = stripHtmlToMarkdown(finding.impact);
  if (impactMd) {
    lines.push(impactMd, '');
  }

  const fixMd = stripHtmlToMarkdown(finding.fix);
  if (fixMd) {
    lines.push(fixMd, '');
  }

  if (finding.suggestion && String(finding.suggestion).trim()) {
    lines.push('```suggestion', String(finding.suggestion).replace(/\r?\n$/, ''), '```', '');
  }

  if (finding.mermaid) {
    lines.push(
      '<details>',
      '<summary>Architecture / Flow Diagram & Reasoning</summary>',
      '',
      '```mermaid',
      finding.mermaid.trim(),
      '```',
      '',
      stripHtmlToMarkdown(finding.reasoning),
      '</details>',
      ''
    );
  } else if (finding.reasoning) {
    lines.push(
      '<details>',
      '<summary>Verification & Reasoning</summary>',
      '',
      stripHtmlToMarkdown(finding.reasoning),
      '</details>',
      ''
    );
  }

  return lines.join('\n').trim();
}

const ACTIONS = new Set(['block', 'comment', 'dismiss', 'pending']);
const SEVERITIES = new Set(['high', 'medium', 'low', 'struct', 'nit', 'ci']);
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function str(v, max = 300) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Marker JSON comes from a PR comment, i.e. untrusted input. Only a fixed set of typed fields is
 * kept: unknown keys (such as `impact`/`fix`/`reasoning` HTML) are dropped, ids/enums are validated.
 */
function sanitizeFindingMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  return {
    v: 1,
    id: raw.id,
    sev: SEVERITIES.has(raw.sev) ? raw.sev : 'medium',
    cat: str(raw.cat, 120),
    verify: str(raw.verify, 20),
    action: ACTIONS.has(raw.action) ? raw.action : 'comment',
    loc: str(raw.loc, 400),
    title: str(raw.title, 300),
    head: SHA_RE.test(str(raw.head, 64)) ? raw.head : '',
    pr: Number.isInteger(raw.pr) && raw.pr > 0 ? raw.pr : null,
    updatedAt: str(raw.updatedAt, 40)
  };
}

function sanitizeOverviewMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const counts = {};
  for (const a of ACTIONS) {
    counts[a] = Number.isInteger(raw.counts && raw.counts[a]) ? Math.max(0, raw.counts[a]) : 0;
  }
  const triage = {};
  if (raw.triage && typeof raw.triage === 'object' && !Array.isArray(raw.triage)) {
    for (const [id, t] of Object.entries(raw.triage).slice(0, 500)) {
      if (!ID_RE.test(id) || !t || typeof t !== 'object') continue;
      triage[id] = {
        action: ACTIONS.has(t.action) ? t.action : 'pending',
        done: t.done === true,
        note: str(t.note, 2000)
      };
    }
  }
  return {
    v: 1,
    repo: str(raw.repo, 140),
    pr: Number.isInteger(raw.pr) && raw.pr > 0 ? raw.pr : null,
    base: SHA_RE.test(str(raw.base, 64)) ? raw.base : '',
    head: SHA_RE.test(str(raw.head, 64)) ? raw.head : '',
    agent: str(raw.agent, 80),
    model: str(raw.model, 80),
    counts,
    triage,
    updatedAt: str(raw.updatedAt, 40)
  };
}

/**
 * Parses a GitHub review comment body to extract `crv-finding` metadata if present.
 * NOTE: parsing alone does not prove who wrote the marker; `hydrateFromGitHubComments` gates on author.
 */
function parseFindingComment(commentBody) {
  if (!commentBody || typeof commentBody !== 'string') return null;
  const match = CRV_FINDING_REGEX.exec(commentBody);
  if (!match) return null;
  try {
    const meta = sanitizeFindingMeta(JSON.parse(match[1]));
    if (!meta) return null;
    const reviewerNoteMatch = />\s*\*\*Reviewer Note:\*\*\s*([\s\S]*?)(?:\n\n|\n[^>]|\s*$)/.exec(commentBody);
    const note = reviewerNoteMatch
      ? reviewerNoteMatch[1].replace(/\n>\s?/g, '\n').trim().slice(0, 2000)
      : '';
    return { meta, note };
  } catch (err) {
    return null;
  }
}

/**
 * Serializes the sticky PR Overview / Summary comment with `<!-- crv-meta: {...} -->`.
 */
function serializeOverviewComment(report, triageMap = {}, reviewerSummary = '', options = {}) {
  // omitEmpty (used by the CI pre-scan comment): leave out the human triage table and the summary block when they
  // would be empty. The crv-meta marker is identical either way. Workbench publishing keeps the full layout.
  const omitEmpty = Boolean(options && options.omitEmpty);
  const issues = report.DATA || [];
  const counts = { block: 0, comment: 0, dismiss: 0, pending: 0 };
  const triagedState = {};

  for (const issue of issues) {
    const t = triageMap[issue.id] || { action: 'pending', note: '' };
    const act = t.action || 'pending';
    counts[act] = (counts[act] || 0) + 1;
    triagedState[issue.id] = {
      action: act,
      done: Boolean(t.done),
      note: t.note || ''
    };
  }

  const publishedIssues = issues.filter((d) => {
    const a = triageMap[d.id]?.action;
    return a === 'block' || a === 'comment';
  });

  /** Renders the comment. GitHub caps bodies at 65536 chars, so degrade in stages (see loop below). */
  function render({ noteLimit, withDetails, maxRows }) {
    const triage = {};
    for (const [id, t] of Object.entries(triagedState)) {
      triage[id] = { ...t, note: String(t.note || '').slice(0, noteLimit) };
    }
    const metaPayload = {
      v: 1,
      repo: report.REVIEW?.repo || '',
      pr: report.REVIEW?.pr || null,
      base: report.REVIEW?.base || '',
      head: report.REVIEW?.head || report.XMETA?.head || '',
      agent: report.REVIEW?.agent || 'Antigravity',
      model: report.REVIEW?.model || '',
      counts,
      triage,
      updatedAt: new Date().toISOString()
    };

    const lines = [
      `<!-- crv-meta: ${markerJson(metaPayload)} -->`,
      `## 🛡️ Agentic PR Review Workbench — ${oneLine(report.PR?.label || `PR #${metaPayload.pr || ''}`)}`,
      ''
    ];

    if (reviewerSummary && reviewerSummary.trim()) {
      lines.push(reviewerSummary.trim(), '');
    }

    const hasTriage = counts.block + counts.comment + counts.dismiss + counts.pending > 0;
    if (!omitEmpty || hasTriage) {
      lines.push(
        `| Triage Status | Count | Description |`,
        `| :--- | :---: | :--- |`,
        `| 🚫 **Blocking** | **${counts.block}** | Must be resolved before merge |`,
        `| 💬 **Comment / Nit** | **${counts.comment}** | Non-blocking suggestions & design candidates |`,
        `| 🔇 **Dismissed** | **${counts.dismiss}** | Filtered out by human reviewer |`,
        `| ⏳ **Pending Triage** | **${counts.pending}** | Awaiting human review |`,
        ''
      );
    }

    if (publishedIssues.length > 0) {
      lines.push(
        '### Curated Findings Published to PR Threads',
        '',
        '| ID | Severity | Triage | Location | Finding |',
        '| :--- | :--- | :--- | :--- | :--- |'
      );
      for (const d of publishedIssues.slice(0, maxRows)) {
        const a = triageMap[d.id]?.action === 'block' ? '🚫 Block' : '💬 Comment';
        const sev = SEVERITY_BADGES[d.sev] || mdCell(d.sev);
        lines.push(`| \`${mdCell(d.id)}\` | ${sev} | ${a} | \`${mdCell(d.loc || 'PR')}\` | ${mdCell(d.title)} |`);
      }
      if (publishedIssues.length > maxRows) {
        lines.push('', `_…and ${publishedIssues.length - maxRows} more finding(s); see the inline review threads._`);
      }
      lines.push('');
    }

    const summaryMd = stripHtmlToMarkdown(report.SUMMARY?.html || '');
    if (withDetails && (!omitEmpty || summaryMd.trim())) {
      lines.push(
        `<details>`,
        `<summary><strong>Architecture & Coverage Summary</strong> ( Head: <code>${escapeHtmlText((metaPayload.head || '').slice(0, 8))}</code> · Model: <code>${escapeHtmlText(metaPayload.model || 'Agent')}</code> )</summary>`,
        '',
        summaryMd,
        '</details>'
      );
    }
    return lines.join('\n').trim();
  }

  const stages = [
    { noteLimit: 2000, withDetails: true, maxRows: Infinity },
    { noteLimit: 300, withDetails: false, maxRows: Infinity },
    { noteLimit: 0, withDetails: false, maxRows: 100 },
    { noteLimit: 0, withDetails: false, maxRows: 0 }
  ];
  let body = '';
  for (const stage of stages) {
    body = render(stage);
    if (body.length <= MAX_COMMENT_CHARS) return body;
  }
  return capComment(body);
}

function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parses the sticky PR Overview comment to extract `crv-meta`.
 */
function parseOverviewComment(commentBody) {
  if (!commentBody || typeof commentBody !== 'string') return null;
  const match = CRV_META_REGEX.exec(commentBody);
  if (!match) return null;
  try {
    return sanitizeOverviewMeta(JSON.parse(match[1]));
  } catch (err) {
    return null;
  }
}

function renderUnplacedSection(findings, triageMap) {
  const rows = findings.map((f) => {
    const a = triageMap[f.id]?.action === 'block' ? '🚫 Block' : '💬 Comment';
    const note = triageMap[f.id]?.note ? ` Reviewer note: ${oneLine(triageMap[f.id].note).slice(0, 500)}` : '';
    return `- ${a} \`${oneLine(f.id)}\` ${SEVERITY_BADGES[f.sev] || oneLine(f.sev)} - ${oneLine(f.title)}${f.loc ? ` (\`${oneLine(f.loc)}\`)` : ''}.${note}`;
  });
  return ['### Findings without an inline location', '', ...rows].join('\n');
}

/**
 * GitHub rejects the WHOLE review (422) if any inline comment targets a line outside the diff.
 * Fallback payload: keep the review event/body and move every inline comment into the body.
 */
function foldCommentsIntoBody(payload) {
  const { comments = [], body = '', ...rest } = payload;
  if (!comments.length) return payload;
  const items = comments.map((c) => `<details><summary><code>${escapeHtmlText(`${c.path}:${c.line}`)}</code></summary>\n\n${c.body}\n\n</details>`);
  return { ...rest, body: capComment(`${body}\n\n### Inline findings (could not be anchored to the diff)\n\n${items.join('\n\n')}`), comments: [] };
}

/**
 * Serializes a follow-up reply + thread resolution directive (`resolve` or `unresolve`)
 * for a finding that ALREADY has an inline comment thread (`commentId`) on GitHub.
 * Prevents duplicate inline threads on re-reviews (`r2+`) and reopens threads whose fix was incomplete.
 */
function serializeFindingThreadUpdateReply(finding, triage = {}, reviewMeta = {}, existingThread = {}) {
  const state = finding.status?.state || 'open';
  const isStateResolved = RESOLVED_STATES.has(state);
  const action = isStateResolved ? 'dismiss' : triage.action || 'comment';
  const isDismissedOrFixed = isStateResolved || action === 'dismiss';
  const humanNote = (triage.note || '').trim();
  const head = reviewMeta.head || '';
  const shortHead = head ? head.slice(0, 8) : 'HEAD';

  const updateMeta = {
    v: 1,
    id: finding.id,
    state,
    action,
    head,
    pr: reviewMeta.pr || null,
    updatedAt: new Date().toISOString()
  };

  const lines = [`<!-- crv-finding-update: ${JSON.stringify(updateMeta)} -->`];

  if (state === 'fixed' || state === 'external') {
    lines.push(
      `✅ **Verified ${state === 'external' ? 'Resolved Upstream' : 'Fixed'}** (\`${finding.id}\` at \`${shortHead}\`)`
    );
  } else if (state === 'dropped' || action === 'dismiss') {
    lines.push(`🔇 **Resolved / Dismissed** (\`${finding.id}\` at \`${shortHead}\`)`);
  } else {
    const stateLabel =
      state === 'partial'
        ? '⚠️ **Partially Fixed — Still Open**'
        : state === 'rebutted'
          ? '🔄 **Rebuttal Reviewed — Still Open**'
          : '🔄 **Still Open**';
    const actionBadge = action === 'block' ? '🚫 **Blocking**' : '💬 **Comment**';
    lines.push(`${stateLabel} (\`${finding.id}\` at \`${shortHead}\` · ${actionBadge})`);
  }

  if (humanNote) {
    lines.push('', `> **Reviewer Note:** ${humanNote.replace(/\n/g, '\n> ')}`);
  }

  const statusNoteMd = stripHtmlToMarkdown(finding.status?.note || '');
  const evidence = (finding.status?.evidence || '').trim();
  if (statusNoteMd || evidence) {
    lines.push(
      '',
      `${statusNoteMd || ''}${evidence ? ` (verified at \`${evidence}\`)` : ''}`.trim()
    );
  }

  if (finding.status?.dev && finding.status.dev.quote) {
    const dev = finding.status.dev;
    const verdictMd = stripHtmlToMarkdown(dev.verdict || '');
    lines.push(
      '',
      `> "${dev.quote}" — @${dev.who || 'author'}`,
      verdictMd ? `\n${verdictMd}` : ''
    );
  }

  if (!isDismissedOrFixed && finding.suggestion && String(finding.suggestion).trim()) {
    lines.push('', '```suggestion', String(finding.suggestion).replace(/\r?\n$/, ''), '```');
  }

  const resolutionAction = isDismissedOrFixed ? 'resolve' : 'unresolve';
  return {
    id: finding.id,
    commentId: existingThread.commentId || triage.ghCommentId,
    threadId: existingThread.threadId || triage.ghThreadId || null,
    state,
    action,
    head,
    resolutionAction,
    body: lines.filter((l) => l !== undefined).join('\n').trim()
  };
}

/**
 * Builds the GitHub Pull Request Review API payload (`POST /repos/{owner}/{repo}/pulls/{number}/reviews`)
 * plus `threadUpdates` for existing `<!-- crv-finding -->` threads so re-reviews reply & resolve/reopen
 * existing threads instead of creating duplicate inline comments.
 */
function buildGitHubReviewPayload(report, triageMap = {}, options = {}) {
  const issues = report.DATA || [];
  const existingThreads = report.GITHUB_STATE?.findingThreads || {};

  const published = issues.filter((d) => {
    const action = triageMap[d.id]?.action;
    const isResolvedState = RESOLVED_STATES.has(d.status?.state);
    const hasExistingThread = Boolean(existingThreads[d.id]?.commentId || triageMap[d.id]?.ghCommentId);
    if (hasExistingThread && (isResolvedState || action === 'dismiss' || action === 'block' || action === 'comment')) {
      return true;
    }
    return (action === 'block' || action === 'comment') && !isResolvedState;
  });

  const hasBlocker = published.some(
    (d) => triageMap[d.id]?.action === 'block' && !RESOLVED_STATES.has(d.status?.state)
  );
  const event = options.event || (hasBlocker ? 'REQUEST_CHANGES' : 'COMMENT');
  const rawCommitId = String(report.REVIEW?.head || report.XMETA?.head || '').trim();
  const commitId = /^[0-9a-f]{40}$/i.test(rawCommitId) ? rawCommitId : undefined;

  const inlineComments = [];
  const threadUpdates = [];
  const outOfDiffNotes = [];
  const unplaced = [];
  for (const finding of published) {
    const t = triageMap[finding.id] || {};
    const existingThread = existingThreads[finding.id] || (t.ghCommentId ? { commentId: t.ghCommentId, threadId: t.ghThreadId } : null);

    if (existingThread && existingThread.commentId) {
      const update = serializeFindingThreadUpdateReply(
        finding,
        t,
        report.REVIEW || {},
        existingThread
      );
      threadUpdates.push(update);
      continue;
    }

    if (RESOLVED_STATES.has(finding.status?.state) || t.action === 'dismiss') {
      continue;
    }

    const { path, line } = parseLoc(finding.loc);
    const body = serializeFindingComment(finding, t, report.REVIEW || {});
    if (path && line) {
      let targetLine = line;
      let canPostInline = true;
      if (finding.diffSlice && Array.isArray(finding.diffSlice.lines)) {
        const rightLines = finding.diffSlice.lines
          .map((l) => l.newNumber)
          .filter((n) => Number.isFinite(n));
        if (rightLines.length === 0) {
          canPostInline = false;
        } else if (!rightLines.includes(line)) {
          targetLine = rightLines[0];
        }
      }
      if (canPostInline) {
        inlineComments.push({
          path,
          line: targetLine,
          side: 'RIGHT',
          body
        });
      } else {
        outOfDiffNotes.push(body);
      }
    } else {
      unplaced.push(finding);
    }
  }

  let body = serializeOverviewComment(report, triageMap, options.summaryNote || '');
  if (outOfDiffNotes.length > 0) {
    body += `\n\n---\n### Additional Findings (Outside Diff Hunks)\n\n${outOfDiffNotes.join('\n\n---\n\n')}`;
  }
  if (unplaced.length) {
    // No `path:line` (or not parseable): GitHub cannot anchor an inline comment, so list them in the review body.
    body += `\n\n${renderUnplacedSection(unplaced, triageMap)}`;
  }
  if (outOfDiffNotes.length > 0 || unplaced.length) {
    body = capComment(body);
  }

  const payload = {
    event,
    body,
    comments: inlineComments,
    threadUpdates
  };
  if (commitId) {
    payload.commit_id = commitId;
  }
  return payload;
}

function hasCrvMarker(body) {
  return typeof body === 'string' && (CRV_META_REGEX.test(body) || CRV_FINDING_REGEX.test(body));
}

function headsMatch(a, b) {
  if (!a || !b) return true; // unknown: cannot call it stale
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Reconciles existing GitHub PR comments/threads back into the Workbench state.
 *
 * Authenticity: `<!-- crv-* -->` markers can be typed by ANY commenter, so they are only honoured when the
 * comment author is in `options.trustedAuthors` (case-insensitive logins: the current `gh` user, configured
 * reviewers, bots). Deny-by-default: with no trusted authors nothing is trusted. Marker comments from other
 * authors are kept as plain comments and counted in `untrustedMarkers`.
 *
 * Staleness: with `options.currentHead`, markers recorded against another commit are flagged `stale: true`.
 */
function hydrateFromGitHubComments(issueComments = [], reviewComments = [], options = {}) {
  const trusted = new Set(Array.from(options.trustedAuthors || [], (a) => String(a).toLowerCase()));
  const isTrusted = (c) => trusted.has(String(c?.user?.login || '').toLowerCase());
  const currentHead = options.currentHead || '';
  const untrustedMarkers = [];

  let overviewMeta = null;
  let overviewStamp = '';
  const findingThreads = {};
  const generalComments = [];
  const generalByCommentId = new Map();

  for (const ic of issueComments || []) {
    const markerTrusted = isTrusted(ic);
    const parsed = markerTrusted ? parseOverviewComment(ic.body) : null;
    if (parsed) {
      const stamp = String(ic.updated_at || parsed.updatedAt || '');
      if (!overviewMeta || stamp >= overviewStamp) {
        overviewStamp = stamp;
        overviewMeta = {
          ...parsed,
          commentId: ic.id,
          htmlUrl: ic.html_url,
          author: ic.user?.login || 'unknown',
          updatedAt: ic.updated_at || parsed.updatedAt,
          stale: !headsMatch(parsed.head, currentHead)
        };
      }
    } else if (ic && ic.body) {
      if (!markerTrusted && hasCrvMarker(ic.body)) {
        untrustedMarkers.push({ id: ic.id, author: ic.user?.login || 'unknown', url: ic.html_url || '' });
      }
      generalComments.push({
        id: ic.id,
        path: null,
        line: null,
        author: ic.user?.login || 'unknown',
        body: ic.body,
        url: ic.html_url || '',
        createdAt: ic.created_at || ic.updated_at || '',
        replies: []
      });
    }
  }

  for (const rc of reviewComments || []) {
    const markerTrusted = isTrusted(rc);
    const parsed = markerTrusted ? parseFindingComment(rc.body) : null;
    if (parsed && parsed.meta?.id) {
      const id = parsed.meta.id;
      const headingMatch = /^###\s+.*?`[^`]+`\s+—\s+([^\n·]+)/m.exec(rc.body || '');
      const title = parsed.meta.title || (headingMatch ? headingMatch[1].trim() : `Finding ${id}`);
      findingThreads[id] = {
        id,
        title,
        commentId: rc.id,
        htmlUrl: rc.html_url,
        path: rc.path,
        line: rc.line || rc.original_line,
        author: rc.user?.login || 'unknown',
        action: parsed.meta.action,
        note: parsed.note,
        body: rc.body || '',
        meta: parsed.meta,
        stale: !headsMatch(parsed.meta.head, currentHead),
        replies: []
      };
      continue;
    }
    if (!markerTrusted && hasCrvMarker(rc.body)) {
      untrustedMarkers.push({ id: rc.id, author: rc.user?.login || 'unknown', url: rc.html_url || '' });
    }
    if (rc.in_reply_to_id) {
      const parentEntry = Object.values(findingThreads).find(
        (t) => t.commentId === rc.in_reply_to_id
      );
      if (parentEntry) {
        let updateMeta = null;
        const updMatch = CRV_FINDING_UPDATE_REGEX.exec(rc.body || '');
        if (updMatch) {
          try {
            updateMeta = JSON.parse(updMatch[1]);
          } catch (e) {}
        }
        if (updateMeta) {
          parentEntry.lastUpdate = updateMeta;
          if (updateMeta.action) parentEntry.action = updateMeta.action;
          if (updateMeta.state) parentEntry.state = updateMeta.state;
        }
        parentEntry.replies.push({
          id: rc.id,
          author: rc.user?.login || 'unknown',
          body: rc.body,
          createdAt: rc.created_at,
          htmlUrl: rc.html_url,
          updateMeta
        });
      } else if (generalByCommentId.has(rc.in_reply_to_id)) {
        generalByCommentId.get(rc.in_reply_to_id).replies.push({
          id: rc.id,
          author: rc.user?.login || 'unknown',
          body: rc.body,
          createdAt: rc.created_at,
          htmlUrl: rc.html_url
        });
      }
    } else if (rc && rc.body) {
      const entry = {
        id: rc.id,
        path: rc.path || null,
        line: rc.line || rc.original_line || 1,
        author: rc.user?.login || 'unknown',
        body: rc.body,
        url: rc.html_url || '',
        createdAt: rc.created_at || rc.updated_at || '',
        replies: []
      };
      generalComments.push(entry);
      if (rc.id != null) {
        generalByCommentId.set(rc.id, entry);
      }
    }
  }

  return { overviewMeta, findingThreads, generalComments, untrustedMarkers };
}

/**
 * Safely parses JSON output from `gh api ... --paginate` (with or without `--slurp`).
 * Handles single JSON arrays, `--slurp` nested page arrays (`[[...], [...]]`), and
 * concatenated page arrays (`[...]\n[...]`) produced when `--paginate` runs without `--slurp`.
 */
function parsePaginatedGhJson(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.length > 0 && Array.isArray(parsed[0]) ? parsed.flat() : parsed;
    }
    return [parsed];
  } catch (e) {
    const normalized = '[' + trimmed.replace(/\]\s*\[/g, '],[') + ']';
    const pages = JSON.parse(normalized);
    return Array.isArray(pages) ? pages.flat() : [];
  }
}

/**
 * Enriches `hydrateFromGitHubComments` output with GraphQL `PullRequestReviewThread`
 * state (`threadId`, `isResolved`, `isOutdated`).
 */
function mergeGraphqlReviewThreads(hydrated, graphqlResponse) {
  if (!hydrated || !hydrated.findingThreads || !graphqlResponse) return hydrated;
  const parsed =
    typeof graphqlResponse === 'string'
      ? (() => {
          try {
            return JSON.parse(graphqlResponse);
          } catch (e) {
            return null;
          }
        })()
      : graphqlResponse;
  const threads =
    parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes ||
    parsed?.repository?.pullRequest?.reviewThreads?.nodes ||
    [];
  if (!Array.isArray(threads)) return hydrated;

  for (const th of threads) {
    if (!th || !Array.isArray(th.comments?.nodes) || th.comments.nodes.length === 0) continue;
    const firstComment = th.comments.nodes[0];
    const dbId = firstComment?.databaseId;
    const parsedFinding = parseFindingComment(firstComment?.body || '');
    const findingId = parsedFinding?.meta?.id;

    let entry = findingId ? hydrated.findingThreads[findingId] : null;
    if (!entry && dbId != null) {
      entry = Object.values(hydrated.findingThreads).find((t) => t.commentId === dbId);
    }
    if (entry) {
      entry.threadId = th.id;
      entry.isResolved = Boolean(th.isResolved);
      entry.isOutdated = Boolean(th.isOutdated);
    }
  }
  return hydrated;
}

module.exports = {
  SEVERITY_BADGES,
  TRIAGE_LABELS,
  RESOLVED_STATES,
  REVIEW_THREADS_GRAPHQL_QUERY,
  stripHtmlToMarkdown,
  parseLoc,
  serializeFindingComment,
  serializeFindingThreadUpdateReply,
  parseFindingComment,
  serializeOverviewComment,
  parseOverviewComment,
  buildGitHubReviewPayload,
  hydrateFromGitHubComments,
  mergeGraphqlReviewThreads,
  parsePaginatedGhJson,
  foldCommentsIntoBody,
  capComment,
  mdCell,
  sanitizeFindingMeta,
  sanitizeOverviewMeta
};
