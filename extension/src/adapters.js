// One adapter per AI site. When a site changes its layout, only this file needs fixing.
//
//   user / assistant        selectors for each message element
//   userContent / assistantContent   optional inner element that holds the text (first match wins)
//   userPlain               read user text as-is (keeps line breaks) instead of converting HTML
//   chatId()                id of the open chat, taken from the URL (null = not a saved chat yet)
//   streaming()             true while the AI is still typing, so we wait before saving
//
// STATUS: ChatGPT is written against its known structure (data-message-author-role).
// Claude, Gemini and Kimi are best-effort and UNVERIFIED: confirm each in DevTools
// (document.querySelectorAll('<selector>').length) and adjust here if it returns 0.
(function (root) {
  'use strict';
  const CTX = (root.CTX = root.CTX || {});

  const idFrom = (re) => () => {
    const m = location.pathname.match(re);
    return m ? m[1] : null;
  };

  CTX.shouldAutosave = function (autosave, key, site) {
    if (!autosave) return false;
    if (key && autosave.chats && typeof autosave.chats[key] === 'boolean') {
      return autosave.chats[key];
    }
    if (site && autosave.sites && typeof autosave.sites[site] === 'boolean') {
      return autosave.sites[site];
    }
    return Boolean(autosave.default);
  };

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    if (el.closest) {
      if (el.closest('[aria-hidden="true"], [hidden], [disabled]')) return false;
    }

    const win = el.ownerDocument ? el.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (cs.width === '0px' && cs.height === '0px') return false;
        if (cs.opacity === '0') return false;
      } catch (e) {}
    }
    if (el.style) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
      if (el.style.width === '0px' && el.style.height === '0px') return false;
      if (el.style.width === '0' && el.style.height === '0') return false;
      if (el.style.opacity === '0') return false;
    }

    const isJsdom = win && win.navigator && /jsdom/i.test(win.navigator.userAgent || '');
    if (!isJsdom) {
      const hasSize = el.offsetWidth > 0 || el.offsetHeight > 0 || (el.getClientRects && el.getClientRects().length > 0);
      if (!hasSize) return false;
    } else {
      const descW = Object.getOwnPropertyDescriptor(el, 'offsetWidth');
      const descH = Object.getOwnPropertyDescriptor(el, 'offsetHeight');
      if (descW && descH && el.offsetWidth === 0 && el.offsetHeight === 0) {
        return false;
      }
    }
    return true;
  }
  CTX.isVisible = isVisible;

  CTX.adapters = [
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      user: [
        '[data-chatgpt-search-unit-key$=":user"]',
        '[data-user-message-bubble="true"]',
        '[data-message-author-role="user"]',
      ],
      assistant: [
        '[data-chatgpt-search-unit-key$=":assistant"]',
        '[data-content-search-unit-key$=":assistant"]',
        '[data-message-author-role="assistant"]',
      ],
      userContent: ['.whitespace-pre-wrap'],
      assistantContent: ['.markdown'],
      userPlain: true,
      chatId: idFrom(/\/c\/([\w-]+)/),
      streaming: () => {
        const btn = document.querySelector('[data-testid="stop-button"]');
        if (btn && isVisible(btn)) {
          CTX.lastStreamingInfo = {
            selector: '[data-testid="stop-button"]',
            tag: btn.tagName.toLowerCase(),
            ariaLabel: btn.getAttribute('aria-label') || '',
            visible: true,
          };
          return true;
        }
        return false;
      },
    },
    {
      id: 'claude',
      name: 'Claude',
      hosts: ['claude.ai'],
      user: ['[data-testid="user-message"]'],
      assistant: ['[data-testid="assistant-message"]'],
      userContent: ['.whitespace-pre-wrap'],
      assistantContent: ['[data-perf-reply-text]'],
      userPlain: true,
      chatId: idFrom(/\/chat\/([\w-]+)/),
      streaming: () => {
        const rows = document.querySelectorAll('[data-testid="transcript-row"], [data-testid="assistant-message"]');
        const lastEl = rows.length ? rows[rows.length - 1] : document.body;
        if (!lastEl) return false;

        const lastRow = (lastEl.closest && lastEl.closest('[data-testid="transcript-row"]')) || lastEl;
        const streamEl = lastRow.matches && lastRow.matches('[data-is-streaming="true"], [data-perf-row-streaming="true"]')
          ? lastRow
          : (lastRow.querySelector ? lastRow.querySelector('[data-is-streaming="true"], [data-perf-row-streaming="true"]') : null);

        if (!streamEl || !isVisible(streamEl)) return false;

        const now = Date.now();
        const text = (lastRow.textContent || '').trim();
        if (text !== CTX._claudeLastText) {
          CTX._claudeLastText = text;
          CTX._claudeLastChangeTime = now;
        } else if (CTX._claudeLastChangeTime > 0 && now - CTX._claudeLastChangeTime >= 3000) {
          return false;
        }

        CTX.lastStreamingInfo = {
          selector: (streamEl.getAttribute && streamEl.getAttribute('data-is-streaming')) ? '[data-is-streaming="true"]' : '[data-perf-row-streaming="true"]',
          tag: streamEl.tagName.toLowerCase(),
          ariaLabel: (streamEl.getAttribute && streamEl.getAttribute('aria-label')) || '',
          visible: true,
        };
        return true;
      },
    },
    {
      id: 'gemini',
      name: 'Gemini',
      hosts: ['gemini.google.com'],
      user: ['user-query'],
      assistant: ['model-response'],
      userContent: ['.query-text', '.query-content'],
      assistantContent: [
        '#model-response-message-content',
        'message-content .markdown',
        'message-content',
      ],
      chatId: idFrom(/(?:^|\/)(?:u\/\d+\/)?app\/([\w-]+)/),
      streaming: () => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const btn of btns) {
          if (!isVisible(btn)) continue;
          if (btn.closest && btn.closest('user-query, model-response, [data-test-id*="message"]')) continue;
          const label = (btn.getAttribute('aria-label') || btn.getAttribute('data-tooltip') || btn.textContent || '').trim();
          if (/^stop\s*(response|generation|generating)?$/i.test(label) || /stop\s+(response|generation|generating)/i.test(label)) {
            CTX.lastStreamingInfo = {
              selector: 'button[aria-label*="Stop"]',
              tag: btn.tagName.toLowerCase(),
              ariaLabel: label,
              visible: true,
            };
            return true;
          }
        }
        return false;
      },
      scrollContainer: [
        'infinite-scroller[data-test-id="chat-history-container"]',
        'infinite-scroller',
      ],
    },
    {
      id: 'kimi',
      name: 'Kimi',
      hosts: ['kimi.ai', 'www.kimi.ai', 'kimi.com', 'www.kimi.com', 'kimi.moonshot.cn'],
      user: ['.chat-content-item-user'],
      assistant: ['.chat-content-item-assistant'],
      userContent: ['.user-content__text', '.user-content'],
      assistantContent: [
        '.toolcall-rollup__part > .markdown-container',
        '.markdown-container:not(.toolcall-content-text)',
      ],
      userPlain: true,
      chatId: idFrom(/\/chat\/([\w-]+)/),
      streaming: null,
    },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
