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
      streaming: () =>
        !!document.querySelector(
          '[data-testid="stop-button"], [data-talvt-turn-state]:not([data-talvt-turn-state="complete"])'
        ),
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
      streaming: () =>
        !!document.querySelector('[data-is-streaming="true"], [data-perf-row-streaming="true"]'),
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
      streaming: () => !!document.querySelector('[aria-label*="Stop"]'),
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
