'use strict';

(function () {
  const META_RE = /<!--\s*crv-meta:\s*(\{[\s\S]*?\})\s*-->/;
  const FINDING_RE = /<!--\s*crv-finding:\s*(\{[\s\S]*?\})\s*-->/;

  function parsePrUrl() {
    const m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(location.pathname);
    if (!m) return null;
    return { repo: m[1], pr: Number(m[2]) };
  }

  const ALLOWED_ACTIONS = ['block', 'comment', 'dismiss', 'pending'];
  const ALLOWED_SEVS = ['high', 'medium', 'low', 'struct', 'nit', 'ci'];

  /** Keep only typed scalar fields from marker JSON (never impact/fix/reasoning HTML). */
  function pickFindingFields(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(raw.id)) return null;
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    return {
      id: raw.id,
      sev: ALLOWED_SEVS.includes(raw.sev) ? raw.sev : 'medium',
      cat: s(raw.cat, 120),
      verify: s(raw.verify, 20),
      action: ALLOWED_ACTIONS.includes(raw.action) ? raw.action : 'comment',
      loc: s(raw.loc, 400),
      title: s(raw.title, 300),
      head: /^[0-9a-f]{7,40}$/i.test(s(raw.head, 64)) ? raw.head : ''
    };
  }

  function viewerLogin() {
    return document.querySelector('meta[name="user-login"]')?.content || '';
  }

  function commentAuthor(el) {
    const container = el.closest ? el.closest('.timeline-comment, .review-comment, .js-comment, .js-timeline-item') : null;
    return container?.querySelector('a.author, .author')?.textContent?.trim() || '';
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
                const parsedFinding = pickFindingFields(JSON.parse(findingMatch[1]));
                if (!parsedFinding) continue;
                const headingEl = el.querySelector ? el.querySelector('h3, h4, strong') : null;
                const textBody = (el.textContent || '').trim().slice(0, 4000);
                const author = commentAuthor(el);
                findings.push({
                  ...parsedFinding,
                  title: parsedFinding.title || (headingEl ? headingEl.textContent.trim().slice(0, 300) : ''),
                  body: textBody,
                  author,
                  // Markers are plain text anyone can post: only the signed-in user's own comments are trusted.
                  trusted: Boolean(author && viewerLogin() && author.toLowerCase() === viewerLogin().toLowerCase())
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
    const existingBtn = document.querySelector('#crv-workbench-trigger');
    if (existingBtn) {
      const badge = existingBtn.querySelector('.crv-ext-badge');
      if (badge) badge.textContent = String(findingCount || 'Open');
      return;
    }
    const navBar =
      document.querySelector('.tabnav-tabs') ||
      document.querySelector('.gh-header-actions');
    if (!navBar) return;

    const btn = document.createElement('button');
    btn.id = 'crv-workbench-trigger';
    btn.type = 'button';
    btn.className = 'crv-ext-tab-btn';
    btn.append('🛡️ Agent Workbench ');
    const badge = document.createElement('span');
    badge.className = 'crv-ext-badge';
    badge.textContent = String(findingCount || 'Open');
    btn.appendChild(badge);
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
    if (!parsePrUrl()) return;
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

  document.addEventListener('turbo:load', initPrPage);
  window.addEventListener('popstate', initPrPage);
  initPrPage();
})();
