(function () {
  'use strict';

  const OV = '__overview__';
  const CONTRACTS_VIEW = '__contracts__';
  const TESTS_VIEW = '__tests__';

  let report = window.__CRV_INITIAL_REPORT__ || null;
  let activeLayer = 'findings'; // 'overview' | 'findings' | 'contracts' | 'tests'
  let activeTab = 'todo';       // 'todo' | 'triaged' | 'all'
  let activeFilter = 'all';
  let currentId = 'H1';
  let triage = {};              // { [id]: { action: 'block'|'comment'|'dismiss'|'pending', note: '', done: false, ghCommentId?: number, ghUrl?: string } }
  let ghConnected = false;

  const $ = (sel) => document.querySelector(sel);

  function storageKey() {
    return (report && report.KEY ? report.KEY : 'crv-workbench') + ':triage-v1';
  }

  function loadTriage() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (raw) {
        triage = JSON.parse(raw) || {};
      } else {
        triage = {};
      }
    } catch (e) {
      triage = {};
    }

    const ghOverviewTriage = report?.GITHUB_STATE?.overviewMeta?.triage || {};
    const ghThreads = report?.GITHUB_STATE?.findingThreads || {};

    if (report && Array.isArray(report.DATA)) {
      for (const d of report.DATA) {
        const ghThread = ghThreads[d.id];
        const ghSaved = ghOverviewTriage[d.id];
        if (!triage[d.id]) {
          const action =
            ghThread?.action ||
            ghSaved?.action ||
            d.suggestedTriage ||
            (d.sev === 'high' ? 'block' : 'comment');
          const note = ghThread?.note || ghSaved?.note || '';
          const done = Boolean(ghThread || ghSaved?.done);
          triage[d.id] = {
            action,
            note,
            done,
            ghCommentId: ghThread?.commentId,
            ghUrl: ghThread?.htmlUrl
          };
        } else if (ghThread) {
          triage[d.id].ghCommentId = ghThread.commentId;
          triage[d.id].ghUrl = ghThread.htmlUrl;
          if (!triage[d.id].note && ghThread.note) {
            triage[d.id].note = ghThread.note;
          }
        }
      }
    }
  }

  function saveTriage() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(triage));
    } catch (e) {}
    updateHeaderCounts();
  }

  function getTriage(id) {
    if (!triage[id]) {
      triage[id] = { action: 'pending', note: '', done: false };
    }
    return triage[id];
  }

  function setTriageAction(id, action) {
    const t = getTriage(id);
    t.action = t.action === action ? 'pending' : action;
    t.done = t.action !== 'pending';
    saveTriage();
    renderRack();
    if (currentId === id && activeLayer === 'findings') {
      renderPane();
    }
  }

  function setTriageNote(id, noteText) {
    const t = getTriage(id);
    t.note = noteText;
    saveTriage();
    renderRack();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatInlineCode(str) {
    return escapeHtml(str).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function stripHtmlToMd(html) {
    if (!html) return '';
    return String(html)
      .replace(/<\/p>\s*<p>/gi, '\n\n')
      .replace(/<\/?p>/gi, '')
      .replace(/<\/?(?:strong|b)>/gi, '**')
      .replace(/<\/?code>/gi, '`')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<[^>]+>/g, '')
      .trim();
  }

  function sevVars(sev) {
    return `--band:var(--s-${sev});--tint:var(--s-${sev}-tint);--idink:var(--s-${sev}-ink)`;
  }

  function updateHeaderCounts() {
    if (!report || !report.DATA) return;
    const counts = { block: 0, comment: 0, dismiss: 0, pending: 0 };
    for (const d of report.DATA) {
      const a = getTriage(d.id).action || 'pending';
      counts[a] = (counts[a] || 0) + 1;
    }

    const pillsEl = $('#triageSummaryPills');
    if (pillsEl) {
      pillsEl.innerHTML = [
        `<span class="tpill block num" title="Findings marked Blocking (Request Changes)">🚫 ${counts.block} Block</span>`,
        `<span class="tpill comment num" title="Findings marked Comment / Non-blocking">💬 ${counts.comment} Comment</span>`,
        `<span class="tpill dismiss num" title="Findings dismissed by human reviewer">🔇 ${counts.dismiss} Dismissed</span>`
      ].join('');
    }

    const publishCount = counts.block + counts.comment;
    const submitBtn = $('#openGhModalBtn');
    if (submitBtn) {
      submitBtn.textContent = `Publish to GitHub (${publishCount})`;
    }
  }

  function formatDocumentTitle(rep) {
    if (!rep) return 'CRV PR Review Workbench';
    const urlMatch = /github\.com\/([^/]+\/([^/]+))\/pull\/(\d+)/i.exec(rep.PR?.url || '');
    const rawRepo = rep.REVIEW?.repo || (urlMatch ? urlMatch[1] : '');
    const repoShort = rawRepo ? rawRepo.split('/').pop() : urlMatch ? urlMatch[2] : '';
    const rawTitle = String(rep.XMETA?.title || '').trim();
    const titlePrMatch = /^PR\s*#(\d+)/i.exec(rawTitle);
    const labelPrMatch = /#(\d+)/.exec(rep.PR?.label || '');
    const prNum =
      rep.REVIEW?.pr ||
      (urlMatch ? urlMatch[3] : '') ||
      (titlePrMatch ? titlePrMatch[1] : '') ||
      (labelPrMatch ? labelPrMatch[1] : '');
    const cleanTitle = rawTitle.replace(/^PR\s*#\d+\s*[:—–-]\s*/i, '').trim();

    const prefixParts = [];
    if (prNum) prefixParts.push(`#${prNum}`);
    if (repoShort) prefixParts.push(repoShort);
    const prefix = prefixParts.join(' · ');

    if (prefix && cleanTitle) return `${prefix} — ${cleanTitle}`;
    if (prefix) return `${prefix} — CRV Workbench`;
    return rawTitle || 'CRV PR Review Workbench';
  }

  function renderHeader() {
    if (!report) return;
    $('#prTitle').textContent = report.XMETA?.title || 'PR Review Workbench';
    document.title = formatDocumentTitle(report);
    const prLinkHolder = $('#prLinkHolder');
    if (report.PR?.url) {
      prLinkHolder.innerHTML = `<a class="prlink" href="${escapeHtml(report.PR.url)}" target="_blank" rel="noopener">🔗 ${escapeHtml(report.PR.label || 'View PR')}</a>`;
    }
    updateHeaderCounts();
  }

  function renderLayerNav() {
    const findingsCount = report?.DATA?.length || 0;
    const contractsCount = (report?.LAYERS?.contracts?.length || 0) + (report?.LAYERS?.flows?.length || 0);
    const testsCount = report?.LAYERS?.testMatrix?.length || 0;
    const lensesCount = report?.LENSES?.length || report?.REVIEW?.lenses?.length || 14;

    const nav = $('#layerNav');
    if (!nav) return;

    const items = [
      { id: 'overview', label: '1. Intent & Arch', badge: `${lensesCount} lenses` },
      { id: 'findings', label: '2. Risk Findings', badge: String(findingsCount) },
      { id: 'contracts', label: '3. Contracts & Flows', badge: String(contractsCount) },
      { id: 'tests', label: '4. Test Matrix', badge: String(testsCount) }
    ];

    nav.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="layer-btn${activeLayer === it.id ? ' on' : ''}" data-layer="${it.id}">
            <span>${escapeHtml(it.label)}</span>
            <span class="lbadge num">${escapeHtml(it.badge)}</span>
          </button>`
      )
      .join('');
  }

  function renderRack() {
    renderLayerNav();
    renderGuideRadar();
    const issues = report?.DATA || [];
    const todoCount = issues.filter((d) => !getTriage(d.id).done).length;
    const triagedCount = issues.length - todoCount;

    const tabsEl = $('#tabs');
    if (tabsEl) {
      const tabs = [
        ['todo', 'Untriaged', todoCount],
        ['triaged', 'Triaged', triagedCount],
        ['all', 'All Findings', issues.length]
      ];
      tabsEl.innerHTML = tabs
        .map(
          ([k, label, cnt]) =>
            `<button type="button" class="${activeTab === k ? 'on' : ''}" data-tab="${k}">
              ${label} <span class="cnt num">${cnt}</span>
            </button>`
        )
        .join('');
    }

    const filtersEl = $('#filters');
    if (filtersEl) {
      const order = report?.ORDER || ['high', 'medium', 'low', 'struct'];
      const sevMeta = report?.SEV || {};
      let fh = `<button type="button" data-f="all" class="${activeFilter === 'all' ? 'on' : ''}">All</button>`;
      for (const sev of order) {
        if (issues.some((d) => d.sev === sev)) {
          fh += `<button type="button" data-f="${sev}" class="${activeFilter === sev ? 'on' : ''}">
            <i style="background:var(--s-${sev})"></i>${escapeHtml(sevMeta[sev]?.l || sev)}
          </button>`;
        }
      }
      filtersEl.innerHTML = fh;
    }

    const filtered = issues.filter((d) => {
      if (activeFilter !== 'all' && d.sev !== activeFilter) return false;
      if (activeTab === 'todo') return !getTriage(d.id).done;
      if (activeTab === 'triaged') return Boolean(getTriage(d.id).done);
      return true;
    });

    const listToShow = filtered.length > 0 ? filtered : issues.filter((d) => activeFilter === 'all' || d.sev === activeFilter);
    const racksEl = $('#racks');
    if (!racksEl) return;

    let html = '';
    if (activeTab === 'todo' && filtered.length === 0 && issues.length > 0) {
      html += `<div class="racksep"><span>All findings triaged — showing full list</span></div>`;
    }

    for (const d of listToShow) {
      const t = getTriage(d.id);
      const isSel = activeLayer === 'findings' && currentId === d.id;
      const isDismissed = t.action === 'dismiss';
      const chipLabel =
        t.action === 'block' ? 'BLOCK' : t.action === 'comment' ? 'CMT' : t.action === 'dismiss' ? 'SKIP' : '';

      html += `<div class="strip${isSel ? ' sel' : ''}${isDismissed ? ' dismissed' : ''}" data-id="${escapeHtml(d.id)}" style="${sevVars(d.sev)}">
        <span class="id num">${escapeHtml(d.id)}</span>
        <span class="stitle">${formatInlineCode(d.title)}</span>
        <span class="smeta">
          ${t.note ? '<span title="Has human reviewer note">📝</span>' : ''}
          ${chipLabel ? `<span class="triage-chip ${t.action}">${chipLabel}</span>` : ''}
        </span>
      </div>`;
    }

    racksEl.innerHTML = html;
  }

  function triggerMermaidRender() {
    if (typeof mermaid === 'undefined') return;
    const isDark =
      document.querySelector('meta[name="color-scheme"]')?.content === 'dark' ||
      (document.querySelector('meta[name="color-scheme"]')?.content !== 'light' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: isDark ? 'dark' : 'neutral',
        fontFamily: '"Open Sans", system-ui, sans-serif',
        flowchart: { useMaxWidth: true, htmlLabels: true },
        sequence: { useMaxWidth: true },
        state: { useMaxWidth: true },
        class: { useMaxWidth: true },
        er: { useMaxWidth: true }
      });
      const nodes = document.querySelectorAll('#pane .mermaid');
      if (nodes.length > 0) {
        mermaid.run({ nodes });
      }
    } catch (e) {}
  }

  function renderDiffSliceHtml(slice, prUrl) {
    if (!slice || !Array.isArray(slice.lines)) return '';
    const rows = slice.lines
      .map((l) => {
        const rowClass = (l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx') + (l.highlight ? ' hl' : '');
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        const ln = l.newNumber ?? l.oldNumber ?? '';
        return `<tr class="${rowClass}">
          <td class="ln num">${ln}</td>
          <td class="sign">${sign}</td>
          <td class="code">${escapeHtml(l.content)}</td>
        </tr>`;
      })
      .join('');

    return `<div class="diff-box">
      <div class="diff-head">
        <span>📄 ${escapeHtml(slice.path)}:${slice.targetLine}</span>
        <span>${escapeHtml(slice.hunkHeader || '')}</span>
      </div>
      <table class="diff-table"><tbody>${rows}</tbody></table>
    </div>`;
  }

  function renderOverviewLayer() {
    const s = report?.SUMMARY || {};
    const rev = report?.REVIEW || {};
    const issues = report?.DATA || [];
    const highMed = issues.filter((d) => d.sev === 'high' || d.sev === 'medium');
    const verifiedHighMed = highMed.filter((d) => d.verify === 'CONFIRMED' || d.verify === 'PLAUSIBLE');
    const verifyText = highMed.length > 0
      ? `✓ ${verifiedHighMed.length} / ${highMed.length} High & Medium Findings Verified`
      : issues.length > 0
        ? `✓ ${issues.length} Findings Loaded`
        : '✓ 4-Layer Diff Decomposition Ready';
    const points = (s.points || [])
      .map((p) => `<li><code>${escapeHtml(p.split(':')[0])}</code>:${escapeHtml(p.split(':').slice(1).join(':'))}</li>`)
      .join('');

    const signals = report?.LAYERS?.attentionSignals || {};
    const removedGuards = signals.removedGuards || [];
    const stealthChanges = signals.stealthChanges || [];
    const reuseCandidates = signals.reuseCandidates || [];
    const shortcuts = signals.shortcuts || [];
    const specAlignment = signals.specAlignment || {};
    const negViolations = specAlignment.negativeSpaceViolations || [];
    const specClauses = specAlignment.specClauses || [];
    const hasSignals =
      removedGuards.length > 0 ||
      stealthChanges.length > 0 ||
      reuseCandidates.length > 0 ||
      shortcuts.length > 0 ||
      negViolations.length > 0 ||
      specClauses.length > 0;
    const lensesCount = report?.LENSES?.length || report?.REVIEW?.lenses?.length || 14;
    const leanSavedLinesTotal =
      s.leanSavedLinesTotal ??
      report?.LAYERS?.leanSavedLinesTotal ??
      issues
        .filter((x) => !report?.STAT?.[x.status?.state || 'open']?.r)
        .reduce((acc, x) => acc + (Number(x.leanSavedLines) || 0), 0);

    const signalsHtml = hasSignals
      ? `<div class="sec">
          <h4>AI Attention, Spec Alignment &amp; Shortcut Ledger (Automated Diff Pre-Scan)</h4>
          <div class="layer-card" style="padding:10px 14px;">
            <ul class="prose" style="margin:0;padding-left:18px;">
              ${negViolations
                .map(
                  (nv) =>
                    `<li>🚫 <strong>Negative-Space / Out-of-Scope Violation:</strong> <code>${escapeHtml(nv.path)}</code> — ${escapeHtml(nv.reason)}</li>`
                )
                .join('')}
              ${removedGuards
                .map(
                  (g) =>
                    `<li>🛡️ <strong>Removed Guard (${escapeHtml(g.category)}):</strong> <code>${escapeHtml(g.path)}:${g.newLine}</code> — deleted <code>${escapeHtml(g.code)}</code></li>`
                )
                .join('')}
              ${stealthChanges
                .map(
                  (sc) =>
                    `<li>🕵️ <strong>Unmentioned High-Blast-Radius Change:</strong> <code>${escapeHtml(sc.path)}</code> — ${escapeHtml(sc.reason)}</li>`
                )
                .join('')}
              ${reuseCandidates
                .map(
                  (rc) =>
                    `<li>♻️ <strong>Near-Duplicate Utility Candidate:</strong> <code>${escapeHtml(rc.name)}</code> added in <code>${escapeHtml(rc.addedIn)}</code> overlaps <code>${escapeHtml((rc.existingMatches || []).join(', '))}</code></li>`
                )
                .join('')}
              ${shortcuts
                .map((sh) =>
                  sh.hasTrigger
                    ? `<li>📌 <strong>Bounded Shortcut (<code>${escapeHtml(sh.marker)}</code>):</strong> <code>${escapeHtml(sh.path)}:${sh.line}</code> — ceiling: <em>${escapeHtml(sh.ceiling)}</em> → upgrade: <em>${escapeHtml(sh.upgrade)}</em></li>`
                    : `<li>⚠️ <strong>Unbounded Deferral / Rot Risk (<code>${escapeHtml(sh.marker)}</code>):</strong> <code>${escapeHtml(sh.path)}:${sh.line}</code> — <code>${escapeHtml(sh.text)}</code> (missing ceiling &amp; upgrade trigger)</li>`
                )
                .join('')}
              ${specClauses
                .map((cl) =>
                  cl.covered
                    ? `<li>✅ <strong>${escapeHtml(cl.kind)} Clause Covered:</strong> ${escapeHtml(cl.clause)} <code>(${escapeHtml((cl.matchedTests || [])[0] || 'tested')})</code></li>`
                    : `<li>⚠️ <strong>Uncovered ${escapeHtml(cl.kind)} Clause:</strong> ${escapeHtml(cl.clause)} — no matching test detected in Layer 4</li>`
                )
                .join('')}
            </ul>
          </div>
        </div>`
      : '';

    return `<div class="panein">
      <div class="triage-card">
        <div class="triage-card-label">
          <span>⚡ <strong>Human-in-the-Loop Triage Presets</strong> — Curate what gets posted to GitHub PR #${escapeHtml(rev.pr || '1230')}</span>
        </div>
        <div class="triage-actions">
          <button type="button" class="btn" id="presetHighOnlyBtn">Block Highs Only · Dismiss Rest</button>
          <button type="button" class="btn" id="presetRecommendedBtn">Block Highs · Comment Medium/Design</button>
        </div>
      </div>

      <div class="fhead">
        <div class="fmeta">
          <span class="verify-pill">${escapeHtml(verifyText)}</span>
          ${leanSavedLinesTotal > 0 ? `<span class="tpill">✂️ Lean: -${leanSavedLinesTotal} lines cuttable</span>` : ''}
          <span>Agent: <strong>${escapeHtml(rev.agent || 'Antigravity')}</strong> (${escapeHtml(rev.model || 'Claude Opus 4.6')})</span>
          <span>Head: <code>${escapeHtml((rev.head || '').slice(0, 8))}</code></span>
        </div>
        <h2 class="ftitle">Layer 1: Intent, Architecture & Verification Summary</h2>
      </div>

      <div class="prose">${s.html || ''}</div>

      ${signalsHtml}

      <div class="sec">
        <h4>${lensesCount}-Lens Verification Matrix</h4>
        <ul class="prose">${points}</ul>
      </div>
    </div>`;
  }

  function renderContractsAndFlowsLayer() {
    const contracts = report?.LAYERS?.contracts || [];
    const flows = report?.LAYERS?.flows || [];

    const contractCards = contracts
      .map((c) => {
        const diffSum = c.diffSummary || c.summary || '';
        const linked = c.linkedFindings || c.findings || [];
        const owners = c.owners || [];
        const blast = c.callerBlastRadius || null;
        const blastHtml =
          blast && Array.isArray(blast.callers) && blast.callers.length > 0
            ? `<div style="margin:6px 0 8px;font-size:12px;color:var(--ink-2);">
                <strong>External Callers (${blast.callers.length}):</strong>
                ${blast.callers
                  .map((cl) => {
                    const callerPath = typeof cl === 'string' ? cl : cl?.path || '';
                    const callerOwners = Array.isArray(cl?.owners) ? cl.owners : [];
                    return `<code style="margin-right:6px;">${escapeHtml(callerPath)}${
                      callerOwners.length
                        ? ` (${escapeHtml(callerOwners.join(', '))})`
                        : blast.unownedCallersCount > 0 && typeof cl === 'object'
                          ? ' (unowned)'
                          : ''
                    }</code>`;
                  })
                  .join('')}
              </div>`
            : '';
        return `<div class="layer-card">
          <div class="layer-card-header">
            <h3 class="layer-card-title"><code>${escapeHtml(c.path)}</code></h3>
            <div style="display:flex;gap:6px;align-items:center;">
              ${owners.length ? `<span class="tpill">${escapeHtml(owners.join(', '))}</span>` : ''}
              <span class="status-badge solid">${escapeHtml(c.category || 'Contract')}</span>
            </div>
          </div>
          <p style="margin:4px 0 8px;color:var(--ink-2)">${escapeHtml(c.summary || '')}</p>
          ${diffSum ? `<div style="font:400 12px var(--mono);background:var(--well);padding:6px 10px;border-radius:4px;margin-bottom:8px;">
            ${escapeHtml(diffSum)}
          </div>` : ''}
          ${blastHtml}
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;">
            <strong style="color:var(--muted)">Linked Findings:</strong>
            ${linked.length
              ? linked
                  .map(
                    (fid) =>
                      `<button type="button" class="btn" style="height:24px;padding:0 8px;font-size:11px;" data-jump-finding="${escapeHtml(fid)}">Jump to ${escapeHtml(fid)}</button>`
                  )
                  .join('')
              : '<span style="color:var(--muted)">None</span>'}
          </div>
        </div>`;
      })
      .join('');

    const flowCards = flows
      .map((f) => {
        const title = f.title || f.name || 'Execution Flow';
        const desc = f.description || f.summary || '';
        const linked = f.linkedFindings || f.findings || [];
        return `<div class="layer-card">
          <div class="layer-card-header">
            <h3 class="layer-card-title">${escapeHtml(title)}</h3>
            <span class="tpill">${(f.files || []).length} files</span>
          </div>
          <p style="margin:4px 0 8px;color:var(--ink-2)">${escapeHtml(desc)}</p>
          <ul style="margin:0 0 10px;padding-left:18px;font:400 12px/1.6 var(--mono);color:var(--ink-2)">
            ${(f.files || []).map((file) => `<li>${escapeHtml(file)}</li>`).join('')}
          </ul>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;">
            <strong style="color:var(--muted)">Findings in this Flow:</strong>
            ${linked.length
              ? linked
                  .map(
                    (fid) =>
                      `<button type="button" class="btn" style="height:24px;padding:0 8px;font-size:11px;" data-jump-finding="${escapeHtml(fid)}">${escapeHtml(fid)}</button>`
                  )
                  .join('')
              : '<span style="color:var(--muted)">None</span>'}
          </div>
        </div>`;
      })
      .join('');

    return `<div class="panein">
      <div class="fhead">
        <div class="fmeta">
          <span class="verify-pill">Human-Leverage View</span>
          <span>Prioritizes API/Event contracts, ADRs, and story-ordered execution flows over alphabetical diffs</span>
        </div>
        <h2 class="ftitle">Layer 3: Contracts, Schemas & Story-Ordered Flows</h2>
      </div>
      <div class="sec">
        <h4>Public Contracts, Schemas, Feature Flags & ADRs (${contracts.length})</h4>
        ${contractCards || '<p style="color:var(--muted)">No contract or schema files modified in this diff.</p>'}
      </div>
      <div class="sec">
        <h4>Story-Ordered Production Flows (${flows.length})</h4>
        ${flowCards || '<p style="color:var(--muted)">No production flow files modified in this diff.</p>'}
      </div>
    </div>`;
  }

  function renderTestMatrixLayer() {
    const matrix = report?.LAYERS?.testMatrix || [];
    const cards = matrix
      .map((suite) => {
        const scenarios = suite.scenarios || suite.cases || [];
        const totalCases = suite.totalCases ?? scenarios.length;
        const assertionsCount =
          suite.assertionsCount ?? scenarios.reduce((sum, c) => sum + (c.assertions || 0), 0);
        const linked = suite.linkedFindings || suite.findings || [];

        const rows = scenarios
          .map((sc) => {
            const st =
              sc.status ||
              (sc.hollow
                ? 'hollow'
                : sc.tautology
                  ? 'tautology'
                  : sc.internalMock
                    ? 'internal-mock'
                    : sc.mockOnly
                      ? 'flawed-spec'
                      : 'solid');
            const note =
              sc.note ||
              (sc.hollow
                ? 'Zero assertions detected in test body'
                : sc.tautology
                  ? 'Oracle tautology: asserts literal constant rather than computed behavior'
                  : sc.internalMock
                    ? 'Mocks internal relative seam'
                    : sc.mockOnly
                      ? 'Mock-only assertions'
                      : '');
            return `<tr>
              <td>${escapeHtml(sc.behavior)}${note ? `<div style="color:var(--s-high-ink);font-size:11.5px;margin-top:2px;">⚠️ ${escapeHtml(note)}</div>` : ''}</td>
              <td class="num" style="text-align:center;font-weight:700;">${sc.assertions ?? 0}</td>
              <td><span class="status-badge ${escapeHtml(st)}">${escapeHtml(st)}</span></td>
            </tr>`;
          })
          .join('');

        return `<div class="layer-card">
          <div class="layer-card-header">
            <div>
              <h3 class="layer-card-title">${escapeHtml(suite.suite || suite.file)}</h3>
              <div style="font:400 11.5px var(--mono);color:var(--muted)">${escapeHtml(suite.file)}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <span class="tpill num">${totalCases} tests · ${assertionsCount} assertions</span>
              ${linked
                .map(
                  (fid) =>
                    `<button type="button" class="btn" style="height:24px;padding:0 8px;font-size:11px;" data-jump-finding="${escapeHtml(fid)}">See ${escapeHtml(fid)}</button>`
                )
                .join('')}
            </div>
          </div>
          <table class="matrix-table">
            <thead>
              <tr>
                <th>Tested Behavior / Scenario</th>
                <th style="width:95px;text-align:center;">Assertions</th>
                <th style="width:120px;">Verdict</th>
              </tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="3" style="color:var(--muted)">No individual test cases parsed from diff hunks.</td></tr>'}</tbody>
          </table>
          <details style="margin-top:10px;font-size:12px;color:var(--muted)">
            <summary style="cursor:pointer;font-weight:600;">Raw AI-generated unit test boilerplate collapsed by default (click to inspect)</summary>
            <div style="margin-top:6px;padding:8px 10px;background:var(--well);border-radius:4px;font-family:var(--mono);overflow-x:auto;">
              ${suite.rawDiff
                ? `<pre style="margin:0;white-space:pre-wrap;font:400 11.5px/1.45 var(--mono);color:var(--ink-2);">${escapeHtml(suite.rawDiff)}</pre>`
                : `Raw mock setup in <code>${escapeHtml(suite.file)}</code> is hidden so human reviewers can focus on behavioral coverage and assertion gaps above.`}
            </div>
          </details>
        </div>`;
      })
      .join('');

    return `<div class="panein">
      <div class="fhead">
        <div class="fmeta">
          <span class="verify-pill">AI Test Boilerplate Collapsed</span>
          <span>Audits what behaviors are actually asserted instead of scrolling 1,000+ lines of mock setup</span>
        </div>
        <h2 class="ftitle">Layer 4: Behavioral Test Matrix & Assertion Audit</h2>
      </div>
      ${cards}
    </div>`;
  }

  function renderFindingLayer() {
    const issues = report?.DATA || [];
    const d = issues.find((item) => item.id === currentId) || issues[0];
    if (!d) return '<div class="panein"><p>No findings loaded.</p></div>';
    currentId = d.id;

    const t = getTriage(d.id);
    const sevMeta = report?.SEV?.[d.sev] || { l: d.sev };
    const earlierLinks = (d.earlier || [])
      .map(
        (e) =>
          `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener" class="tpill" style="text-decoration:none;">💬 Earlier thread by ${escapeHtml(e.who)}</a>`
      )
      .join(' ');

    const mermaidHtml = d.mermaid
      ? `<div class="diaslot"><div class="mermaid">${escapeHtml(d.mermaid)}</div></div>`
      : '';

    return `<div class="panein" style="${sevVars(d.sev)}">
      <div class="triage-card">
        <div class="triage-card-label">
          <span>GitHub Review Decision for <code>${escapeHtml(d.id)}</code>:</span>
        </div>
        <div class="triage-actions">
          <button type="button" class="tbtn${t.action === 'block' ? ' on' : ''}" data-triage="block" title="Shortcut: b">
            🚫 Block (Must Fix)
          </button>
          <button type="button" class="tbtn${t.action === 'comment' ? ' on' : ''}" data-triage="comment" title="Shortcut: m">
            💬 Comment / Nit
          </button>
          <button type="button" class="tbtn${t.action === 'dismiss' ? ' on' : ''}" data-triage="dismiss" title="Shortcut: x">
            🔇 Dismiss (Skip)
          </button>
          <button type="button" class="btn" id="copyFixPromptBtn" title="Copy structured fix instruction for your Coding Agent">
            🤖 Copy Agent Fix Prompt
          </button>
        </div>
      </div>

      <div class="fhead">
        <div class="fmeta">
          <span class="badge">${escapeHtml(d.id)} · ${escapeHtml(sevMeta.l)}</span>
          ${d.verify ? `<span class="verify-pill">✓ ${escapeHtml(d.verify)}</span>` : ''}
          ${d.leanSavedLines > 0 ? `<span class="tpill">✂️ -${d.leanSavedLines} lines cuttable</span>` : ''}
          <span>Lenses: <strong>${escapeHtml(d.cat || 'general')}</strong></span>
          ${earlierLinks}
        </div>
        <h2 class="ftitle">${formatInlineCode(d.title)}</h2>
        ${d.loc ? `<div class="floc">📍 ${escapeHtml(d.loc)}</div>` : ''}
      </div>

      ${renderDiffSliceHtml(d.diffSlice, report?.PR?.url)}

      <div class="sec">
        <h4>Impact (Breaks · Because · Reach)</h4>
        <div class="prose">${d.impact || ''}</div>
      </div>

      ${mermaidHtml}

      <div class="sec">
        <h4>Recommended Fix (Do · Check)</h4>
        <div class="prose fixbox">${d.fix || ''}</div>
        ${
          d.suggestion
            ? `<div style="margin-top:10px;padding:10px 12px;border-radius:6px;border:1px solid var(--rule);background:var(--well);">
                <div style="font:700 11px var(--mono);color:var(--muted);margin-bottom:4px;">SURGICAL GITHUB SUGGESTION (1-CLICK COMMITTABLE IN PR)</div>
                <pre style="margin:0;white-space:pre-wrap;font:400 12px/1.45 var(--mono);color:var(--ink);">${escapeHtml(d.suggestion)}</pre>
              </div>`
            : ''
        }
      </div>

      ${
        d.reasoning
          ? `<div class="sec">
              <h4>Verifier & Evidence</h4>
              <div class="prose">${d.reasoning}</div>
            </div>`
          : ''
      }

      ${
        report?.GITHUB_STATE?.findingThreads?.[d.id]?.replies?.length
          ? `<div class="sec">
              <h4>GitHub PR Thread Replies (${report.GITHUB_STATE.findingThreads[d.id].replies.length})</h4>
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${report.GITHUB_STATE.findingThreads[d.id].replies
                  .map(
                    (rep) => `<div style="padding:8px 12px;border-radius:6px;border:1px solid var(--rule);background:var(--surface);font-size:12.5px;">
                      <div style="font-weight:700;color:var(--ink-2);margin-bottom:4px;">
                        @${escapeHtml(rep.author || 'reviewer')}
                        ${rep.createdAt ? `<span style="font-weight:400;color:var(--muted);margin-left:6px;">${escapeHtml(rep.createdAt)}</span>` : ''}
                      </div>
                      <div style="white-space:pre-wrap;">${escapeHtml(rep.body || '')}</div>
                    </div>`
                  )
                  .join('')}
              </div>
            </div>`
          : ''
      }

      <div class="note-box">
        <label for="findingNoteInput">Human Reviewer Note (Included in GitHub PR inline comment & Coding Agent prompt):</label>
        <textarea id="findingNoteInput" placeholder="Add context for the PR author or instructions for the coding agent...">${escapeHtml(t.note || '')}</textarea>
      </div>
    </div>`;
  }

  function renderPane() {
    const paneEl = $('#pane');
    if (!paneEl) return;

    if (activeLayer === 'overview') {
      paneEl.innerHTML = renderOverviewLayer();
    } else if (activeLayer === 'contracts') {
      paneEl.innerHTML = renderContractsAndFlowsLayer();
    } else if (activeLayer === 'tests') {
      paneEl.innerHTML = renderTestMatrixLayer();
    } else {
      paneEl.innerHTML = renderFindingLayer();
    }

    bindPaneEvents();
    triggerMermaidRender();
  }

  function bindPaneEvents() {
    document.querySelectorAll('[data-triage]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setTriageAction(currentId, btn.dataset.triage);
      });
    });

    const noteInput = $('#findingNoteInput');
    if (noteInput) {
      noteInput.addEventListener('input', () => {
        setTriageNote(currentId, noteInput.value);
      });
    }

    const copyFixBtn = $('#copyFixPromptBtn');
    if (copyFixBtn) {
      copyFixBtn.addEventListener('click', async () => {
        const issues = report?.DATA || [];
        const d = issues.find((item) => item.id === currentId) || issues[0];
        if (!d) return;
        const t = getTriage(d.id);
        const promptLines = d.fixPrompt
          ? [d.fixPrompt, t.note ? `\nReviewer note: ${t.note}` : ''].filter(Boolean)
          : [
              `Fix finding ${d.id} (${String(d.sev || '').toUpperCase()}) at \`${d.loc || 'PR'}\`: ${d.title}`,
              '',
              stripHtmlToMd(d.impact),
              '',
              stripHtmlToMd(d.fix),
              d.suggestion ? `\nSuggested replacement:\n\`\`\`\n${d.suggestion}\n\`\`\`` : '',
              t.note ? `\nReviewer note: ${t.note}` : ''
            ].filter(Boolean);
        try {
          await navigator.clipboard.writeText(promptLines.join('\n').trim());
          copyFixBtn.textContent = '✓ Copied Agent Fix Prompt!';
          setTimeout(() => {
            copyFixBtn.textContent = '🤖 Copy Agent Fix Prompt';
          }, 1800);
        } catch (err) {}
      });
    }

    document.querySelectorAll('[data-jump-finding]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentId = btn.dataset.jumpFinding;
        activeLayer = 'findings';
        renderRack();
        renderPane();
      });
    });

    const presetHighBtn = $('#presetHighOnlyBtn');
    if (presetHighBtn) {
      presetHighBtn.addEventListener('click', () => {
        for (const d of report.DATA || []) {
          triage[d.id] = {
            ...getTriage(d.id),
            action: d.sev === 'high' ? 'block' : 'dismiss',
            done: true
          };
        }
        saveTriage();
        renderRack();
        renderPane();
      });
    }

    const presetRecBtn = $('#presetRecommendedBtn');
    if (presetRecBtn) {
      presetRecBtn.addEventListener('click', () => {
        for (const d of report.DATA || []) {
          triage[d.id] = {
            ...getTriage(d.id),
            action: d.sev === 'high' ? 'block' : 'comment',
            done: true
          };
        }
        saveTriage();
        renderRack();
        renderPane();
      });
    }
  }

  function buildGitHubPreviewPayload() {
    const issues = report?.DATA || [];
    const published = issues.filter((d) => {
      const a = getTriage(d.id).action;
      return a === 'block' || a === 'comment';
    });
    const selectedEvent =
      document.querySelector('input[name="ghReviewEvent"]:checked')?.value || 'REQUEST_CHANGES';
    const summaryNote = $('#ghSummaryNote')?.value || '';

    const inlineComments = [];
    const outOfHunkBodies = [];
    for (const d of published) {
      const t = getTriage(d.id);
      const locMatch = /^(.+):(\d+)(?:-(\d+))?$/.exec(String(d.loc || '').trim());
      const filePath = locMatch ? locMatch[1] : String(d.loc || '').trim();
      const lineNum = locMatch ? Number(locMatch[2]) : 1;
      const meta = {
        v: 1,
        id: d.id,
        sev: d.sev,
        cat: d.cat || '',
        verify: d.verify || '',
        action: t.action,
        loc: d.loc || '',
        title: d.title || '',
        head: report?.REVIEW?.head || '',
        pr: report?.REVIEW?.pr || null
      };
      const bodyParts = [
        `<!-- crv-finding: ${JSON.stringify(meta)} -->`,
        `### ${t.action === 'block' ? '🚫 **BLOCKING**' : '💬 **COMMENT**'} \`${d.id}\` (${d.sev.toUpperCase()}) — ${d.title}`,
        t.note ? `\n> **Reviewer Note:** ${t.note}\n` : '',
        stripHtmlToMd(d.impact),
        '',
        stripHtmlToMd(d.fix),
        d.suggestion ? `\n\`\`\`suggestion\n${String(d.suggestion).replace(/\r?\n$/, '')}\n\`\`\`` : ''
      ];
      if (d.mermaid) {
        bodyParts.push(
          '',
          '<details>',
          '<summary>Architecture / Flow Diagram & Reasoning</summary>',
          '',
          '```mermaid',
          d.mermaid.trim(),
          '```',
          d.reasoning ? `\n${stripHtmlToMd(d.reasoning)}` : '',
          '</details>'
        );
      } else if (d.reasoning) {
        bodyParts.push(
          '',
          '<details>',
          '<summary>Verification & Reasoning</summary>',
          '',
          stripHtmlToMd(d.reasoning),
          '</details>'
        );
      }

      const fullBody = bodyParts.filter(Boolean).join('\n');
      let targetLine = lineNum || 1;
      let canPostInline = Boolean(filePath);
      if (d.diffSlice && Array.isArray(d.diffSlice.lines)) {
        const rightLines = d.diffSlice.lines
          .map((l) => l.newNumber)
          .filter((n) => Number.isFinite(n));
        if (rightLines.length === 0) {
          canPostInline = false;
        } else if (!rightLines.includes(targetLine)) {
          targetLine = rightLines[0];
        }
      } else if ('diffSlice' in d && !d.diffSlice) {
        canPostInline = false;
      }

      if (canPostInline) {
        inlineComments.push({
          path: filePath,
          line: targetLine,
          side: 'RIGHT',
          body: fullBody
        });
      } else {
        outOfHunkBodies.push(fullBody);
      }
    }

    const counts = { block: 0, comment: 0, dismiss: 0, pending: 0 };
    for (const d of issues) {
      const act = getTriage(d.id).action || 'pending';
      counts[act] = (counts[act] || 0) + 1;
    }

    const overviewMeta = {
      v: 1,
      repo: report?.REVIEW?.repo || '',
      pr: report?.REVIEW?.pr || 0,
      head: report?.REVIEW?.head || '',
      counts,
      triage: Object.fromEntries(
        issues.map((d) => [d.id, { action: getTriage(d.id).action, done: Boolean(getTriage(d.id).done), note: getTriage(d.id).note }])
      )
    };

    const overviewLines = [
      `<!-- crv-meta: ${JSON.stringify(overviewMeta)} -->`,
      `## 🛡️ Agentic PR Review Workbench — ${report?.PR?.label || `PR #${overviewMeta.pr || ''}`}`,
      '',
      summaryNote ? `${summaryNote.trim()}\n` : '',
      `| Triage Status | Count | Description |`,
      `| :--- | :---: | :--- |`,
      `| 🚫 **Blocking** | **${counts.block}** | Must be resolved before merge |`,
      `| 💬 **Comment / Nit** | **${counts.comment}** | Non-blocking suggestions & design candidates |`,
      `| 🔇 **Dismissed** | **${counts.dismiss}** | Filtered out by human reviewer |`,
      `| ⏳ **Pending Triage** | **${counts.pending}** | Awaiting human review |`
    ].filter(Boolean);

    if (outOfHunkBodies.length > 0) {
      overviewLines.push('', '---', '### Findings Outside Diff Hunks', '', outOfHunkBodies.join('\n\n---\n\n'));
    }

    const rawHead = String(report?.REVIEW?.head || '').trim();
    const reviewPayload = {
      event: selectedEvent,
      body: overviewLines.join('\n').trim(),
      comments: inlineComments
    };
    if (/^[0-9a-f]{40}$/i.test(rawHead)) {
      reviewPayload.commit_id = rawHead;
    }

    return reviewPayload;
  }

  function updateModalPreview() {
    const payload = buildGitHubPreviewPayload();
    const previewEl = $('#ghPayloadPreview');
    if (previewEl) {
      previewEl.textContent = JSON.stringify(payload, null, 2);
    }
    const statsEl = $('#ghModalStats');
    if (statsEl) {
      statsEl.textContent = `${payload.comments.length} inline PR review thread comments + 1 sticky crv-meta overview comment`;
    }
  }

  function buildAgentPromptExport() {
    const issues = (report?.DATA || []).filter((d) => {
      const a = getTriage(d.id).action;
      return a === 'block' || a === 'comment' || getTriage(d.id).note;
    });
    const lines = [
      'Act on the curated PR review findings below.',
      `Pull request: ${report?.PR?.url || ''}`,
      `Head commit:  ${report?.REVIEW?.head || ''}`,
      `Curated:      ${issues.length} findings`,
      ''
    ];
    for (const d of issues) {
      const t = getTriage(d.id);
      lines.push('-'.repeat(76));
      lines.push(`${d.id} · ${d.sev.toUpperCase()} · Triage: ${t.action.toUpperCase()} · ${d.loc || ''}`);
      lines.push(d.title);
      if (t.note) lines.push(`Reviewer Instruction: ${t.note}`);
      if (d.impact) lines.push('', stripHtmlToMd(d.impact));
      if (d.fix) lines.push('', stripHtmlToMd(d.fix));
      if (d.reasoning) lines.push('', `Context: ${stripHtmlToMd(d.reasoning)}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function setupDialogAndTheme() {
    document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
      // Fallback for browsers without native closedby="any" support per modern-web-guidance
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        dialog.addEventListener('click', (event) => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          const isDialogContent =
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width;
          if (isDialogContent) return;
          dialog.close();
        });
      }

      dialog.addEventListener('close', () => {
        dialog.returnValue = '';
      });
    });

    // Two-state dark mode toggle per modern-web-guidance (`dark-mode-toggle`)
    const themeBtn = $('#themeToggleBtn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const meta = document.querySelector('meta[name="color-scheme"]');
        const stored = localStorage.getItem('color-scheme');
        const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const currentRendered = stored || (sysDark ? 'dark' : 'light');
        const target = currentRendered === 'dark' ? 'light' : 'dark';
        const sysScheme = sysDark ? 'dark' : 'light';

        if (target !== sysScheme) {
          localStorage.setItem('color-scheme', target);
          if (meta) meta.content = target;
        } else {
          localStorage.removeItem('color-scheme');
          if (meta) meta.content = 'light dark';
        }
        triggerMermaidRender();
      });
    }
  }

  function renderGuideRadar() {
    const radarEl = $('#guideLiveRadar');
    if (!radarEl) return;

    const issues = report?.DATA || [];
    const signals = report?.LAYERS?.attentionSignals || {};
    const contracts = report?.LAYERS?.contracts || [];
    const testMatrix = report?.LAYERS?.testMatrix || [];

    const plausibleIssues = issues.filter((d) => String(d.verify || '').toUpperCase() === 'PLAUSIBLE');
    const highIssues = issues.filter((d) => d.sev === 'high');
    const untriagedCount = issues.filter((d) => !getTriage(d.id).done).length;
    const removedGuards = signals.removedGuards || [];
    const stealthChanges = signals.stealthChanges || [];
    const shortcuts = signals.shortcuts || [];
    const rotRiskShortcuts = shortcuts.filter((s) => s.rotRisk || !s.hasTrigger);
    const negViolations = signals.specAlignment?.negativeSpaceViolations || [];
    const uncoveredClauses = (signals.specAlignment?.specClauses || []).filter((c) => !c.covered);
    const unownedCallerContracts = contracts.filter(
      (c) => (c.callerBlastRadius?.unownedCallersCount || 0) > 0
    );
    const weakTestSuites = testMatrix.filter((tm) =>
      (tm.scenarios || tm.cases || []).some(
        (sc) => sc.hollow || sc.tautology || sc.internalMock || sc.mockOnly
      )
    );

    const radarItems = [];

    if (plausibleIssues.length > 0) {
      const firstId = plausibleIssues[0].id;
      radarItems.push({
        tone: 'warn',
        html: `<span>🔍 <strong>${plausibleIssues.length} <code>PLAUSIBLE</code> finding${plausibleIssues.length > 1 ? 's' : ''}</strong> need human domain verification (${plausibleIssues.map((x) => `<code>${escapeHtml(x.id)}</code>`).join(', ')})</span>
               <button type="button" class="btn guide-jump-btn" data-guide-finding="${escapeHtml(firstId)}">Inspect</button>`
      });
    }

    if (highIssues.length > 0) {
      const firstHigh = highIssues[0].id;
      radarItems.push({
        tone: 'high',
        html: `<span>🚫 <strong>${highIssues.length} High-Severity Blocker${highIssues.length > 1 ? 's' : ''}</strong> (${untriagedCount} total untriaged)</span>
               <button type="button" class="btn guide-jump-btn" data-guide-finding="${escapeHtml(firstHigh)}">Review</button>`
      });
    }

    if (removedGuards.length > 0 || negViolations.length > 0) {
      radarItems.push({
        tone: 'high',
        html: `<span>🛡️ <strong>${removedGuards.length} Removed Guard${removedGuards.length === 1 ? '' : 's'} · ${negViolations.length} Scope Violation${negViolations.length === 1 ? '' : 's'}</strong></span>
               <button type="button" class="btn guide-jump-btn" data-guide-layer="overview">Layer 1</button>`
      });
    }

    if (stealthChanges.length > 0 || rotRiskShortcuts.length > 0) {
      radarItems.push({
        tone: 'warn',
        html: `<span>🕵️ <strong>${stealthChanges.length} Stealth File${stealthChanges.length === 1 ? '' : 's'} · ${rotRiskShortcuts.length} Rot-Risk TODO${rotRiskShortcuts.length === 1 ? '' : 's'}</strong></span>
               <button type="button" class="btn guide-jump-btn" data-guide-layer="overview">Layer 1</button>`
      });
    }

    if (contracts.length > 0 || unownedCallerContracts.length > 0) {
      radarItems.push({
        tone: unownedCallerContracts.length > 0 ? 'warn' : 'normal',
        html: `<span>📜 <strong>${contracts.length} Public Contract${contracts.length === 1 ? '' : 's'}</strong>${unownedCallerContracts.length > 0 ? ` (${unownedCallerContracts.length} w/ unowned callers)` : ''}</span>
               <button type="button" class="btn guide-jump-btn" data-guide-layer="contracts">Layer 3</button>`
      });
    }

    if (weakTestSuites.length > 0 || uncoveredClauses.length > 0) {
      radarItems.push({
        tone: 'warn',
        html: `<span>🧪 <strong>${weakTestSuites.length} Weak/Mock-Only Suite${weakTestSuites.length === 1 ? '' : 's'} · ${uncoveredClauses.length} Uncovered Spec${uncoveredClauses.length === 1 ? '' : 's'}</strong></span>
               <button type="button" class="btn guide-jump-btn" data-guide-layer="tests">Layer 4</button>`
      });
    }

    if (radarItems.length === 0) {
      radarItems.push({
        tone: 'normal',
        html: `<span>✅ <strong>No automated red flags</strong> — spot-check Layer 1 intent &amp; Layer 3 contracts before approving.</span>
               <button type="button" class="btn guide-jump-btn" data-guide-layer="overview">Layer 1</button>`
      });
    }

    radarEl.innerHTML = `
      <div class="guide-radar-title">
        <span>⚡ What to Check on This PR</span>
        <span class="num">${radarItems.length} signal${radarItems.length === 1 ? '' : 's'}</span>
      </div>
      <ul class="guide-radar-list">
        ${radarItems
          .map(
            (it) =>
              `<li class="guide-radar-item ${it.tone === 'high' ? 'high' : it.tone === 'warn' ? 'warn' : ''}">${it.html}</li>`
          )
          .join('')}
      </ul>
    `;
  }

  function setupGuidePanel() {
    const appEl = $('#app');
    const panelEl = $('#guidePanel');
    const toggleBtn = $('#guideToggleBtn');
    const closeBtn = $('#guideCloseBtn');
    if (!appEl || !panelEl || !toggleBtn) return;

    function setGuideOpen(isOpen, persist = true) {
      if (isOpen) {
        panelEl.removeAttribute('hidden');
        appEl.classList.remove('guide-collapsed');
        toggleBtn.setAttribute('aria-expanded', 'true');
      } else {
        if ('onbeforematch' in HTMLElement.prototype) {
          panelEl.setAttribute('hidden', 'until-found');
        } else {
          panelEl.setAttribute('hidden', '');
        }
        appEl.classList.add('guide-collapsed');
        toggleBtn.setAttribute('aria-expanded', 'false');
      }
      if (persist) {
        try {
          localStorage.setItem('crv-guide-open', isOpen ? '1' : '0');
        } catch (e) {}
      }
    }

    // Restore saved state (defaults to open on first visit so reviewers see what to focus on)
    let initialOpen = true;
    try {
      const saved = localStorage.getItem('crv-guide-open');
      if (saved === '0') initialOpen = false;
    } catch (e) {}
    setGuideOpen(initialOpen, false);

    // Synchronize state when native Find-in-Page matches text inside the collapsed panel
    // per modern-web-guidance (`search-hidden-content`)
    panelEl.addEventListener('beforematch', () => {
      setGuideOpen(true, true);
    });

    toggleBtn.addEventListener('click', () => {
      const currentlyOpen = toggleBtn.getAttribute('aria-expanded') === 'true';
      setGuideOpen(!currentlyOpen, true);
    });

    closeBtn?.addEventListener('click', () => {
      setGuideOpen(false, true);
    });

    panelEl.addEventListener('click', (e) => {
      const layerBtn = e.target.closest('[data-guide-layer]');
      if (layerBtn) {
        activeLayer = layerBtn.dataset.guideLayer;
        renderRack();
        renderPane();
        return;
      }
      const findingBtn = e.target.closest('[data-guide-finding]');
      if (findingBtn) {
        currentId = findingBtn.dataset.guideFinding;
        activeLayer = 'findings';
        renderRack();
        renderPane();
      }
    });
  }

  function stepFinding(delta) {
    const issues = report?.DATA || [];
    if (!issues.length) return;
    const idx = issues.findIndex((d) => d.id === currentId);
    const nextIdx = Math.max(0, Math.min(issues.length - 1, (idx === -1 ? 0 : idx) + delta));
    currentId = issues[nextIdx].id;
    activeLayer = 'findings';
    renderRack();
    renderPane();
  }

  async function init() {
    if (!report) {
      try {
        const res = await fetch('/api/report');
        if (res.ok) {
          report = await res.json();
          ghConnected = true;
        }
      } catch (e) {}
    }

    loadTriage();
    renderHeader();
    renderRack();
    renderPane();
    setupDialogAndTheme();
    setupGuidePanel();

    $('#layerNav')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-layer]');
      if (!btn) return;
      activeLayer = btn.dataset.layer;
      renderRack();
      renderPane();
    });

    $('#tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      activeTab = btn.dataset.tab;
      renderRack();
    });

    $('#filters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-f]');
      if (!btn) return;
      activeFilter = btn.dataset.f;
      renderRack();
    });

    $('#racks')?.addEventListener('click', (e) => {
      const strip = e.target.closest('.strip[data-id]');
      if (!strip) return;
      currentId = strip.dataset.id;
      activeLayer = 'findings';
      renderRack();
      renderPane();
    });

    $('#prevBtn')?.addEventListener('click', () => stepFinding(-1));
    $('#nextBtn')?.addEventListener('click', () => stepFinding(1));

    const resizerEl = $('#resizer');
    if (resizerEl) {
      resizerEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        resizerEl.classList.add('drag');
        resizerEl.setPointerCapture(e.pointerId);
        const onMove = (ev) => {
          const guideW = $('#guidePanel')?.offsetWidth || 0;
          const w = Math.max(260, Math.min(window.innerWidth - guideW - 360, ev.clientX));
          document.documentElement.style.setProperty('--rack-w', `${w}px`);
        };
        const onUp = (ev) => {
          resizerEl.classList.remove('drag');
          try {
            resizerEl.releasePointerCapture(ev.pointerId);
          } catch {}
          resizerEl.removeEventListener('pointermove', onMove);
          resizerEl.removeEventListener('pointerup', onUp);
        };
        resizerEl.addEventListener('pointermove', onMove);
        resizerEl.addEventListener('pointerup', onUp);
      });
    }

    $('#copyAgentPromptBtn')?.addEventListener('click', async () => {
      const text = buildAgentPromptExport();
      await navigator.clipboard.writeText(text);
      const btn = $('#copyAgentPromptBtn');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied Agent Prompt';
      setTimeout(() => {
        btn.textContent = orig;
      }, 1600);
    });

    $('#openGhModalBtn')?.addEventListener('click', () => {
      const hasBlocker = (report?.DATA || []).some((d) => getTriage(d.id).action === 'block');
      const defaultEvent = hasBlocker ? 'REQUEST_CHANGES' : 'COMMENT';
      const radio = document.querySelector(`input[name="ghReviewEvent"][value="${defaultEvent}"]`);
      if (radio) radio.checked = true;
      updateModalPreview();
      $('#ghReviewDialog')?.showModal();
    });

    async function loadPrIntoWorkbench(prInput) {
      const statusEl = $('#loadPrStatus');
      const explicitRepo = ($('#repoConfigInput')?.value || '').trim();
      if (!prInput) return;
      try {
        if (statusEl) statusEl.textContent = `Fetching PR ${prInput} & decomposing 4 Layers via gh...`;
        const res = await fetch('/api/github/load-pr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prInput, repo: explicitRepo || undefined })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to load PR');
        }
        report = data.report;
        currentId = report?.DATA?.[0]?.id || OV;
        activeLayer = report?.DATA?.length ? 'findings' : 'overview';
        loadTriage();
        renderHeader();
        renderRack();
        renderPane();
        updateSkillPromptPreview();
        if (statusEl) statusEl.textContent = `✓ Loaded ${report?.XMETA?.title || prInput}`;
        setTimeout(() => {
          $('#switchPrDialog')?.close();
        }, 450);
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `⚠ ${err.message} (Make sure the local server is running via "npm start" or "crv pr <N>")`;
        }
      }
    }

    function updateSkillPromptPreview() {
      const url =
        report?.PR?.url ||
        `PR #${report?.REVIEW?.pr || ''} in ${report?.REVIEW?.repo || ($('#repoConfigInput')?.value || 'target repo')}`;
      const el = $('#skillPromptPreview');
      if (el) el.textContent = `Review ${url} with crv-code-review`;
    }

    async function syncRepoConfigInModal() {
      const repoInput = $('#repoConfigInput');
      const sourceBadge = $('#repoSourceBadge');
      const repoLabel = $('#recentPrsRepoLabel');
      try {
        const res = await fetch('/api/github/repo-config');
        const data = await res.json();
        if (res.ok && data.ok) {
          if (repoInput && !repoInput.value) repoInput.value = data.repo || report?.REVIEW?.repo || '';
          if (sourceBadge) sourceBadge.textContent = `source: ${data.source || 'none'}`;
          if (repoLabel) repoLabel.textContent = (repoInput && repoInput.value) || data.repo || 'default repo';
        }
      } catch (e) {
        const fallbackRepo = report?.REVIEW?.repo || '';
        if (repoInput && !repoInput.value) repoInput.value = fallbackRepo;
        if (sourceBadge) sourceBadge.textContent = fallbackRepo ? 'source: active report' : 'source: unset';
        if (repoLabel) repoLabel.textContent = fallbackRepo || 'target repo';
      }

      const agentSelect = $('#agentSelectInput');
      const modelInput = $('#modelConfigInput');
      const effortSelect = $('#effortSelectInput');
      const agentBadge = $('#agentSourceBadge');
      try {
        const aRes = await fetch('/api/github/agent-config');
        const aData = await aRes.json();
        if (aRes.ok && aData.ok) {
          if (agentSelect && aData.agent) agentSelect.value = aData.agent;
          if (modelInput) modelInput.value = aData.model || '';
          if (effortSelect) effortSelect.value = aData.effort || '';
          if (agentBadge) {
            agentBadge.textContent = `agent: ${aData.agent || 'auto'} · model: ${aData.model || 'default'} · effort: ${aData.effort || 'default'}`;
          }
        }
      } catch (e) {}
    }

    async function populateRecentPrs(explicitRepoOverride) {
      updateSkillPromptPreview();
      const listEl = $('#recentPrsList');
      const repoLabel = $('#recentPrsRepoLabel');
      const sourceBadge = $('#repoSourceBadge');
      if (!listEl) return;
      try {
        const repoParam = (explicitRepoOverride ?? $('#repoConfigInput')?.value ?? '').trim();
        listEl.innerHTML = `<div style="font-size:12px;color:var(--muted);">Loading recent PRs from GitHub via gh cli...</div>`;
        const url = repoParam ? `/api/github/list-prs?repo=${encodeURIComponent(repoParam)}` : '/api/github/list-prs';
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Unavailable');
        if (data.repo && repoLabel) repoLabel.textContent = data.repo;
        if (data.repo && $('#repoConfigInput') && !$('#repoConfigInput').value) {
          $('#repoConfigInput').value = data.repo;
        }
        if (data.repoSource && sourceBadge) {
          sourceBadge.textContent = `source: ${data.repoSource}`;
        }
        listEl.innerHTML = (data.prs || [])
          .map(
            (p) => `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--rule);border-radius:5px;background:var(--surface);">
            <span class="chip" style="font-family:var(--mono);">#${escapeHtml(String(p.number))}</span>
            <span class="chip ${p.state === 'OPEN' ? 'ok' : ''}" style="font-size:10px;">${escapeHtml(p.state)}</span>
            <span style="flex:1;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.title)}</span>
            <span style="font-size:11px;color:var(--muted);">@${escapeHtml(p.author?.login || '')}</span>
            <button type="button" class="btn primary" data-pick-pr="${escapeHtml(String(p.number))}" style="padding:3px 8px;font-size:11.5px;">Load</button>
          </div>`
          )
          .join('');
      } catch (e) {
        listEl.innerHTML = `<div style="font-size:12px;color:var(--muted);">${escapeHtml(e.message || 'Run npm start to browse live PRs via gh pr list.')}</div>`;
      }
    }

    $('#openSwitchPrBtn')?.addEventListener('click', async () => {
      $('#switchPrDialog')?.showModal();
      await syncRepoConfigInModal();
      populateRecentPrs();
    });

    $('#refreshRepoPrsBtn')?.addEventListener('click', () => {
      populateRecentPrs(($('#repoConfigInput')?.value || '').trim());
    });

    $('#saveRepoConfigBtn')?.addEventListener('click', async () => {
      const repoVal = ($('#repoConfigInput')?.value || '').trim();
      const statusEl = $('#loadPrStatus');
      const sourceBadge = $('#repoSourceBadge');
      if (!repoVal) return;
      try {
        const res = await fetch('/api/github/repo-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repoVal })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save default repo');
        if (sourceBadge) sourceBadge.textContent = `source: .crvrc.json`;
        if (statusEl) statusEl.textContent = `✓ Saved default repo ${data.repo} to ${data.saved?.configPath || data.savedTo || '.crvrc.json'}`;
        populateRecentPrs(data.repo);
      } catch (err) {
        if (statusEl) statusEl.textContent = `⚠ ${err.message}`;
      }
    });

    $('#saveAgentConfigBtn')?.addEventListener('click', async () => {
      const agentVal = ($('#agentSelectInput')?.value || '').trim();
      const modelVal = ($('#modelConfigInput')?.value || '').trim();
      const effortVal = ($('#effortSelectInput')?.value || '').trim();
      const statusEl = $('#loadPrStatus');
      const agentBadge = $('#agentSourceBadge');
      try {
        const res = await fetch('/api/github/agent-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: agentVal,
            model: modelVal || 'default',
            effort: effortVal || 'default'
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save agent, model & effort config');
        if (agentBadge) {
          agentBadge.textContent = `agent: ${data.agent} · model: ${data.model || 'default'} · effort: ${data.effort || 'default'}`;
        }
        if (statusEl) {
          statusEl.textContent = `✓ Saved default agent "${data.agent}", model "${data.model || 'default'}", effort "${data.effort || 'default'}" to ${data.saved?.configPath || '.crvrc.json'}`;
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = `⚠ ${err.message}`;
      }
    });

    $('#loadPrBtn')?.addEventListener('click', () => {
      const val = ($('#prSearchInput')?.value || '').trim();
      loadPrIntoWorkbench(val);
    });

    $('#prSearchInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadPrIntoWorkbench(($('#prSearchInput')?.value || '').trim());
      }
    });

    $('#recentPrsList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick-pr]');
      if (!btn) return;
      loadPrIntoWorkbench(btn.dataset.pickPr);
    });

    $('#copySkillRunPromptBtn')?.addEventListener('click', async () => {
      const url = report?.PR?.url || `PR #${report?.REVIEW?.pr || 1230}`;
      await navigator.clipboard.writeText(`Review ${url} with crv-code-review`);
      const btn = $('#copySkillRunPromptBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => {
        btn.textContent = 'Copy Skill Prompt';
      }, 1500);
    });

    $('#copySkillRereviewPromptBtn')?.addEventListener('click', async () => {
      const url = report?.PR?.url || `PR #${report?.REVIEW?.pr || 1230}`;
      await navigator.clipboard.writeText(`Re-review ${url} with crv-code-review`);
      const btn = $('#copySkillRereviewPromptBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => {
        btn.textContent = 'Copy Re-review (r2) Prompt';
      }, 1500);
    });

    document.querySelectorAll('input[name="ghReviewEvent"]').forEach((r) => {
      r.addEventListener('change', updateModalPreview);
    });
    $('#ghSummaryNote')?.addEventListener('input', updateModalPreview);

    $('#copyGhPayloadBtn')?.addEventListener('click', async () => {
      const payload = buildGitHubPreviewPayload();
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      const btn = $('#copyGhPayloadBtn');
      btn.textContent = '✓ Copied JSON Payload';
      setTimeout(() => {
        btn.textContent = 'Copy gh api Payload';
      }, 1600);
    });

    $('#submitGhReviewBtn')?.addEventListener('click', async () => {
      const statusEl = $('#ghSubmitStatus');
      const payload = buildGitHubPreviewPayload();
      try {
        statusEl.textContent = 'Publishing review to GitHub via local gh bridge...';
        const res = await fetch('/api/github/submit-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: report?.REVIEW?.repo,
            pr: report?.REVIEW?.pr,
            payload
          })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          statusEl.textContent = `✓ Published to GitHub! (${data.mode || 'gh api'})`;
        } else {
          statusEl.textContent = `Saved locally (${data.error || 'Run via "crv review --publish" to push live to GitHub'})`;
        }
      } catch (err) {
        statusEl.textContent = 'Offline mode: Copy the payload or run `npx crv demo` to connect the local gh CLI bridge.';
      }
    });

    if (ghConnected && typeof EventSource !== 'undefined') {
      try {
        const es = new EventSource('/api/events');
        es.addEventListener('report-updated', async () => {
          try {
            const rRes = await fetch('/api/report');
            if (rRes.ok) {
              report = await rRes.json();
              loadTriage();
              renderHeader();
              renderRack();
              renderPane();
            }
          } catch (e) {}
        });
      } catch (e) {}
    }

    window.addEventListener('keydown', (e) => {
      if (['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target?.tagName)) return;
      if ($('#ghReviewDialog')?.open || $('#switchPrDialog')?.open) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        stepFinding(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepFinding(-1);
      } else if (e.key === 'b' && activeLayer === 'findings') {
        e.preventDefault();
        setTriageAction(currentId, 'block');
      } else if (e.key === 'm' && activeLayer === 'findings') {
        e.preventDefault();
        setTriageAction(currentId, 'comment');
      } else if (e.key === 'x' && activeLayer === 'findings') {
        e.preventDefault();
        setTriageAction(currentId, 'dismiss');
      } else if (e.key === '?') {
        e.preventDefault();
        $('#guideToggleBtn')?.click();
      }
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
