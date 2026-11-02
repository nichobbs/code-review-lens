'use strict';

(function () {
  const META_RE = /<!--\s*crv-meta:\s*(\{[\s\S]*?\})\s*-->/;
  const FINDING_RE = /<!--\s*crv-finding:\s*(\{[\s\S]*?\})\s*-->/;

  function parsePrUrl() {
    const m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(location.pathname);
    if (!m) return null;
    return { repo: m[1], pr: Number(m[2]) };
  }

  function extractPageMetadata(prInfo) {
    const titleEl =
      document.querySelector('.js-issue-title') ||
      document.querySelector('bdi.markdown-title') ||
      document.querySelector('.gh-header-title');
    const branchEls = Array.from(document.querySelectorAll('.commit-ref'));
    const baseBranch = branchEls[0]?.textContent?.trim() || '';
    const headBranch = branchEls[1]?.textContent?.trim() || '';
    return {
      title: titleEl ? titleEl.textContent.trim() : `PR #${prInfo.pr}`,
      url: `https://github.com/${prInfo.repo}/pull/${prInfo.pr}`,
      baseBranch,
      headBranch
    };
  }

  /**
   * Scans GitHub PR comment DOM nodes in batches using requestAnimationFrame
   * so we never block the main thread on large PR threads.
   */
  async function scanPageCommentsForCrvMarkers() {
    const prInfo = parsePrUrl();
    if (!prInfo) return { repo: '', pr: 0, title: '', url: '', meta: null, findings: [] };

    const pageMeta = extractPageMetadata(prInfo);
    const commentElements = Array.from(
      document.querySelectorAll('.comment-body, textarea[name="comment[body]"]')
    );
    let discoveredMeta = null;
    const findings = [];
    const BATCH_SIZE = 20;

    for (let i = 0; i < commentElements.length; i += BATCH_SIZE) {
      const batch = commentElements.slice(i, i + BATCH_SIZE);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          for (const el of batch) {
            const raw = el.value || el.innerHTML || '';
            const metaMatch = META_RE.exec(raw);
            if (metaMatch) {
              try {
                discoveredMeta = JSON.parse(metaMatch[1]);
              } catch (e) {}
            }
            const findingMatch = FINDING_RE.exec(raw);
            if (findingMatch) {
              try {
                const parsedFinding = JSON.parse(findingMatch[1]);
                const headingEl = el.querySelector ? el.querySelector('h3, h4, strong') : null;
                const textBody = (el.textContent || '').trim();
                findings.push({
                  ...parsedFinding,
                  title: parsedFinding.title || (headingEl ? headingEl.textContent.trim() : ''),
                  body: parsedFinding.body || textBody
                });
              } catch (e) {}
            }
          }
          resolve();
        })
      );
      if (typeof scheduler !== 'undefined' && scheduler.yield) {
        await scheduler.yield();
      }
    }

    return {
      repo: prInfo.repo,
      pr: prInfo.pr,
      ...pageMeta,
      meta: discoveredMeta,
      findings
    };
  }

  function injectWorkbenchButton(findingCount) {
    if (document.querySelector('#crv-workbench-trigger')) return;
    const navBar =
      document.querySelector('.tabnav-tabs') ||
      document.querySelector('.gh-header-actions');
    if (!navBar) return;

    const btn = document.createElement('button');
    btn.id = 'crv-workbench-trigger';
    btn.type = 'button';
    btn.className = 'crv-ext-tab-btn';
    btn.innerHTML = `🛡️ Agent Workbench <span class="crv-ext-badge">${findingCount || 'Open'}</span>`;
    btn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
      } catch (err) {
        console.error('Could not open Workbench side panel:', err);
      }
    });
    navBar.appendChild(btn);
  }

  async function initPrPage() {
    try {
      const result = await scanPageCommentsForCrvMarkers();
      injectWorkbenchButton(result.findings.length);
      await chrome.runtime.sendMessage({
        type: 'PR_COMMENTS_DISCOVERED',
        ...result
      });
    } catch (err) {
      console.warn('CRV Workbench content script warning:', err);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        if (message?.type === 'RESCAN_PR_PAGE') {
          const result = await scanPageCommentsForCrvMarkers();
          sendResponse({ ok: true, ...result });
          return;
        }
        sendResponse({ ok: false });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  });

  initPrPage();
})();
