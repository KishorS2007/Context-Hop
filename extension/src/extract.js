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
      if (text) out.push({ role, text });
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

  function sameMsg(a, b) {
    return !!(a && b && a.role === b.role && a.text === b.text);
  }

  function normText(s) {
    if (typeof s !== 'string') return '';
    return s
      .replace(/\r\n/g, '\n')
      .replace(/[\u00a0\u2000-\u200b\u2028\u2029]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function matchMsg(freshMsg, prevMsg, isPrevLast, hadExactMatch) {
    if (!freshMsg || !prevMsg || freshMsg.role !== prevMsg.role) return false;
    if (freshMsg.text === prevMsg.text) return true;
    const nf = normText(freshMsg.text);
    const np = normText(prevMsg.text);
    if (nf === np) return true;
    if (isPrevLast && hadExactMatch && (nf.startsWith(np) || prevMsg.role === 'assistant')) {
      return true;
    }
    return false;
  }

  // The page may only render part of a long chat. Merge the freshly scraped window
  // onto what is already stored (handles tail, middle, head, and superset windows).
  function merge(prev, fresh) {
    if (!prev || !prev.length) return fresh ? fresh.slice() : [];
    if (!fresh || !fresh.length) return prev ? prev.slice() : [];

    const P = prev.length;
    const F = fresh.length;

    let bestK = null;
    let bestScore = 0;

    // Search all possible offsets k where fresh[j] aligns with prev[k + j]
    for (let k = -(F - 1); k < P; k++) {
      let currentRun = 0;
      let maxRun = 0;
      let matches = 0;
      const startJ = Math.max(0, -k);
      const endJ = Math.min(F, P - k);

      for (let j = startJ; j < endJ; j++) {
        const isPrevLast = (k + j === P - 1);
        if (matchMsg(fresh[j], prev[k + j], isPrevLast, currentRun > 0)) {
          matches++;
          currentRun++;
          if (currentRun > maxRun) maxRun = currentRun;
        } else {
          currentRun = 0;
        }
      }

      if (maxRun > 0) {
        // Require two consecutive matches when possible to avoid false anchors on repeated texts
        const canRequireTwo = P >= 2 && F >= 2 && (endJ - startJ) >= 2;
        if (canRequireTwo && maxRun < 2) continue;

        const score = maxRun * 1000 + matches;
        if (score > bestScore) {
          bestScore = score;
          bestK = k;
        }
      }
    }

    // No overlap at all: keep prev unless fresh is larger
    if (bestK === null) {
      return fresh.length > prev.length ? fresh : prev;
    }

    const k = bestK;

    // Tail window or superset (fresh extends to or past the end of prev)
    if (k + F >= P) {
      if (k <= 0) {
        return fresh;
      }
      return prev.slice(0, k).concat(fresh);
    }

    // Head window (fresh starts before prev and ends inside prev)
    if (k <= 0) {
      return fresh.concat(prev.slice(k + F));
    }

    // Middle window (fresh is fully inside prev)
    return prev.slice(0, k).concat(fresh).concat(prev.slice(k + F));
  }

  CTX.scrape = scrape;
  CTX.diagnose = diagnose;
  CTX.merge = merge;
  CTX.normText = normText;
})(typeof window !== 'undefined' ? window : globalThis);
