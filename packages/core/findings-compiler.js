'use strict';

const { sanitizeReport } = require('../ui/sanitize.js');

const { parseUnifiedDiff, extractDiffSlice, buildLayersFromParsedDiff } = require('./diff-classifier');

const DEFAULT_SEV = {
  high: { l: 'High', i: '', c: '#D52043', g: 'High' },
  medium: { l: 'Medium', i: '', c: '#D87A1C', g: 'Medium' },
  low: { l: 'Low', i: '', c: '#1C73A8', g: 'Low' },
  struct: { l: 'Design', i: '', c: '#0F8171', g: 'Design candidates' },
  nit: { l: 'Nit', i: '', c: '#795F9A', g: 'Nits' },
  ci: { l: 'CI', i: '', c: '#6D7979', g: 'CI' }
};

const DEFAULT_STAT = {
  fixed: { l: 'Fixed', i: 'fixed', c: '#0E893C', r: true },
  external: { l: 'Fixed elsewhere', i: 'external', c: '#0F8171', r: true },
  dropped: { l: 'Dropped', i: 'dropped', c: '#6D7979', r: true },
  partial: { l: 'Partly fixed', i: 'partial', c: '#D87A1C', r: false },
  rebutted: { l: 'Author rebutted', i: 'rebutted', c: '#795F9A', r: false },
  open: { l: 'Still open', i: 'open', c: '#D52043', r: false }
};

const LEADS_IMPACT = ['**Breaks:**', '**Because:**', '**Reach:**'];
const LEADS_FIX = ['**Do:**', '**Check:**'];
const VERIFY_VALUES = new Set(['CONFIRMED', 'PLAUSIBLE']);

const BANNED_SLOP_RE =
  /\b(?:delve|tapestry|testament|underscore[sd]?|pivotal|crucial|seamlessly|holistic|paradigm|synergy|foster|elevate|beacon|landscape|interplay|intricate|meticulous|multifaceted|overarching|robust|streamline|utilize|leverage|facilitate|empower|cutting-edge|game changer|realm|paramount|transformative|embark|supercharge|harness|ever-evolving|load-bearing|fans out|poisons|evaporates|bolted on|earns its place|makes the call|leans on|sit with|the estate|closes the hole|hits a wall|single pane of glass)\b/i;

