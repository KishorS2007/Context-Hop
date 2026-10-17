// Content script: watches the chat and keeps a local copy up to date. Nothing leaves the browser.
(function () {
  'use strict';
  const CTX = window.CTX;
  if (!CTX || !CTX.adapters) return;
  const adapter = CTX.adapters.find((a) => a.hosts.includes(location.hostname));
  if (!adapter) return;

  const DEBOUNCE_MS = CTX.DEBOUNCE_MS !== undefined ? CTX.DEBOUNCE_MS : 1500; // wait until the page stops changing (~1.5s)
  const MAX_WAIT_MS = CTX.MAX_WAIT_MS !== undefined ? CTX.MAX_WAIT_MS : 5000; // max wait (~5s) so long streaming replies still get saved
  const STREAM_CHECK_MS = CTX.STREAM_CHECK_MS !== undefined ? CTX.STREAM_CHECK_MS : 1500;
  let timer = null;
  let firstQueued = 0;
  let warned = false;
  let observer = null;

  const writeQueues = new Map();

  function runExclusive(key, fn) {
    const prevPromise = writeQueues.get(key) || Promise.resolve();
    const nextPromise = prevPromise.then(() => fn()).catch((err) => {
      console.error('[Context Handoff] Exclusive write error:', err);
      throw err;
    });
    writeQueues.set(key, nextPromise);
    nextPromise.finally(() => {
      if (writeQueues.get(key) === nextPromise) {
        writeQueues.delete(key);
      }
    });
    return nextPromise;
  }

  function hashOf(msgs) {
    let h = 5381;
    for (const m of msgs) {
      const s = m.role[0] + m.text;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return h + ':' + msgs.length;
  }

  function titleOf(msgs) {
    const t = (document.title || '').replace(/\s*[-|–]\s*(ChatGPT|Claude|Gemini|Kimi).*$/i, '').trim();
    if (t && !/^(chatgpt|claude|google gemini|gemini|kimi.*)$/i.test(t)) return t;
    const first = msgs.find((m) => m.role === 'user');
    return first ? first.text.replace(/\s+/g, ' ').slice(0, 60) : 'Untitled chat';
  }

  async function save() {
    timer = null;
    firstQueued = 0;
    const chatId = adapter.chatId();
    if (!chatId) return { ok: false, error: 'This is not a saved chat yet. Send a message first.' };

    const fresh = CTX.scrape(adapter);
    if (!fresh.length) {
      const matched = CTX.diagnose(adapter);
      if (!warned) {
        warned = true;
        console.warn(
          '[Context Handoff] No messages found for ' + adapter.name + ' (matched ' + matched.user +
            ' user / ' + matched.assistant + ' assistant elements). The site layout may have changed: see src/adapters.js.'
        );
      }
      return { ok: false, error: 'No messages found', matched };
    }

    try {
      const key = adapter.id + ':' + chatId;
      let settings;
      try {
        const data = await chrome.storage.local.get('settings');
        settings = data && data.settings;
      } catch (e) {}
      if (!shouldAutosave(settings && settings.autosave, key, adapter.id)) {
        stopObserving();
        return { ok: false, error: 'Autosave is disabled' };
      }

      const sk = 'chat:' + key;
      let finalCount = 0;
      await runExclusive(key, async () => {
        const prev = (await chrome.storage.local.get(sk))[sk];
        let messages = CTX.merge(prev && prev.messages, fresh);
        // Ensure saved count never decreases
        if (prev && prev.messages && messages.length < prev.messages.length) {
          messages = prev.messages;
        }
        finalCount = messages.length;
        const hash = hashOf(messages);
        if (!prev || prev.hash !== hash) {
          await chrome.storage.local.set({
            [sk]: {
              key,
              site: adapter.id,
              siteName: adapter.name,
              title: prev && prev.titleEdited ? prev.title : titleOf(messages),
              titleEdited: Boolean(prev && prev.titleEdited),
              url: location.href,
              updatedAt: Date.now(),
              messages,
              hash,
            },
          });
        }
      });
      return { ok: true, key, count: finalCount };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/context invalidated/i.test(msg) && observer) observer.disconnect();
      return { ok: false, error: /context invalidated/i.test(msg) ? 'Extension was reloaded. Refresh this page.' : msg };
    }
  }

  function queue() {
    const now = Date.now();
    if (!firstQueued) firstQueued = now;
    clearTimeout(timer);
    timer = setTimeout(save, Math.max(0, Math.min(DEBOUNCE_MS, firstQueued + MAX_WAIT_MS - now)));
  }

  let cancelCaptureRequested = false;

  function describeScroller(el) {
    if (!el || el === document.scrollingElement || el === document.documentElement || el === document.body || el === window) {
      return 'document.scrollingElement';
    }
    let desc = (el.tagName || '').toLowerCase();
    if (el.id) desc += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) desc += '.' + cls;
    }
    return desc;
  }

  function getScrollTop(el) {
    if (!el || el === document.body || el === document.documentElement || el === document.scrollingElement || el === window) {
      return window.scrollY || (document.documentElement ? document.documentElement.scrollTop : 0) || (document.body ? document.body.scrollTop : 0) || 0;
    }
    return el.scrollTop || 0;
  }

  function setScrollTop(el, y) {
    const targetY = Math.max(0, y);
    if (!el || el === document.body || el === document.documentElement || el === document.scrollingElement || el === window) {
      if (typeof window.scrollTo === 'function') {
        try { window.scrollTo(0, targetY); } catch (e) {}
      }
      if (document.documentElement) document.documentElement.scrollTop = targetY;
      if (document.body) document.body.scrollTop = targetY;
    } else {
      el.scrollTop = targetY;
    }
  }

  function getScrollHeight(el) {
    if (!el || el === document.body || el === document.documentElement || el === document.scrollingElement || el === window) {
      return Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
    }
    return el.scrollHeight || 0;
  }

  function getClientHeight(el) {
    if (!el || el === document.body || el === document.documentElement || el === document.scrollingElement || el === window) {
      return window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 0) || (document.body ? document.body.clientHeight : 0) || 0;
    }
    return el.clientHeight || 0;
  }

  function isScrollableStyle(el) {
    if (!el) return false;
    if (el === document.scrollingElement || el === document.documentElement || el === document.body || el === window) {
      return true;
    }
    try {
      const cs = window.getComputedStyle(el);
      const oy = ((cs && cs.overflowY) || el.style.overflowY || '').toLowerCase();
      if (/auto|scroll|overlay/.test(oy)) return true;
    } catch (e) {
      if (el.style && /auto|scroll|overlay/.test(el.style.overflowY)) return true;
    }
    if (el.getAttribute && el.getAttribute('role') === 'feed') return true;
    if (el.tagName && el.tagName.toLowerCase() === 'infinite-scroller') return true;
    return false;
  }

  function testCandidateMoves(el) {
    const ch = getClientHeight(el);
    const origY = getScrollTop(el);
    // 1. If scrolled down, try setting to scrollTop - 0.8 * clientHeight (at least 1)
    if (origY > 0) {
      const stepDown = Math.max(1, Math.floor(0.8 * ch));
      const testY = Math.max(0, origY - stepDown);
      setScrollTop(el, testY);
      const moved = getScrollTop(el) !== origY;
      setScrollTop(el, origY);
      if (moved) return true;
    }
    // 2. If at 0 (or didn't move upwards), test setting downward movement
    const sh = getScrollHeight(el);
    if (sh > ch + 10 || origY === 0) {
      const testDelta = Math.min(20, Math.max(5, Math.floor(0.8 * ch)));
      setScrollTop(el, origY + testDelta);
      const moved = getScrollTop(el) !== origY;
      setScrollTop(el, origY);
      if (moved) return true;
    }
    return false;
  }

  function findScroller() {
    const msgSelector = adapter.user.concat(adapter.assistant).join(',');
    const firstMsg = document.querySelector(msgSelector);
    if (!firstMsg) return null;

    const rawCandidates = [];
    let cur = firstMsg.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      rawCandidates.push(cur);
      cur = cur.parentElement;
    }
    if (document.scrollingElement && !rawCandidates.includes(document.scrollingElement)) {
      rawCandidates.push(document.scrollingElement);
    }
    if (document.documentElement && !rawCandidates.includes(document.documentElement)) {
      rawCandidates.push(document.documentElement);
    }
    if (document.body && !rawCandidates.includes(document.body)) {
      rawCandidates.push(document.body);
    }

    // Keep those with overflow-y auto/scroll/overlay and scrollHeight > clientHeight + 10 (or scrollTop > 0)
    const candidates = rawCandidates.filter((cand) => {
      const sh = getScrollHeight(cand);
      const ch = getClientHeight(cand);
      const hasOverflow = (sh > ch + 10) || (getScrollTop(cand) > 0);
      return hasOverflow && isScrollableStyle(cand);
    });

    for (const cand of candidates) {
      if (testCandidateMoves(cand)) return cand;
    }

    // If none moves, try firstMessage.scrollIntoView({block:'start'}) and a synthetic wheel event
    try {
      firstMsg.scrollIntoView({ block: 'start' });
    } catch (e) {}
    try {
      const wheelEvt = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
      firstMsg.dispatchEvent(wheelEvt);
    } catch (e) {}

    for (const cand of candidates) {
      if (testCandidateMoves(cand)) return cand;
    }

    return { error: "Could not find the chat's scroll area", hasOverflow: candidates.length > 0 };
  }

  function waitDomQuiet(targetNode, idleMs, maxWaitMs) {
    return new Promise((resolve) => {
      let idleTimer = null;
      let maxTimer = null;
      let obs = null;

      const done = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (obs) obs.disconnect();
        resolve();
      };

      idleTimer = setTimeout(done, idleMs);
      maxTimer = setTimeout(done, maxWaitMs);

      try {
        obs = new MutationObserver(() => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(done, idleMs);
        });
        obs.observe(targetNode || document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch (e) {
        setTimeout(done, idleMs);
      }
    });
  }

  async function capture() {
    cancelCaptureRequested = false;
    const chatId = adapter.chatId();
    if (!chatId) return { ok: false, error: 'This is not a saved chat yet. Send a message first.' };

    if (adapter.streaming && adapter.streaming()) {
      return { ok: false, error: 'The reply is still streaming. Try again in a moment.' };
    }

    // 1. Initial scrape before capture starts
    const fresh = CTX.scrape(adapter);
    if (!fresh.length) {
      const matched = CTX.diagnose(adapter);
      return { ok: false, error: 'No messages found', matched };
    }

    // Stability check before capture starts (once at the start)
    if (STREAM_CHECK_MS > 0) {
      await new Promise((r) => setTimeout(r, STREAM_CHECK_MS));
      const fresh2 = CTX.scrape(adapter);
      if (hashOf(fresh) !== hashOf(fresh2)) {
        return { ok: false, error: 'The reply is still streaming. Try again in a moment.' };
      }
    }

    const key = adapter.id + ':' + chatId;
    const sk = 'chat:' + key;

    let initialCount = 0;
    let allMessages = [];

    // Save immediately within exclusive queue so something is kept even if scrolling fails
    await runExclusive(key, async () => {
      const prev = (await chrome.storage.local.get(sk))[sk];
      initialCount = (prev && prev.messages && prev.messages.length) || 0;
      allMessages = CTX.merge(prev && prev.messages, fresh);
      if (prev && prev.messages && allMessages.length < prev.messages.length) {
        allMessages = prev.messages;
      }
      const hash = hashOf(allMessages);
      await chrome.storage.local.set({
        [sk]: {
          key,
          site: adapter.id,
          siteName: adapter.name,
          title: prev && prev.titleEdited ? prev.title : titleOf(allMessages),
          titleEdited: Boolean(prev && prev.titleEdited),
          url: location.href,
          updatedAt: Date.now(),
          messages: allMessages,
          hash,
        },
      });
    });

    try {
      chrome.runtime.sendMessage({ type: 'ctx:captureProgress', phase: 'reading', count: allMessages.length });
    } catch (e) {}

    // 2. Find the scroller robustly
    const scrollerRes = findScroller();
    if (scrollerRes && scrollerRes.error) {
      if (scrollerRes.hasOverflow) {
        return { ok: false, error: scrollerRes.error };
      }
      // Content completely fits within viewport (no scroll overflow anywhere)
      const stored = (await chrome.storage.local.get(sk))[sk];
      const totalCount = (stored && stored.messages && stored.messages.length) || allMessages.length;
      const addedCount = Math.max(0, totalCount - initialCount);
      const summary = 'Captured ' + totalCount + ' messages (' + addedCount + ' new)';
      const report = summary + '. Reached the start of the chat: yes. Steps: 0.';
      return { ok: true, count: totalCount, added: addedCount, summary, reachedStart: true, steps: 0, report, skippedScroll: true };
    }

    const scroller = scrollerRes;
    if (!scroller) {
      return { ok: false, error: "Could not find the chat's scroll area" };
    }

    // 3. Scroll phase: loop from current position up to the top
    const initialScrollTop = getScrollTop(scroller);
    let currentY = initialScrollTop;
    let step = 0;
    let reachedStart = false;
    const startTime = Date.now();
    const MAX_TIME_MS = 180000; // ~3 minutes hard cap
    const MAX_STEPS = 400; // ~400 steps hard cap
    const QUIET_IDLE_MS = CTX.QUIET_IDLE_MS !== undefined ? CTX.QUIET_IDLE_MS : 400;
    const QUIET_MAX_MS = CTX.QUIET_MAX_MS !== undefined ? CTX.QUIET_MAX_MS : 3000;
    const GRACE_CHECK_MS = CTX.GRACE_CHECK_MS !== undefined ? CTX.GRACE_CHECK_MS : 500;

    try {
      while (!cancelCaptureRequested && Date.now() - startTime < MAX_TIME_MS && step < MAX_STEPS) {
        // If at or near top (scrollTop <= 2), perform grace checks across 4 consecutive checks
        if (currentY <= 2) {
          let consecutiveNoChange = 0;
          let graceCheckCount = 0;

          while (graceCheckCount < 4 && !cancelCaptureRequested && Date.now() - startTime < MAX_TIME_MS && step < MAX_STEPS) {
            graceCheckCount++;
            await waitDomQuiet(
              scroller === window || scroller === document.scrollingElement ? document.body : scroller,
              Math.min(QUIET_IDLE_MS, GRACE_CHECK_MS),
              GRACE_CHECK_MS
            );
            if (cancelCaptureRequested) break;

            step++;
            const gPrevCount = allMessages.length;
            const gPrevSH = getScrollHeight(scroller);
            const gPrevFirstText = (allMessages[0] && allMessages[0].text) || '';

            const gFresh = CTX.scrape(adapter);
            if (gFresh.length) {
              allMessages = CTX.merge(allMessages, gFresh);
            }

            const gCurrCount = allMessages.length;
            const gCurrSH = getScrollHeight(scroller);
            const gCurrFirstText = (allMessages[0] && allMessages[0].text) || '';
            const gY = getScrollTop(scroller);

            console.debug(
              '[Context Handoff] Step ' + step + ' (grace check ' + graceCheckCount + '):',
              describeScroller(scroller),
              'scrollTop=' + gY,
              'scrollHeight=' + gCurrSH,
              'messages=' + gCurrCount
            );

            try {
              chrome.runtime.sendMessage({
                type: 'ctx:captureProgress',
                phase: 'loading',
                count: allMessages.length,
                step,
              });
            } catch (e) {}

            const changed = (gCurrCount > gPrevCount) || (gCurrSH !== gPrevSH) || (gCurrFirstText !== gPrevFirstText);
            if (changed) {
              consecutiveNoChange = 0;
              graceCheckCount = 0;
              if (gY > 2) {
                currentY = gY;
                break; // Content shifted scroll position down, resume scrolling!
              }
              setScrollTop(scroller, 0);
            } else {
              consecutiveNoChange++;
            }
          }

          if (consecutiveNoChange >= 4) {
            reachedStart = true;
            break;
          }
          if (currentY > 2) {
            continue;
          }
          if (graceCheckCount >= 4) {
            reachedStart = (consecutiveNoChange >= 4);
            break;
          }
        }

        // Normal step upwards (70% viewport height)
        step++;
        const ch = getClientHeight(scroller);
        const stepSize = Math.max(150, Math.floor(ch * 0.7));
        const prevY = currentY;
        const targetY = Math.max(0, currentY - stepSize);
        setScrollTop(scroller, targetY);
        currentY = getScrollTop(scroller);

        // Wait until DOM is quiet
        await waitDomQuiet(
          scroller === window || scroller === document.scrollingElement ? document.body : scroller,
          QUIET_IDLE_MS,
          QUIET_MAX_MS
        );
        if (cancelCaptureRequested) break;

        const prevCount = allMessages.length;
        const prevSH = getScrollHeight(scroller);
        const prevFirstText = (allMessages[0] && allMessages[0].text) || '';

        const stepFresh = CTX.scrape(adapter);
        if (stepFresh.length) {
          allMessages = CTX.merge(allMessages, stepFresh);
        }

        const currentSH = getScrollHeight(scroller);
        const currentCount = allMessages.length;
        const currentFirstText = (allMessages[0] && allMessages[0].text) || '';

        console.debug(
          '[Context Handoff] Step ' + step + ':',
          describeScroller(scroller),
          'scrollTop=' + currentY,
          'scrollHeight=' + currentSH,
          'messages=' + currentCount
        );

        try {
          chrome.runtime.sendMessage({
            type: 'ctx:captureProgress',
            phase: 'loading',
            count: allMessages.length,
            step,
          });
        } catch (e) {}

        // If scroller didn't move despite targetY < prevY
        if (currentY === prevY && targetY < prevY) {
          setScrollTop(scroller, 0);
          currentY = getScrollTop(scroller);
        }
      }
    } finally {
      // Always restore the original scroll position (try/finally), also on error and on cancel
      setScrollTop(scroller, initialScrollTop);
    }

    // 4. Stability check at the end (once at the end, never between scroll steps)
    if (STREAM_CHECK_MS > 0 && !cancelCaptureRequested) {
      const end1 = CTX.scrape(adapter);
      await new Promise((r) => setTimeout(r, STREAM_CHECK_MS));
      const end2 = CTX.scrape(adapter);
      if (hashOf(end1) !== hashOf(end2)) {
        return { ok: false, error: 'The reply is still streaming. Try again in a moment.' };
      }
      allMessages = CTX.merge(allMessages, end2);
    }

    // Final save to storage within exclusive queue
    await runExclusive(key, async () => {
      const prev = (await chrome.storage.local.get(sk))[sk];
      let merged = CTX.merge(prev && prev.messages, allMessages);
      if (prev && prev.messages && merged.length < prev.messages.length) {
        merged = prev.messages;
      }
      allMessages = merged;
      const hash = hashOf(allMessages);
      await chrome.storage.local.set({
        [sk]: {
          key,
          site: adapter.id,
          siteName: adapter.name,
          title: prev && prev.titleEdited ? prev.title : titleOf(allMessages),
          titleEdited: Boolean(prev && prev.titleEdited),
          url: location.href,
          updatedAt: Date.now(),
          messages: allMessages,
          hash,
        },
      });
    });

    // Read back stored chat after write completes to ensure accurate final count
    const stored = (await chrome.storage.local.get(sk))[sk];
    const totalCount = (stored && stored.messages && stored.messages.length) || allMessages.length;
    const addedCount = Math.max(0, totalCount - initialCount);

    const summary = 'Captured ' + totalCount + ' messages (' + addedCount + ' new)';
    const report =
      summary + '. ' +
      'Reached the start of the chat: ' + (reachedStart ? 'yes' : 'no') + '. ' +
      'Steps: ' + step + '.' +
      (reachedStart ? '' : ' Try running Capture again to load earlier history.');

    return {
      ok: true,
      count: totalCount,
      added: addedCount,
      summary,
      reachedStart,
      steps: step,
      report,
      cancelled: cancelCaptureRequested,
    };
  }

  const shouldAutosave = CTX.shouldAutosave || function (autosave, key, site) {
    if (!autosave) return false;
    if (key && autosave.chats && typeof autosave.chats[key] === 'boolean') {
      return autosave.chats[key];
    }
    if (site && autosave.sites && typeof autosave.sites[site] === 'boolean') {
      return autosave.sites[site];
    }
    return Boolean(autosave.default);
  };

  let isObserving = false;

  function attachObserver() {
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
    }
    observer = new MutationObserver(queue);
    if (typeof document !== 'undefined' && document.body) {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const rootSel = document.querySelector('main') ||
                      document.querySelector('[role="main"]') ||
                      document.querySelector('[data-testid*="conversation"]');
      if (rootSel && rootSel !== document.body) {
        try {
          observer.observe(rootSel, { childList: true, subtree: true, characterData: true });
        } catch (e) {}
      }
    }
  }

  function startObserving() {
    if (isObserving) return;
    attachObserver();
    isObserving = true;
    queue();
  }

  function stopObserving() {
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
    }
    isObserving = false;
    clearTimeout(timer);
    timer = null;
    firstQueued = 0;
  }

  async function syncAutosaveState() {
    const chatId = adapter.chatId();
    const key = chatId ? adapter.id + ':' + chatId : null;
    let settings;
    try {
      const data = await chrome.storage.local.get('settings');
      settings = data && data.settings;
    } catch (e) {
      return;
    }
    const enabled = shouldAutosave(settings && settings.autosave, key, adapter.id);
    if (enabled) {
      startObserving();
    } else {
      stopObserving();
    }
  }

  let lastUrl = typeof location !== 'undefined' ? location.href : '';
  let lastChatId = adapter.chatId();

  function checkRouteChange() {
    const currentUrl = typeof location !== 'undefined' ? location.href : '';
    const currentChatId = adapter.chatId();
    if (currentUrl !== lastUrl || currentChatId !== lastChatId) {
      lastUrl = currentUrl;
      lastChatId = currentChatId;
      syncAutosaveState();
      if (isObserving) {
        attachObserver();
        queue();
      }
    }
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        syncAutosaveState();
      }
    });
  }

  if (typeof window !== 'undefined') {
    if (window.history) {
      const origPush = window.history.pushState;
      if (typeof origPush === 'function') {
        window.history.pushState = function (...args) {
          const ret = origPush.apply(this, args);
          checkRouteChange();
          return ret;
        };
      }
      const origReplace = window.history.replaceState;
      if (typeof origReplace === 'function') {
        window.history.replaceState = function (...args) {
          const ret = origReplace.apply(this, args);
          checkRouteChange();
          return ret;
        };
      }
    }
    window.addEventListener('popstate', checkRouteChange);
    setInterval(checkRouteChange, 1000);
  }

  // Initial sync: only observe if autosave is enabled
  syncAutosaveState();

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (!msg) return;
    if (msg.type === 'ctx:key') {
      const id = adapter.chatId();
      send({ key: id ? adapter.id + ':' + id : null });
      return;
    }
    if (msg.type === 'ctx:capture') {
      capture().then(send);
      return true; // async response
    }
    if (msg.type === 'ctx:cancelCapture') {
      cancelCaptureRequested = true;
      send({ ok: true });
      return;
    }
  });
})();
