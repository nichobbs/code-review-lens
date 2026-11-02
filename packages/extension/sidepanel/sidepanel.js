'use strict';

const LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:4320';

let activePrInfo = { repo: '', pr: 0, title: '' };
let localServerOnline = false;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseGitHubPrUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    if (u.hostname !== 'github.com') return null;
    const m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(u.pathname);
    if (!m) return null;
    return { repo: m[1], pr: Number(m[2]) };
  } catch (e) {
    return null;
  }
}

function updateCliCommandBox() {
  const cmdEl = document.getElementById('cliCmdPreview');
  if (!cmdEl) return;
  if (activePrInfo.repo && activePrInfo.pr) {
    cmdEl.textContent = `crv pr ${activePrInfo.pr} --repo ${activePrInfo.repo} --analyze`;
  } else {
    cmdEl.textContent = 'crv serve';
  }
}

async function checkLocalServerStatus() {
  const badgeEl = document.getElementById('serverStatusBadge');
  const detailEl = document.getElementById('localServerDetail');
  const localBtn = document.getElementById('openFullWorkbenchBtn');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${LOCAL_SERVER_ORIGIN}/api/health`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    localServerOnline = Boolean(data?.ok);

    if (badgeEl) {
      badgeEl.textContent = '🟢 Local Server Online';
      badgeEl.classList.add('online');
    }
    if (detailEl) {
      detailEl.textContent =
        data.activeRepo && data.activePr
          ? `Serving ${data.activeRepo}#${data.activePr}`
          : 'Listening on :4320';
    }
    if (localBtn) {
      localBtn.textContent =
        activePrInfo.repo && activePrInfo.pr
          ? `Load PR #${activePrInfo.pr} in :4320`
          : 'Open Local Server (:4320)';
    }
  } catch (err) {
    localServerOnline = false;
    if (badgeEl) {
      badgeEl.textContent = '⚪ Standalone Mode';
      badgeEl.classList.remove('online');
    }
    if (detailEl) {
      detailEl.textContent = 'Local server offline';
    }
    if (localBtn) {
      localBtn.textContent = 'Open Local Server (:4320)';
    }
  }
}

async function refreshSidePanel() {
  const statusEl = document.getElementById('prStatus');
  const listEl = document.getElementById('findingsList');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const parsedTabPr = parseGitHubPrUrl(tab?.url);

    if (tab?.id && parsedTabPr) {
      activePrInfo = {
        repo: parsedTabPr.repo,
        pr: parsedTabPr.pr,
        title: tab.title || ''
      };
      updateCliCommandBox();
      statusEl.textContent = `Active PR: ${parsedTabPr.repo}#${parsedTabPr.pr}`;

      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN_PR_PAGE' });
        if (res?.ok) {
          activePrInfo = {
            repo: res.repo || parsedTabPr.repo,
            pr: res.pr || parsedTabPr.pr,
            title: res.title || tab.title || ''
          };
          updateCliCommandBox();
          await chrome.runtime.sendMessage({
            type: 'PR_COMMENTS_DISCOVERED',
            ...res
          });
          renderFindings(listEl, res.findings || []);
          await checkLocalServerStatus();
          return;
        }
      } catch (e) {
        // Content script might not be ready yet; fall back to stored PR data
      }
    }

    const stored = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PR_DATA' });
    if (stored?.ok && stored.data) {
      activePrInfo = {
        repo: stored.data.repo || '',
        pr: stored.data.pr || 0,
        title: stored.data.title || ''
      };
      updateCliCommandBox();
      statusEl.textContent = `Last scanned PR: ${stored.data.repo}#${stored.data.pr}`;
      renderFindings(listEl, stored.data.findings || []);
    } else {
      statusEl.textContent = 'Navigate to a GitHub Pull Request or open the Bundled Workbench below.';
      updateCliCommandBox();
    }
  } catch (err) {
    statusEl.textContent = `Status check failed: ${err.message}`;
  }

  await checkLocalServerStatus();
}

function renderFindings(container, findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    container.innerHTML =
      'No <code>&lt;!-- crv-finding --&gt;</code> threads found on this PR yet. Open the Bundled Workbench or run the CLI command above to analyze this PR.';
    return;
  }

  container.innerHTML = findings
    .map(
      (f) => `<div class="finding-item">
        <strong>${escapeHtml(f.id || 'Finding')}</strong> (${escapeHtml((f.sev || 'info').toUpperCase())}) · <code>${escapeHtml(f.action || 'comment')}</code>
        ${f.title ? `<div style="margin-top:2px;font-weight:500;">${escapeHtml(f.title)}</div>` : ''}
        <div style="color:var(--muted);margin-top:2px;font-family:var(--mono);font-size:11px;">${escapeHtml(f.loc || '')}</div>
      </div>`
    )
    .join('');
}

document.getElementById('openBundledWorkbenchBtn')?.addEventListener('click', async () => {
  try {
    const url = chrome.runtime.getURL('workbench/index.html?mode=standalone');
    await chrome.tabs.create({ url });
  } catch (err) {
    console.error('Failed to open bundled Workbench tab:', err);
  }
});

document.getElementById('openFullWorkbenchBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('openFullWorkbenchBtn');
  try {
    if (localServerOnline && activePrInfo.repo && activePrInfo.pr) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = `Loading PR #${activePrInfo.pr}...`;
      }
      try {
        await fetch(`${LOCAL_SERVER_ORIGIN}/api/github/load-pr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prInput: String(activePrInfo.pr),
            repo: activePrInfo.repo
          })
        });
      } catch (e) {
        // Proceed to open tab even if load-pr fails
      }
    }
    await chrome.tabs.create({ url: LOCAL_SERVER_ORIGIN });
  } catch (err) {
    console.error('Failed to open local server tab:', err);
  } finally {
    if (btn) btn.disabled = false;
    await checkLocalServerStatus();
  }
});

document.getElementById('copyCliCmdBtn')?.addEventListener('click', async () => {
  const cmdEl = document.getElementById('cliCmdPreview');
  const btn = document.getElementById('copyCliCmdBtn');
  if (!cmdEl || !btn) return;
  try {
    await navigator.clipboard.writeText(cmdEl.textContent || '');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => {
      btn.textContent = orig;
    }, 1500);
  } catch (err) {
    console.error('Clipboard copy failed:', err);
  }
});

document.getElementById('rescanTabBtn')?.addEventListener('click', () => {
  refreshSidePanel();
});

refreshSidePanel();
