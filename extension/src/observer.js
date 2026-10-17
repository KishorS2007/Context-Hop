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
  let isCapturing = false;

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
    if (isCapturing) return { ok: false, error: 'Autosave paused during capture' };
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
    let storedBeforeCapture = null;
    try {
      const prevData = (await chrome.storage.local.get(sk))[sk];
      storedBeforeCapture = prevData;
      initialCount = (prevData && prevData.messages && prevData.messages.length) || 0;
    } catch (e) {}

    let allMessages = [];

    // 2. Find the scroller robustly
    const scrollerRes = findScroller();
    if (scrollerRes && scrollerRes.error) {
      if (scrollerRes.hasOverflow) {
        return { ok: false, error: scrollerRes.error };
      }
      // Content completely fits within viewport (no scroll overflow anywhere)
      allMessages = fresh;
      try {
        chrome.runtime.sendMessage({ type: 'ctx:captureProgress', phase: 'reading', count: allMessages.length });
      } catch (e) {}
      const isComplete = true;
      await runExclusive(key, async () => {
        const prev = (await chrome.storage.local.get(sk))[sk];
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

      const totalCount = allMessages.length;
      const addedCount = Math.max(0, totalCount - initialCount);
      const summary = 'Captured ' + totalCount + ' messages (' + addedCount + ' new)';
      const report = summary + '. Duplicates removed: 0. Possible gaps: 0. Ambiguous overlaps: 0. Reached the start: yes. Steps: 0.';
      return { ok: true, count: totalCount, added: addedCount, summary, reachedStart: true, steps: 0, report, skippedScroll: true };
    }

    const scroller = scrollerRes;
    if (!scroller) {
      return { ok: false, error: "Could not find the chat's scroll area" };
    }

    const scrollerNode = (scroller === window || scroller === document.scrollingElement) ? document.body : scroller;
    const initialScrollTop = getScrollTop(scroller);

    isCapturing = true;
    let step = 0;
    let reachedStart = false;
    let scrollBlocked = false;
    const gaps = [];
    let ambiguousCount = 0;
    const stepLogs = [];
    let debugCapture = false;
    try {
      debugCapture = typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('ui:debugCapture') === '1';
    } catch (e) {}

    const startTime = Date.now();
    const MAX_TIME_MS = 180000; // ~3 minutes hard cap
    const MAX_STEPS = 400; // ~400 steps hard cap
    const QUIET_IDLE_MS = CTX.QUIET_IDLE_MS !== undefined ? CTX.QUIET_IDLE_MS : 400;
    const QUIET_MAX_MS = CTX.QUIET_MAX_MS !== undefined ? CTX.QUIET_MAX_MS : 3000;
    const CHECK_INTERVAL = CTX.GRACE_CHECK_MS !== undefined ? CTX.GRACE_CHECK_MS : 500;

    try {
      // Part B #1: Before first scrape: scroll scroller to bottom, wait DOM quiet, scrape and merge
      setScrollTop(scroller, Math.max(getScrollHeight(scroller), getScrollTop(scroller)));
      await waitDomQuiet(scrollerNode, QUIET_IDLE_MS, QUIET_MAX_MS);

      let bottomFresh = CTX.scrape(adapter);
      // Part B #5: Render check: if any message has empty text, wait and rescan (up to ~3 s)
      if (bottomFresh.some((m) => !m.text || !m.text.trim())) {
        const wStart = Date.now();
        while (Date.now() - wStart < 3000 && bottomFresh.some((m) => !m.text || !m.text.trim())) {
          await new Promise((r) => setTimeout(r, 200));
          bottomFresh = CTX.scrape(adapter);
        }
      }
      allMessages = bottomFresh;

      // Save initial bottom state immediately within exclusive queue
      await runExclusive(key, async () => {
        const prev = (await chrome.storage.local.get(sk))[sk];
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

      let realY = getScrollTop(scroller);
      let lastSH = getScrollHeight(scroller);

      // Part B: Upward scroll loop
      while (!cancelCaptureRequested && Date.now() - startTime < MAX_TIME_MS && step < MAX_STEPS) {
        // Near top check (realY <= 2)
        if (realY <= 2) {
          // Part B #6: wait until scrollHeight stays unchanged for 2 consecutive checks (500 ms apart, max 3 s)
          let topWaitStart = Date.now();
          let topPrevSH = getScrollHeight(scroller);
          let consecutiveTopNoChange = 0;
          while (Date.now() - topWaitStart < 3000 && consecutiveTopNoChange < 2 && !cancelCaptureRequested) {
            await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
            await waitDomQuiet(scrollerNode, QUIET_IDLE_MS, Math.min(QUIET_MAX_MS, CHECK_INTERVAL));
            step++;
            const topNewSH = getScrollHeight(scroller);
            if (topNewSH === topPrevSH) {
              consecutiveTopNoChange++;
            } else {
              consecutiveTopNoChange = 0;
              topWaitStart = Date.now();
              topPrevSH = topNewSH;
              let topFresh = CTX.scrape(adapter);
              if (topFresh.length) {
                const topMerge = CTX.mergeDetailed(allMessages, topFresh, { prefer: 'head' });
                if (!topMerge.gap && topMerge.kind !== 'no-overlap') {
                  allMessages = topMerge.messages;
                  if (topMerge.ambiguous) ambiguousCount++;
                }
              }
              try {
                chrome.runtime.sendMessage({
                  type: 'ctx:captureProgress',
                  phase: 'loading',
                  count: allMessages.length,
                  step,
                });
              } catch (e) {}
              const topY = getScrollTop(scroller);
              if (topY > 2) {
                realY = topY;
                break;
              }
              setScrollTop(scroller, 0);
            }
          }
          if (consecutiveTopNoChange >= 2 || Date.now() - topWaitStart >= 3000) {
            reachedStart = true;
            break;
          }
          if (realY > 2) continue;
        }

        // Normal step upwards (70% viewport height)
        step++;
        const ch = getClientHeight(scroller);
        let stepSize = Math.max(150, Math.floor(ch * 0.7));
        const prevY = realY;
        const targetY = Math.max(0, realY - stepSize);
        setScrollTop(scroller, targetY);

        // Part B #2: Re-read scrollTop AFTER waitDomQuiet and after scrape;
        // compute next target from real position, never from cached currentY.
        await waitDomQuiet(scrollerNode, QUIET_IDLE_MS, QUIET_MAX_MS);
        if (cancelCaptureRequested) break;

        realY = getScrollTop(scroller);

        // Treat change of scrollHeight between steps as possible prepended content
        const currentSH = getScrollHeight(scroller);
        if (currentSH !== lastSH) {
          await waitDomQuiet(scrollerNode, QUIET_IDLE_MS, QUIET_MAX_MS);
          lastSH = getScrollHeight(scroller);
          realY = getScrollTop(scroller);
        }

        // Part B #3: Remove jump to 0. If scroller did not move upward, retry with smaller step, then give up with scroll blocked
        if (realY >= prevY && targetY < prevY) {
          let unblocked = false;
          let retryStep = Math.floor(stepSize / 2);
          while (retryStep >= 20) {
            const tryY = Math.max(0, realY - retryStep);
            setScrollTop(scroller, tryY);
            await waitDomQuiet(scrollerNode, QUIET_IDLE_MS, QUIET_MAX_MS);
            const newY = getScrollTop(scroller);
            if (newY < realY) {
              realY = newY;
              unblocked = true;
              break;
            }
            retryStep = Math.floor(retryStep / 2);
          }
          if (!unblocked) {
            scrollBlocked = true;
            break;
          }
        }

        // Scrape window
        let windowFresh = CTX.scrape(adapter);

        // Part B #5: Render check: if any message has empty text, wait and rescan (up to ~3 s)
        if (windowFresh.some((m) => !m.text || !m.text.trim())) {
          const wStart = Date.now();
          while (Date.now() - wStart < 3000 && windowFresh.some((m) => !m.text || !m.text.trim())) {
            await new Promise((r) => setTimeout(r, 200));
            windowFresh = CTX.scrape(adapter);
          }
        }

        // Part B #4: Overlap guard per step: call mergeDetailed(acc, window, {prefer: 'head'}).
        // If kind is 'no-overlap' or 'ambiguous': scroll down by about half step, wait quiet, rescan,
        // retry with smaller step (up to 5 attempts, each halving). If still fails, record gap marker and continue.
        let mRes = CTX.mergeDetailed(allMessages, windowFresh, { prefer: 'head' });
        if (mRes.kind === 'no-overlap' || mRes.kind === 'ambiguous') {
          let currentRetryStep = stepSize;
          let recovered = false;
          for (let attempt = 0; attempt < 5; attempt++) {
            currentRetryStep = Math.max(20, Math.floor(currentRetryStep / 2));
            setScrollTop(scroller, getScrollTop(scroller) + Math.floor(currentRetryStep / 2));
            await waitDomQuiet(scrollerNode, QUIET_IDLE_MS, QUIET_MAX_MS);
            const retryFresh = CTX.scrape(adapter);
            mRes = CTX.mergeDetailed(allMessages, retryFresh, { prefer: 'head' });
            if (mRes.kind !== 'no-overlap' && mRes.kind !== 'ambiguous') {
              recovered = true;
              windowFresh = retryFresh;
              break;
            }
          }
          if (!recovered) {
            gaps.push({ index: allMessages.length, scrollTop: realY });
          } else {
            allMessages = mRes.messages;
            if (mRes.ambiguous) ambiguousCount++;
          }
        } else {
          allMessages = mRes.messages;
          if (mRes.ambiguous) ambiguousCount++;
        }

        // Part B #10: Debug log when localStorage "ui:debugCapture" === "1"
        if (debugCapture) {
          stepLogs.push({
            step,
            scrollTop: realY,
            scrollHeight: getScrollHeight(scroller),
            window: windowFresh.map((m) => [m.role, m.text.length, m.text.slice(0, 40), hashOf([m]), m.id || null]),
            result: {
              kind: mRes.kind,
              overlap: mRes.overlap,
              ambiguous: mRes.ambiguous,
              gap: mRes.gap,
            },
          });
        }

        try {
          chrome.runtime.sendMessage({
            type: 'ctx:captureProgress',
            phase: 'loading',
            count: allMessages.length,
            step,
          });
        } catch (e) {}
      }
    } finally {
      // Part B #7: Clear isCapturing in finally
      isCapturing = false;
      // Always restore original scroll position in finally
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
      const endMerge = CTX.mergeDetailed(allMessages, end2, { prefer: 'head' });
      if (!endMerge.gap && endMerge.kind !== 'no-overlap') {
        allMessages = endMerge.messages;
      }
    }

    // Part B #9: Count duplicates removed D
    let prevAdjacentDupes = 0;
    if (storedBeforeCapture && storedBeforeCapture.messages) {
      const pm = storedBeforeCapture.messages;
      for (let di = 1; di < pm.length; di++) {
        const fp1 = CTX.fingerprint ? CTX.fingerprint(pm[di]) : (pm[di].role + ':' + pm[di].text);
        const fp0 = CTX.fingerprint ? CTX.fingerprint(pm[di - 1]) : (pm[di - 1].role + ':' + pm[di - 1].text);
        if (fp1 === fp0) prevAdjacentDupes++;
      }
    }
    let finalAdjacentDupes = 0;
    for (let di = 1; di < allMessages.length; di++) {
      const fp1 = CTX.fingerprint ? CTX.fingerprint(allMessages[di]) : (allMessages[di].role + ':' + allMessages[di].text);
      const fp0 = CTX.fingerprint ? CTX.fingerprint(allMessages[di - 1]) : (allMessages[di - 1].role + ':' + allMessages[di - 1].text);
      if (fp1 === fp0) finalAdjacentDupes++;
    }
    const duplicatesRemoved = Math.max(0, prevAdjacentDupes - finalAdjacentDupes);

    // Part B #8: Final result: if reachedStart is true and no gaps and no ambiguous steps,
    // REPLACE stored messages skipping the "count never decreases" guard to heal duplicates.
    // If incomplete scan, merge into stored data as today with guard.
    const isComplete = reachedStart && gaps.length === 0 && ambiguousCount === 0;

    await runExclusive(key, async () => {
      const prev = (await chrome.storage.local.get(sk))[sk];
      if (isComplete) {
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
      } else {
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
      }
    });

    // Part B #9: Report string
    const gapStr = gaps.length
      ? `${gaps.length} (${gaps.map((g) => 'near message ' + g.index).join(', ')})`
      : '0';
    const summary = 'Captured ' + allMessages.length + ' messages (' + Math.max(0, allMessages.length - initialCount) + ' new)';
    let report = `Captured ${allMessages.length} messages. Duplicates removed: ${duplicatesRemoved}. Possible gaps: ${gapStr}. Ambiguous overlaps: ${ambiguousCount}. Reached the start: ${reachedStart ? 'yes' : 'no'}.`;
    if (scrollBlocked) report += ' (scroll blocked)';

    if (debugCapture) {
      CTX.debugCaptureLog = stepLogs;
    }

    return {
      ok: true,
      count: allMessages.length,
      added: Math.max(0, allMessages.length - initialCount),
      summary,
      reachedStart,
      steps: step,
      report,
      cancelled: cancelCaptureRequested,
      duplicatesRemoved,
      gaps: gaps.length,
      ambiguous: ambiguousCount,
      scrollBlocked,
      debugLog: debugCapture ? stepLogs : undefined,
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
