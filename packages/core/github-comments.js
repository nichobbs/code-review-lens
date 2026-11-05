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
    `<!-- crv-finding: ${JSON.stringify(metadata)} -->`,
    `### ${sevBadge} \`${finding.id}\` — ${finding.title}${verifyTag}${actionTag}`,
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

/**
 * Parses a GitHub review comment body to extract `crv-finding` metadata if present.
 */
function parseFindingComment(commentBody) {
  if (!commentBody || typeof commentBody !== 'string') return null;
  const match = CRV_FINDING_REGEX.exec(commentBody);
  if (!match) return null;
  try {
    const meta = JSON.parse(match[1]);
    const reviewerNoteMatch = />\s*\*\*Reviewer Note:\*\*\s*([\s\S]*?)(?:\n\n|\n[^>]|\s*$)/.exec(commentBody);
    const note = reviewerNoteMatch
      ? reviewerNoteMatch[1].replace(/\n>\s?/g, '\n').trim()
      : '';
    return { meta, note };
  } catch (err) {
    return null;
  }
}

/**
 * Serializes the sticky PR Overview / Summary comment with `<!-- crv-meta: {...} -->`.
 */
function serializeOverviewComment(report, triageMap = {}, reviewerSummary = '') {
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

  const metaPayload = {
    v: 1,
    repo: report.REVIEW?.repo || '',
    pr: report.REVIEW?.pr || null,
    base: report.REVIEW?.base || '',
    head: report.REVIEW?.head || report.XMETA?.head || '',
    agent: report.REVIEW?.agent || 'Antigravity',
    model: report.REVIEW?.model || '',
    counts,
    triage: triagedState,
    updatedAt: new Date().toISOString()
  };

  const lines = [
    `<!-- crv-meta: ${JSON.stringify(metaPayload)} -->`,
    `## 🛡️ Agentic PR Review Workbench — ${report.PR?.label || `PR #${metaPayload.pr || ''}`}`,
    ''
  ];

  if (reviewerSummary && reviewerSummary.trim()) {
    lines.push(reviewerSummary.trim(), '');
  }

  lines.push(
    `| Triage Status | Count | Description |`,
    `| :--- | :---: | :--- |`,
    `| 🚫 **Blocking** | **${counts.block}** | Must be resolved before merge |`,
    `| 💬 **Comment / Nit** | **${counts.comment}** | Non-blocking suggestions & design candidates |`,
    `| 🔇 **Dismissed** | **${counts.dismiss}** | Filtered out by human reviewer |`,
    `| ⏳ **Pending Triage** | **${counts.pending}** | Awaiting human review |`,
    ''
  );

  const publishedIssues = issues.filter((d) => {
    const a = triageMap[d.id]?.action;
    return a === 'block' || a === 'comment';
  });

  if (publishedIssues.length > 0) {
    lines.push(
      '### Curated Findings Published to PR Threads',
      '',
      '| ID | Severity | Triage | Location | Finding |',
      '| :--- | :--- | :--- | :--- | :--- |'
    );
    for (const d of publishedIssues) {
      const a = triageMap[d.id]?.action === 'block' ? '🚫 Block' : '💬 Comment';
      const sev = SEVERITY_BADGES[d.sev] || d.sev;
      lines.push(`| \`${d.id}\` | ${sev} | ${a} | \`${d.loc || 'PR'}\` | ${d.title} |`);
    }
    lines.push('');
  }

  lines.push(
    `<details>`,
    `<summary><strong>Architecture & Coverage Summary</strong> ( Head: <code>${(metaPayload.head || '').slice(0, 8)}</code> · Model: <code>${metaPayload.model || 'Agent'}</code> )</summary>`,
    '',
    stripHtmlToMarkdown(report.SUMMARY?.html || ''),
    '</details>'
  );

  return lines.join('\n').trim();
}

/**
 * Parses the sticky PR Overview comment to extract `crv-meta`.
 */
function parseOverviewComment(commentBody) {
  if (!commentBody || typeof commentBody !== 'string') return null;
  const match = CRV_META_REGEX.exec(commentBody);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    return null;
  }
}

/**
 * Builds the GitHub Pull Request Review API payload (`POST /repos/{owner}/{repo}/pulls/{number}/reviews`).
 */
function buildGitHubReviewPayload(report, triageMap = {}, options = {}) {
  const issues = report.DATA || [];
  const published = issues.filter((d) => {
    const action = triageMap[d.id]?.action;
    return action === 'block' || action === 'comment';
  });

  const hasBlocker = published.some((d) => triageMap[d.id]?.action === 'block');
  const event = options.event || (hasBlocker ? 'REQUEST_CHANGES' : 'COMMENT');
  const commitId = report.REVIEW?.head || report.XMETA?.head || undefined;

  const inlineComments = [];
  for (const finding of published) {
    const { path, line } = parseLoc(finding.loc);
    const body = serializeFindingComment(finding, triageMap[finding.id], report.REVIEW || {});
    if (path && line) {
      inlineComments.push({
        path,
        line,
        side: 'RIGHT',
        body
      });
    }
  }

  const body = serializeOverviewComment(report, triageMap, options.summaryNote || '');

  return {
    commit_id: commitId,
    event,
    body,
    comments: inlineComments
  };
}

/**
 * Reconciles existing GitHub PR comments/threads back into the Workbench state.
 */
function hydrateFromGitHubComments(issueComments = [], reviewComments = []) {
  let overviewMeta = null;
  const findingThreads = {};
  const generalComments = [];
  const generalByCommentId = new Map();

  for (const ic of issueComments || []) {
    const parsed = parseOverviewComment(ic.body);
    if (parsed) {
      overviewMeta = {
        ...parsed,
        commentId: ic.id,
        htmlUrl: ic.html_url,
        author: ic.user?.login || 'unknown',
        updatedAt: ic.updated_at || parsed.updatedAt
      };
    } else if (ic && ic.body) {
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
    const parsed = parseFindingComment(rc.body);
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
        replies: []
      };
    } else if (rc.in_reply_to_id) {
      const parentEntry = Object.values(findingThreads).find(
        (t) => t.commentId === rc.in_reply_to_id
      );
      if (parentEntry) {
        parentEntry.replies.push({
          id: rc.id,
          author: rc.user?.login || 'unknown',
          body: rc.body,
          createdAt: rc.created_at,
          htmlUrl: rc.html_url
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

  return { overviewMeta, findingThreads, generalComments };
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

module.exports = {
  SEVERITY_BADGES,
  TRIAGE_LABELS,
  stripHtmlToMarkdown,
  parseLoc,
  serializeFindingComment,
  parseFindingComment,
  serializeOverviewComment,
  parseOverviewComment,
  buildGitHubReviewPayload,
  hydrateFromGitHubComments,
  parsePaginatedGhJson
};
