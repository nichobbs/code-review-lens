'use strict';

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
        <strong>${f.id || 'Finding'}</strong> (${(f.sev || 'info').toUpperCase()}) · <code>${f.action || 'comment'}</code>
        <div style="color:var(--muted);margin-top:2px;">${f.loc || ''}</div>
      </div>`
    )
    .join('');
}

document.getElementById('openFullWorkbenchBtn')?.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: 'http://127.0.0.1:4320' });
  } catch (err) {
    console.error('Failed to open Workbench tab:', err);
  }
});

document.getElementById('rescanTabBtn')?.addEventListener('click', () => {
  refreshSidePanel();
});

refreshSidePanel();
