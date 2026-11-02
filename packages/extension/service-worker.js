'use strict';

// Configure side panel to open when the user clicks the extension toolbar icon.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('Failed to set side panel behavior:', err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'OPEN_SIDE_PANEL') {
        const windowId = sender?.tab?.windowId;
        if (windowId) {
          await chrome.sidePanel.open({ windowId });
        }
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'PR_COMMENTS_DISCOVERED') {
        const prKey = `pr:${message.repo}#${message.pr}`;
        await chrome.storage.local.set({
          [prKey]: {
            repo: message.repo,
            pr: message.pr,
            meta: message.meta || null,
            findings: message.findings || [],
            updatedAt: new Date().toISOString()
          },
          lastActivePrKey: prKey
        });

        const count = Array.isArray(message.findings) ? message.findings.length : 0;
        if (sender?.tab?.id) {
          await chrome.action.setBadgeText({
            tabId: sender.tab.id,
            text: count > 0 ? String(count) : ''
          });
          await chrome.action.setBadgeBackgroundColor({
            tabId: sender.tab.id,
            color: '#0F8171'
          });
        }
        sendResponse({ ok: true, count });
        return;
      }

      if (message?.type === 'GET_ACTIVE_PR_DATA') {
        const { lastActivePrKey } = await chrome.storage.local.get('lastActivePrKey');
        if (!lastActivePrKey) {
          sendResponse({ ok: true, data: null });
          return;
        }
        const stored = await chrome.storage.local.get(lastActivePrKey);
        sendResponse({ ok: true, data: stored[lastActivePrKey] || null });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      console.error('Service worker message error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});
