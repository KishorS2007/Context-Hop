// Turns chat DOM into clean [{role, text}] messages. Site-specific selectors live in adapters.js.
(function (root) {
  'use strict';
  const CTX = (root.CTX = root.CTX || {});


  // UI chrome that must never end up in message text (buttons such as "Think", "Copy", icons, toolbars, tooltips, reasoning...).
  const SKIP =
    'button, svg, nav, form, script, style, noscript, canvas, [aria-hidden="true"], .sr-only, .visually-hidden, .cdk-visually-hidden, mat-icon, gem-icon-button, ' +
    '.segment-code-header, .icon-button, .kimi-tooltip, .toolcall-flow, ' +
    '[role="toolbar"], [role="tooltip"], [data-testid*="copy"], [data-testid*="feedback"], ' +
    '[data-testid*="toolbar"], [data-testid*="thought"], [data-testid*="reasoning"], [data-testid*="action"], ' +
    '[data-testid*="tool-use"], [data-testid*="tool-call"]';
  function isCodeHeader(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'pre' || el.closest('pre')) return false;
    if (el.querySelector('pre')) return false;
    let cur = el.parentElement;
    while (cur && !cur.matches('.markdown, [data-perf-reply-text], article, [data-testid*="message"], body, main')) {
      if (cur.matches('code-block, div[role="group"], [class*="code-block"], [class*="codeblock"], [class*="code_block"], .segment-code')) {
        if (cur.querySelector('pre')) return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function skipped(el) {
    try {
      if (el.matches(SKIP)) return true;
      if (el.closest && (el.closest('.toolcall-flow') || el.closest('.segment-code-header'))) return true;
      if (isCodeHeader(el)) return true;
      const t = (el.textContent || '').trim();
      if (/^(ChatGPT|You) said:?$/i.test(t)) return true;
      if (/^(Thought process|Thinking Process)$/i.test(t)) return true;
      if (/^Thought for (\d+|a few|a moment)/i.test(t) && (el.children.length === 0 || el.matches('summary, [data-testid*="thought"], div, span'))) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function langOf(pre, code) {
    const parent = pre.parentElement;
    const parentLang = parent && (parent.getAttribute('language') || parent.getAttribute('data-language') || '');
    const cls = ((code && code.className) || '') + ' ' + (pre.className || '') + ' ' + ((parent && parent.className) || '');
    const m = cls.match(/language-([\w+#.-]+)/i);
    if (m) return m[1].toLowerCase();
    if (parentLang && /^[A-Za-z][\w+#.-]{0,14}$/.test(parentLang)) return parentLang.toLowerCase();
    if (!code) return '';
    // fallback: a small label (e.g. "python") in the code block header
    for (const el of pre.querySelectorAll('span, div')) {
      if (code.contains(el) || el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (/^[A-Za-z][\w+#.-]{0,14}$/.test(t)) return t.toLowerCase();
    }
    if (parent && (parent.tagName.toLowerCase() === 'code-block' || parent.matches('[class*="code-block"], div[role="group"]'))) {
      for (const el of parent.querySelectorAll('span, div')) {
        if (pre.contains(el) || el.children.length || skipped(el)) continue;
        const t = (el.textContent || '').trim();
        if (/^[A-Za-z][\w+#.-]{0,14}$/.test(t)) return t.toLowerCase();
      }
    }
    return '';
  }

  function inPreWrap(node) {
    const p = node.parentElement;
    return !!(p && p.closest && p.closest('[class*="whitespace-pre"], [class*="user-content"], pre'));
  }

  function kids(node) {
    let s = '';
    node.childNodes.forEach((c) => {
      let t = md(c);
      if (c.nodeType === 3 && !inPreWrap(c) && (s === '' || /\n$/.test(s))) t = t.replace(/^ +/, '');
      s += t;
    });
    return s;
  }

  function md(node) {
    if (node.nodeType === 3) {
      return inPreWrap(node) ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1 || skipped(node)) return '';
    const tag = node.tagName.toLowerCase();

    if (node.classList && node.classList.contains('katex')) {
      const a = node.querySelector('annotation[encoding="application/x-tex"]');
      return a ? ' $' + a.textContent + '$ ' : node.textContent;
    }

    switch (tag) {
      case 'code-block': {
        const pre = node.querySelector('pre');
        if (pre) return md(pre);
        const code = node.querySelector('code');
        const lang = node.getAttribute('language') || node.getAttribute('data-language') || langOf(node, code);
        const text = (code ? code.textContent : node.textContent).trim();
        return '\n\n```' + lang + '\n' + text + '\n```\n\n';
      }
      case 'pre': {
        const code = node.querySelector('code');
        const host = code || node;
        const lineGroups = host.querySelectorAll('[data-code-line-group]');
        let text = host.textContent;
        if (lineGroups.length > 1 && (!text.includes('\n') || text.trim().split('\n').length < lineGroups.length)) {
          text = Array.from(lineGroups).map((l) => l.textContent).join('\n');
        }
        text = text.replace(/\n$/, '');
        return '\n\n```' + langOf(node, code) + '\n' + text + '\n```\n\n';
      }
      case 'code':
        return '`' + node.textContent + '`';
      case 'br':
        return '\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + kids(node).trim() + '\n\n';
      case 'p':
        return '\n\n' + kids(node) + '\n\n';
      case 'strong': case 'b':
        return '**' + kids(node).trim() + '**';
      case 'em': case 'i':
        return '*' + kids(node).trim() + '*';
      case 'a': {
        const t = kids(node).trim();
        const href = node.getAttribute('href') || '';
        return /^https?:/i.test(href) && t ? '[' + t + '](' + href + ')' : t;
      }
      case 'blockquote':
        return '\n\n' + kids(node).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      case 'ul': case 'ol': {
        const ordered = tag === 'ol';
        let n = parseInt(node.getAttribute('start') || '1', 10);
        let out = '\n';
        Array.from(node.children).forEach((li) => {
          if (li.tagName.toLowerCase() !== 'li' || skipped(li)) return;
          const body = kids(li).trim().replace(/\n/g, '\n    ');
          out += (ordered ? n++ + '. ' : '- ') + body + '\n';
        });
        return out + '\n';
      }
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.children).map((c) => kids(c).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '))
        );
        if (!rows.length) return '';
        const w = Math.max(...rows.map((r) => r.length));
        const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] || '').join(' | ') + ' |';
        const sep = '| ' + Array(w).fill('---').join(' | ') + ' |';
        return '\n\n' + [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n') + '\n\n';
      }
      case 'div': {
        if (node.classList && node.classList.contains('paragraph')) {
          return '\n\n' + kids(node) + '\n\n';
        }
        const content = kids(node);
        return content ? '\n' + content + '\n' : '';
      }
      case 'span': {
        const cls = String(node.className || '');
        if (cls.includes('block')) {
          return '\n' + kids(node) + '\n';
        }
        return kids(node);
      }
      default:
        return kids(node);
    }
  }

  function markdown(el) {
    return kids(el).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function plainText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('*').forEach((n) => {
      if (skipped(n)) n.remove();
    });
    c.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    c.querySelectorAll('p, div, li, tr, [class*="block"]').forEach((b) => b.after('\n'));
    return (c.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pick(el, sels) {
    const all = pickAll(el, sels);
    return all[0] || el;
  }

  function pickAll(el, sels) {
    for (const s of sels || []) {
      const found = outermost(Array.from(el.querySelectorAll(s)).filter((n) => !skipped(n)));
      if (found.length) return found;
    }
    return [el];
  }

  function outermost(list) {
    const set = new Set(list);
    return list.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  function extractId(el, role, adapter) {
    if (!el || el.nodeType !== 1) return null;
    if (el.hasAttribute('data-message-id')) return el.getAttribute('data-message-id');
    if (el.hasAttribute('data-chatgpt-search-unit-key')) return el.getAttribute('data-chatgpt-search-unit-key');
    if (el.hasAttribute('data-content-search-unit-key')) return el.getAttribute('data-content-search-unit-key');
    const unitAncestor = el.closest('[data-message-id], [data-chatgpt-search-unit-key], [data-content-search-unit-key]');
    if (unitAncestor) {
      return (
        unitAncestor.getAttribute('data-message-id') ||
        unitAncestor.getAttribute('data-chatgpt-search-unit-key') ||
        unitAncestor.getAttribute('data-content-search-unit-key')
      );
    }

    // A turn key identifies a user/assistant turn, not necessarily a message:
    // some ChatGPT DOMs place multiple assistant message elements inside one
    // turn. Include the role-local index so distinct messages do not share an
    // identity and collapse when overlapping virtualized windows are merged.
    const turnAncestor = el.closest('[data-turn-key], article[data-testid*="conversation-turn"], [data-testid^="conversation-turn"]');
    if (turnAncestor) {
      const turnId = turnAncestor.getAttribute('data-turn-key') || turnAncestor.getAttribute('data-testid');
      const roleSelector = role === 'user' ? adapter.user.join(',') : adapter.assistant.join(',');
      const roleMessages = outermost(Array.from(turnAncestor.querySelectorAll(roleSelector)));
      const roleIndex = Math.max(0, roleMessages.indexOf(el));
      return `${turnId}:${role}:${roleIndex}`;
    }
    return null;
  }

  function scrape(adapter) {
    const us = adapter.user.join(',');
    const as = adapter.assistant.join(',');
    const els = outermost(Array.from(document.querySelectorAll(us + ',' + as)));
    const out = [];
    for (const el of els) {
      const role = el.matches(us) ? 'user' : 'assistant';
      let raw;
      if (role === 'user') {
        const hosts = pickAll(el, adapter.userContent);
        raw = hosts
          .map((host) => {
            const qLines = host.querySelectorAll('p.query-text-line');
            if (qLines.length) {
              return Array.from(qLines)
                .filter((p) => !skipped(p))
                .map((p) => kids(p).trim())
                .join('\n');
            }
            return adapter.userPlain ? plainText(host) : markdown(host);
          })
          .filter(Boolean)
          .join('\n\n');
      } else {
        const hosts = pickAll(el, adapter.assistantContent);
        raw = hosts.map((h) => markdown(h)).filter(Boolean).join('\n\n');
      }
      const text = CTX.redact ? CTX.redact(raw) : raw;
      if (text) {
        const id = extractId(el, role, adapter);
        const msg = { role, text };
        if (id) msg.id = id;
        out.push(msg);
      }
    }
    return out;
  }

  // How many elements each selector group matches (helps debug stale selectors).
  function diagnose(adapter) {
    return {
      user: document.querySelectorAll(adapter.user.join(',')).length,
      assistant: document.querySelectorAll(adapter.assistant.join(',')).length,
    };
  }

  function normText(s) {
    if (typeof s !== 'string') return '';
    return s
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
      .replace(/[\u00a0\u2000-\u200a\u2028\u2029\u3000]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function fingerprint(msg) {
    if (!msg) return '';
    if (msg.id) return msg.role + ':id:' + msg.id;
    return msg.role + ':' + normText(msg.text);
  }

  function isPrefixMatch(a, b) {
    if (!a || !b) return false;
    let shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    shorter = shorter.replace(/(?:\.{3,}|…|\s)+$/, '');
    if (shorter.length < 5) return false;
    if (!longer.startsWith(shorter)) return false;
    const nextChar = longer[shorter.length];
    if (!nextChar) return true;
    if (shorter.length >= 20) return true;
    return /[\s\p{P}]/u.test(nextChar) || /[\s\p{P}]$/u.test(shorter);
  }

  function sameMsg(a, b) {
    if (!a || !b || a.role !== b.role) return false;
    if (a.id && b.id) return a.id === b.id;
    if (a.text === b.text) return true;
    const na = normText(a.text);
    const nb = normText(b.text);
    if (na === nb) return true;
    if (na && nb && isPrefixMatch(na, nb)) return true;
    return false;
  }

  function pickLonger(msgA, msgB) {
    if (!msgA) return msgB ? { ...msgB } : null;
    if (!msgB) return { ...msgA };
    const textA = msgA.text || '';
    const textB = msgB.text || '';
    const base = textB.length > textA.length ? msgB : msgA;
    const res = { ...base };
    if (!res.id && (msgA.id || msgB.id)) res.id = msgA.id || msgB.id;
    return res;
  }

  function solveLCS(A, B) {
    const m = A.length;
    const n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (sameMsg(A[i - 1], B[j - 1])) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    const maxLen = dp[m][n];
    if (maxLen === 0) return { maxLen: 0, tailAnchors: [], headAnchors: [], multiple: false };

    let i = m;
    let j = n;
    const tailAnchors = [];
    while (i > 0 && j > 0) {
      if (sameMsg(A[i - 1], B[j - 1]) && dp[i][j] === dp[i - 1][j - 1] + 1) {
        tailAnchors.push([i - 1, j - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    tailAnchors.reverse();

    const dpRev = Array.from({ length: m + 2 }, () => new Int32Array(n + 2));
    for (let ri = m; ri >= 1; ri--) {
      for (let rj = n; rj >= 1; rj--) {
        if (sameMsg(A[ri - 1], B[rj - 1])) {
          dpRev[ri][rj] = dpRev[ri + 1][rj + 1] + 1;
        } else {
          dpRev[ri][rj] = Math.max(dpRev[ri + 1][rj], dpRev[ri][rj + 1]);
        }
      }
    }
    i = 1;
    j = 1;
    const headAnchors = [];
    while (i <= m && j <= n) {
      if (sameMsg(A[i - 1], B[j - 1]) && dpRev[i][j] === dpRev[i + 1][j + 1] + 1) {
        headAnchors.push([i - 1, j - 1]);
        i++;
        j++;
      } else if (dpRev[i + 1][j] >= dpRev[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }

    const multiple = JSON.stringify(tailAnchors) !== JSON.stringify(headAnchors);
    return { maxLen, tailAnchors, headAnchors, multiple };
  }

  // The page may only render part of a long chat. Merge the freshly scraped window
  // onto what is already stored (handles tail, middle, head, and superset windows).
  function mergeDetailed(prev, fresh, opts) {
    opts = opts || {};
    const P = prev ? prev.length : 0;
    const F = fresh ? fresh.length : 0;
    if (!P && !F) return { messages: [], kind: 'empty', overlap: 0, ambiguous: false, gap: false };
    if (!P) return { messages: fresh.map((m) => ({ ...m })), kind: 'fresh', overlap: 0, ambiguous: false, gap: false };
    if (!F) return { messages: prev.map((m) => ({ ...m })), kind: 'prev', overlap: 0, ambiguous: false, gap: false };

    // Fast path 1: superset (fresh contains prev as an ordered subsequence)
    let sj = 0;
    const subIdxs = [];
    for (let i = 0; i < P; i++) {
      while (sj < F && !sameMsg(prev[i], fresh[sj])) sj++;
      if (sj >= F) break;
      subIdxs.push(sj);
      sj++;
    }
    if (subIdxs.length === P) {
      const res = fresh.map((m) => ({ ...m }));
      for (let i = 0; i < P; i++) {
        res[subIdxs[i]] = pickLonger(prev[i], res[subIdxs[i]]);
      }
      return { messages: res, kind: 'superset', overlap: P, ambiguous: false, gap: false };
    }

    // Fast path 2: contiguous run (prev contains fresh as a contiguous run)
    for (let i = 0; i <= P - F; i++) {
      let match = true;
      for (let k = 0; k < F; k++) {
        if (!sameMsg(prev[i + k], fresh[k])) {
          match = false;
          break;
        }
      }
      if (match) {
        const res = prev.map((m) => ({ ...m }));
        for (let k = 0; k < F; k++) {
          res[i + k] = pickLonger(res[i + k], fresh[k]);
        }
        return { messages: res, kind: 'contiguous', overlap: F, ambiguous: false, gap: false };
      }
    }

    // Candidate regions
    const candidateRegions = [];
    const candSize = Math.min(P, 3 * F + 20);
    if (opts.prefer === 'head') {
      candidateRegions.push({ region: prev.slice(0, candSize), offset: 0 });
      if (candSize < P) candidateRegions.push({ region: prev, offset: 0 });
    } else if (opts.prefer === 'tail') {
      const tailOffset = Math.max(0, P - candSize);
      candidateRegions.push({ region: prev.slice(tailOffset), offset: tailOffset });
      if (candSize < P) candidateRegions.push({ region: prev, offset: 0 });
    } else {
      if (candSize < P) {
        candidateRegions.push({ region: prev.slice(0, candSize), offset: 0 });
        const tailOffset = Math.max(0, P - candSize);
        candidateRegions.push({ region: prev.slice(tailOffset), offset: tailOffset });
      }
      candidateRegions.push({ region: prev, offset: 0 });
    }

    let bestGapResult = null;
    for (const { region, offset } of candidateRegions) {
      const fpCounts = new Map();
      for (const m of region) {
        const fp = fingerprint(m);
        fpCounts.set(fp, (fpCounts.get(fp) || 0) + 1);
      }
      function isLowInfo(m) {
        if (!m) return true;
        if (m.id) return false;
        const norm = normText(m.text);
        return norm.length <= 20 || (fpCounts.get(fingerprint(m)) || 0) > 1;
      }

      const lcsRes = solveLCS(region, fresh);
      if (lcsRes.maxLen === 0) continue;

      let anchors = lcsRes.tailAnchors;
      if (lcsRes.multiple) {
        const tailLow = lcsRes.tailAnchors.every(([pIdx]) => isLowInfo(region[pIdx]));
        const headLow = lcsRes.headAnchors.every(([pIdx]) => isLowInfo(region[pIdx]));
        if (tailLow && headLow) {
          return { messages: prev.map((m) => ({ ...m })), kind: 'ambiguous', overlap: lcsRes.maxLen, ambiguous: true, gap: false };
        }
        if (opts.prefer === 'head') {
          if (!headLow) anchors = lcsRes.headAnchors;
          else if (!tailLow) anchors = lcsRes.tailAnchors;
          else return { messages: prev.map((m) => ({ ...m })), kind: 'ambiguous', overlap: lcsRes.maxLen, ambiguous: true, gap: false };
        }
      }

      // Anchor count check
      if (anchors.length < 2) {
        const isSingleMsgWindow = P === 1 || F === 1;
        const [candP0, f0] = anchors[0];
        const absP0 = offset + candP0;
        const isEdge = (absP0 === 0 && f0 === F - 1) || (absP0 === P - 1 && f0 === 0);
        const isUnique = (fpCounts.get(fingerprint(region[candP0])) || 0) === 1;
        if (!isSingleMsgWindow && (!isEdge || !isUnique)) {
          continue;
        }
      }

      const absAnchors = anchors.map(([candP, fIdx]) => [offset + candP, fIdx]);
      // Repeated low-information text can produce a plausible but wrong LCS
      // alignment (for example, several identical "continue" turns). Do not
      // silently drop a turn when one of those repeated values anchors a window.
      const freshCounts = new Map();
      for (const m of fresh) {
        const fp = fingerprint(m);
        freshCounts.set(fp, (freshCounts.get(fp) || 0) + 1);
      }
      const repeatedAnchor = absAnchors.some(([pIdx, fIdx]) => {
        const m = prev[pIdx];
        const fp = fingerprint(m);
        return isLowInfo(m) && ((fpCounts.get(fp) || 0) > 1 || (freshCounts.get(fp) || 0) > 1);
      });
      if (repeatedAnchor) {
        return { messages: prev.map((m) => ({ ...m })), kind: 'ambiguous', overlap: absAnchors.length, ambiguous: true, gap: false };
      }
      const pFirst = absAnchors[0][0];
      const fFirst = absAnchors[0][1];
      const pLast = absAnchors[absAnchors.length - 1][0];
      const fLast = absAnchors[absAnchors.length - 1][1];

      // Gaps check: unmatched messages before first anchor or after last anchor must touch matching end
      if (fFirst > 0 && pFirst > 0) {
        bestGapResult = { messages: prev.map((m) => ({ ...m })), kind: 'gap', overlap: absAnchors.length, ambiguous: false, gap: true };
        continue;
      }
      if (fLast < F - 1 && pLast < P - 1) {
        bestGapResult = { messages: prev.map((m) => ({ ...m })), kind: 'gap', overlap: absAnchors.length, ambiguous: false, gap: true };
        continue;
      }

      const out = [];
      let isAmbiguous = false;

      // Messages before first anchor
      if (fFirst > 0 && pFirst === 0) {
        for (let k = 0; k < fFirst; k++) out.push({ ...fresh[k] });
      } else if (pFirst > 0) {
        for (let k = 0; k < pFirst; k++) out.push({ ...prev[k] });
      }

      // Anchors and intervening messages
      for (let idx = 0; idx < absAnchors.length; idx++) {
        const [pIdx, fIdx] = absAnchors[idx];
        out.push(pickLonger(prev[pIdx], fresh[fIdx]));

        if (idx < absAnchors.length - 1) {
          const [nextP, nextF] = absAnchors[idx + 1];
          const unP = prev.slice(pIdx + 1, nextP);
          const unF = fresh.slice(fIdx + 1, nextF);
          if (unP.length > 0 || unF.length > 0) {
            const rolesP = unP.map((m) => m.role).join(',');
            const rolesF = unF.map((m) => m.role).join(',');
            const positionsMatch = unP.length === unF.length && unP.every((m, k) => sameMsg(m, unF[k]));
            if (rolesP === rolesF && positionsMatch) {
              for (let k = 0; k < unP.length; k++) {
                out.push(pickLonger(unP[k], unF[k]));
              }
            } else {
              isAmbiguous = true;
              for (const m of unP) out.push({ ...m });
              for (const m of unF) out.push({ ...m });
            }
          }
        }
      }

      // Messages after last anchor
      if (fLast < F - 1 && pLast === P - 1) {
        for (let k = fLast + 1; k < F; k++) out.push({ ...fresh[k] });
      } else if (pLast < P - 1) {
        for (let k = pLast + 1; k < P; k++) out.push({ ...prev[k] });
      }

      let kind = 'overlap';
      if (fFirst > 0 && fLast === F - 1 && pLast < P - 1) kind = 'head';
      else if (fFirst === 0 && fLast < F - 1 && pFirst > 0) kind = 'tail';
      else if (fFirst === 0 && fLast === F - 1 && (pFirst > 0 || pLast < P - 1)) kind = 'middle';

      return { messages: out, kind, overlap: absAnchors.length, ambiguous: isAmbiguous, gap: false };
    }

    return bestGapResult || { messages: prev.map((m) => ({ ...m })), kind: 'no-overlap', overlap: 0, ambiguous: false, gap: true };
  }

  function merge(prev, fresh, opts) {
    return mergeDetailed(prev, fresh, opts).messages;
  }

  CTX.scrape = scrape;
  CTX.diagnose = diagnose;
  CTX.mergeDetailed = mergeDetailed;
  CTX.merge = merge;
  CTX.normText = normText;
  CTX.sameMsg = sameMsg;
  CTX.fingerprint = fingerprint;
})(typeof window !== 'undefined' ? window : globalThis);
