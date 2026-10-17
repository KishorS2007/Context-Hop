// Builds the paste-ready handoff and compresses it to a token budget.
// Pure JavaScript, runs locally, costs nothing. (Tier 1: rule-based compression.)
//
// Priority when space is tight:
//   1. instruction + your own notes/summary
//   2. most recent messages, verbatim
//   3. latest version of each code block from earlier messages
//   4. compressed digest of the older conversation
(function (root) {
  'use strict';
  const CTX = (root.CTX = root.CTX || {});

  const tok = (s) => Math.ceil((s || '').length / 4); // rough: about 4 characters per token
  const FENCE_SRC = '```([\\w+#.-]*)\\n([\\s\\S]*?)```';

  function clip(text, maxChars) {
    if (text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 0.7);
    const tail = Math.max(0, maxChars - head - 5);
    return text.slice(0, head).trimEnd() + ' … ' + (tail ? text.slice(-tail).trimStart() : '');
  }

  function clipSafe(text, maxChars) {
    let t = clip(text, Math.max(20, maxChars));
    if ((t.match(/```/g) || []).length % 2) t += '\n```'; // never leave a code fence open
    return t;
  }

  function truncCode(code, maxChars) {
    if (code.length <= maxChars) return code;
    const cut = code.slice(0, maxChars);
    return cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0)) + '\n// ... (truncated)';
  }

  // Latest version of each code block. Blocks count as "the same file" when their first
  // two non-empty lines match; the later one wins.
  function codeBlocks(messages) {
    const found = new Map();
    messages.forEach((m, idx) => {
      const re = new RegExp(FENCE_SRC, 'g');
      let x;
      while ((x = re.exec(m.text))) {
        const code = x[2].replace(/\n$/, '');
        if (!code.trim()) continue;
        const sig = code.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('|').slice(0, 100);
        const key = (x[1] || '') + '|' + sig;
        found.delete(key);
        found.set(key, { lang: x[1] || '', code, idx });
      }
    });
    return Array.from(found.values()).sort((a, b) => a.idx - b.idx);
  }

  const FILLER =
    /^(sure|certainly|of course|absolutely|great question|good question|happy to help|okay|ok|here'?s|here is|let me|i'll|i will)\b[^.!?\n]*[.!?:]?\s*/i;
  const STOP = new Set(
    ('the a an and or but if then of to in on for with as by at is are was were be been it this that these those i you we they he she not no do does did can could should would will just also from into your my our their there here have has had so than too very about what which who how when where why').split(' ')
  );
  const words = (s) => (s.toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter((w) => !STOP.has(w));

  function stripCode(text) {
    return text.replace(new RegExp(FENCE_SRC, 'g'), (_, lang, code) => '[code: ' + (lang || 'text') + ', ' + code.split('\n').length + ' lines]');
  }

  function sentences(text) {
    const out = [];
    for (let line of text.split(/\n+/)) {
      line = line.trim();
      if (!line) continue;
      if (/^(#{1,6}\s|[-*]\s|\d+\.\s)/.test(line)) out.push(line);
      else out.push(...(line.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [line]).map((s) => s.trim()));
    }
    return out.filter(Boolean);
  }

  // Extractive summary: keep the highest-scoring sentences (word frequency + position + decision words).
  function summarize(text, maxChars) {
    const sents = sentences(stripCode(text).replace(FILLER, ''));
    if (!sents.length) return '';
    const freq = {};
    sents.forEach((s) => words(s).forEach((w) => (freq[w] = (freq[w] || 0) + 1)));
    const scored = sents.map((s, i) => {
      const w = words(s);
      const base = w.length ? w.reduce((a, x) => a + freq[x], 0) / Math.sqrt(w.length) : 0;
      const bonus = (i === 0 ? 3 : 0) + (/^#{1,6}\s/.test(s) ? 1 : 0) + (/\b(use|should|must|because|fix|error|decid|chose|need|create|build)\w*/i.test(s) ? 1 : 0);
      return { s, i, score: base + bonus };
    });
    const picked = [];
    let len = 0;
    for (const x of scored.slice().sort((a, b) => b.score - a.score)) {
      if (len + x.s.length + 1 > maxChars) continue;
      picked.push(x);
      len += x.s.length + 1;
    }
    if (!picked.length) return clip(sents[0], maxChars);
    return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
  }

  function olderSection(older, budgetTokens) {
    const maxChars = budgetTokens * 4;
    const build = (from) => {
      const slice = older.slice(from);
      const asst = slice.filter((m) => m.role === 'assistant').length || 1;
      const userChars = slice.filter((m) => m.role === 'user').reduce((a, m) => a + Math.min(m.text.length, 280) + 10, 0);
      const per = Math.max(100, Math.min(600, Math.floor((maxChars - userChars) / asst)));
      return slice
        .map((m) =>
          m.role === 'user'
            ? '- Me: ' + clip(m.text.replace(/\s+/g, ' '), 280)
            : '  Assistant: ' + (summarize(m.text, per) || '(code or short reply)')
        )
        .join('\n');
    };
    let first = 0;
    let text = build(0);
    while (text.length > maxChars && first < older.length) {
      first = Math.min(older.length, first + Math.max(1, Math.ceil((older.length - first) * 0.15)));
      text = build(first);
    }
    return { text, omitted: first };
  }

  function headerText(site, title) {
    return (
      '# Continuing a previous ' + site + ' conversation' + (title ? ': ' + title : '') + '\n' +
      'This conversation was cut off by a usage limit, so I moved to a new account. ' +
      'The context below comes from the old chat. Treat it as our shared history and continue from the ' +
      'last message without repeating what is already settled. Ask me only if something essential is missing.\n'
    );
  }

  function assemble(chat, msgs, notes, budget, scale) {
    const header = headerText(chat.siteName || 'AI', chat.title);
    const footer =
      '\n---\nAcknowledge briefly, then wait for my next message. If my last message was a request, continue from there.\n';
    const notesBlock = notes ? '\n## Goal and summary (written by me)\n' + clipSafe(notes, Math.floor(budget * 0.35 * 4)) + '\n' : '';
    const fixed = tok(header) + tok(notesBlock) + tok(footer) + 40; // 40 = section headings
    const R = Math.max(0, Math.floor((budget - fixed) * scale));

    // 1) most recent messages, verbatim (always at least the last two)
    const recentCap = Math.floor(R * 0.5);
    const recent = [];
    let used = 0;
    let start = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const label = msgs[i].role === 'user' ? '**Me:**' : '**Assistant:**';
      let block = label + '\n' + msgs[i].text;
      if (tok(block) > recentCap * 0.6) block = label + '\n' + clipSafe(msgs[i].text, Math.floor(recentCap * 0.6 * 4) - 20);
      if (used + tok(block) > recentCap && recent.length >= 2) break;
      recent.push(block);
      used += tok(block);
      start = i;
    }
    recent.reverse();

    // 2) latest code from messages that are not already shown verbatim
    const codeCap = Math.floor((R - used) * 0.4);
    const blocks = codeBlocks(msgs).filter((b) => b.idx < start);
    const keep = [];
    let cu = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      let code = blocks[i].code;
      if (cu + tok(code) + 10 > codeCap) {
        if (keep.length || codeCap < 150) continue;
        code = truncCode(code, (codeCap - 10) * 4); // newest block alone is too big: keep its beginning
      }
      keep.push({ lang: blocks[i].lang, code });
      cu += tok(code) + 10;
    }
    keep.reverse();

    // 3) digest of everything older, with whatever space is left
    const older = msgs.slice(0, start);
    let olderText = '';
    let omitted = 0;
    const olderBudget = R - used - cu;
    if (older.length && olderBudget > 80) ({ text: olderText, omitted } = olderSection(older, olderBudget));
    else omitted = older.length;

    const parts = [header];
    if (notesBlock) parts.push(notesBlock);
    if (olderText) {
      parts.push('\n## Earlier in the conversation (compressed' + (omitted ? '; ' + omitted + ' oldest messages left out' : '') + ')\n' + olderText + '\n');
    } else if (omitted) {
      parts.push('\n(' + omitted + ' earlier messages were left out to fit the size limit.)\n');
    }
    if (keep.length) {
      parts.push('\n## Latest code from earlier messages\n' + keep.map((b) => '```' + b.lang + '\n' + b.code + '\n```').join('\n\n') + '\n');
    }
    parts.push('\n## Most recent messages (verbatim)\n' + (recent.join('\n\n') || '(no messages saved yet)') + '\n');
    parts.push(footer);

    const text = parts.join('');
    return { text, tokens: tok(text), totalMessages: msgs.length, verbatim: recent.length, omitted, codeBlocks: keep.length };
  }

  function buildHandoff(chat, opts) {
    opts = opts || {};
    const budget = opts.budget || 5000;
    const notes = (opts.notes || '').trim();
    const msgs = (chat && chat.messages) || [];
    let result;
    for (let scale = 1, i = 0; i < 8; i++, scale *= 0.8) {
      result = assemble(chat || {}, msgs, notes, budget, scale);
      if (result.tokens <= budget) break;
    }
    result.overBudget = result.tokens > budget;
    return result;
  }

  CTX.buildHandoff = buildHandoff;
  CTX.estimateTokens = tok;
  CTX._summarize = summarize;
})(typeof window !== 'undefined' ? window : globalThis);
