(() => {
  'use strict';

  // Fallback mock chrome.storage when loaded standalone in browser preview
  if (!window.chrome || !window.chrome.storage || !window.chrome.storage.local) {
    const mockStorage = {
      'chat:chatgpt:c1': {
        key: 'chatgpt:c1',
        site: 'chatgpt',
        siteName: 'ChatGPT',
        title: 'Debounce function implementation',
        updatedAt: Date.now() - 3600000 * 2,
        messages: [
          { role: 'user', text: 'How do I debounce in JS? Show code.' },
          { role: 'assistant', text: 'Here is a debounce helper with trailing execution:\n\n```javascript\nfunction debounce(fn, ms) {\n  let t;\n  return (...args) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n\n- Call `clearTimeout` first\n- Return a function that preserves arguments\n- Use 200–300ms for search input' }
        ]
      },
      'chat:claude:c2': {
        key: 'claude:c2',
        site: 'claude',
        siteName: 'Claude',
        title: 'Auth token expiration handler',
        updatedAt: Date.now() - 3600000 * 24,
        messages: [
          { role: 'user', text: 'Where should we store refresh tokens in Next.js?' },
          { role: 'assistant', text: 'Store refresh tokens in an httpOnly cookie.' }
        ]
      },
      settings: { budget: 5000, autosave: { default: false, sites: { chatgpt: true } } }
    };
    window.chrome = window.chrome || {};
    window.chrome.storage = {
      local: {
        get: async (k) => {
          if (k === null) return { ...mockStorage };
          if (typeof k === 'string') return { [k]: mockStorage[k] };
          if (Array.isArray(k)) {
            const out = {};
            for (const key of k) out[key] = mockStorage[key];
            return out;
          }
          return {};
        },
        set: async (obj) => Object.assign(mockStorage, obj),
        remove: async (keys) => { for (const k of [].concat(keys)) delete mockStorage[k]; },
        getBytesInUse: (k, cb) => cb && cb(198 * 1024),
      }
    };
    window.chrome.tabs = window.chrome.tabs || {
      query: (o, cb) => cb([{ id: 1 }]),
      sendMessage: (id, msg, cb) => cb && cb({ key: 'chatgpt:c1', ok: true, count: 2 })
    };
    window.chrome.runtime = window.chrome.runtime || {
      onMessage: { addListener: () => {} }
    };
  }

  const $ = (id) => document.getElementById(id);
  const SUMMARY_PROMPT =
    'Write a handoff summary of our conversation so I can continue it in a new chat. Include: ' +
    '1) the goal, 2) key decisions and why, 3) the current state of the work, ' +
    '4) the latest version of any code, 5) open problems and the exact next step. Be concise.';

  let chats = [];
  let current = null;
  let currentKey = null;
  let notesTimer = null;
  let toastTimer = null;
  let copyResetTimer = null;
  let previewExpanded = false;

  // --- Monogram & Site Identity ---
  const SITE_LOGOS = {
    chatgpt: 'chatgpt-logo.webp',
    claude: 'claude-logo.png',
    gemini: 'gemini-logo.webp',
    kimi: 'kimi-logo.webp',
  };

  const MONOGRAMS = {
    chatgpt: { label: 'CG', dot: 'chatgpt', name: 'ChatGPT' },
    claude: { label: 'CL', dot: 'claude', name: 'Claude' },
    gemini: { label: 'GE', dot: 'gemini', name: 'Gemini' },
    kimi: { label: 'KI', dot: 'kimi', name: 'Kimi' },
  };

  function getSiteMeta(siteId) {
    const s = (siteId || '').toLowerCase();
    const logoFile = SITE_LOGOS[s] || null;
    const base = MONOGRAMS[s] || { label: 'AI', dot: 'ai', name: 'AI Chat' };
    return {
      ...base,
      site: s,
      logoFile,
    };
  }

  function createSiteChip(siteId, size = 20) {
    const meta = getSiteMeta(siteId);
    if (typeof document === 'undefined') return null;
    const chip = document.createElement('span');
    chip.className = 'siteChip' + (meta.logoFile ? ' logoChip' : '');

    if (meta.logoFile) {
      const img = document.createElement('img');
      img.src = `../icons/${meta.logoFile}`;
      img.alt = meta.name;
      img.width = size;
      img.height = size;
      img.className = 'siteLogoImg';
      img.onerror = () => {
        chip.classList.remove('logoChip');
        chip.textContent = '';
        const dot = document.createElement('span');
        dot.className = 'siteDot ' + meta.dot;
        const mono = document.createElement('span');
        mono.className = 'siteMonogram';
        mono.textContent = meta.label;
        chip.append(dot, mono);
      };
      chip.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'siteDot ' + meta.dot;
      const mono = document.createElement('span');
      mono.className = 'siteMonogram';
      mono.textContent = meta.label;
      chip.append(dot, mono);
    }
    return chip;
  }

  function updateSiteChip(chipEl, siteId, size = 20) {
    if (!chipEl) return;
    const newChip = createSiteChip(siteId, size);
    if (!newChip) return;
    chipEl.className = newChip.className;
    chipEl.textContent = '';
    while (newChip.firstChild) {
      chipEl.appendChild(newChip.firstChild);
    }
  }

  // --- Theme Management (UI preferences in localStorage with "ui:" prefix) ---
  function applyTheme(theme) {
    const resolved = theme || 'auto';
    try {
      localStorage.setItem('ui:theme', resolved);
    } catch (e) {}
    if (document.documentElement) document.documentElement.setAttribute('data-theme', resolved);

    document.querySelectorAll('.themeOptionBtn').forEach((btn) => {
      const match = btn.getAttribute('data-theme-val') === resolved;
      btn.classList.toggle('active', match);
      btn.setAttribute('aria-checked', match ? 'true' : 'false');
    });
  }

  function initTheme() {
    let saved = 'auto';
    try {
      saved = localStorage.getItem('ui:theme') || 'auto';
    } catch (e) {}
    applyTheme(saved);

    document.querySelectorAll('.themeOptionBtn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-theme-val');
        applyTheme(val);
      });
    });
  }

  // --- Toasts (Replaces plain status line, maintains accessibility) ---
  function showToast(text, duration = 2400) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, duration);

    // Keep hidden status element updated for screen readers
    const srStatus = $('status');
    if (srStatus) srStatus.textContent = text;
  }

  // --- Relative Time Formatting (No middle dots) ---
  function formatRelativeTime(ts) {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'saved just now';
    if (m < 60) return `saved ${m}m ago`;
    if (m < 1440) return `saved ${Math.round(m / 60)}h ago`;
    return `saved ${Math.round(m / 1440)}d ago`;
  }

  // --- Active Tab Identification ---
  function activeKey() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (!t) return resolve(null);
        chrome.tabs.sendMessage(t.id, { type: 'ctx:key' }, (r) => {
          void chrome.runtime.lastError; // Not a supported site or no content script
          resolve((r && r.key) || null);
        });
      });
    });
  }

  const shouldAutosave = (CTX && CTX.shouldAutosave) || function (autosave, key, site) {
    if (!autosave) return false;
    if (key && autosave.chats && typeof autosave.chats[key] === 'boolean') {
      return autosave.chats[key];
    }
    if (site && autosave.sites && typeof autosave.sites[site] === 'boolean') {
      return autosave.sites[site];
    }
    return Boolean(autosave.default);
  };

  // --- Update Current Tab Card ---
  function updateCurrentTabStatus(settings) {
    const card = $('currentTabBox');
    const noTabCard = $('noActiveTabBox');

    if (!currentKey) {
      if (card) card.hidden = true;
      if (noTabCard) noTabCard.hidden = false;
      return;
    }

    if (card) card.hidden = false;
    if (noTabCard) noTabCard.hidden = true;

    const site = currentKey.split(':')[0];
    const meta = getSiteMeta(site);
    const autosave = (settings && settings.autosave) || {};
    const isAuto = shouldAutosave(autosave, currentKey, site);

    const chip = $('currentTabChip');
    if (chip) {
      updateSiteChip(chip, site, 20);
    }

    const savedChat = chats.find((c) => c.key === currentKey);
    const statusPill = $('currentTabStatus');
    const msgCountEl = $('currentMsgCount');
    const savedTimeEl = $('currentSavedTime');
    const titleEl = $('currentChatTitle');

    if (titleEl) {
      titleEl.textContent = (savedChat && savedChat.title) || meta.name;
    }

    $('autosaveChat').checked = isAuto;

    if (isAuto) {
      statusPill.textContent = 'Auto-saving';
      statusPill.className = 'statusPill active';
    } else if (savedChat && savedChat.messages && savedChat.messages.length) {
      statusPill.textContent = `Saved - ${savedChat.messages.length} message${savedChat.messages.length === 1 ? '' : 's'}`;
      statusPill.className = 'statusPill';
    } else {
      statusPill.textContent = 'Not saved';
      statusPill.className = 'statusPill';
    }

    if (savedChat && savedChat.messages) {
      const count = savedChat.messages.length;
      msgCountEl.textContent = `${count} message${count === 1 ? '' : 's'}`;
      savedTimeEl.textContent = formatRelativeTime(savedChat.updatedAt);
    } else {
      msgCountEl.textContent = '0 messages';
      savedTimeEl.textContent = 'not saved yet';
    }
  }

  // --- Data Loading ---
  async function load() {
    const all = await chrome.storage.local.get(null);
    chats = Object.keys(all)
      .filter((k) => k.startsWith('chat:'))
      .map((k) => all[k])
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (all.settings && all.settings.budget) {
      setBudgetValue(String(all.settings.budget));
    }

    currentKey = await activeKey();
    renderChatList();

    const here = chats.find((c) => c.key === currentKey);
    if (here) {
      select(here);
    } else if (chats.length) {
      select(chats[0]);
    } else {
      $('detail').hidden = true;
    }

    $('autosaveNotice').hidden = Boolean(all.settings && all.settings.autosaveNoticeDismissed);
    updateCurrentTabStatus(all.settings);
  }

  // --- Segmented Budget Switcher ---
  function setBudgetValue(val) {
    const b = $('budget');
    if (b) b.value = String(val);

    document.querySelectorAll('.segmentBtn').forEach((btn) => {
      const active = btn.getAttribute('data-value') === String(val);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  // --- Render Saved Chats List ---
  function renderChatList() {
    const list = $('list');
    list.textContent = '';

    const filterText = ($('popupSearch') ? $('popupSearch').value : '').toLowerCase().trim();
    const filtered = chats.filter((c) => {
      if (!filterText) return true;
      const title = (c.title || '').toLowerCase();
      const site = (c.siteName || '').toLowerCase();
      return title.includes(filterText) || site.includes(filterText);
    });

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.style.padding = '12px 8px';
      empty.style.fontSize = '12px';
      empty.style.color = 'var(--text-3)';
      empty.textContent = filterText ? 'No matching chats found.' : 'No saved chats yet.';
      list.appendChild(empty);
      return;
    }

    for (const c of filtered) {
      const item = document.createElement('div');
      item.className = 'chatItem' + (current && current.key === c.key ? ' active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', current && current.key === c.key ? 'true' : 'false');

      const meta = getSiteMeta(c.site);
      const main = document.createElement('div');
      main.className = 'itemMain';

      const title = document.createElement('div');
      title.className = 'itemTitle';
      title.textContent = c.title || 'Untitled chat';

      const metaRow = document.createElement('div');
      metaRow.className = 'itemMetaRow';

      const siteSpan = document.createElement('span');
      siteSpan.textContent = meta.name;

      const countSpan = document.createElement('span');
      const count = (c.messages && c.messages.length) || 0;
      countSpan.textContent = `${count} msg${count === 1 ? '' : 's'}`;

      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatRelativeTime(c.updatedAt);

      metaRow.append(siteSpan, countSpan, timeSpan);
      main.append(title, metaRow);
      item.appendChild(main);

      item.addEventListener('click', () => select(c));
      list.appendChild(item);
    }
  }

  // --- Chat Selection ---
  async function select(chat) {
    current = chat;
    $('detail').hidden = false;
    $('detailTitle').textContent = chat.title || 'Untitled chat';

    const meta = getSiteMeta(chat.site);
    $('detailMeta').textContent = meta.name;

    const nk = 'notes:' + chat.key;
    const storedNotes = (await chrome.storage.local.get(nk))[nk] || '';
    $('notes').value = storedNotes;

    renderChatList();
    preview();
  }

  // --- Live Preview & Token Meter ---
  function preview() {
    if (!current) return;
    const budgetVal = Number($('budget').value) || 5000;
    const r = CTX.buildHandoff(current, { budget: budgetVal, notes: $('notes').value });

    $('preview').value = r.text;

    // Token Count Label
    const countLabel = $('tokenCountLabel');
    if (countLabel) {
      countLabel.textContent = `${r.tokens.toLocaleString()} of ${budgetVal.toLocaleString()} tokens`;
    }

    // Meter Fill Bar
    const meterFill = $('meterFill');
    const warningEl = $('tokenWarning');
    if (meterFill) {
      const pct = Math.min(100, Math.round((r.tokens / budgetVal) * 100));
      meterFill.style.width = pct + '%';
      meterFill.className = 'meterFill' + (r.overBudget ? ' danger' : pct > 90 ? ' warn' : '');
    }
    if (warningEl) {
      warningEl.hidden = !r.overBudget;
      if (r.overBudget) warningEl.textContent = 'over limit: shorten notes';
    }

    // Fixed Pluralization on Stats Line
    const statsEl = $('stats');
    if (statsEl) {
      const codeWord = r.codeBlocks === 1 ? '1 code block' : `${r.codeBlocks} code blocks`;
      const msgWord = `${r.verbatim} of ${r.totalMessages} messages kept word for word`;
      statsEl.textContent = r.codeBlocks ? `${msgWord}, ${codeWord}` : msgWord;
    }
  }

  // --- Clipboard Helper ---
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  // --- Signature Copy Animation ---
  function triggerSignatureAnimation() {
    // 1. Baton slides along lane line
    const baton = $('laneBaton');
    if (baton) {
      baton.classList.remove('slide');
      void baton.offsetWidth; // Force DOM reflow
      baton.classList.add('slide');
      setTimeout(() => {
        baton.classList.remove('slide');
      }, 1400);
    }

    // 2. Button text reads "Copied" for 1.5s
    const copyBtnText = $('copyBtnText');
    if (copyBtnText) {
      copyBtnText.textContent = 'Copied';
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyBtnText.textContent = 'Copy context';
      }, 1500);
    }
  }

  // --- Inline Confirmation Dialog (replaces window.confirm) ---
  let pendingConfirmAction = null;

  function showConfirm(heading, message, onConfirm, actionText = 'Delete') {
    const dialog = $('confirmDialog');
    if (!dialog) {
      if (window.confirm(message)) onConfirm();
      return;
    }
    $('confirmHeading').textContent = heading;
    $('confirmMessage').textContent = message;
    $('confirmAcceptBtn').textContent = actionText;
    pendingConfirmAction = onConfirm;
    dialog.showModal();
    $('confirmCancelBtn').focus();
  }

  $('confirmCancelBtn').addEventListener('click', () => {
    $('confirmDialog').close();
    pendingConfirmAction = null;
  });

  $('confirmAcceptBtn').addEventListener('click', async () => {
    $('confirmDialog').close();
    if (typeof pendingConfirmAction === 'function') {
      const action = pendingConfirmAction;
      pendingConfirmAction = null;
      await action();
    }
  });

  // --- Capturing State ---
  let capturing = false;

  function setCapturing(isCapturing, showCancel = false) {
    capturing = isCapturing;
    const btn = $('captureBtn');
    const cancelBtn = $('cancelBtn');
    const progressBox = $('captureProgressBox');

    if (btn) {
      btn.disabled = isCapturing;
      btn.textContent = isCapturing ? 'Capturing…' : 'Capture chat';
    }
    if (cancelBtn) {
      cancelBtn.hidden = !showCancel;
    }
    if (progressBox) {
      progressBox.hidden = !isCapturing;
    }
  }

  // --- Event Listeners ---

  // Capture Button
  $('captureBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t) return showToast('No active tab.');

      setCapturing(true, false);
      const statusText = $('captureStatusText');
      if (statusText) statusText.textContent = 'Reading chat…';

      chrome.tabs.sendMessage(t.id, { type: 'ctx:capture' }, async (r) => {
        setCapturing(false, false);
        if (chrome.runtime.lastError || !r) {
          return showToast('Tab is not a supported chat site (or needs a refresh).');
        }
        if (!r.ok) {
          const m = r.matched
            ? `Matched ${r.matched.user} user / ${r.matched.assistant} assistant elements.`
            : '';
          const err = r.error ? (r.error.endsWith('.') ? r.error : r.error + '.') : 'Failed to capture chat.';
          return showToast(m ? `${err} ${m}` : err);
        }
        const msg = r.summary || (r.count !== undefined && r.added !== undefined ? `Captured ${r.count} messages (${r.added} new)` : (r.report || `Captured ${r.count} messages`));
        showToast(msg);
        await load();
      });
    });
  });

  // Cancel Button
  $('cancelBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (t) {
        chrome.tabs.sendMessage(t.id, { type: 'ctx:cancelCapture' }, () => {
          showToast('Cancelling capture…');
        });
      }
    });
  });

  // Capture Progress listener
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ctx:captureProgress') {
      const statusText = $('captureStatusText');
      if (msg.phase === 'reading') {
        const str = `Reading ${msg.count} message${msg.count === 1 ? '' : 's'}…`;
        if (statusText) statusText.textContent = str;
      } else if (msg.phase === 'loading') {
        setCapturing(true, true);
        const str = `Loading earlier messages (${msg.count} found)…`;
        if (statusText) statusText.textContent = str;
      }
    }
  });

  // Auto-save Toggle
  $('autosaveChat').addEventListener('change', async () => {
    if (!currentKey) return;
    const all = await chrome.storage.local.get('settings');
    const settings = all.settings || {};
    settings.autosave = settings.autosave || {
      default: false,
      sites: { chatgpt: false, claude: false, gemini: false, kimi: false },
      chats: {},
    };
    settings.autosave.chats = settings.autosave.chats || {};
    settings.autosave.chats[currentKey] = $('autosaveChat').checked;
    await chrome.storage.local.set({ settings });
    updateCurrentTabStatus(settings);
    showToast(settings.autosave.chats[currentKey] ? 'Auto-updating enabled for this chat' : 'Auto-updating disabled');
  });

  // Segmented Budget Buttons
  document.querySelectorAll('.segmentBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-value');
      setBudgetValue(val);
      chrome.storage.local.set({ settings: { budget: Number(val) } });
      preview();
    });
  });

  // Notes Field
  $('notes').addEventListener('input', () => {
    preview();
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      if (current) {
        chrome.storage.local.set({ ['notes:' + current.key]: $('notes').value });
      }
    }, 400);
  });

  // Copy Handoff Prompt Helper
  $('copyPrompt').addEventListener('click', async () => {
    await copyText(SUMMARY_PROMPT);
    showToast('Prompt copied. Paste it into your chat before switching.');
  });

  // Toggle Preview Expand/Collapse
  $('togglePreviewBtn').addEventListener('click', () => {
    previewExpanded = !previewExpanded;
    const wrapper = $('previewWrapper');
    if (wrapper) {
      wrapper.className = 'previewWrapper ' + (previewExpanded ? 'expanded' : 'collapsed');
    }
    $('togglePreviewBtn').textContent = previewExpanded ? 'Collapse preview' : 'Show full preview';
  });

  // Primary Copy Action
  $('copy').addEventListener('click', async () => {
    if (!$('preview').value) return showToast('No context to copy.');
    await copyText($('preview').value);
    triggerSignatureAnimation();
    showToast('Context copied. Ready to paste in new chat.');
  });

  // Export Markdown
  $('export').addEventListener('click', () => {
    if (!current) return showToast('No chat selected.');
    const blob = new Blob([$('preview').value], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `handoff-${current.site || 'ai'}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Exported Markdown file.');
  });

  // Delete Chat with Two-Step Inline Confirmation
  $('delete').addEventListener('click', () => {
    if (!current) return;
    const title = current.title || 'this chat';
    showConfirm(
      'Delete chat',
      `Permanently delete "${title}" and its notes from this device?`,
      async () => {
        await chrome.storage.local.remove(['chat:' + current.key, 'notes:' + current.key]);
        showToast('Chat deleted.');
        current = null;
        $('detail').hidden = true;
        await load();
      },
      'Delete permanently'
    );
  });

  // Menu Toggle & Outside Click
  $('menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('headerMenu');
    const isHidden = menu.hidden;
    menu.hidden = !isHidden;
    $('menuBtn').setAttribute('aria-expanded', String(!isHidden));
  });

  document.addEventListener('click', (e) => {
    const menu = $('headerMenu');
    if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== $('menuBtn')) {
      menu.hidden = true;
      $('menuBtn').setAttribute('aria-expanded', 'false');
    }
  });

  // Clear All with Two-Step Inline Confirmation
  $('menuClearAll').addEventListener('click', () => {
    $('headerMenu').hidden = true;
    showConfirm(
      'Clear all saved chats',
      'Permanently delete ALL saved chats and notes on this device? This cannot be undone.',
      async () => {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith('chat:') || k.startsWith('notes:'));
        await chrome.storage.local.remove(keys);
        showToast('All saved chats cleared.');
        current = null;
        $('detail').hidden = true;
        await load();
      },
      'Clear all data'
    );
  });

  // Open Manager
  function openManager() {
    if (chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('manager/manager.html'));
    }
  }

  $('manageBtn').addEventListener('click', openManager);
  $('seeAllBtn').addEventListener('click', openManager);

  // Search filter
  $('popupSearch').addEventListener('input', () => {
    renderChatList();
  });

  // Dismiss autosave notice
  $('dismissNotice').addEventListener('click', async () => {
    $('autosaveNotice').hidden = true;
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings || {};
    settings.autosaveNoticeDismissed = true;
    await chrome.storage.local.set({ settings });
  });

  // React live to storage changes without requiring popup reopen
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        load();
      }
    });
  }

  // Initialize
  initTheme();
  load();
})();
