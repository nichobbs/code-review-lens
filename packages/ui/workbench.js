(function () {
  'use strict';

  try {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.content = localStorage.getItem('color-scheme') ?? 'light dark';
    }
  } catch (e) {}

  const OV = '__overview__';
  const CONTRACTS_VIEW = '__contracts__';
  const TESTS_VIEW = '__tests__';
  const IS_EXTENSION_PAGE =
    typeof window !== 'undefined' && window.location?.protocol === 'chrome-extension:';
  const API_BASE = IS_EXTENSION_PAGE ? 'http://127.0.0.1:4320' : '';

  function apiUrl(route) {
    return `${API_BASE}${route}`;
  }

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
      }
    } catch (e) {
      triage = {};
    }
    if (report && Array.isArray(report.DATA)) {
      for (const d of report.DATA) {
        if (!triage[d.id]) {
          triage[d.id] = {
            action: d.suggestedTriage || (d.sev === 'high' ? 'block' : 'comment'),
            note: '',
            done: false
          };
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

  function renderHeader() {
    if (!report) return;
    $('#prTitle').textContent = report.XMETA?.title || 'PR Review Workbench';
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

    const nav = $('#layerNav');
    if (!nav) return;

    const items = [
      { id: 'overview', label: '1. Intent & Arch', badge: '13 lenses' },
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
    const points = (s.points || [])
      .map((p) => `<li><code>${escapeHtml(p.split(':')[0])}</code>:${escapeHtml(p.split(':').slice(1).join(':'))}</li>`)
      .join('');

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
          <span class="verify-pill">✓ 13 / 13 High & Medium Findings Verified</span>
          <span>Agent: <strong>${escapeHtml(rev.agent || 'Antigravity')}</strong> (${escapeHtml(rev.model || 'Claude Opus 4.6')})</span>
          <span>Head: <code>${escapeHtml((rev.head || '').slice(0, 8))}</code></span>
        </div>
        <h2 class="ftitle">Layer 1: Intent, Architecture & Verification Summary</h2>
      </div>

      <div class="prose">${s.html || ''}</div>

      <div class="sec">
        <h4>13-Lens Verification Matrix</h4>
        <ul class="prose">${points}</ul>
      </div>
    </div>`;
  }

  function renderContractsAndFlowsLayer() {
    const contracts = report?.LAYERS?.contracts || [];
    const flows = report?.LAYERS?.flows || [];

    const contractCards = contracts
      .map(
        (c) => `<div class="layer-card">
          <div class="layer-card-header">
            <h3 class="layer-card-title"><code>${escapeHtml(c.path)}</code></h3>
            <span class="status-badge solid">${escapeHtml(c.category)}</span>
          </div>
          <p style="margin:4px 0 8px;color:var(--ink-2)">${escapeHtml(c.summary)}</p>
          <div style="font:400 12px var(--mono);background:var(--well);padding:6px 10px;border-radius:4px;margin-bottom:8px;">
            ${escapeHtml(c.diffSummary)}
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;">
            <strong style="color:var(--muted)">Linked Findings:</strong>
            ${(c.linkedFindings || [])
              .map(
                (fid) =>
                  `<button type="button" class="btn" style="height:24px;padding:0 8px;font-size:11px;" data-jump-finding="${escapeHtml(fid)}">Jump to ${escapeHtml(fid)}</button>`
              )
              .join('')}
          </div>
        </div>`
      )
      .join('');

    const flowCards = flows
      .map(
        (f) => `<div class="layer-card">
          <div class="layer-card-header">
            <h3 class="layer-card-title">${escapeHtml(f.title)}</h3>
            <span class="tpill">${(f.files || []).length} files</span>
          </div>
          <p style="margin:4px 0 8px;color:var(--ink-2)">${escapeHtml(f.description)}</p>
          <ul style="margin:0 0 10px;padding-left:18px;font:400 12px/1.6 var(--mono);color:var(--ink-2)">
            ${(f.files || []).map((file) => `<li>${escapeHtml(file)}</li>`).join('')}
          </ul>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;">
            <strong style="color:var(--muted)">Findings in this Flow:</strong>
            ${(f.linkedFindings || [])
              .map(
                (fid) =>
                  `<button type="button" class="btn" style="height:24px;padding:0 8px;font-size:11px;" data-jump-finding="${escapeHtml(fid)}">${escapeHtml(fid)}</button>`
              )
              .join('')}
          </div>
        </div>`
      )
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
        ${contractCards}
      </div>
      <div class="sec">
        <h4>Story-Ordered Production Flows (${flows.length})</h4>
        ${flowCards}
      </div>
    </div>`;
  }

  function renderTestMatrixLayer() {
    const matrix = report?.LAYERS?.testMatrix || [];
    const cards = matrix
      .map((suite) => {
        const rows = (suite.scenarios || [])
          .map(
            (sc) => `<tr>
              <td>${escapeHtml(sc.behavior)}${sc.note ? `<div style="color:var(--s-high-ink);font-size:11.5px;margin-top:2px;">⚠️ ${escapeHtml(sc.note)}</div>` : ''}</td>
              <td class="num" style="text-align:center;font-weight:700;">${sc.assertions}</td>
              <td><span class="status-badge ${escapeHtml(sc.status)}">${escapeHtml(sc.status)}</span></td>
            </tr>`
          )
          .join('');

        return `<div class="layer-card">
          <div class="layer-card-header">
            <div>
              <h3 class="layer-card-title">${escapeHtml(suite.suite)}</h3>
              <div style="font:400 11.5px var(--mono);color:var(--muted)">${escapeHtml(suite.file)}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <span class="tpill num">${suite.totalCases} tests · ${suite.assertionsCount} assertions</span>
              ${(suite.linkedFindings || [])
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
            <tbody>${rows}</tbody>
          </table>
          <details style="margin-top:10px;font-size:12px;color:var(--muted)">
            <summary style="cursor:pointer;font-weight:600;">Raw AI-generated unit test boilerplate collapsed by default (click to inspect)</summary>
            <div style="margin-top:6px;padding:8px 10px;background:var(--well);border-radius:4px;font-family:var(--mono);">
              Raw mock setup in <code>${escapeHtml(suite.file)}</code> is hidden so human reviewers can focus on behavioral coverage and assertion gaps above.
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
        </div>
      </div>

      <div class="fhead">
        <div class="fmeta">
          <span class="badge">${escapeHtml(d.id)} · ${escapeHtml(sevMeta.l)}</span>
          ${d.verify ? `<span class="verify-pill">✓ ${escapeHtml(d.verify)}</span>` : ''}
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
      </div>

      ${
        d.reasoning
          ? `<div class="sec">
              <h4>Verifier & Evidence</h4>
              <div class="prose">${d.reasoning}</div>
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

    const inlineComments = published.map((d) => {
      const t = getTriage(d.id);
      const [filePath, lineStr] = String(d.loc || '').split(':');
      const meta = {
        v: 1,
        id: d.id,
        sev: d.sev,
        verify: d.verify || '',
        action: t.action,
        loc: d.loc || '',
        head: report?.REVIEW?.head || ''
      };
      const bodyParts = [
        `<!-- crv-finding: ${JSON.stringify(meta)} -->`,
        `### ${t.action === 'block' ? '🚫 **BLOCKING**' : '💬 **COMMENT**'} \`${d.id}\` (${d.sev.toUpperCase()}) — ${d.title}`,
        t.note ? `\n> **Reviewer Note:** ${t.note}\n` : '',
        stripHtmlToMd(d.impact),
        '',
        stripHtmlToMd(d.fix)
      ].filter(Boolean);

      return {
        path: filePath,
        line: Number(lineStr) || 1,
        side: 'RIGHT',
        body: bodyParts.join('\n')
      };
    });

    const overviewMeta = {
      v: 1,
      repo: report?.REVIEW?.repo || '',
      pr: report?.REVIEW?.pr || 0,
      head: report?.REVIEW?.head || '',
      triage: Object.fromEntries(
        issues.map((d) => [d.id, { action: getTriage(d.id).action, note: getTriage(d.id).note }])
      )
    };

    const reviewPayload = {
      commit_id: report?.REVIEW?.head,
      event: selectedEvent,
      body: `<!-- crv-meta: ${JSON.stringify(overviewMeta)} -->\n## 🛡️ Agentic PR Review (${published.length} curated findings)\n\n${summaryNote}`.trim(),
      comments: inlineComments
    };

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
    const dialog = $('#ghReviewDialog');
    if (dialog) {
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
    }

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

  function buildStandaloneExtensionReport(prData) {
    if (!prData || (!prData.repo && !prData.pr)) return null;
    const findings = Array.isArray(prData.findings) ? prData.findings : [];
    const mappedData = findings.map((f, index) => ({
      id: f.id || `F${index + 1}`,
      sev: f.sev || 'medium',
      lens: f.lens || 'published-thread',
      verify: f.verify || 'verified',
      suggestedTriage: f.action === 'block' ? 'block' : f.action === 'dismiss' ? 'dismiss' : 'comment',
      title: f.title || `${f.id || 'Finding'} (${f.loc || 'inline comment'})`,
      loc: f.loc || '',
      impact: f.impact || (f.body ? `<p>${escapeHtml(f.body)}</p>` : '<p>Published PR review thread discovered on GitHub.</p>'),
      fix: f.fix || '',
      reasoning: f.reasoning || ''
    }));

    const prTitle = prData.title
      ? `PR #${prData.pr} — ${prData.title}`
      : `PR #${prData.pr} (${prData.repo})`;
    const prUrl = prData.url || `https://github.com/${prData.repo}/pull/${prData.pr}`;

    return {
      KEY: `crv-ext-${prData.repo}-${prData.pr}`,
      PR: {
        url: prUrl,
        label: `${prData.repo}#${prData.pr}`
      },
      XMETA: {
        title: prTitle,
        sub: `Standalone Extension Mode · ${prData.repo}#${prData.pr}`,
        branch:
          prData.headBranch && prData.baseBranch
            ? `${prData.headBranch} → ${prData.baseBranch}`
            : ''
      },
      REVIEW: {
        repo: prData.repo,
        pr: prData.pr,
        head: prData.meta?.head || findings[0]?.head || ''
      },
      SUMMARY: {
        overview: mappedData.length
          ? `<p>Loaded <strong>${mappedData.length}</strong> published <code>crv-finding</code> review thread(s) directly from the active GitHub Pull Request tab in standalone browser mode.</p><p>To decompose full diffs or run the 13-lens AI review agent, run <code>crv pr ${escapeHtml(String(prData.pr))} --repo ${escapeHtml(prData.repo)} --analyze</code> or import a <code>report.json</code> file using <strong>📂 Import JSON</strong> above.</p>`
          : `<p>Connected to <strong>${escapeHtml(prData.repo)}#${escapeHtml(String(prData.pr))}</strong> in standalone Chrome Extension mode (local CLI server is offline).</p><p>Run <code>crv pr ${escapeHtml(String(prData.pr))} --repo ${escapeHtml(prData.repo)} --analyze</code> in your terminal or click <strong>📂 Import JSON</strong> in the top bar to load a compiled review report.</p>`
      },
      DATA: mappedData,
      LAYERS: {
        contracts: [],
        flows: [],
        testMatrix: []
      }
    };
  }

  async function loadExtensionStoredReport() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const requestedKey = params.get('prKey');
      const { lastActivePrKey } = await chrome.storage.local.get('lastActivePrKey');
      const targetKey = requestedKey || lastActivePrKey;
      if (!targetKey) return null;
      const stored = await chrome.storage.local.get(targetKey);
      const prData = stored?.[targetKey];
      return buildStandaloneExtensionReport(prData);
    } catch (e) {
      return null;
    }
  }

  function normalizeImportedJson(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid JSON report file');
    }
    if (Array.isArray(parsed.DATA)) {
      return parsed;
    }
    if (Array.isArray(parsed.issues)) {
      const meta = parsed.meta || {};
      const data = parsed.issues.map((issue, idx) => ({
        id: issue.id || `F${idx + 1}`,
        sev: issue.severity || issue.sev || 'medium',
        lens: issue.lens || 'general',
        verify: issue.verification || issue.verify || 'verified',
        suggestedTriage:
          (issue.severity || issue.sev) === 'high' ? 'block' : 'comment',
        title: issue.title || `Issue ${idx + 1}`,
        loc: issue.location || issue.loc || '',
        impact: issue.impact || issue.description || '',
        fix: issue.fix || issue.recommendation || '',
        reasoning: issue.reasoning || '',
        diff: issue.diff || '',
        diagram: issue.diagram || ''
      }));
      return {
        KEY: meta.key || `crv-import-${meta.pr || Date.now()}`,
        PR: {
          url: meta.url || '',
          label: meta.repo && meta.pr ? `${meta.repo}#${meta.pr}` : 'Imported Report'
        },
        XMETA: {
          title: meta.title || 'Imported Findings Report',
          sub: meta.subtitle || ''
        },
        REVIEW: {
          repo: meta.repo || '',
          pr: meta.pr || 0,
          head: meta.head || ''
        },
        SUMMARY: {
          overview: parsed.summary?.overview || '<p>Imported from <code>findings.json</code>.</p>'
        },
        DATA: data,
        LAYERS: parsed.layers || { contracts: [], flows: [], testMatrix: [] }
      };
    }
    throw new Error('JSON file must contain either a Workbench "DATA" array or a findings "issues" array.');
  }

  async function init() {
    const preferExtensionStorage =
      IS_EXTENSION_PAGE && new URLSearchParams(window.location.search).get('mode') === 'standalone';

    if (!report && preferExtensionStorage) {
      report = await loadExtensionStoredReport();
    }

    if (!report) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(apiUrl('/api/report'), { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          report = await res.json();
          ghConnected = true;
        }
      } catch (e) {}
    }

    if (!report && IS_EXTENSION_PAGE) {
      report = await loadExtensionStoredReport();
    }

    currentId = report?.DATA?.[0]?.id || OV;
    if (!report?.DATA?.length) {
      activeLayer = 'overview';
    }

    loadTriage();
    renderHeader();
    renderRack();
    renderPane();
    setupDialogAndTheme();

    const importBtn = $('#importReportBtn');
    const importInput = $('#importReportInput');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          report = normalizeImportedJson(parsed);
          currentId = report?.DATA?.[0]?.id || OV;
          activeLayer = report?.DATA?.length ? 'findings' : 'overview';
          loadTriage();
          renderHeader();
          renderRack();
          renderPane();
        } catch (err) {
          alert(`Could not import JSON report: ${err.message}`);
        } finally {
          importInput.value = '';
        }
      });
    }

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
          const w = Math.max(260, Math.min(window.innerWidth - 360, ev.clientX));
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
      updateModalPreview();
      $('#ghReviewDialog')?.showModal();
    });

    async function loadPrIntoWorkbench(prInput) {
      const statusEl = $('#loadPrStatus');
      const explicitRepo = ($('#repoConfigInput')?.value || '').trim();
      if (!prInput) return;
      try {
        if (statusEl) statusEl.textContent = `Fetching PR ${prInput} & decomposing 4 Layers via gh...`;
        const res = await fetch(apiUrl('/api/github/load-pr'), {
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
        const res = await fetch(apiUrl('/api/github/repo-config'));
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
        const aRes = await fetch(apiUrl('/api/github/agent-config'));
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
        const url = repoParam
          ? apiUrl(`/api/github/list-prs?repo=${encodeURIComponent(repoParam)}`)
          : apiUrl('/api/github/list-prs');
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
        const res = await fetch(apiUrl('/api/github/repo-config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repoVal })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save default repo');
        if (sourceBadge) sourceBadge.textContent = `source: .crvrc.json`;
        if (statusEl) statusEl.textContent = `✓ Saved default repo ${data.repo} to ${data.savedTo}`;
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
        const res = await fetch(apiUrl('/api/github/agent-config'), {
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
        const res = await fetch(apiUrl('/api/github/submit-review'), {
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

    window.addEventListener('keydown', (e) => {
      if (['TEXTAREA', 'INPUT'].includes(e.target?.tagName)) return;
      if ($('#ghReviewDialog')?.open) return;
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
      }
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
