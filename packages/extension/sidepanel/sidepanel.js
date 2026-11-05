'use strict';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function resolveLocalWorkbenchUrl() {
  for (let port = 4320; port <= 4325; port++) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 350);
      const res = await fetch(`${base}/api/report`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return base;
    } catch (e) {}
  }
  return 'http://127.0.0.1:4320';
}

async function refreshSidePanel() {
  const statusEl = document.getElementById('prStatus');
  const listEl = document.getElementById('findingsList');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url?.includes('github.com') && tab.url.includes('/pull/')) {
      statusEl.textContent = `Connected to: ${tab.title || tab.url}`;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN_PR_PAGE' });
        if (res?.ok) {
          renderFindings(listEl, res.findings || []);
          return;
        }
      } catch (e) {
        // Content script might not be ready yet; fall back to stored PR data
      }
    }

    const stored = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PR_DATA' });
    if (stored?.ok && stored.data) {
      statusEl.textContent = `Last scanned PR: ${stored.data.repo} #${stored.data.pr}`;
      renderFindings(listEl, stored.data.findings || []);
    } else {
      statusEl.textContent = 'Navigate to a GitHub Pull Request or start `npx crv demo` locally.';
    }
  } catch (err) {
    statusEl.textContent = `Status check failed: ${err.message}`;
  }
}

function renderFindings(container, findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    container.innerHTML =
      'No <code>&lt;!-- crv-finding --&gt;</code> threads found on this PR yet. Curate and publish from the 4-Layer Workbench.';
    return;
  }

  container.innerHTML = findings
    .map(
      (f) => `<div class="finding-item">
        <strong>${escapeHtml(f.id || 'Finding')}</strong> (${escapeHtml(String(f.sev || 'info').toUpperCase())}) · <code>${escapeHtml(f.action || 'comment')}</code>
        ${f.title ? `<div style="margin-top:2px;">${escapeHtml(f.title)}</div>` : ''}
        <div style="color:var(--muted);margin-top:2px;">${escapeHtml(f.loc || '')}</div>
      </div>`
    )
    .join('');
}

document.getElementById('openFullWorkbenchBtn')?.addEventListener('click', async () => {
  try {
    const url = await resolveLocalWorkbenchUrl();
    await chrome.tabs.create({ url });
  } catch (err) {
    console.error('Failed to open Workbench tab:', err);
  }
});

document.getElementById('rescanTabBtn')?.addEventListener('click', () => {
  refreshSidePanel();
});

refreshSidePanel();