const NOT_X_BUT_Y_RE = /\bnot\s+(?:just\s+|only\s+)?[^,;.]{2,35},\s*but\s+(?:rather\s+)?/i;

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdown(escapedStr) {
  return escapedStr
    .replace(/``([^`\n]+)``|`([^`\n]+)`/g, (_, a, b) => `<code>${a || b}</code>`)
    .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '<strong>$1</strong>');
}

function renderParas(text) {
  if (!text) return '';
  const chunks = String(text).split(/(```mermaid\s*\n[\s\S]*?```)/g);
  const parts = [];

  for (const chunk of chunks) {
    const mm = /^```mermaid\s*\n([\s\S]*?)```$/.exec(chunk.trim());
    if (mm) {
      parts.push(`<div class="diaslot"><div class="mermaid">${escapeHtml(mm[1].trim())}</div></div>`);
      continue;
    }

    const blocks = chunk.split(/\n\s*\n/);
    for (const rawBlock of blocks) {
      const lines = rawBlock
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) continue;

      let bullets = [];
      const flushBullets = () => {
        if (!bullets.length) return;
        parts.push('<ul>' + bullets.map((b) => `<li>${inlineMarkdown(escapeHtml(b))}</li>`).join('') + '</ul>');
        bullets = [];
      };

      for (let line of lines) {
        const hm = /^\*\*(What it does|Human Focus|Coverage)[.:]?\*\*\s*(.*)$/.exec(line);
        if (hm) {
          flushBullets();
          parts.push(`<h3>${escapeHtml(hm[1])}</h3>`);
          line = hm[2].trim();
          if (!line) continue;
        }
        if (line.startsWith('### ')) {
          flushBullets();
          parts.push(`<h5>${inlineMarkdown(escapeHtml(line.slice(4).trim()))}</h5>`);
          continue;
        }
        const bm = /^[-*]\s+(.*)$/.exec(line);
        if (bm) {
          bullets.push(bm[1].trim());
        } else {
          flushBullets();
          parts.push(`<p>${inlineMarkdown(escapeHtml(line))}</p>`);
        }
      }
      flushBullets();
    }
  }
  return parts.join('');
}

function isOpenIssue(issue) {
  const state = issue?.status?.state || 'open';
  return !DEFAULT_STAT[state]?.r;
}

function stripCodeSpans(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/``[^`\n]+``|`[^`\n]+`/g, ' ');
}

/**
 * Validates `findings.json` against the 5-label lesson shape (`Breaks`/`Because`/`Reach` + `Do`/`Check`),
 * `verify` (`CONFIRMED` | `PLAUSIBLE`), and literal prose rules (no AI slop or figurative idioms).
 */
function checkFindingsShape(findingsJson) {
  const warnings = [];
  const summaryText = stripCodeSpans(findingsJson?.meta?.summary || '');
  const summaryMatches = [
    ...new Set(
      [...summaryText.matchAll(new RegExp(BANNED_SLOP_RE.source, 'gi'))].map((m) => m[0].toLowerCase())
    )
  ];
  for (const term of summaryMatches) {
    warnings.push(`meta.summary: contains banned AI filler or figurative idiom "${term}"`);
  }
  if (NOT_X_BUT_Y_RE.test(summaryText)) {
    warnings.push('meta.summary: contains "not X, but Y" contrast (state the positive claim directly)');
  }

  for (const x of findingsJson?.issues || []) {
    if (!isOpenIssue(x)) continue;
    if ((x.sev === 'high' || x.sev === 'medium') && !x.status && !VERIFY_VALUES.has(x.verify)) {
      warnings.push(`${x.id}: missing verify (CONFIRMED or PLAUSIBLE)`);
    }
    const imp = x.impact || '';
    const fix = x.fix || '';
    const missing = [
      ...LEADS_IMPACT.filter((l) => !imp.includes(l)),
      ...LEADS_FIX.filter((l) => !fix.includes(l))
    ];
    if (missing.length) {
      warnings.push(`${x.id}: missing ${missing.join(', ')}`);
    }
    if (imp.length > 800) {
      warnings.push(`${x.id}: impact is ${imp.length} chars; aim under ~700 and move detail to reasoning`);
    }
    if (fix.length > 500) {
      warnings.push(`${x.id}: fix is ${fix.length} chars; aim under ~450 and move detail to reasoning`);
    }
    const prose = stripCodeSpans(`${x.title || ''} ${imp} ${fix}`);
    const slopTerms = [
      ...new Set(
        [...prose.matchAll(new RegExp(BANNED_SLOP_RE.source, 'gi'))].map((m) => m[0].toLowerCase())
      )
    ];
    for (const term of slopTerms) {
      warnings.push(
        `${x.id}: contains banned AI filler or figurative idiom "${term}" (use literal prose)`
      );
    }
    if (NOT_X_BUT_Y_RE.test(prose)) {
      warnings.push(`${x.id}: contains "not X, but Y" contrast (state the positive claim directly)`);
    }
  }
  return warnings;
}

/**
 * Compiles a `crv-code-review` `findings.json` (`{ meta, issues }`) and optional unified diff
 * into the full 4-Layer Workbench report schema.
 */
function compileFindingsToWorkbenchReport(findingsJson, options = {}) {
  if (findingsJson && Array.isArray(findingsJson.DATA) && findingsJson.SUMMARY) {
    // Already compiled (possibly by a third party): treat its HTML fields as untrusted.
    return sanitizeReport(findingsJson);
  }

  const meta = findingsJson?.meta || {};
  const rawIssues = findingsJson?.issues || [];
  const diffText = options.diffText || '';
  const parsedFiles = diffText ? parseUnifiedDiff(diffText) : [];

  const DATA = rawIssues.map((x) => {
    const slot = x.mermaid ? '<div class="diaslot"></div>' : '';
    const leanSavedLines = Number.isFinite(Number(x.leanSavedLines)) && Number(x.leanSavedLines) > 0
      ? Math.round(Number(x.leanSavedLines))
      : 0;
    const item = {
      id: x.id,
      sev: x.sev,
      cat: x.cat || '',
      verify: VERIFY_VALUES.has(x.verify) ? x.verify : '',
      earlier: x.earlier || [],
      src: x.src || [],
      tag: x.tag || '',
      guide: x.guide || '',
      loc: x.loc || '',
      title: x.title || '',
      impact: renderParas(x.impact || ''),
      fix: renderParas(x.fix || ''),
      reasoning: renderParas(x.reasoning || ''),
      mermaid: x.mermaid || '',
      html: slot + (x.htmlExtra || ''),
      status: x.status
        ? {
            state: x.status.state || 'open',
            note: renderParas(x.status.note || ''),
            evidence: x.status.evidence || '',
            commits: x.status.commits || [],
            dev: x.status.dev
              ? {
                  ...x.status.dev,
                  verdict: renderParas(x.status.dev.verdict || '')
                }
              : null
          }
        : null,
      isNew: Boolean(x.isNew),
      strength: x.strength || '',
      scope: x.scope || '',
      deps: x.deps || '',
      suggestion: x.suggestion || '',
      fixPrompt: x.fixPrompt || '',
      leanSavedLines,
      diffSlice: x.diffSlice || (parsedFiles.length && x.loc ? extractDiffSlice(parsedFiles, x.loc) : null)
    };
    return item;
  });

  const openIssues = rawIssues.filter(isOpenIssue);
  const leanSavedLinesTotal = openIssues.reduce(
    (sum, x) => sum + (Number.isFinite(Number(x.leanSavedLines)) && Number(x.leanSavedLines) > 0 ? Math.round(Number(x.leanSavedLines)) : 0),
    0
  );
  const hasBlockers = openIssues.some((x) => x.sev === 'high' && x.verify !== 'PLAUSIBLE');
  const verdict = hasBlockers ? 'Blockers found' : openIssues.length ? 'No blockers' : 'No findings';

  const rev = meta.revision
    ? {
        ...meta.revision,
        summaryHtml: renderParas(meta.revision.summary || '')
      }
    : null;

  const SUMMARY = {
    html: renderParas(meta.summary || ''),
    points: meta.summaryPoints || [],
    outside: (meta.outside || []).map((o) => ({
      loc: o.loc || '',
      sev: o.sev === 'high' ? 'high' : '',
      html: renderParas(o.text || ''),
      ticket: o.ticket || ''
    })),
    engines: meta.engines || [],
    prUrl: meta.prUrl || '',
    headCommit: meta.headCommit || meta.review?.head || '',
    leanSavedLinesTotal,
    revision: rev
  };

  const precomputedLayers = options.layers || findingsJson.LAYERS || null;
  let layers;
  if (parsedFiles.length) {
    const preCallerMap = {};
    if (precomputedLayers && Array.isArray(precomputedLayers.contracts)) {
      for (const c of precomputedLayers.contracts) {
        if (c.path && c.callerBlastRadius) {
          preCallerMap[c.path] = c.callerBlastRadius;
        }
      }
    }
    layers = buildLayersFromParsedDiff(parsedFiles, rawIssues, {
      prMeta: options.prMeta || meta,
      reuseCandidates: options.reuseCandidates || precomputedLayers?.attentionSignals?.reuseCandidates,
      specAlignment: precomputedLayers?.attentionSignals?.specAlignment,
      codeownersText: options.codeownersText,
      codeownersRules: options.codeownersRules,
      callerBlastRadius: options.callerBlastRadius || preCallerMap
    });
    if (precomputedLayers && typeof precomputedLayers === 'object') {
      const preOwnersByPath = new Map(
        (precomputedLayers.contracts || []).map((c) => [c.path, c.owners || []])
      );
      for (const c of layers.contracts || []) {
        if ((!c.owners || c.owners.length === 0) && preOwnersByPath.has(c.path)) {
          c.owners = preOwnersByPath.get(c.path);
        }
      }
    }
  } else if (precomputedLayers) {
    layers = precomputedLayers;
  } else {
    layers = {
      contracts: [],
      flows: [],
      testMatrix: [],
      attentionSignals: {
        removedGuards: [],
        addedSymbols: [],
        reuseCandidates: [],
        stealthChanges: [],
        shortcuts: [],
        specAlignment: { outOfScope: [], repoPrecedents: [], negativeSpaceViolations: [], specClauses: [] },
        humanFocusPrompts: []
      }
    };
  }
  if (layers && typeof layers === 'object') {
    layers.leanSavedLinesTotal = leanSavedLinesTotal;
  }

  return {
    DATA,
    SEV: DEFAULT_SEV,
    ORDER: Object.keys(DEFAULT_SEV),
    KEY: meta.storageKey || 'crv-review',
    SUMMARY,
    STAT: DEFAULT_STAT,
    REV: rev?.number || 1,
    PR: { url: meta.prUrl || '', head: SUMMARY.headCommit },
    XMETA: {
      title: meta.title || 'PR Review',
      subtitle: meta.subtitle || '',
      verdict,
      file: options.outPath || ''
    },
    REVIEW: meta.review || {},
    LENSES: meta.review?.lenses || [],
    LAYERS: layers,
    rawFindings: findingsJson
  };
}

module.exports = {
  renderParas,
  checkFindingsShape,
  compileFindingsToWorkbenchReport
};
