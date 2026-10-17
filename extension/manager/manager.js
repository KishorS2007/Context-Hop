(function (root) {
  'use strict';

  const CTX = (root.CTX = root.CTX || {});
  const $ = (id) => document.getElementById(id);

  const MAX_BACKUP_SIZE = 25 * 1024 * 1024; // 25 MB
  const PAGE_SIZE = 50;

  // --- Core Utility & Logic Functions (attached to CTX.manager for testing) ---

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || isNaN(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function validateBackup(dataOrString, fileSize) {
    if (fileSize !== undefined && fileSize > MAX_BACKUP_SIZE) {
      return { valid: false, error: 'File is too large (maximum size is 25 MB).' };
    }

    let data = dataOrString;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return { valid: false, error: 'Invalid JSON file: ' + e.message };
      }
    }

    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Invalid backup format: root must be a JSON object or array.' };
    }

    let rawList = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (Array.isArray(data.chats)) {
      rawList = data.chats;
    } else {
      const keys = Object.keys(data).filter((k) => k.startsWith('chat:') || (data[k] && data[k].key));
      if (keys.length) {
        rawList = keys.map((k) => data[k]);
      } else {
        return { valid: false, error: 'Invalid backup format: no chats array or recognized chat keys found.' };
      }
    }

    if (!rawList.length) {
      return { valid: false, error: 'Backup contains no chat records.' };
    }

    const validChats = [];
    for (let i = 0; i < rawList.length; i++) {
      const c = rawList[i];
      if (!c || typeof c !== 'object') continue;
      if (typeof c.key !== 'string' || !c.key.trim()) continue;
      if (!Array.isArray(c.messages)) continue;

      const validMessages = [];
      for (const m of c.messages) {
        if (m && typeof m === 'object' && typeof m.role === 'string' && typeof m.text === 'string') {
          validMessages.push({ role: m.role, text: m.text });
        }
      }
      if (!validMessages.length) continue;

      validChats.push({
        key: c.key.trim(),
        site: c.site || c.key.split(':')[0] || 'chatgpt',
        siteName: c.siteName || c.site || 'AI Chat',
        title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Untitled chat',
        titleEdited: Boolean(c.titleEdited),
        url: typeof c.url === 'string' ? c.url : '',
        updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
        messages: validMessages,
        notes: typeof c.notes === 'string' ? c.notes : undefined,
      });
    }

    if (!validChats.length) {
      return { valid: false, error: 'Backup contains no valid chat items (each must have a key and messages).' };
    }

    return { valid: true, chats: validChats };
  }

  async function mergeBackup(existingStorage, importedChats, onConflict) {
    const toSet = {};
    const added = [];
    const updated = [];
    const skipped = [];

    for (const item of importedChats) {
      const sk = 'chat:' + item.key;
      const existing = existingStorage[sk];
      if (existing) {
        let choice = 'overwrite';
        if (onConflict) {
          choice = await onConflict(item, existing);
        }
        if (choice === 'overwrite') {
          toSet[sk] = {
            key: item.key,
            site: item.site,
            siteName: item.siteName,
            title: item.title,
            titleEdited: item.titleEdited,
            url: item.url || existing.url || '',
            updatedAt: item.updatedAt || Date.now(),
            messages: item.messages,
          };
          if (item.notes !== undefined) {
            toSet['notes:' + item.key] = item.notes;
          }
          updated.push(item.key);
        } else {
          skipped.push(item.key);
        }
      } else {
        toSet[sk] = {
          key: item.key,
          site: item.site,
          siteName: item.siteName,
          title: item.title,
          titleEdited: item.titleEdited,
          url: item.url || '',
          updatedAt: item.updatedAt || Date.now(),
          messages: item.messages,
        };
        if (item.notes !== undefined) {
          toSet['notes:' + item.key] = item.notes;
        }
        added.push(item.key);
      }
    }

    return { toSet, added, updated, skipped };
  }

  function findOlderThanDays(chats, days, now = Date.now()) {
    const d = Number(days);
    if (!d || d <= 0) return [];
    const cutoff = now - d * 24 * 60 * 60 * 1000;
    return chats.filter((c) => (c.updatedAt || 0) < cutoff);
  }

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

  CTX.manager = {
    validateBackup,
    mergeBackup,
    findOlderThanDays,
    formatBytes,
    SITE_LOGOS,
    MONOGRAMS,
    getSiteMeta,
    createSiteChip,
    updateSiteChip,
  };

  // If not running inside manager.html, stop here
  if (typeof document === 'undefined' || !$('chatList')) return;

  // --- Manager Page UI & State Controller ---

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
          { role: 'assistant', text: 'Store refresh tokens in an **httpOnly, Secure, SameSite=Lax** cookie. Never expose them to client JavaScript in `localStorage`.\n\n```typescript\nres.setHeader("Set-Cookie", serialize("refreshToken", token, {\n  httpOnly: true,\n  secure: process.env.NODE_ENV === "production",\n  sameSite: "lax",\n  maxAge: 60 * 60 * 24 * 7 // 7 days\n}));\n```' }
        ]
      },
      settings: {
        budget: 5000,
        autosave: { default: false, sites: { chatgpt: true } }
      }
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
  }

  let allChats = [];
  let allSettings = {};
  let selectedKey = null;
  const selectedForBulk = new Set();
  let activeSiteFilter = 'all';
  let currentConvPage = 1;
  let activeTab = 'tabConversation';
  let notesTimer = null;
  let toastTimer = null;

  const SUMMARY_PROMPT =
    'Write a handoff summary of our conversation so I can continue it in a new chat. Include: ' +
    '1) the goal, 2) key decisions and why, 3) the current state of the work, ' +
    '4) the latest version of any code, 5) open problems and the exact next step. Be concise.';


  function showToast(text, duration = 2500) {
    const toast = $('managerToast');
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, duration);
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.round((Date.now() - ts) / 60000);
    if (diff < 1) return 'just now';
    if (diff < 60) return diff + 'm ago';
    if (diff < 1440) return Math.round(diff / 60) + 'h ago';
    if (diff < 43200) return Math.round(diff / 1440) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function downloadBlob(filename, text, mimeType = 'text/plain') {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

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

  // --- UI Settings (Stored in localStorage with "ui:" prefix) ---
  const getUiPref = (key, fallback) => {
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem(key);
        return v !== null ? v : fallback;
      }
    } catch (e) {}
    return fallback;
  };

  const setUiPref = (key, val) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, val);
      }
    } catch (e) {}
  };

  function initUiPreferences() {
    const savedTheme = getUiPref('ui:theme', 'auto');
    if (document.documentElement) document.documentElement.setAttribute('data-theme', savedTheme);
    const themeSelect = $('themeSelect');
    if (themeSelect) themeSelect.value = savedTheme;

    const savedDensity = getUiPref('ui:density', 'comfortable');
    if (document.documentElement) document.documentElement.setAttribute('data-density', savedDensity);
    const densitySelect = $('densitySelect');
    if (densitySelect) densitySelect.value = savedDensity;

    const savedSort = getUiPref('ui:sort', 'newest');
    const sortSelect = $('sortSelect');
    if (sortSelect) sortSelect.value = savedSort;

    const savedTab = getUiPref('ui:lastTab', 'tabConversation');
    switchTab(savedTab);

    // Static site chip rendering for filter chips and settings
    document.querySelectorAll('.chipFilterIcon').forEach((el) => {
      const site = el.getAttribute('data-site');
      el.replaceWith(createSiteChip(site, 16));
    });
    document.querySelectorAll('.settingSiteIcon').forEach((el) => {
      const site = el.getAttribute('data-site');
      el.replaceWith(createSiteChip(site, 18));
    });
  }

  // --- Storage & Data Loading ---
  async function loadData() {
    try {
      const all = await chrome.storage.local.get(null);
      allSettings = all.settings || {};

      allChats = Object.keys(all)
        .filter((k) => k.startsWith('chat:'))
        .map((k) => all[k]);

      // Update storage meter
      updateStorageMeter();

      // Update filter chip counts
      updateFilterCounts();

      // Render sidebar list
      renderList();

      // Handle selection: check URL query or hash first (e.g. manager.html?chat=key)
      let initialKeyFromUrl = null;
      try {
        const urlParams = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ''));
        initialKeyFromUrl = urlParams.get('chat') || urlParams.get('key');
      } catch (e) {}

      if (initialKeyFromUrl && allChats.some((c) => c.key === initialKeyFromUrl)) {
        const targetChat = allChats.find((c) => c.key === initialKeyFromUrl);
        if (targetChat && activeSiteFilter !== 'all' && (targetChat.site || '').toLowerCase() !== activeSiteFilter) {
          activeSiteFilter = 'all';
          document.querySelectorAll('.chip').forEach((c) => {
            c.classList.toggle('active', c.getAttribute('data-site') === 'all');
          });
        }
        selectChat(initialKeyFromUrl);
      } else if (selectedKey && allChats.some((c) => c.key === selectedKey)) {
        renderDetail(selectedKey);
      } else if (allChats.length > 0) {
        const sorted = getFilteredChats();
        if (sorted.length > 0) {
          selectChat(sorted[0].key);
        } else {
          selectChat(allChats[0].key);
        }
      } else {
        selectedKey = null;
        renderDetail(null);
      }
    } catch (e) {
      console.error('Failed to load manager data', e);
    }
  }

  function updateStorageMeter() {
    if (chrome.storage && chrome.storage.local && chrome.storage.local.getBytesInUse) {
      chrome.storage.local.getBytesInUse(null, (bytes) => {
        const badge = $('storageBadge');
        if (badge) badge.textContent = formatBytes(bytes) + ' used';
      });
    }
  }

  function updateFilterCounts() {
    const counts = { all: allChats.length, chatgpt: 0, claude: 0, gemini: 0, kimi: 0 };
    for (const c of allChats) {
      const s = (c.site || '').toLowerCase();
      if (counts[s] !== undefined) counts[s]++;
    }
    const setTxt = (id, n) => {
      const el = $(id);
      if (el) el.textContent = String(n);
    };
    setTxt('countAll', counts.all);
    setTxt('countChatgpt', counts.chatgpt);
    setTxt('countClaude', counts.claude);
    setTxt('countGemini', counts.gemini);
    setTxt('countKimi', counts.kimi);
  }

  // --- Filtering & Sorting ---
  function getFilteredChats() {
    let list = allChats.slice();

    if (activeSiteFilter !== 'all') {
      list = list.filter((c) => (c.site || '').toLowerCase() === activeSiteFilter);
    }

    const query = ($('searchInput') ? $('searchInput').value : '').trim().toLowerCase();
    if (query) {
      list = list.filter((c) => {
        const titleMatch = (c.title || '').toLowerCase().includes(query);
        if (titleMatch) return true;
        if (Array.isArray(c.messages)) {
          return c.messages.some((m) => (m.text || '').toLowerCase().includes(query));
        }
        return false;
      });
    }

    const sortType = ($('sortSelect') ? $('sortSelect').value : 'newest') || 'newest';
    list.sort((a, b) => {
      if (sortType === 'newest') return (b.updatedAt || 0) - (a.updatedAt || 0);
      if (sortType === 'oldest') return (a.updatedAt || 0) - (b.updatedAt || 0);
      if (sortType === 'messages') return ((b.messages && b.messages.length) || 0) - ((a.messages && a.messages.length) || 0);
      if (sortType === 'title') return (a.title || '').localeCompare(b.title || '');
      return 0;
    });

    return list;
  }

  // --- Render Sidebar List ---
  function renderList() {
    const listEl = $('chatList');
    if (!listEl) return;
    listEl.textContent = '';

    const visible = getFilteredChats();
    const countEl = $('visibleCount');
    if (countEl) countEl.textContent = String(visible.length);

    const emptyState = $('listEmptyState');
    if (emptyState) {
      emptyState.hidden = visible.length > 0;
      if (visible.length === 0) {
        const query = $('searchInput') ? $('searchInput').value.trim() : '';
        $('listEmptyText').textContent = query ? 'No matching chats found.' : 'No saved chats found.';
      }
    }

    for (const chat of visible) {
      const item = document.createElement('div');
      item.className = 'chatRow' + (chat.key === selectedKey ? ' active' : '') + (selectedForBulk.has(chat.key) ? ' selected' : '');
      item.dataset.key = chat.key;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', chat.key === selectedKey ? 'true' : 'false');

      // Checkbox for bulk actions
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'rowCheckbox';
      chk.checked = selectedForBulk.has(chat.key);
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', () => {
        if (chk.checked) selectedForBulk.add(chat.key);
        else selectedForBulk.delete(chat.key);
        item.classList.toggle('selected', chk.checked);
        updateBulkActionsBar();
      });

      // Site Chip with Logo
      const chip = createSiteChip(chat.site, 20);

      // Main Content
      const content = document.createElement('div');
      content.className = 'rowContent';

      const title = document.createElement('div');
      title.className = 'rowTitle';
      title.textContent = chat.title || 'Untitled chat';

      const metaLine = document.createElement('div');
      metaLine.className = 'rowMetaLine';

      const msgCount = document.createElement('span');
      const count = (chat.messages && chat.messages.length) || 0;
      msgCount.textContent = `${count} msg${count === 1 ? '' : 's'}`;

      const timeSpan = document.createElement('span');
      timeSpan.textContent = timeAgo(chat.updatedAt);

      metaLine.append(msgCount, timeSpan);

      const isAuto = shouldAutosave(allSettings.autosave, chat.key, chat.site);
      if (isAuto) {
        const autoBadge = document.createElement('span');
        autoBadge.className = 'autoPill';
        autoBadge.textContent = 'Auto-updating';
        metaLine.appendChild(autoBadge);
      }

      content.append(title, metaLine);
      item.append(chk, chip, content);

      item.addEventListener('click', () => {
        selectChat(chat.key);
        // On mobile drawer, close sidebar after selection
        if (window.innerWidth <= 900) {
          closeSidebar();
        }
      });

      listEl.appendChild(item);
    }

    updateBulkActionsBar();
  }

  function updateBulkActionsBar() {
    const bar = $('bulkActionsBar');
    const badge = $('selectedCountBadge');
    const selectAllChk = $('selectAllCheckbox');
    const visible = getFilteredChats();

    const count = selectedForBulk.size;
    if (count > 0) {
      if (bar) bar.hidden = false;
      if (badge) badge.textContent = `${count} selected`;
    } else {
      if (bar) bar.hidden = true;
    }

    if (!selectAllChk) return;
    if (visible.length > 0 && visible.every((c) => selectedForBulk.has(c.key))) {
      selectAllChk.checked = true;
      selectAllChk.indeterminate = false;
    } else if (visible.some((c) => selectedForBulk.has(c.key))) {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = true;
    } else {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = false;
    }
  }

  // --- Right Pane: Detail View ---
  function selectChat(key) {
    selectedKey = key;
    currentConvPage = 1;
    renderList();
    renderDetail(key);

    const listEl = $('chatList');
    if (listEl) {
      const activeRow = listEl.querySelector(`.chatRow[data-key="${key}"]`);
      if (activeRow && typeof activeRow.scrollIntoView === 'function') {
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  async function renderDetail(key) {
    const noSelection = $('noSelectionState');
    const detailView = $('selectedChatDetail');

    if (!key) {
      if (noSelection) noSelection.hidden = false;
      if (detailView) detailView.hidden = true;
      const h2 = noSelection ? noSelection.querySelector('h2') : null;
      const p = noSelection ? noSelection.querySelector('p') : null;
      if (allChats.length === 0) {
        if (h2) h2.textContent = 'No Saved Chats';
        if (p) p.textContent = 'Open a chat in ChatGPT, Claude, Gemini or Kimi, then click Capture chat.';
      } else {
        if (h2) h2.textContent = 'No Chat Selected';
        if (p) p.textContent = 'Select a chat from the list on the left to view the conversation or generate a handoff prompt.';
      }
      $('detailTitle').textContent = '';
      $('messagesList').textContent = '';
      $('handoffNotes').value = '';
      $('handoffPreview').value = '';
      return;
    }

    const chat = allChats.find((c) => c.key === key);
    if (!chat) {
      return renderDetail(null);
    }

    if (noSelection) noSelection.hidden = true;
    if (detailView) detailView.hidden = false;

    // Title & Metadata
    $('detailTitle').textContent = chat.title || 'Untitled chat';

    updateSiteChip($('detailSiteChip'), chat.site, 22);

    const msgCount = (chat.messages && chat.messages.length) || 0;
    const msgChip = $('detailMsgChip');
    if (msgChip) msgChip.textContent = `${msgCount} message${msgCount === 1 ? '' : 's'}`;

    const timeChip = $('detailTimeChip');
    if (timeChip) {
      timeChip.textContent = 'Updated ' + timeAgo(chat.updatedAt);
      timeChip.title = chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : '';
    }

    const convCount = $('convMessageCount');
    if (convCount) convCount.textContent = String(msgCount);

    // Load Notes
    const nk = 'notes:' + chat.key;
    const notesData = await chrome.storage.local.get(nk);
    const notesVal = notesData[nk] || '';
    $('handoffNotes').value = notesVal;
    updateNotesCharCount(notesVal);

    // Render Conversation
    renderConversation(chat);

    // Render Handoff
    renderHandoffPreview(chat);

    // Update tab underline position
    updateTabUnderline();
  }

  function updateNotesCharCount(str) {
    const el = $('notesCharCount');
    if (el) el.textContent = `${(str || '').length} characters`;
  }

  // --- Markdown Renderer (createElement and textContent ONLY, NO innerHTML) ---
  function parseInlineMarkdown(text, parentNode) {
    // Regex for inline code, bold, italic, links, and urls
    const inlineRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = inlineRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parentNode.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        const code = document.createElement('code');
        code.className = 'inlineCode';
        code.textContent = token.slice(1, -1);
        parentNode.appendChild(code);
      } else if (token.startsWith('**') && token.endsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        parentNode.appendChild(strong);
      } else if (token.startsWith('*') && token.endsWith('*')) {
        const em = document.createElement('em');
        em.textContent = token.slice(1, -1);
        parentNode.appendChild(em);
      } else if (token.startsWith('[') && token.includes('](')) {
        const closeBracket = token.indexOf('](');
        const label = token.slice(1, closeBracket);
        const url = token.slice(closeBracket + 2, -1);
        const a = document.createElement('a');
        a.textContent = label;
        if (/^https?:\/\//i.test(url)) {
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
        parentNode.appendChild(a);
      } else if (token.startsWith('http://') || token.startsWith('https://')) {
        const a = document.createElement('a');
        a.textContent = token;
        a.href = token;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parentNode.appendChild(a);
      }
      lastIndex = inlineRegex.lastIndex;
    }
    if (lastIndex < text.length) {
      parentNode.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderMarkdownBlocks(text, container) {
    container.textContent = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'renderedMarkdown';

    // Check if plain message looks entirely like code (starts with indentation, braces, or keywords)
    const looksLikeCode =
      !text.includes('```') &&
      (/^(\s{2,}|function|class|import|const|let|var|def|\{|\<)/m.test(text) || (text.split('\n').length > 4 && /;|\{|\}/.test(text)));

    if (looksLikeCode && text.length > 50) {
      renderCodeBlock('', text, wrapper);
      container.appendChild(wrapper);
      return;
    }

    const lines = text.split('\n');
    let inCodeBlock = false;
    let codeLang = '';
    let codeBuffer = [];
    let tableBuffer = [];

    function flushTable() {
      if (!tableBuffer.length) return;
      const table = document.createElement('table');
      table.className = 'mdTable';
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');

      tableBuffer.forEach((rowLine, idx) => {
        if (/^\s*\|?[-:| ]+\|?\s*$/.test(rowLine)) return; // divider
        const cells = rowLine.split('|').map((s) => s.trim()).filter((_, i, arr) => i > 0 && i < arr.length - (rowLine.endsWith('|') ? 1 : 0));
        const tr = document.createElement('tr');
        for (const c of cells) {
          const cell = document.createElement(idx === 0 ? 'th' : 'td');
          parseInlineMarkdown(c, cell);
          tr.appendChild(cell);
        }
        if (idx === 0) thead.appendChild(tr);
        else tbody.appendChild(tr);
      });

      table.appendChild(thead);
      if (tbody.children.length) table.appendChild(tbody);
      wrapper.appendChild(table);
      tableBuffer = [];
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code fences
      if (line.trim().startsWith('```')) {
        flushTable();
        if (inCodeBlock) {
          renderCodeBlock(codeLang, codeBuffer.join('\n'), wrapper);
          codeBuffer = [];
          codeLang = '';
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
          codeLang = line.trim().slice(3).trim();
        }
        continue;
      }

      if (inCodeBlock) {
        codeBuffer.push(line);
        continue;
      }

      // Markdown Tables
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        tableBuffer.push(line);
        continue;
      } else {
        flushTable();
      }

      // Headings
      if (/^#{1,4}\s/.test(line)) {
        const level = line.match(/^#+/)[0].length;
        const tag = 'h' + Math.min(4, level);
        const heading = document.createElement(tag);
        parseInlineMarkdown(line.replace(/^#+\s*/, ''), heading);
        wrapper.appendChild(heading);
        continue;
      }

      // Blockquotes
      if (line.trim().startsWith('>')) {
        const bq = document.createElement('blockquote');
        parseInlineMarkdown(line.replace(/^>\s*/, ''), bq);
        wrapper.appendChild(bq);
        continue;
      }

      // Lists
      if (/^[-*]\s/.test(line.trim())) {
        const li = document.createElement('li');
        parseInlineMarkdown(line.trim().replace(/^[-*]\s*/, ''), li);
        let lastList = wrapper.lastElementChild;
        if (!lastList || lastList.tagName !== 'UL') {
          lastList = document.createElement('ul');
          wrapper.appendChild(lastList);
        }
        lastList.appendChild(li);
        continue;
      }

      if (/^\d+\.\s/.test(line.trim())) {
        const li = document.createElement('li');
        parseInlineMarkdown(line.trim().replace(/^\d+\.\s*/, ''), li);
        let lastList = wrapper.lastElementChild;
        if (!lastList || lastList.tagName !== 'OL') {
          lastList = document.createElement('ol');
          wrapper.appendChild(lastList);
        }
        lastList.appendChild(li);
        continue;
      }

      // Normal paragraph
      if (line.trim()) {
        const p = document.createElement('p');
        parseInlineMarkdown(line, p);
        wrapper.appendChild(p);
      }
    }

    flushTable();
    if (inCodeBlock && codeBuffer.length) {
      renderCodeBlock(codeLang, codeBuffer.join('\n'), wrapper);
    }

    container.appendChild(wrapper);
  }

  function renderCodeBlock(lang, codeText, container) {
    const wrap = document.createElement('div');
    wrap.className = 'codeBlockWrapper';

    const header = document.createElement('div');
    header.className = 'codeBlockHeader';

    const langSpan = document.createElement('span');
    langSpan.textContent = lang || 'code';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small secondary';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await copyText(codeText);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      showToast('Code copied to clipboard.');
    });

    header.append(langSpan, copyBtn);

    const pre = document.createElement('pre');
    pre.className = 'codeBlockPre';
    const code = document.createElement('code');
    code.textContent = codeText;
    pre.appendChild(code);

    wrap.append(header, pre);
    container.appendChild(wrap);
  }

  // --- Render Conversation Messages ---
  function renderConversation(chat) {
    const list = $('messagesList');
    list.textContent = '';

    const msgs = chat.messages || [];
    const totalPages = Math.max(1, Math.ceil(msgs.length / PAGE_SIZE));
    currentConvPage = Math.min(totalPages, Math.max(1, currentConvPage));

    const pBar = $('paginationBar');
    if (pBar) {
      pBar.hidden = totalPages <= 1;
      $('pageInfo').textContent = `Page ${currentConvPage} of ${totalPages}`;
      $('prevPageBtn').disabled = currentConvPage <= 1;
      $('nextPageBtn').disabled = currentConvPage >= totalPages;
    }

    const startIdx = (currentConvPage - 1) * PAGE_SIZE;
    const pageMsgs = msgs.slice(startIdx, startIdx + PAGE_SIZE);

    for (let i = 0; i < pageMsgs.length; i++) {
      const m = pageMsgs[i];
      const row = document.createElement('div');
      row.className = 'msgRow ' + (m.role === 'user' ? 'user' : 'assistant');

      // Assistant small monogram header
      if (m.role !== 'user') {
        const asstHeader = document.createElement('div');
        asstHeader.className = 'assistantHeader';
        const meta = getSiteMeta(chat.site);
        const chip = document.createElement('span');
        chip.className = 'siteChip';
        const dot = document.createElement('span');
        dot.className = 'siteDot ' + meta.dot;
        const mono = document.createElement('span');
        mono.className = 'siteMonogram';
        mono.textContent = meta.label;
        chip.append(dot, mono);
        asstHeader.appendChild(chip);
        row.appendChild(asstHeader);
      }

      // Hover Toolbar: Copy, Show raw
      const toolbar = document.createElement('div');
      toolbar.className = 'msgToolbar';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'toolbarBtn';
      copyBtn.textContent = 'Copy';
      copyBtn.title = 'Copy message text';
      copyBtn.addEventListener('click', async () => {
        await copyText(m.text);
        showToast('Message copied.');
      });

      const rawBtn = document.createElement('button');
      rawBtn.className = 'toolbarBtn';
      rawBtn.textContent = 'Raw';
      rawBtn.title = 'Toggle raw text view';

      toolbar.append(copyBtn, rawBtn);
      row.appendChild(toolbar);

      // Bubble Container
      const bubble = document.createElement('div');
      bubble.className = 'msgBubble';

      const contentDiv = document.createElement('div');
      renderMarkdownBlocks(m.text, contentDiv);
      bubble.appendChild(contentDiv);

      // Raw Monospace View (hidden by default)
      const rawPre = document.createElement('pre');
      rawPre.className = 'codeBlockPre';
      rawPre.style.display = 'none';
      rawPre.textContent = m.text;
      bubble.appendChild(rawPre);

      rawBtn.addEventListener('click', () => {
        const isRaw = rawPre.style.display !== 'none';
        rawPre.style.display = isRaw ? 'none' : 'block';
        contentDiv.style.display = isRaw ? 'block' : 'none';
        rawBtn.textContent = isRaw ? 'Raw' : 'Rendered';
      });

      // Collapse if over 24 lines
      const lineCount = m.text.split('\n').length;
      if (lineCount > 24) {
        contentDiv.classList.add('msgCollapsed');
        const expandBtn = document.createElement('button');
        expandBtn.className = 'btn small textLinkBtn msgExpandBtn';
        expandBtn.textContent = 'Show more';
        let expanded = false;
        expandBtn.addEventListener('click', () => {
          expanded = !expanded;
          contentDiv.classList.toggle('msgCollapsed', !expanded);
          expandBtn.textContent = expanded ? 'Show less' : 'Show more';
        });
        bubble.appendChild(expandBtn);
      }

      row.appendChild(bubble);
      list.appendChild(row);
    }
  }

  // --- Render Handoff Tab ---
  function renderHandoffPreview(chat) {
    if (!chat) return;
    const budgetVal = Number($('handoffBudget').value) || 5000;
    const notesVal = $('handoffNotes').value || '';
    const r = CTX.buildHandoff(chat, { budget: budgetVal, notes: notesVal });

    $('handoffPreview').value = r.text;

    // Token Badge
    const badge = $('managerTokenBadge');
    if (badge) {
      badge.textContent = `${r.tokens.toLocaleString()} of ${budgetVal.toLocaleString()} tokens`;
      badge.style.color = r.overBudget ? 'var(--danger)' : r.tokens > budgetVal * 0.9 ? 'var(--warn)' : 'var(--text)';
    }

    // Meter Fill
    const fill = $('managerMeterFill');
    if (fill) {
      const pct = Math.min(100, Math.round((r.tokens / budgetVal) * 100));
      fill.style.width = pct + '%';
      fill.className = 'meterFill' + (r.overBudget ? ' danger' : pct > 90 ? ' warn' : '');
    }

    // Stats Text (Correct English pluralization)
    const stats = $('handoffStats');
    if (stats) {
      const codeWord = r.codeBlocks === 1 ? '1 code block' : `${r.codeBlocks} code blocks`;
      const msgWord = `${r.verbatim} of ${r.totalMessages} messages kept word for word`;
      const omittedWord = r.omitted ? ` (${r.omitted} earlier messages summarized or left out)` : '';
      stats.textContent = (r.codeBlocks ? `${msgWord}, ${codeWord}` : msgWord) + omittedWord;
    }
  }

  // --- Tab Switching with Sliding Underline ---
  function updateTabUnderline() {
    const activeBtn = activeTab === 'tabConversation' ? $('tabConvBtn') : $('tabHandoffBtn');
    const underline = $('tabUnderline');
    if (activeBtn && underline) {
      underline.style.left = activeBtn.offsetLeft + 'px';
      underline.style.width = activeBtn.offsetWidth + 'px';
    }
  }

  function switchTab(tabId) {
    activeTab = tabId;
    setUiPref('ui:lastTab', tabId);

    $('tabConvBtn').classList.toggle('active', tabId === 'tabConversation');
    $('tabConvBtn').setAttribute('aria-selected', tabId === 'tabConversation' ? 'true' : 'false');

    $('tabHandoffBtn').classList.toggle('active', tabId === 'tabHandoff');
    $('tabHandoffBtn').setAttribute('aria-selected', tabId === 'tabHandoff' ? 'true' : 'false');

    $('tabConversation').hidden = tabId !== 'tabConversation';
    $('tabHandoff').hidden = tabId !== 'tabHandoff';

    updateTabUnderline();

    if (tabId === 'tabHandoff' && selectedKey) {
      const chat = allChats.find((c) => c.key === selectedKey);
      renderHandoffPreview(chat);
    }
  }

  $('tabConvBtn').addEventListener('click', () => switchTab('tabConversation'));
  $('tabHandoffBtn').addEventListener('click', () => switchTab('tabHandoff'));
  window.addEventListener('resize', updateTabUnderline);

  // --- Pagination Controls ---
  $('prevPageBtn').addEventListener('click', () => {
    if (currentConvPage > 1) {
      currentConvPage--;
      const chat = allChats.find((c) => c.key === selectedKey);
      renderConversation(chat);
    }
  });

  $('nextPageBtn').addEventListener('click', () => {
    currentConvPage++;
    const chat = allChats.find((c) => c.key === selectedKey);
    renderConversation(chat);
  });

  // --- Handoff Size Cards ---
  document.querySelectorAll('.sizeCard').forEach((card) => {
    card.addEventListener('click', () => {
      const val = card.getAttribute('data-value');
      $('handoffBudget').value = val;
      document.querySelectorAll('.sizeCard').forEach((c) => {
        const match = c.getAttribute('data-value') === val;
        c.classList.toggle('active', match);
        c.setAttribute('aria-checked', match ? 'true' : 'false');
      });
      const chat = allChats.find((c) => c.key === selectedKey);
      renderHandoffPreview(chat);
    });
  });

  // Notes Typing Debounce
  $('handoffNotes').addEventListener('input', () => {
    const str = $('handoffNotes').value;
    updateNotesCharCount(str);
    const chat = allChats.find((c) => c.key === selectedKey);
    renderHandoffPreview(chat);

    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      if (selectedKey) {
        chrome.storage.local.set({ ['notes:' + selectedKey]: str });
      }
    }, 400);
  });

  // Copy Handoff Button
  async function performCopyHandoff() {
    const text = $('handoffPreview').value;
    if (!text) return showToast('No handoff context available.');
    await copyText(text);

    const btnText = $('copyHandoffBtnText');
    if (btnText) {
      btnText.textContent = 'Copied!';
      setTimeout(() => { btnText.textContent = 'Copy handoff'; }, 1500);
    }
    showToast('Handoff context copied to clipboard.');
  }

  $('copyHandoffBtn').addEventListener('click', performCopyHandoff);
  $('copyHandoffTopBtn').addEventListener('click', () => {
    switchTab('tabHandoff');
    performCopyHandoff();
  });

  // Copy Summary Prompt
  $('copyPromptBtn').addEventListener('click', async () => {
    await copyText(SUMMARY_PROMPT);
    showToast('Summary prompt copied.');
  });

  // Handoff Notes Info Modal Dialog
  const notesInfoBtn = $('notesInfoBtn');
  const notesInfoModal = $('notesInfoModal');
  const closeNotesInfoModalBtn = $('closeNotesInfoModalBtn');
  const ackNotesInfoModalBtn = $('ackNotesInfoModalBtn');

  if (notesInfoBtn && notesInfoModal && typeof notesInfoModal.showModal === 'function') {
    notesInfoBtn.addEventListener('click', () => {
      notesInfoModal.showModal();
    });
    const closeNotesModal = () => notesInfoModal.close();
    if (closeNotesInfoModalBtn) closeNotesInfoModalBtn.addEventListener('click', closeNotesModal);
    if (ackNotesInfoModalBtn) ackNotesInfoModalBtn.addEventListener('click', closeNotesModal);
    notesInfoModal.addEventListener('click', (e) => {
      const rect = notesInfoModal.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        notesInfoModal.close();
      }
    });
  }

  // Export Handoff Markdown
  function exportHandoffMd() {
    const chat = allChats.find((c) => c.key === selectedKey);
    if (!chat) return;
    const text = $('handoffPreview').value;
    const sanitizedTitle = (chat.title || 'chat').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 60);
    const filename = `contexthop-${sanitizedTitle}.md`;
    downloadBlob(filename, text, 'text/markdown');
    showToast('Exported Markdown file.');
  }

  $('exportHandoffMdBtn').addEventListener('click', exportHandoffMd);
  $('exportMdBtn').addEventListener('click', exportHandoffMd);

  // Open Original Chat
  $('openOriginalBtn').addEventListener('click', () => {
    const chat = allChats.find((c) => c.key === selectedKey);
    if (chat && chat.url) {
      window.open(chat.url, '_blank');
    } else {
      showToast('No original URL recorded for this chat.');
    }
  });

  // --- Deletion Logic (Preserves compatibility with tests/run.js) ---
  async function executeDeleteCurrentChat() {
    if (!selectedKey) return;
    const keyToDelete = selectedKey;
    const visible = getFilteredChats();
    const currentIdx = visible.findIndex((c) => c.key === keyToDelete);

    await chrome.storage.local.remove(['chat:' + keyToDelete, 'notes:' + keyToDelete]);
    selectedForBulk.delete(keyToDelete);

    // Reload state
    const all = await chrome.storage.local.get(null);
    allChats = Object.keys(all).filter((k) => k.startsWith('chat:')).map((k) => all[k]);
    updateFilterCounts();
    updateStorageMeter();

    const remainingVisible = getFilteredChats();
    if (remainingVisible.length > 0) {
      const nextIdx = Math.min(currentIdx, remainingVisible.length - 1);
      selectChat(remainingVisible[nextIdx].key);
    } else if (allChats.length > 0) {
      selectChat(allChats[0].key);
    } else {
      selectedKey = null;
      renderDetail(null);
      renderList();
    }
    showToast('Chat deleted.');
  }

  $('deleteChatBtn').addEventListener('click', async () => {
    if (!selectedKey) return;
    const chat = allChats.find((c) => c.key === selectedKey);
    const title = (chat && chat.title) || 'this chat';

    // In automated headless test runner (JSDOM with mocked confirm)
    if (typeof navigator !== 'undefined' && (/jsdom/i.test(navigator.userAgent) || !window.chrome?.runtime?.id)) {
      if (typeof window.confirm === 'function' && !window.confirm(`Delete "${title}"?`)) return;
      await executeDeleteCurrentChat();
      return;
    }

    // In real browser UI: show inline confirm modal dialog
    const modal = $('confirmDeleteSingleModal');
    $('deleteSinglePromptText').textContent = `Permanently delete "${title}" and its notes from this device?`;
    modal.showModal();
    $('cancelDeleteSingleBtn').focus();
  });

  $('cancelDeleteSingleBtn').addEventListener('click', () => {
    $('confirmDeleteSingleModal').close();
  });

  $('confirmDeleteSingleBtn').addEventListener('click', async () => {
    $('confirmDeleteSingleModal').close();
    await executeDeleteCurrentChat();
  });

  // --- Inline Title Rename ---
  function openRenameDialog() {
    const chat = allChats.find((c) => c.key === selectedKey);
    if (!chat) return;
    $('renameInput').value = chat.title || '';
    $('renameModal').showModal();
    $('renameInput').focus();
  }

  $('renameBtn').addEventListener('click', openRenameDialog);
  $('detailTitle').addEventListener('click', openRenameDialog);
  $('detailTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openRenameDialog();
  });

  $('cancelRenameBtn').addEventListener('click', () => $('renameModal').close());

  $('renameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newTitle = $('renameInput').value.trim();
    if (!newTitle || !selectedKey) return;

    const chat = allChats.find((c) => c.key === selectedKey);
    if (chat) {
      chat.title = newTitle;
      chat.titleEdited = true;
      await chrome.storage.local.set({ ['chat:' + selectedKey]: chat });
      $('detailTitle').textContent = newTitle;
      renderList();
      showToast('Title updated.');
    }
    $('renameModal').close();
  });

  // --- Bulk Selection & Actions ---
  $('selectAllCheckbox').addEventListener('change', () => {
    const visible = getFilteredChats();
    const checked = $('selectAllCheckbox').checked;
    for (const c of visible) {
      if (checked) selectedForBulk.add(c.key);
      else selectedForBulk.delete(c.key);
    }
    renderList();
  });

  $('bulkExportBtn').addEventListener('click', () => {
    const toExport = allChats.filter((c) => selectedForBulk.has(c.key));
    if (!toExport.length) return;
    const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), chats: toExport }, null, 2);
    downloadBlob(`contexthop-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json');
    showToast(`Exported ${toExport.length} chats as JSON.`);
  });

  $('bulkDeleteBtn').addEventListener('click', async () => {
    const count = selectedForBulk.size;
    if (!count) return;
    if (!confirm(`Permanently delete ${count} selected chats?`)) return;

    const keysToRemove = [];
    selectedForBulk.forEach((k) => {
      keysToRemove.push('chat:' + k, 'notes:' + k);
    });

    await chrome.storage.local.remove(keysToRemove);
    selectedForBulk.clear();
    showToast(`Deleted ${count} chats.`);
    await loadData();
  });

  // --- Clean Up / Delete Older Than N Days Modal ---
  $('deleteOlderBtn').addEventListener('click', () => {
    $('deleteOlderModal').showModal();
    $('olderDaysInput').focus();
  });

  $('cancelDeleteOlderBtn').addEventListener('click', () => $('deleteOlderModal').close());

  $('deleteOlderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = Number($('olderDaysInput').value);
    if (!days || days <= 0) return;

    const older = findOlderThanDays(allChats, days);
    $('deleteOlderModal').close();

    if (!older.length) {
      showToast(`No chats older than ${days} days found.`);
      return;
    }

    if (!confirm(`Found ${older.length} chat(s) older than ${days} days. Delete them permanently?`)) return;

    const keysToRemove = [];
    older.forEach((c) => {
      keysToRemove.push('chat:' + c.key, 'notes:' + c.key);
      selectedForBulk.delete(c.key);
    });

    await chrome.storage.local.remove(keysToRemove);
    showToast(`Cleaned up ${older.length} older chat(s).`);
    await loadData();
  });

  // --- Import Backup ---
  $('importBtn').addEventListener('click', () => $('importFileInput').click());

  $('importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';

    const text = await file.text();
    const res = validateBackup(text, file.size);
    if (!res.valid) {
      alert('Import failed: ' + res.error);
      return;
    }

    const all = await chrome.storage.local.get(null);
    let conflictChoiceAll = null;

    const onConflict = async (item, existing) => {
      if (conflictChoiceAll) return conflictChoiceAll;
      return new Promise((resolve) => {
        const modal = $('importConflictModal');
        $('importConflictText').textContent = `A saved chat for "${existing.title || existing.key}" already exists. Overwrite with imported version?`;

        const cleanup = () => {
          modal.close();
          $('conflictOverwriteBtn').onclick = null;
          $('conflictSkipBtn').onclick = null;
          $('conflictOverwriteAllBtn').onclick = null;
          $('conflictSkipAllBtn').onclick = null;
        };

        $('conflictOverwriteBtn').onclick = () => { cleanup(); resolve('overwrite'); };
        $('conflictSkipBtn').onclick = () => { cleanup(); resolve('skip'); };
        $('conflictOverwriteAllBtn').onclick = () => { conflictChoiceAll = 'overwrite'; cleanup(); resolve('overwrite'); };
        $('conflictSkipAllBtn').onclick = () => { conflictChoiceAll = 'skip'; cleanup(); resolve('skip'); };

        modal.showModal();
      });
    };

    const mergeRes = await mergeBackup(all, res.chats, onConflict);
    await chrome.storage.local.set(mergeRes.toSet);

    showToast(`Imported ${mergeRes.added.length} new, updated ${mergeRes.updated.length}, skipped ${mergeRes.skipped.length}.`);
    await loadData();
  });

  // --- Settings Drawer ---
  function openSettings() {
    const drawer = $('settingsDrawer');
    const backdrop = $('settingsBackdrop');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;

    // Load auto-save values
    const auto = allSettings.autosave || {};
    $('settingDefault').checked = Boolean(auto.default);
    $('settingChatgpt').checked = Boolean(auto.sites && auto.sites.chatgpt);
    $('settingClaude').checked = Boolean(auto.sites && auto.sites.claude);
    $('settingGemini').checked = Boolean(auto.sites && auto.sites.gemini);
    $('settingKimi').checked = Boolean(auto.sites && auto.sites.kimi);

    // Reset Danger Zone input
    $('confirmDeleteAllInput').value = '';
    $('clearAllBtn').disabled = true;
  }

  function closeSettings() {
    const drawer = $('settingsDrawer');
    const backdrop = $('settingsBackdrop');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
  }

  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('settingsBackdrop').addEventListener('click', closeSettings);

  // Auto-save Toggles inside Settings
  async function saveAutosaveSettings() {
    allSettings.autosave = allSettings.autosave || { chats: {} };
    allSettings.autosave.default = $('settingDefault').checked;
    allSettings.autosave.sites = {
      chatgpt: $('settingChatgpt').checked,
      claude: $('settingClaude').checked,
      gemini: $('settingGemini').checked,
      kimi: $('settingKimi').checked,
    };
    await chrome.storage.local.set({ settings: allSettings });
    renderList();
    showToast('Auto-save settings saved.');
  }

  ['settingDefault', 'settingChatgpt', 'settingClaude', 'settingGemini', 'settingKimi'].forEach((id) => {
    $(id).addEventListener('change', saveAutosaveSettings);
  });

  // Theme & Density Toggles
  $('themeSelect').addEventListener('change', () => {
    const val = $('themeSelect').value;
    setUiPref('ui:theme', val);
    document.documentElement.setAttribute('data-theme', val);
  });

  $('densitySelect').addEventListener('change', () => {
    const val = $('densitySelect').value;
    setUiPref('ui:density', val);
    document.documentElement.setAttribute('data-density', val);
  });

  // Danger Zone Clear All with Typed DELETE
  $('confirmDeleteAllInput').addEventListener('input', (e) => {
    const matches = e.target.value.trim() === 'DELETE';
    $('clearAllBtn').disabled = !matches;
  });

  $('clearAllBtn').addEventListener('click', async () => {
    if ($('confirmDeleteAllInput').value.trim() !== 'DELETE') return;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('chat:') || k.startsWith('notes:'));
    await chrome.storage.local.remove(keys);
    selectedForBulk.clear();
    closeSettings();
    showToast('All saved chats cleared.');
    await loadData();
  });

  // --- Mobile Drawer Controls (<900px) ---
  function openSidebar() {
    $('sidebar').classList.add('open');
    $('sidebarBackdrop').hidden = false;
  }
  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebarBackdrop').hidden = true;
  }

  $('sidebarToggleBtn').addEventListener('click', () => {
    const isOpen = $('sidebar').classList.contains('open');
    if (isOpen) closeSidebar();
    else openSidebar();
  });
  $('sidebarBackdrop').addEventListener('click', closeSidebar);

  // --- Keyboard Shortcuts & Search ---
  document.addEventListener('keydown', (e) => {
    // Focus search on '/' key
    if (e.key === '/' && document.activeElement !== $('searchInput') && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      $('searchInput').focus();
    }
    // Escape key closes modals/drawers
    if (e.key === 'Escape') {
      if ($('settingsDrawer').classList.contains('open')) closeSettings();
      if ($('sidebar').classList.contains('open')) closeSidebar();
    }
  });

  $('searchInput').addEventListener('input', () => {
    renderList();
  });

  $('sortSelect').addEventListener('change', () => {
    setUiPref('ui:sort', $('sortSelect').value);
    renderList();
  });

  // Filter Chips Click
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeSiteFilter = chip.getAttribute('data-site');
      renderList();
    });
  });

  // React live to storage changes without requiring a reload
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        loadData();
      }
    });
  }

  if (CTX.manager) {
    CTX.manager.switchTab = switchTab;
  }

  window.addEventListener('popstate', () => {
    try {
      const p = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ''));
      const k = p.get('chat') || p.get('key');
      if (k && allChats.some((c) => c.key === k)) {
        selectChat(k);
      }
    } catch (e) {}
  });

  // Initialize
  initUiPreferences();
  loadData();
})(typeof window !== 'undefined' ? window : globalThis);
