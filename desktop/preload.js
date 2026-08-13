/**
 * Gitu Desktop — preload (sandboxed, contextIsolation on).
 *
 * Watches the Gitu web UI DOM for assistant replies that just finished
 * streaming and tells the main process so it can raise a native notification
 * when the window is hidden or unfocused. It also bridges splash-screen
 * status updates. No page scripts are modified.
 *
 * Detection: while a reply streams, its content element carries a `.cursor`
 * class; the web UI removes it when the reply completes. We only notify on a
 * cursor -> no-cursor transition (messages rendered from history never have
 * the cursor, so they are ignored).
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function watchAssistantReplies() {
  // el -> { hadCursor: boolean, notified: boolean }
  const state = new WeakMap();
  const observer = new MutationObserver(() => {
    for (const el of document.querySelectorAll('.msg.assistant')) {
      const s = state.get(el);
      const hasCursor = !!el.querySelector('.cursor');
      if (!s) {
        state.set(el, { hadCursor: hasCursor, notified: false });
        continue;
      }
      if (s.notified) continue;
      if (s.hadCursor && !hasCursor) {
        s.notified = true;
        const contentEl = el.querySelector('.content');
        const text = (contentEl ? contentEl.textContent : '').trim();
        if (text) ipcRenderer.send('gitu:assistant-done', text);
      }
      s.hadCursor = hasCursor;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

contextBridge.exposeInMainWorld('gituDesktop', {
  onSplashStatus: (cb) => ipcRenderer.on('splash:status', (_e, text) => cb(text)),
  onSplashError: (cb) => ipcRenderer.on('splash:error', (_e, text) => cb(text))
});

window.addEventListener('DOMContentLoaded', watchAssistantReplies);
