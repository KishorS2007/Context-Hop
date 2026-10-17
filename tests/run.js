// Run with: npm install && npm test
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8');
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function load(html, url) {
  const dom = new JSDOM(html || '<body></body>', { url: url || 'https://chatgpt.com/c/abc-123', runScripts: 'outside-only' });
  const w = dom.window;
  for (const f of ['src/redact.js', 'src/extract.js', 'src/adapters.js', 'src/compress.js', 'manager/manager.js']) w.eval(src(f));
  return w;
}

// ---------- ChatGPT scraping ----------
const CHATGPT_HTML = `
<body><main>
  <div class="composer"><button>Think</button></div>
  <article data-testid="conversation-turn-1">
    <div data-message-author-role="user"><div class="whitespace-pre-wrap">How do I debounce in JS?
Show code.</div></div>
  </article>
  <article data-testid="conversation-turn-2">
    <div data-message-author-role="assistant">
      <div class="markdown">
        <p>Sure! Here is a debounce helper.</p>
        <pre><div><span>javascript</span><button>Copy code</button></div><div><code class="language-javascript">function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}</code></div></pre>
        <ul><li>Use <code>ms</code> wisely</li><li>Call <strong>clearTimeout</strong> first</li></ul>
        <table><tr><th>Delay</th><th>Use</th></tr><tr><td>200ms</td><td>search</td></tr></table>
      </div>
      <button>Copy</button><button>Good response</button>
    </div>
  </article>
  <button>Think</button>
</main></body>`;

test('chatgpt: ignores UI buttons like "Think" and reads only real messages', () => {
  const w = load(CHATGPT_HTML);
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(Array.from(msgs, (m) => m.role), ['user', 'assistant']);
  assert.ok(!msgs.some((m) => /^Think$/m.test(m.text)), 'Think leaked into messages');
});

test('chatgpt: user text keeps its line breaks', () => {
  const w = load(CHATGPT_HTML);
  const msgs = w.CTX.scrape(w.CTX.adapters[0]);
  assert.strictEqual(msgs[0].text, 'How do I debounce in JS?\nShow code.');
});

test('chatgpt: assistant markdown keeps code fence, language, lists, table; drops Copy buttons', () => {
  const w = load(CHATGPT_HTML);
  const t = w.CTX.scrape(w.CTX.adapters[0])[1].text;
  assert.ok(t.includes('```javascript\nfunction debounce(fn, ms) {'), t);
  assert.ok(t.includes('  let t;'), 'code indentation lost');
  assert.ok(t.includes('- Use `ms` wisely'), t);
  assert.ok(t.includes('**clearTimeout**'), t);
  assert.ok(t.includes('| Delay | Use |') && t.includes('| 200ms | search |'), t);
  assert.ok(!/Copy code|Good response/.test(t), 'button text leaked');
});

test('chatgpt: chat id is read from the URL', () => {
  const w = load(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123');
  assert.strictEqual(w.CTX.adapters[0].chatId(), 'abc-123');
  const w2 = load(CHATGPT_HTML, 'https://chatgpt.com/');
  assert.strictEqual(w2.CTX.adapters[0].chatId(), null);
});

test('diagnose reports matched element counts', () => {
  const w = load(CHATGPT_HTML);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.CTX.diagnose(w.CTX.adapters[0]))), { user: 1, assistant: 1 });
});

// ---------- ChatGPT real DOM structure (live data-chatgpt-search-unit-key) ----------
const CHATGPT_REAL_HTML = `
<body>
  <div data-chatgpt-conversation-selection-target="true" data-thread-find-target="conversation" class="flex min-h-full flex-1 flex-col gap-1.5 pb-5">
    <div data-turn-key="f8609fbc-dc68-4549-8512-4597440ccb14" class="[&_[data-virtualized-turn-content]]:[content-visibility:visible]">
      <div data-content-search-turn-key="fallback-turn-4">
        <div data-talvt-turn-state="complete" class="group flex flex-col">
          <!-- User message -->
          <div data-chatgpt-search-unit-key="fallback-turn-4:0:user" data-content-search-unit-key="fallback-turn-4:0:user" class="group/user-message">
            <div data-user-message-bubble="true" class="bg-user-message">
              <div class="text-size-chat whitespace-pre-wrap">hi
What are we working on today?</div>
            </div>
          </div>
          <!-- Assistant message (spanning consecutive search units) -->
          <div data-chatgpt-search-unit-key="fallback-turn-4:1:assistant" data-content-search-unit-key="fallback-turn-4:1:assistant">
            <div class="sr-only">ChatGPT said:</div>
            <div>Thought for 8 seconds</div>
            <div class="markdown">
              <p>Hello! I am ready to help.</p>
            </div>
            <div role="toolbar"><button>Copy</button><button>Regenerate</button></div>
            <div role="tooltip">Copy to clipboard</div>
          </div>
          <div data-chatgpt-search-unit-key="fallback-turn-4:2:assistant" data-content-search-unit-key="fallback-turn-4:2:assistant">
            <div class="markdown">
              <p>Here is step two of the response.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>`;

test('chatgpt live DOM: scrapes user and consecutive assistant messages in order', () => {
  const w = load(CHATGPT_REAL_HTML);
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 3);
  assert.deepStrictEqual(Array.from(msgs, (m) => m.role), ['user', 'assistant', 'assistant']);
  assert.strictEqual(msgs[0].text, 'hi\nWhat are we working on today?');
  assert.strictEqual(msgs[1].text, 'Hello! I am ready to help.');
  assert.strictEqual(msgs[2].text, 'Here is step two of the response.');
});

test('chatgpt live DOM: strips UI junk (ChatGPT said, Thought for..., toolbars, tooltips, buttons)', () => {
  const w = load(CHATGPT_REAL_HTML);
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  const msgs = w.CTX.scrape(a);
  const combined = msgs.map((m) => m.text).join('\n');
  assert.ok(!/ChatGPT said/i.test(combined), 'ChatGPT said leaked');
  assert.ok(!/Thought for/i.test(combined), 'Thought for leaked');
  assert.ok(!/Copy|Regenerate|tooltip/i.test(combined), 'UI toolbar/button leaked');
});

test('chatgpt live DOM: streaming() detects complete state vs streaming state', () => {
  const w = load(CHATGPT_REAL_HTML);
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  assert.strictEqual(a.streaming(), false);

  // Incomplete turn state counts as streaming
  const wStreaming = load(CHATGPT_REAL_HTML.replace('data-talvt-turn-state="complete"', 'data-talvt-turn-state="in_progress"'));
  const aStreaming = wStreaming.CTX.adapters.find((x) => x.id === 'chatgpt');
  assert.strictEqual(aStreaming.streaming(), true);

  // Stop button counts as streaming
  const wStop = load(CHATGPT_REAL_HTML + '<button data-testid="stop-button">Stop</button>');
  const aStop = wStop.CTX.adapters.find((x) => x.id === 'chatgpt');
  assert.strictEqual(aStop.streaming(), true);
});

test('chatgpt live DOM: diagnose reports matched element counts', () => {
  const w = load(CHATGPT_REAL_HTML);
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  const diag = w.CTX.diagnose(a);
  // Matches outer [data-chatgpt-search-unit-key$=":user"] and inner [data-user-message-bubble="true"]
  assert.strictEqual(diag.user, 2);
  assert.strictEqual(diag.assistant, 2);
});

test('chatgpt live DOM: virtualized turn merge keeps earlier conversation', () => {
  const w = load(CHATGPT_REAL_HTML);
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  const fresh = w.CTX.scrape(a);
  const prev = [
    { role: 'user', text: 'turn 1 question' },
    { role: 'assistant', text: 'turn 1 answer' },
    { role: 'user', text: 'turn 2 question' },
    { role: 'assistant', text: 'turn 2 answer' },
    fresh[0],
    fresh[1]
  ];
  const merged = w.CTX.merge(prev, fresh);
  assert.strictEqual(merged.length, 7);
  assert.strictEqual(merged[0].text, 'turn 1 question');
  assert.strictEqual(merged[merged.length - 1].text, 'Here is step two of the response.');
});

// ---------- other adapters: structure only (selectors are unverified against live sites) ----------
test('claude/gemini/kimi adapters scrape a mock DOM shaped like their selectors', () => {
  const w = load(
    `<body>
      <div data-testid="user-message"><p>hello claude</p></div>
      <div data-testid="assistant-message"><p>hi there</p></div>
      <user-query><div class="query-text"><p>hello gemini</p></div></user-query>
      <model-response><message-content><p>hi from gemini</p></message-content></model-response>
    </body>`,
    'https://claude.ai/chat/xyz'
  );
  const claude = w.CTX.scrape(w.CTX.adapters.find((x) => x.id === 'claude'));
  assert.deepStrictEqual(Array.from(claude, (m) => m.text), ['hello claude', 'hi there']);
  const gem = w.CTX.scrape(w.CTX.adapters.find((x) => x.id === 'gemini'));
  assert.deepStrictEqual(Array.from(gem, (m) => m.text), ['hello gemini', 'hi from gemini']);
});

// ---------- Claude real DOM structure (2025/2026 update) ----------
const CLAUDE_REAL_HTML = `
<body>
  <div role="feed" data-perf-region="transcript">
    <div data-rocksteady-sizer>
      <!-- User message (two-line text) -->
      <div data-testid="transcript-row" data-perf-row="human" data-rs-index="0">
        <div data-cds="UserMessage">
          <div data-testid="user-message">
            <p class="whitespace-pre-wrap break-words">First line of user prompt
Second line of user prompt</p>
          </div>
        </div>
      </div>
      <!-- Assistant message (reply with thinking UI, tool panel, bullet list, and code block) -->
      <div data-testid="transcript-row" data-perf-row="assistant" data-rs-index="1">
        <div data-cds="AssistantMessage">
          <div data-testid="assistant-message" data-cds="AssistantMessage" data-is-streaming="false">
            <!-- Thought process to be ignored -->
            <div data-testid="thought-process"><button>Thought process</button></div>
            <div data-perf-reply-text>
              <div data-cds="Prose">
                <p>Here is Claude's response with a list:</p>
                <ul>
                  <li>First bullet item</li>
                  <li>Second bullet item</li>
                </ul>
              </div>
            </div>
            <!-- Tool-use panel to be ignored -->
            <div data-testid="tool-use"><span>Tool call: search</span></div>
            <!-- Code block in second data-perf-reply-text block -->
            <div data-perf-reply-text>
              <div data-cds="Prose">
                <pre class="code-block__code"><code class="language-js" data-highlight="final"><span data-code-line-group class="block">const x = 10;</span><span data-code-line-group class="block">const y = 20;</span><span data-code-line-group class="block">console.log(x + y);</span></code></pre>
              </div>
            </div>
            <!-- Action toolbar to be ignored -->
            <div role="toolbar"><button>Copy</button><button>Retry</button></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>`;

test('claude live DOM: scrapes two-line user message and multi-part assistant response with list and code', () => {
  const w = load(CLAUDE_REAL_HTML, 'https://claude.ai/chat/c-123');
  const a = w.CTX.adapters.find((x) => x.id === 'claude');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].text, 'First line of user prompt\nSecond line of user prompt');
  assert.strictEqual(msgs[1].role, 'assistant');
  const t = msgs[1].text;
  assert.ok(t.includes("Here is Claude's response with a list:"), t);
  assert.ok(t.includes('- First bullet item\n- Second bullet item'), t);
  assert.ok(t.includes('```js\nconst x = 10;\nconst y = 20;\nconsole.log(x + y);\n```'), t);
});

test('claude live DOM: excludes thinking UI, tool panels, and toolbars', () => {
  const w = load(CLAUDE_REAL_HTML, 'https://claude.ai/chat/c-123');
  const a = w.CTX.adapters.find((x) => x.id === 'claude');
  const msgs = w.CTX.scrape(a);
  const combined = msgs.map((m) => m.text).join('\n');
  assert.ok(!/Thought process/i.test(combined), 'Thought process leaked');
  assert.ok(!/Tool call/i.test(combined), 'Tool call leaked');
  assert.ok(!/Copy|Retry/.test(combined), 'Toolbar buttons leaked');
});

test('claude live DOM: streaming() detects is-streaming and perf-row-streaming', () => {
  const w = load(CLAUDE_REAL_HTML, 'https://claude.ai/chat/c-123');
  const a = w.CTX.adapters.find((x) => x.id === 'claude');
  assert.strictEqual(a.streaming(), false);

  const wStreaming = load(CLAUDE_REAL_HTML.replace('data-is-streaming="false"', 'data-is-streaming="true"'), 'https://claude.ai/chat/c-123');
  const aStreaming = wStreaming.CTX.adapters.find((x) => x.id === 'claude');
  assert.strictEqual(aStreaming.streaming(), true);

  const wRowStreaming = load(CLAUDE_REAL_HTML.replace('data-perf-row="assistant"', 'data-perf-row="assistant" data-perf-row-streaming="true"'), 'https://claude.ai/chat/c-123');
  const aRowStreaming = wRowStreaming.CTX.adapters.find((x) => x.id === 'claude');
  assert.strictEqual(aRowStreaming.streaming(), true);
});

test('claude live DOM: virtualized transcript merge preserves earlier stored messages', () => {
  const w = load(CLAUDE_REAL_HTML, 'https://claude.ai/chat/c-123');
  const a = w.CTX.adapters.find((x) => x.id === 'claude');
  const fresh = w.CTX.scrape(a); // turns near viewport (e.g. index 0 and 1)
  const prev = [
    { role: 'user', text: 'earlier question from row 0' },
    { role: 'assistant', text: 'earlier answer from row 1' },
    fresh[0]
  ];
  const merged = w.CTX.merge(prev, fresh);
  assert.strictEqual(merged.length, 4);
  assert.strictEqual(merged[0].text, 'earlier question from row 0');
  assert.strictEqual(merged[1].text, 'earlier answer from row 1');
  assert.strictEqual(merged[2].text, fresh[0].text);
  assert.strictEqual(merged[3].text, fresh[1].text);
});

// ---------- Gemini real DOM structure (2025/2026 update) ----------
const GEMINI_REAL_HTML = `
<body>
  <div class="chat-history-wrapper" style="overflow-y: auto; height: 500px;">
    <infinite-scroller data-test-id="chat-history-container">
      <!-- Turn 1: User prompt and Assistant response -->
      <div class="conversation-container" id="conversation-container-0">
        <user-query>
          <user-query-content>
            <div id="user-query-content-0" class="query-content">
              <div class="query-text">
                <h5 class="cdk-visually-hidden screen-reader-user-query-label">You said</h5>
                <p class="query-text-line">Compare Python and Rust.</p>
                <p class="query-text-line">Show a table and a sample function.</p>
              </div>
            </div>
            <gem-icon-button data-test-id="prompt-copy-button">
              <mat-icon>copy</mat-icon>
            </gem-icon-button>
          </user-query-content>
        </user-query>

        <model-response>
          <response-container>
            <thinking-overlay>Thinking process</thinking-overlay>
            <model-response-content>
              <structured-content-container class="model-response-text">
                <message-content>
                  <div id="model-response-message-content" class="markdown markdown-main-panel md-content">
                    <p data-path-to-node="0">Here is the comparison between Python and Rust:</p>
                    <table>
                      <thead>
                        <tr><th>Language</th><th>Typing</th><th>Performance</th></tr>
                      </thead>
                      <tbody>
                        <tr><td>Python</td><td>Dynamic</td><td>Interpreted</td></tr>
                        <tr><td>Rust</td><td>Static</td><td>Compiled</td></tr>
                      </tbody>
                    </table>
                    <code-block language="python">
                      <div class="code-block-decoration header">
                        <span class="code-block-header-text">python</span>
                        <gem-icon-button data-test-id="code-copy-button">
                          <mat-icon>content_copy</mat-icon>
                        </gem-icon-button>
                      </div>
                      <pre><code class="language-python">def calculate_total(prices):
    return sum(prices)</code></pre>
                    </code-block>
                  </div>
                </message-content>
              </structured-content-container>
            </model-response-content>
            <sources-list>Sources: python.org, rust-lang.org</sources-list>
            <message-actions>
              <gem-icon-button><mat-icon>thumb_up</mat-icon></gem-icon-button>
              <gem-icon-button><mat-icon>thumb_down</mat-icon></gem-icon-button>
              <gem-icon-button><mat-icon>share</mat-icon></gem-icon-button>
              <gem-icon-button><mat-icon>more_horiz</mat-icon></gem-icon-button>
            </message-actions>
          </response-container>
        </model-response>
        <model-response-disclaimers>Gemini may display inaccurate info, including about people.</model-response-disclaimers>
      </div>
    </infinite-scroller>
  </div>
</body>`;

test('gemini live DOM: user query lines joined with single \\n, hidden label and copy icon stripped', () => {
  const w = load(GEMINI_REAL_HTML, 'https://gemini.google.com/app/58b0f83cf241c7b8');
  const a = w.CTX.adapters.find((x) => x.id === 'gemini');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].text, 'Compare Python and Rust.\nShow a table and a sample function.');
  assert.ok(!msgs[0].text.includes('You said'), 'cdk-visually-hidden screen-reader label leaked');
  assert.ok(!msgs[0].text.includes('copy'), 'mat-icon copy text leaked');
});

test('gemini live DOM: assistant reply formats table and code-block without stray header text', () => {
  const w = load(GEMINI_REAL_HTML, 'https://gemini.google.com/app/58b0f83cf241c7b8');
  const a = w.CTX.adapters.find((x) => x.id === 'gemini');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs[1].role, 'assistant');
  const text = msgs[1].text;

  // Table verified
  assert.ok(text.includes('| Language | Typing | Performance |'), 'Table header missing');
  assert.ok(text.includes('| Python | Dynamic | Interpreted |'), 'Table row 1 missing');
  assert.ok(text.includes('| Rust | Static | Compiled |'), 'Table row 2 missing');

  // Fenced code block verified
  assert.ok(
    text.includes('```python\ndef calculate_total(prices):\n    return sum(prices)\n```'),
    'Code block missing or improperly formatted:\n' + text
  );

  // Stray UI chrome elements verified NOT present
  assert.ok(!text.includes('content_copy'), 'mat-icon content_copy leaked');
  assert.ok(!text.includes('thumb_up'), 'mat-icon thumb_up leaked');
  assert.ok(!text.includes('share'), 'mat-icon share leaked');
  assert.ok(!text.includes('Thinking process'), 'thinking overlay leaked');
  assert.ok(!text.includes('Sources:'), 'sources list leaked');
  assert.ok(!text.includes('Gemini may display inaccurate info'), 'disclaimer leaked');

  // Code block header: lone language label before code fence must not exist
  assert.ok(!/\bpython\s+```python/.test(text), 'Stray language label preceded fenced code block');
});

test('gemini live DOM: chatId extracted from standard and multi-account URLs', () => {
  const check = (url) => {
    const w = load(GEMINI_REAL_HTML, url);
    const a = w.CTX.adapters.find((x) => x.id === 'gemini');
    return a.chatId();
  };
  assert.strictEqual(check('https://gemini.google.com/app/58b0f83cf241c7b8'), '58b0f83cf241c7b8');
  assert.strictEqual(check('https://gemini.google.com/u/1/app/58b0f83cf241c7b8'), '58b0f83cf241c7b8');
  assert.strictEqual(check('https://gemini.google.com/u/2/app/abc-123_turn'), 'abc-123_turn');
  assert.strictEqual(check('https://gemini.google.com/u/1/app'), null);
});

test('gemini live DOM: streaming() detects stop button', () => {
  const w = load(GEMINI_REAL_HTML, 'https://gemini.google.com/app/58b0f83cf241c7b8');
  const a = w.CTX.adapters.find((x) => x.id === 'gemini');
  assert.strictEqual(a.streaming(), false);

  const wStop = load(
    GEMINI_REAL_HTML.replace('</body>', '<button aria-label="Stop response">Stop</button></body>'),
    'https://gemini.google.com/app/58b0f83cf241c7b8'
  );
  const aStop = wStop.CTX.adapters.find((x) => x.id === 'gemini');
  assert.strictEqual(aStop.streaming(), true);

  const wStopGen = load(
    GEMINI_REAL_HTML.replace('</body>', '<button aria-label="Stop generation">Stop</button></body>'),
    'https://gemini.google.com/app/58b0f83cf241c7b8'
  );
  const aStopGen = wStopGen.CTX.adapters.find((x) => x.id === 'gemini');
  assert.strictEqual(aStopGen.streaming(), true);
});

test('gemini live DOM: lazy-loaded turns merge preserves earlier and newly loaded messages', () => {
  const w = load(GEMINI_REAL_HTML, 'https://gemini.google.com/app/58b0f83cf241c7b8');
  const a = w.CTX.adapters.find((x) => x.id === 'gemini');
  const currentTurn = w.CTX.scrape(a); // [user, assistant]
  // Suppose turn 2 was already stored
  const prev = [
    { role: 'user', text: 'turn 2 question' },
    { role: 'assistant', text: 'turn 2 answer' },
  ];
  // Fresh window scrolled to top loads turn 1 (currentTurn) and overlaps turn 2
  const fresh = [
    currentTurn[0],
    currentTurn[1],
    { role: 'user', text: 'turn 2 question' },
    { role: 'assistant', text: 'turn 2 answer' },
  ];
  const merged = w.CTX.merge(prev, fresh);
  assert.strictEqual(merged.length, 4);
  assert.strictEqual(merged[0].text, currentTurn[0].text);
  assert.strictEqual(merged[1].text, currentTurn[1].text);
  assert.strictEqual(merged[2].text, 'turn 2 question');
  assert.strictEqual(merged[3].text, 'turn 2 answer');
});

// ---------- Kimi real DOM structure (live kimi.ai) ----------
const KIMI_REAL_HTML = `
<body>
  <div class="chat-content-list">
    <!-- User message -->
    <div class="chat-content-item chat-content-item-user">
      <div class="user-content"><span class="user-content__text">zxqtest1 - list three fruits as bullets,
then show a 2-line python code block</span></div>
      <div class="segment-user-action-row"><button><svg></svg></button></div>
    </div>

    <!-- Assistant message -->
    <div class="chat-content-item chat-content-item-assistant">
      <div class="segment-avatar"><canvas></canvas></div>
      <div class="toolcall-rollup">
        <!-- PART 1 = THINKING, must NOT be saved -->
        <div class="toolcall-rollup__part">
          <div class="toolcall-flow">
            <div class="markdown-container toolcall-content-text">
              <div class="paragraph">Thinking process: user requested three fruits and python code...</div>
            </div>
          </div>
        </div>

        <!-- PART 2 = THE ANSWER -->
        <div class="toolcall-rollup__part">
          <div class="markdown-container">
            <div class="markdown">
              <div class="paragraph" dir="auto">Here are three fruits:</div>
              <ul start="1">
                <li><div class="paragraph" dir="auto">Apple</div></li>
                <li><div class="paragraph" dir="auto">Banana</div></li>
                <li><div class="paragraph" dir="auto">Cherry</div></li>
              </ul>
              <div class="paragraph" dir="auto">And here is the python code block:</div>
              <div class="segment-code">
                <div class="sticky-release" style="--sticky-header-height: 42.5px;">
                  <div class="sticky-release-rail">
                    <div class="sticky-release-header" style="top: 0px;">
                      <header class="segment-code-header">
                        <div class="segment-code-header-content">
                          <span class="segment-code-lang">Python</span> <!---->
                          <span><div class="icon-button" style="width: 32px; height: 32px;"> <div class="kimi-tooltip tooltip-bottom icon-button-tooltip bottom" data-testid="icon-button-tooltip">Copy</div></div></span>
                        </div>
                      </header>
                    </div>
                  </div>
                </div>
                <div class="syntax-highlighter dark segment-code-content">
                  <pre class="language-python"><code class="language-python"><span class="token keyword">print</span><span class="token punctuation">(</span><span class="token string">"hello"</span><span class="token punctuation">)</span>
<span class="token keyword">print</span><span class="token punctuation">(</span><span class="token string">"world"</span><span class="token punctuation">)</span></code></pre>
                </div>
              </div>
              <div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="segment-assistant-actions"><button><svg></svg></button></div>
    </div>
  </div>
</body>`;

test('kimi live DOM: scrapes user prompt with line breaks, excludes thinking, formats list, paragraphs, and code fence', () => {
  const w = load(KIMI_REAL_HTML, 'https://www.kimi.ai/chat/cquu0k4v5i7s');
  const a = w.CTX.adapters.find((x) => x.id === 'kimi');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(
    msgs[0].text,
    'zxqtest1 - list three fruits as bullets,\nthen show a 2-line python code block'
  );

  assert.strictEqual(msgs[1].role, 'assistant');
  const text = msgs[1].text;

  // 1. Thinking text must be absent
  assert.ok(!text.includes('Thinking process'), 'Thinking text leaked into assistant reply');

  // 2. Paragraphs separated by blank lines
  assert.ok(text.includes('Here are three fruits:\n\n- Apple'), 'Paragraph before list missing blank line');
  assert.ok(text.includes('\n\nAnd here is the python code block:\n\n```python'), 'Paragraph before code missing blank line');

  // 3. List items start with "- "
  assert.ok(text.includes('- Apple\n- Banana\n- Cherry'), 'List items not formatted with "- "');

  // 4. Code fence reads ```python with no stray label or tooltip lines
  assert.ok(
    text.includes('```python\nprint("hello")\nprint("world")\n```'),
    'Code block missing or improperly formatted:\n' + text
  );
  assert.ok(!/\bCopy\b/.test(text), 'Copy tooltip leaked into text');
  assert.ok(!/\bPython\s+```python/.test(text), 'Stray Python header leaked');
});

test('kimi live DOM: chatId extracted from live kimi.ai and www.kimi.ai URLs', () => {
  const check = (url) => {
    const w = load(KIMI_REAL_HTML, url);
    const a = w.CTX.adapters.find((x) => x.id === 'kimi');
    return a.chatId();
  };
  assert.strictEqual(check('https://www.kimi.ai/chat/cquu0k4v5i7s'), 'cquu0k4v5i7s');
  assert.strictEqual(check('https://kimi.ai/chat/cquu0k4v5i7s'), 'cquu0k4v5i7s');
  assert.strictEqual(check('https://kimi.ai/chat/abc-123_xyz'), 'abc-123_xyz');
  assert.strictEqual(check('https://kimi.ai/'), null);
});

test('kimi live DOM: multiple answer parts joined with blank line', () => {
  const multiPartHtml = KIMI_REAL_HTML.replace(
    /<\/div>\s*<div class="segment-assistant-actions">/,
    `        <!-- PART 3 = SECOND ANSWER PART -->
        <div class="toolcall-rollup__part">
          <div class="markdown-container">
            <div class="markdown">
              <div class="paragraph" dir="auto">Here is additional information after tool call:</div>
              <ul start="1">
                <li><div class="paragraph" dir="auto">Dragonfruit</div></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <div class="segment-assistant-actions">`
  );
  const w = load(multiPartHtml, 'https://www.kimi.ai/chat/cquu0k4v5i7s');
  const a = w.CTX.adapters.find((x) => x.id === 'kimi');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 2);
  const text = msgs[1].text;
  assert.ok(text.includes('```\n\nHere is additional information after tool call:'));
  assert.ok(text.includes('- Dragonfruit'));
});

test('extract: SKIP list ignores .cdk-visually-hidden and mat-icon in any site', () => {
  const html = `<body>
    <article data-testid="conversation-turn-1">
      <div data-message-author-role="user">
        <div class="whitespace-pre-wrap">
          <span class="cdk-visually-hidden">Hidden reader text</span>
          Normal text
          <mat-icon>check_circle</mat-icon>
        </div>
      </div>
    </article>
  </body>`;
  const w = load(html, 'https://chatgpt.com/c/abc-123');
  const a = w.CTX.adapters.find((x) => x.id === 'chatgpt');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 1);
  assert.ok(!msgs[0].text.includes('Hidden reader text'), 'cdk-visually-hidden text leaked');
  assert.ok(!msgs[0].text.includes('check_circle'), 'mat-icon text leaked');
  assert.ok(msgs[0].text.includes('Normal text'), 'Normal text missing');
});

// ---------- merge ----------
test('merge: tail window extends past prev and updates partial/new messages', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });
  const prev = [m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('assistant', 'partial')];
  const fresh = [m('user', 'c'), m('assistant', 'completed reply'), m('user', 'e')];
  const out = Array.from(w.CTX.merge(prev, fresh), (x) => x.text);
  assert.deepStrictEqual(out, ['a', 'b', 'c', 'completed reply', 'e']);
});

test('merge: middle window replaces region and KEEPS messages after it', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });
  const prev = [m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('assistant', 'd'), m('user', 'e'), m('assistant', 'f')];
  const fresh = [m('user', 'c'), m('assistant', 'd')];
  const out = Array.from(w.CTX.merge(prev, fresh), (x) => x.text);
  assert.deepStrictEqual(out, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('merge: head window prepends new messages and keeps rest of prev', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });
  const prev = [m('user', 'c'), m('assistant', 'd'), m('user', 'e')];
  const fresh = [m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('assistant', 'd')];
  const out = Array.from(w.CTX.merge(prev, fresh), (x) => x.text);
  assert.deepStrictEqual(out, ['a', 'b', 'c', 'd', 'e']);
});

test('merge: no overlap keeps prev unless fresh is larger', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });
  const prev = [m('user', 'a'), m('assistant', 'b'), m('user', 'c')];
  // fresh is smaller -> keep prev
  assert.deepStrictEqual(Array.from(w.CTX.merge(prev, [m('user', 'x'), m('assistant', 'y')]), (x) => x.text), ['a', 'b', 'c']);
  // fresh is larger -> keep fresh
  assert.deepStrictEqual(Array.from(w.CTX.merge(prev, [m('user', 'w'), m('assistant', 'x'), m('user', 'y'), m('assistant', 'z')]), (x) => x.text), ['w', 'x', 'y', 'z']);
});

test('merge: requires two consecutive matches to avoid false anchor on repeated "continue"', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });
  const prev = [m('user', 'q1'), m('assistant', 'continue'), m('user', 'q2'), m('assistant', 'a2')];
  // fresh only matches "continue", next message differs
  const fresh = [m('assistant', 'continue'), m('user', 'different')];
  // Since 2 consecutive matches are not found, does not false-anchor on "continue"; prev is larger so kept
  assert.deepStrictEqual(Array.from(w.CTX.merge(prev, fresh), (x) => x.text), ['q1', 'continue', 'q2', 'a2']);
});

// ---------- user message line breaks & code headers ----------
test('extract: user message preserves line breaks with whitespace-pre-wrap, <br>, and block elements', () => {
  const w = load(
    `<body>
      <!-- text node with newlines and leading indentation under whitespace-pre-wrap -->
      <div data-testid="user-message">
        <p class="whitespace-pre-wrap break-words">HIT 1:
  p ...
  &lt; div ...</p>
      </div>
      <div data-testid="assistant-message"><div data-perf-reply-text><p>ack 1</p></div></div>

      <!-- <br> line breaks -->
      <div data-testid="user-message">
        <p class="whitespace-pre-wrap">Line 1<br>  Line 2<br>  Line 3</p>
      </div>
      <div data-testid="assistant-message"><div data-perf-reply-text><p>ack 2</p></div></div>

      <!-- block-level div and span lines -->
      <div data-testid="user-message">
        <div class="whitespace-pre-wrap"><div>Block 1: hello</div><div>  Block 2: indented</div><span class="block">  Block 3: span</span></div>
      </div>
      <div data-testid="assistant-message"><div data-perf-reply-text><p>ack 3</p></div></div>
    </body>`,
    'https://claude.ai/chat/test-lines'
  );
  const a = w.CTX.adapters.find((x) => x.id === 'claude');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 6);

  // Check 1: whitespace-pre-wrap with \n and leading spaces
  assert.ok(msgs[0].text.includes('HIT 1:\n  p ...\n  < div ...'), msgs[0].text);

  // Check 2: <br> becomes \n
  assert.ok(msgs[2].text.includes('Line 1\n  Line 2\n  Line 3'), msgs[2].text);

  // Check 3: block divs and span.block keep line breaks and indentation
  assert.ok(msgs[4].text.includes('Block 1: hello\n  Block 2: indented\n  Block 3: span'), msgs[4].text);
});

test('extract: code block excludes lone language header before fenced code', () => {
  const w = load(
    `<body>
      <div data-testid="assistant-message">
        <div data-perf-reply-text>
          <div data-cds="Prose">
            <p>Here is code:</p>
            <div role="group" class="code-block">
              <div class="code-block__header">
                <span class="code-lang">js</span>
                <button>Copy</button>
              </div>
              <pre class="code-block__code"><code class="language-js"><span data-code-line-group class="block">const x = 1;</span><span data-code-line-group class="block">const y = 2;</span></code></pre>
            </div>
          </div>
        </div>
      </div>
    </body>`,
    'https://claude.ai/chat/test-code-header'
  );
  const a = w.CTX.adapters.find((x) => x.id === 'claude');
  const msgs = w.CTX.scrape(a);
  assert.strictEqual(msgs.length, 1);
  const text = msgs[0].text;
  // Should NOT start with lone "js" before the code block
  assert.ok(!/^js\s*```/m.test(text), 'Lone language header leaked: ' + text);
  assert.ok(text.includes('```js\nconst x = 1;\nconst y = 2;\n```'), text);
});

test('compress: footer has updated instruction for next message acknowledgment', () => {
  const w = load();
  const chat = { siteName: 'Claude', title: 'Test', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] };
  const r = w.CTX.buildHandoff(chat, { budget: 2000 });
  assert.ok(
    r.text.includes('Acknowledge briefly, then wait for my next message. If my last message was a request, continue from there.'),
    'Missing updated footer'
  );
});

// ---------- redaction ----------
test('redact: removes keys but leaves normal code alone', () => {
  const w = load();
  const r = w.CTX.redact;
  assert.ok(!r('key sk-abcdefghijklmnopqrstuvwxyz123456').includes('abcdefghij'));
  assert.ok(!r('AIzaSyA1234567890abcdefghijklmnopqrstuv').includes('A1234567890'));
  assert.ok(!r('api_key = "abc123def456ghi789"').includes('abc123def456'));
  assert.ok(!r('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123').includes('abcdefghijkl'));
  const code = 'password = os.environ["PASSWORD"]\ntoken = request.getToken()';
  assert.strictEqual(r(code), code);
});

// ---------- compression ----------
function fakeChat(turns) {
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', text: 'Question ' + i + ': how should I handle the retry logic for the payments service when the gateway times out?' });
    let a =
      "Sure, I'd be happy to help with that. For turn " + i + ' you should use exponential backoff because it avoids hammering the gateway. ' +
      'Also decide on a maximum retry count. Finally log every failure so support can trace the payment. ' +
      'Remember that idempotency keys are required whenever a request is retried after a timeout.';
    if (i === 10) a += '\n```js\nfunction add(a, b) {\n  return a + b;\n  // version one\n}\n```';
    if (i === 30) a += '\n```js\nfunction add(a, b) {\n  return a + b;\n  // version two\n}\n```';
    msgs.push({ role: 'assistant', text: a });
  }
  msgs.push({ role: 'user', text: 'FINAL QUESTION: what is left to do?' });
  msgs.push({ role: 'assistant', text: 'FINAL ANSWER: write the tests.' });
  return { siteName: 'ChatGPT', title: 'Payments retries', messages: msgs };
}

test('compress: stays within the token budget for every size', () => {
  const w = load();
  const chat = fakeChat(80);
  for (const budget of [1000, 2000, 5000, 10000]) {
    const r = w.CTX.buildHandoff(chat, { budget });
    assert.ok(r.tokens <= budget, 'budget ' + budget + ' got ' + r.tokens);
    assert.ok(!r.overBudget);
  }
});

test('compress: always keeps the most recent messages verbatim', () => {
  const w = load();
  const r = w.CTX.buildHandoff(fakeChat(80), { budget: 1000 });
  assert.ok(r.text.includes('FINAL QUESTION: what is left to do?'));
  assert.ok(r.text.includes('FINAL ANSWER: write the tests.'));
});

test('compress: keeps only the latest version of a code block from older messages', () => {
  const w = load();
  const r = w.CTX.buildHandoff(fakeChat(80), { budget: 5000 });
  assert.ok(r.text.includes('// version two'), 'latest code missing');
  assert.ok(!r.text.includes('// version one'), 'old code version kept');
});

test('compress: strips filler openers and is much smaller than the original', () => {
  const w = load();
  const chat = fakeChat(80);
  const original = chat.messages.reduce((a, m) => a + m.text.length, 0);
  const r = w.CTX.buildHandoff(chat, { budget: 2000 });
  assert.ok(!/Assistant: Sure/.test(r.text), 'filler opener kept');
  // 2000 tokens is about 8000 characters, so a 33k-character chat should shrink roughly 4x or more
  assert.ok(r.text.length < original / 4, 'not compressed enough: ' + r.text.length + ' vs ' + original);
  assert.ok(r.omitted > 0);
});

test('compress: user notes appear near the top and are clipped when huge', () => {
  const w = load();
  const r = w.CTX.buildHandoff(fakeChat(5), { budget: 2000, notes: 'GOAL: ship the retry fix' });
  assert.ok(r.text.indexOf('GOAL: ship the retry fix') < r.text.indexOf('Most recent messages'));
  const big = w.CTX.buildHandoff(fakeChat(5), { budget: 1000, notes: 'x '.repeat(20000) });
  assert.ok(big.tokens <= 1000, 'huge notes broke the budget: ' + big.tokens);
});

test('compress: handles an empty chat and a one-message chat', () => {
  const w = load();
  assert.ok(w.CTX.buildHandoff({ siteName: 'ChatGPT', messages: [] }, { budget: 2000 }).text.includes('no messages saved yet'));
  const one = w.CTX.buildHandoff({ siteName: 'ChatGPT', messages: [{ role: 'user', text: 'hi' }] }, { budget: 2000 });
  assert.ok(one.text.includes('**Me:**\nhi'));
});

// ---------- On-demand Capture ('ctx:capture') tests ----------
function loadWithObserver(html, url, initialSettings, initialStorage) {
  const dom = new JSDOM(html || '<body></body>', {
    url: url || 'https://chatgpt.com/c/abc-123',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const storage = {};
  if (initialSettings) storage.settings = initialSettings;
  if (initialStorage) Object.assign(storage, initialStorage);
  const listeners = [];
  const storageListeners = [];
  const sentMessages = [];
  w.chrome = {
    storage: {
      local: {
        get: async (k) => {
          if (k === null) return { ...storage };
          if (typeof k === 'string') return { [k]: storage[k] };
          if (Array.isArray(k)) {
            const out = {};
            for (const key of k) out[key] = storage[key];
            return out;
          }
          return {};
        },
        set: async (obj) => {
          Object.assign(storage, obj);
          for (const fn of storageListeners) {
            const changes = {};
            for (const key of Object.keys(obj)) {
              changes[key] = { newValue: obj[key] };
            }
            fn(changes, 'local');
          }
        },
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn),
      },
      sendMessage: (msg) => {
        sentMessages.push(msg);
      },
    },
  };
  for (const f of ['src/redact.js', 'src/extract.js', 'src/adapters.js', 'src/compress.js']) {
    w.eval(src(f));
  }
  w.CTX.DEBOUNCE_MS = 20; // fast debounce for tests
  w.CTX.STREAM_CHECK_MS = 10; // fast stream check for tests
  w.CTX.QUIET_IDLE_MS = 10;
  w.CTX.QUIET_MAX_MS = 40;
  w.CTX.GRACE_CHECK_MS = 15;
  w.eval(src('src/observer.js'));

  const dispatch = (msg) =>
    new Promise((resolve) => {
      let handled = false;
      for (const fn of listeners) {
        const res = fn(msg, {}, (response) => {
          handled = true;
          resolve(response);
        });
        if (res === true) return;
      }
      if (!handled) resolve(undefined);
    });
  return { w, storage, listeners, storageListeners, sentMessages, dispatch };
}

test('capture: ctx:capture refuses when streaming is active', async () => {
  const html = CHATGPT_REAL_HTML.replace('</body>', '<button data-testid="stop-button">Stop</button></body>');
  const env = loadWithObserver(html, 'https://chatgpt.com/c/abc-123');
  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('streaming'), 'Expected streaming error but got: ' + res.error);
});

test('capture: site-independent double-scrape detects ongoing streaming when DOM changes', async () => {
  const env = loadWithObserver(KIMI_REAL_HTML, 'https://www.kimi.ai/chat/cquu0k4v5i7s');
  // Mutate DOM halfway through STREAM_CHECK_MS (which is 20ms in tests)
  setTimeout(() => {
    const code = env.w.document.querySelector('code');
    if (code) code.textContent += '\nprint("streaming line 3")';
  }, 10);
  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('streaming'), 'Expected streaming error but got: ' + res.error);
});

test('capture: site-independent double-scrape succeeds when DOM is stable', async () => {
  const env = loadWithObserver(KIMI_REAL_HTML, 'https://www.kimi.ai/chat/cquu0k4v5i7s');
  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);
  assert.ok(env.storage['chat:kimi:cquu0k4v5i7s']);
  assert.strictEqual(env.storage['chat:kimi:cquu0k4v5i7s'].messages.length, 2);
});

test('capture: ctx:capture reports diagnostics when no messages found', async () => {
  const env = loadWithObserver('<body><div>nothing here</div></body>', 'https://chatgpt.com/c/abc-123');
  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'No messages found');
  assert.strictEqual(res.matched.user, 0);
  assert.strictEqual(res.matched.assistant, 0);
});

test('capture: ctx:capture scrapes immediately and skips scrolling for short chat at top', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123');
  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);
  assert.strictEqual(res.skippedScroll, true);
  assert.ok(env.storage['chat:chatgpt:abc-123']);
  assert.strictEqual(env.storage['chat:chatgpt:abc-123'].messages.length, 2);
  const readingProgress = env.sentMessages.find((m) => m.type === 'ctx:captureProgress' && m.phase === 'reading');
  assert.ok(readingProgress, 'Expected reading progress message');
  assert.strictEqual(readingProgress.count, 2);
});

test('capture: ctx:cancelCapture stops capture and keeps captured messages', async () => {
  const env = loadWithObserver(CLAUDE_REAL_HTML, 'https://claude.ai/chat/c-123');
  const cancelRes = await env.dispatch({ type: 'ctx:cancelCapture' });
  assert.strictEqual(cancelRes.ok, true);
});

test('capture: ctx:capture auto-scrolls and restores initial scroll position when scrolled down', async () => {
  const env = loadWithObserver(CLAUDE_REAL_HTML, 'https://claude.ai/chat/c-123');
  const feed = env.w.document.querySelector('[role="feed"][data-perf-region="transcript"]');
  feed.scrollTop = 400;
  feed.scrollHeight = 1000;
  feed.clientHeight = 300;

  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(feed.scrollTop, 400);
  const loadingProgress = env.sentMessages.find((m) => m.type === 'ctx:captureProgress' && m.phase === 'loading');
  assert.ok(loadingProgress, 'Expected loading progress message during scroll');
});

test('capture: fake lazy-loading scroller captures 100 messages across delayed loads and restores scroll', async () => {
  function makeTurnHtml(i) {
    return `<article data-testid="conversation-turn-${i}">
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">Turn ${i} user</div></div>
      <div data-message-author-role="assistant"><div class="markdown"><p>Turn ${i} assistant</p></div></div>
    </article>`;
  }

  let oldestTurn = 41;
  const initialTurns = [];
  for (let i = 41; i <= 50; i++) {
    initialTurns.push(makeTurnHtml(i));
  }
  const html = `<body>
    <div id="lazy-scroller" style="overflow-y: auto; height: 300px;">
      <div id="turns-container">
        ${initialTurns.join('\n')}
      </div>
    </div>
  </body>`;

  const env = loadWithObserver(html, 'https://chatgpt.com/c/test-lazy-100');
  const scroller = env.w.document.getElementById('lazy-scroller');
  const turnsContainer = env.w.document.getElementById('turns-container');

  let currentY = 500;
  let currentSH = 1000;
  const ch = 300;
  let loading = false;

  Object.defineProperty(scroller, 'scrollHeight', {
    get: () => currentSH,
    configurable: true,
  });
  Object.defineProperty(scroller, 'clientHeight', {
    get: () => ch,
    configurable: true,
  });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => currentY,
    set: (v) => {
      currentY = Math.max(0, v);
      if (currentY <= 2 && oldestTurn > 1 && !loading) {
        loading = true;
        // Delay 25ms before prepending 10 turns (20 messages)
        setTimeout(() => {
          const nextOldest = Math.max(1, oldestTurn - 10);
          const newTurns = [];
          for (let i = nextOldest; i < oldestTurn; i++) {
            newTurns.push(makeTurnHtml(i));
          }
          oldestTurn = nextOldest;
          const temp = env.w.document.createElement('div');
          temp.innerHTML = newTurns.join('\n');
          while (temp.lastChild) {
            turnsContainer.insertBefore(temp.lastChild, turnsContainer.firstChild);
          }
          currentSH += 300;
          loading = false;
        }, 25);
      }
    },
    configurable: true,
  });

  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 100, 'Expected all 100 messages to be captured');
  assert.strictEqual(res.reachedStart, true);
  assert.strictEqual(scroller.scrollTop, 500, 'Original scroll position was not restored');

  const saved = env.storage['chat:chatgpt:test-lazy-100'];
  assert.ok(saved);
  assert.strictEqual(saved.messages.length, 100);
  assert.strictEqual(saved.messages[0].text, 'Turn 1 user');
  assert.strictEqual(saved.messages[1].text, 'Turn 1 assistant');
  assert.strictEqual(saved.messages[98].text, 'Turn 50 user');
  assert.strictEqual(saved.messages[99].text, 'Turn 50 assistant');
});

// ---------- Autosave opt-in and precedence tests ----------
test('autosave: precedence order (per-chat override > per-site > default)', () => {
  const w = load();
  const fn = w.CTX.shouldAutosave;

  // Default fallback when neither site nor chat is set
  assert.strictEqual(fn({ default: false }, 'chatgpt:123', 'chatgpt'), false);
  assert.strictEqual(fn({ default: true }, 'chatgpt:123', 'chatgpt'), true);
  assert.strictEqual(fn(null, 'chatgpt:123', 'chatgpt'), false);

  // Per-site overrides default
  assert.strictEqual(fn({ default: false, sites: { chatgpt: true } }, 'chatgpt:123', 'chatgpt'), true);
  assert.strictEqual(fn({ default: true, sites: { chatgpt: false } }, 'chatgpt:123', 'chatgpt'), false);
  assert.strictEqual(fn({ default: true, sites: { claude: false } }, 'chatgpt:123', 'chatgpt'), true);

  // Per-chat override wins over per-site and default
  assert.strictEqual(fn({ default: false, sites: { chatgpt: false }, chats: { 'chatgpt:123': true } }, 'chatgpt:123', 'chatgpt'), true);
  assert.strictEqual(fn({ default: true, sites: { chatgpt: true }, chats: { 'chatgpt:123': false } }, 'chatgpt:123', 'chatgpt'), false);
  assert.strictEqual(fn({ default: true, sites: { chatgpt: false }, chats: { 'chatgpt:123': true } }, 'chatgpt:123', 'chatgpt'), true);
  assert.strictEqual(fn({ default: false, sites: { chatgpt: true }, chats: { 'chatgpt:123': false } }, 'chatgpt:123', 'chatgpt'), false);
});

test('autosave: with autosave off, DOM mutations never trigger a storage write', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123', {
    autosave: { default: false, sites: { chatgpt: false }, chats: {} },
  });

  // Mutate DOM
  const div = env.w.document.createElement('div');
  div.textContent = 'new turn';
  env.w.document.body.appendChild(div);

  // Wait long enough for any debounce timer (> 30ms)
  await new Promise((r) => setTimeout(r, 80));

  // Verify no chat was written to storage
  assert.strictEqual(env.storage['chat:chatgpt:abc-123'], undefined);
});

test('autosave: with a per-chat override on, DOM mutations trigger a storage write', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123', {
    autosave: { default: false, sites: { chatgpt: false }, chats: { 'chatgpt:abc-123': true } },
  });

  // Mutate DOM
  const div = env.w.document.createElement('div');
  div.textContent = 'new turn';
  env.w.document.body.appendChild(div);

  // Wait for debounce timer (> 30ms)
  await new Promise((r) => setTimeout(r, 80));

  // Verify chat was auto-saved to storage
  assert.ok(env.storage['chat:chatgpt:abc-123'], 'Chat was not auto-saved despite per-chat override being on');
  assert.strictEqual(env.storage['chat:chatgpt:abc-123'].messages.length, 2);
});

test('autosave: reacting live to storage changes starts and stops observation without reload', async () => {
  // Start with autosave off
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123', {
    autosave: { default: false, sites: {}, chats: {} },
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.storage['chat:chatgpt:abc-123'], undefined);

  // Enable autosave for this chat live via storage set (triggers onChanged)
  await env.w.chrome.storage.local.set({
    settings: {
      autosave: { default: false, sites: {}, chats: { 'chatgpt:abc-123': true } },
    },
  });

  // Mutate DOM
  const div = env.w.document.createElement('div');
  div.textContent = 'new message';
  env.w.document.body.appendChild(div);

  await new Promise((r) => setTimeout(r, 80));
  assert.ok(env.storage['chat:chatgpt:abc-123'], 'Chat was not saved after live enable');

  // Disable autosave live
  await env.w.chrome.storage.local.set({
    settings: {
      autosave: { default: false, sites: {}, chats: { 'chatgpt:abc-123': false } },
    },
  });

  // Delete stored chat to verify subsequent mutations don't re-save it
  delete env.storage['chat:chatgpt:abc-123'];

  // Mutate DOM again
  const p = env.w.document.createElement('p');
  p.textContent = 'another message';
  env.w.document.body.appendChild(p);

  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(env.storage['chat:chatgpt:abc-123'], undefined, 'Chat was saved after live disable');
});

// ---------- Manager tests: import validation, merge-by-key, older-than-N deletion, titleEdited ----------
test('manager: import validation rejects wrong shapes and oversized files', () => {
  const w = load();
  const { validateBackup } = w.CTX.manager;

  // 1. Oversized file (> 25MB)
  const overRes = validateBackup('{"chats":[]}', 26 * 1024 * 1024);
  assert.strictEqual(overRes.valid, false);
  assert.ok(overRes.error.includes('too large'), overRes.error);

  // 2. Malformed JSON
  const malformed = validateBackup('{not valid json', 50);
  assert.strictEqual(malformed.valid, false);
  assert.ok(malformed.error.includes('Invalid JSON'), malformed.error);

  // 3. Non-object / non-array root
  const nonObj = validateBackup('12345', 10);
  assert.strictEqual(nonObj.valid, false);

  // 4. Empty chats list
  const emptyRes = validateBackup(JSON.stringify({ chats: [] }), 20);
  assert.strictEqual(emptyRes.valid, false);
  assert.ok(emptyRes.error.includes('no chat records'), emptyRes.error);

  // 5. Chat item missing key or with invalid key
  const noKey = validateBackup(JSON.stringify([{ title: 'Chat', messages: [{ role: 'user', text: 'hi' }] }]));
  assert.strictEqual(noKey.valid, false);

  // 6. Chat item with invalid/empty messages array
  const badMsgs = validateBackup(JSON.stringify([{ key: 'chatgpt:1', messages: 'not an array' }]));
  assert.strictEqual(badMsgs.valid, false);

  // 7. Valid array format
  const validArray = validateBackup(
    JSON.stringify([
      { key: 'chatgpt:123', title: 'Test 1', messages: [{ role: 'user', text: 'Hello' }] },
    ])
  );
  assert.strictEqual(validArray.valid, true);
  assert.strictEqual(validArray.chats.length, 1);
  assert.strictEqual(validArray.chats[0].key, 'chatgpt:123');

  // 8. Valid object format with chats array
  const validObj = validateBackup(
    JSON.stringify({
      version: 1,
      chats: [
        { key: 'claude:456', title: 'Claude Chat', messages: [{ role: 'assistant', text: 'Hi there' }] },
      ],
    })
  );
  assert.strictEqual(validObj.valid, true);
  assert.strictEqual(validObj.chats.length, 1);
  assert.strictEqual(validObj.chats[0].site, 'claude');
});

test('manager: merge-by-key handles new chats and conflict overwrite/skip choices', async () => {
  const w = load();
  const { mergeBackup } = w.CTX.manager;

  const existingStorage = {
    'chat:chatgpt:1': {
      key: 'chatgpt:1',
      site: 'chatgpt',
      title: 'Original Title',
      messages: [{ role: 'user', text: 'original text' }],
    },
  };

  const imported = [
    {
      key: 'chatgpt:1',
      site: 'chatgpt',
      title: 'Overwritten Title',
      messages: [{ role: 'user', text: 'updated text' }],
    },
    {
      key: 'gemini:2',
      site: 'gemini',
      title: 'New Gemini Chat',
      messages: [{ role: 'user', text: 'gemini text' }],
    },
  ];

  // Case A: User chooses to skip conflicting chat
  const skipResult = await mergeBackup(existingStorage, imported, async (imp, ex) => {
    assert.strictEqual(imp.key, 'chatgpt:1');
    assert.strictEqual(ex.title, 'Original Title');
    return 'skip';
  });

  assert.strictEqual(skipResult.added.length, 1);
  assert.strictEqual(skipResult.added[0], 'gemini:2');
  assert.strictEqual(skipResult.skipped.length, 1);
  assert.strictEqual(skipResult.skipped[0], 'chatgpt:1');
  assert.strictEqual(skipResult.updated.length, 0);
  assert.strictEqual(skipResult.toSet['chat:chatgpt:1'], undefined);
  assert.ok(skipResult.toSet['chat:gemini:2']);

  // Case B: User chooses to overwrite conflicting chat
  const overwriteResult = await mergeBackup(existingStorage, imported, async () => 'overwrite');
  assert.strictEqual(overwriteResult.added.length, 1);
  assert.strictEqual(overwriteResult.updated.length, 1);
  assert.strictEqual(overwriteResult.updated[0], 'chatgpt:1');
  assert.strictEqual(overwriteResult.skipped.length, 0);
  assert.strictEqual(overwriteResult.toSet['chat:chatgpt:1'].title, 'Overwritten Title');
});

test('manager: older-than-N-days finds only chats updated before cutoff timestamp', () => {
  const w = load();
  const { findOlderThanDays } = w.CTX.manager;

  const now = 1700000000000;
  const dayMs = 24 * 60 * 60 * 1000;

  const chats = [
    { key: 'c1', updatedAt: now - 5 * dayMs },  // 5 days ago
    { key: 'c2', updatedAt: now - 35 * dayMs }, // 35 days ago
    { key: 'c3', updatedAt: now - 90 * dayMs }, // 90 days ago
  ];

  // Older than 30 days -> c2 and c3
  const older30 = findOlderThanDays(chats, 30, now);
  assert.deepStrictEqual(older30.map((c) => c.key), ['c2', 'c3']);

  // Older than 60 days -> only c3
  const older60 = findOlderThanDays(chats, 60, now);
  assert.deepStrictEqual(older60.map((c) => c.key), ['c3']);

  // Older than 100 days -> none
  const older100 = findOlderThanDays(chats, 100, now);
  assert.strictEqual(older100.length, 0);

  // Invalid days (0 or negative)
  assert.strictEqual(findOlderThanDays(chats, 0, now).length, 0);
});

test('observer: respects titleEdited=true and never overwrites an edited title', async () => {
  const customTitle = 'My Custom Chat Title';
  const env = loadWithObserver(
    CHATGPT_HTML,
    'https://chatgpt.com/c/abc-123',
    { autosave: { default: true } },
    {
      'chat:chatgpt:abc-123': {
        key: 'chatgpt:abc-123',
        site: 'chatgpt',
        siteName: 'ChatGPT',
        title: customTitle,
        titleEdited: true,
        updatedAt: 1000,
        messages: [{ role: 'user', text: 'old message' }],
      },
    }
  );

  // Mutate DOM to trigger observer save
  const div = env.w.document.createElement('div');
  div.textContent = 'new message';
  env.w.document.body.appendChild(div);

  await new Promise((r) => setTimeout(r, 80));

  const saved = env.storage['chat:chatgpt:abc-123'];
  assert.ok(saved, 'Chat was not saved');
  assert.strictEqual(saved.title, customTitle, 'Observer overwrote an edited title!');
  assert.strictEqual(saved.titleEdited, true);
});

test('manager: selecting a chat hides no-selection state and deleting advances viewing position', async () => {
  const html = src('manager/manager.html');
  const dom = new JSDOM(html, { url: 'chrome-extension://id/manager/manager.html', runScripts: 'outside-only' });
  const w = dom.window;

  const storage = {
    'chat:chatgpt:c1': {
      key: 'chatgpt:c1',
      site: 'chatgpt',
      siteName: 'ChatGPT',
      title: 'Chat 1',
      updatedAt: 2000,
      messages: [{ role: 'user', text: 'hi 1' }],
    },
    'chat:chatgpt:c2': {
      key: 'chatgpt:c2',
      site: 'chatgpt',
      siteName: 'ChatGPT',
      title: 'Chat 2',
      updatedAt: 1000,
      messages: [{ role: 'user', text: 'hi 2' }],
    },
  };

  w.confirm = () => true;
  w.alert = () => {};

  w.chrome = {
    storage: {
      local: {
        get: async (k) => {
          if (k === null) return { ...storage };
          if (typeof k === 'string') return { [k]: storage[k] };
          if (Array.isArray(k)) {
            const out = {};
            for (const key of k) out[key] = storage[key];
            return out;
          }
          return {};
        },
        set: async (obj) => Object.assign(storage, obj),
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete storage[k];
        },
        getBytesInUse: (keys, cb) => cb(1024),
      },
      onChanged: { addListener: () => {} },
    },
  };

  for (const f of ['src/adapters.js', 'src/compress.js', 'manager/manager.js']) {
    w.eval(src(f));
  }

  // Wait for initial load
  await new Promise((r) => setTimeout(r, 40));

  const noSelection = w.document.getElementById('noSelectionState');
  const detail = w.document.getElementById('selectedChatDetail');
  const detailTitle = w.document.getElementById('detailTitle');

  // 1. First chat should be selected, empty state hidden, detail view visible
  assert.strictEqual(noSelection.hidden, true);
  assert.strictEqual(detail.hidden, false);
  assert.strictEqual(detailTitle.textContent, 'Chat 1');

  // 2. Delete Chat 1 -> viewing position should advance to Chat 2
  const deleteBtn = w.document.getElementById('deleteChatBtn');
  deleteBtn.click();
  await new Promise((r) => setTimeout(r, 40));

  assert.strictEqual(noSelection.hidden, true);
  assert.strictEqual(detail.hidden, false);
  assert.strictEqual(detailTitle.textContent, 'Chat 2');

  // 3. Delete Chat 2 (last remaining chat) -> viewing position switches to empty state
  deleteBtn.click();
  await new Promise((r) => setTimeout(r, 40));

  assert.strictEqual(noSelection.hidden, false);
  assert.strictEqual(detail.hidden, true);
  assert.strictEqual(noSelection.querySelector('h2').textContent, 'No Saved Chats');
});

// ---------- ISSUE 1: Tab Overlap & Panel Visibility ----------
test('manager: activating each tab toggles exactly one visible tabpanel', async () => {
  const html = src('manager/manager.html');
  const dom = new JSDOM(html, { url: 'chrome-extension://id/manager/manager.html', runScripts: 'outside-only' });
  const w = dom.window;

  const storage = {
    'chat:chatgpt:c1': {
      key: 'chatgpt:c1',
      site: 'chatgpt',
      siteName: 'ChatGPT',
      title: 'Chat 1',
      updatedAt: 2000,
      messages: [{ role: 'user', text: 'hi 1' }, { role: 'assistant', text: 'ack 1' }],
    },
  };

  w.chrome = {
    storage: {
      local: {
        get: async (k) => {
          if (k === null) return { ...storage };
          if (typeof k === 'string') return { [k]: storage[k] };
          return {};
        },
        set: async (obj) => Object.assign(storage, obj),
        remove: async () => {},
        getBytesInUse: (keys, cb) => cb(1024),
      },
      onChanged: { addListener: () => {} },
    },
  };

  for (const f of ['src/adapters.js', 'src/compress.js', 'manager/manager.js']) {
    w.eval(src(f));
  }

  await new Promise((r) => setTimeout(r, 40));

  const convTab = w.document.getElementById('tabConversation');
  const handoffTab = w.document.getElementById('tabHandoff');
  const convBtn = w.document.getElementById('tabConvBtn');
  const handoffBtn = w.document.getElementById('tabHandoffBtn');
  const allPanels = Array.from(w.document.querySelectorAll('[role="tabpanel"]'));

  assert.strictEqual(allPanels.length, 2, 'Expected 2 tabpanels');

  // Activate Conversation tab
  convBtn.click();
  let visiblePanels = allPanels.filter((p) => !p.hidden);
  assert.strictEqual(visiblePanels.length, 1, 'Expected exactly one panel not hidden');
  assert.strictEqual(visiblePanels[0], convTab);
  assert.strictEqual(convBtn.getAttribute('aria-selected'), 'true');
  assert.strictEqual(handoffBtn.getAttribute('aria-selected'), 'false');

  // Activate Handoff tab
  handoffBtn.click();
  visiblePanels = allPanels.filter((p) => !p.hidden);
  assert.strictEqual(visiblePanels.length, 1, 'Expected exactly one panel not hidden');
  assert.strictEqual(visiblePanels[0], handoffTab);
  assert.strictEqual(convBtn.getAttribute('aria-selected'), 'false');
  assert.strictEqual(handoffBtn.getAttribute('aria-selected'), 'true');

  // Toggle back to Conversation tab
  convBtn.click();
  visiblePanels = allPanels.filter((p) => !p.hidden);
  assert.strictEqual(visiblePanels.length, 1, 'Expected exactly one panel not hidden after toggling back');
  assert.strictEqual(visiblePanels[0], convTab);
});

// ---------- ISSUE 2: Real-time Auto-save & Route Changes ----------
test('autosave: with a per-chat override on, appending a message to the DOM leads to storage write within debounce', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123', {
    autosave: { default: false, sites: { chatgpt: false }, chats: { 'chatgpt:abc-123': true } },
  });

  // Mutate DOM by appending another turn
  const article = env.w.document.createElement('article');
  article.setAttribute('data-testid', 'conversation-turn-3');
  article.innerHTML = '<div data-message-author-role="user"><div class="whitespace-pre-wrap">Next question</div></div>';
  env.w.document.querySelector('main').appendChild(article);

  // Wait for debounce timer (DEBOUNCE_MS = 20)
  await new Promise((r) => setTimeout(r, 60));

  const saved = env.storage['chat:chatgpt:abc-123'];
  assert.ok(saved, 'Chat was not saved');
  assert.strictEqual(saved.messages.length, 3, 'Expected 3 messages saved');
  assert.strictEqual(saved.messages[2].text, 'Next question');
});

test('autosave: after simulated route change to another chat, new messages save under the new key', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/chat-alpha', {
    autosave: { default: true },
  });

  // Initial save for chat-alpha
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(env.storage['chat:chatgpt:chat-alpha']);

  // Simulate SPA route change to chat-beta
  env.w.history.pushState({}, '', 'https://chatgpt.com/c/chat-beta');

  // Add new turns for chat-beta
  const main = env.w.document.querySelector('main');
  main.innerHTML = `
    <article data-testid="conversation-turn-1">
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">Question on beta</div></div>
    </article>
    <article data-testid="conversation-turn-2">
      <div data-message-author-role="assistant"><div class="markdown"><p>Answer on beta</p></div></div>
    </article>
  `;

  // Trigger mutation
  const dummy = env.w.document.createElement('div');
  env.w.document.body.appendChild(dummy);

  await new Promise((r) => setTimeout(r, 80));

  assert.ok(env.storage['chat:chatgpt:chat-beta'], 'New chat was not saved under the new key');
  assert.strictEqual(env.storage['chat:chatgpt:chat-beta'].key, 'chatgpt:chat-beta');
  assert.strictEqual(env.storage['chat:chatgpt:chat-beta'].messages.length, 2);
  assert.strictEqual(env.storage['chat:chatgpt:chat-beta'].messages[0].text, 'Question on beta');
});

test('autosave: continuous stream of mutations produces a write by max-wait', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/stream-test', {
    autosave: { default: true },
  });
  env.w.CTX.DEBOUNCE_MS = 100; // longer debounce
  env.w.CTX.MAX_WAIT_MS = 150; // max wait cap

  const main = env.w.document.querySelector('main');
  const startTime = Date.now();
  let writtenAt = null;

  // Stream mutations rapidly (every 25ms, which is < DEBOUNCE_MS 100ms)
  const interval = setInterval(() => {
    const p = env.w.document.createElement('p');
    p.textContent = 'token';
    main.appendChild(p);

    if (env.storage['chat:chatgpt:stream-test'] && !writtenAt) {
      writtenAt = Date.now();
    }
  }, 25);

  // Wait 260ms (> MAX_WAIT_MS 150ms)
  await new Promise((r) => setTimeout(r, 260));
  clearInterval(interval);

  assert.ok(env.storage['chat:chatgpt:stream-test'], 'Storage write was never executed during streaming mutations');
  assert.ok(writtenAt - startTime <= 230, `Expected write by max wait (~150ms), got ${writtenAt - startTime}ms`);
});

test('autosave: saved count never decreases even if rendered DOM window has fewer messages', async () => {
  const existingMsgs = [];
  for (let i = 1; i <= 30; i++) {
    existingMsgs.push({ role: 'user', text: `Message ${i}` });
  }

  const env = loadWithObserver(
    CHATGPT_HTML,
    'https://chatgpt.com/c/abc-123',
    { autosave: { default: true } },
    {
      'chat:chatgpt:abc-123': {
        key: 'chatgpt:abc-123',
        site: 'chatgpt',
        siteName: 'ChatGPT',
        title: 'Long Chat',
        updatedAt: 1000,
        messages: existingMsgs,
      },
    }
  );

  // Trigger mutation with DOM that only has 2 messages (virtualized tail)
  const div = env.w.document.createElement('div');
  env.w.document.body.appendChild(div);

  await new Promise((r) => setTimeout(r, 60));

  const saved = env.storage['chat:chatgpt:abc-123'];
  assert.ok(saved);
  assert.ok(saved.messages.length >= 30, `Saved count decreased from 30 to ${saved.messages.length}`);
});

// ---------- ISSUE 3: Capture Counts, Matching Normalization & Duplicates ----------
test('capture: save 30 then capture same 30 reports total 30 and 0 new', async () => {
  const turns = [];
  for (let i = 1; i <= 15; i++) {
    turns.push(`
      <article data-testid="conversation-turn-${i * 2 - 1}">
        <div data-message-author-role="user"><div class="whitespace-pre-wrap">User message ${i}</div></div>
      </article>
      <article data-testid="conversation-turn-${i * 2}">
        <div data-message-author-role="assistant"><div class="markdown"><p>Assistant message ${i}</p></div></div>
      </article>
    `);
  }
  const html = `<body><main>${turns.join('\n')}</main></body>`;
  const env = loadWithObserver(html, 'https://chatgpt.com/c/chat-30');

  // First capture: saves 30 messages
  const res1 = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res1.ok, true);
  assert.strictEqual(res1.count, 30);
  assert.strictEqual(res1.added, 30);

  // Second capture with no changes: total is 30, 0 new
  const res2 = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.count, 30, 'Total should be 30');
  assert.strictEqual(res2.added, 0, 'Added should be 0');
  assert.ok(res2.summary.includes('Captured 30 messages (0 new)'), `Unexpected summary: ${res2.summary}`);
  assert.strictEqual(env.storage['chat:chatgpt:chat-30'].messages.length, 30);
});

test('capture: saved 30 and page has 50 reports total 50 and 20 new', async () => {
  const turns30 = [];
  const msgs30 = [];
  for (let i = 1; i <= 15; i++) {
    turns30.push(`
      <article data-testid="conversation-turn-${i * 2 - 1}">
        <div data-message-author-role="user"><div class="whitespace-pre-wrap">User message ${i}</div></div>
      </article>
      <article data-testid="conversation-turn-${i * 2}">
        <div data-message-author-role="assistant"><div class="markdown"><p>Assistant message ${i}</p></div></div>
      </article>
    `);
    msgs30.push({ role: 'user', text: `User message ${i}` });
    msgs30.push({ role: 'assistant', text: `Assistant message ${i}` });
  }

  // Add 10 more turns (20 messages) at the end
  const turns50 = [...turns30];
  for (let i = 16; i <= 25; i++) {
    turns50.push(`
      <article data-testid="conversation-turn-${i * 2 - 1}">
        <div data-message-author-role="user"><div class="whitespace-pre-wrap">User message ${i}</div></div>
      </article>
      <article data-testid="conversation-turn-${i * 2}">
        <div data-message-author-role="assistant"><div class="markdown"><p>Assistant message ${i}</p></div></div>
      </article>
    `);
  }

  const html = `<body><main>${turns50.join('\n')}</main></body>`;
  const env = loadWithObserver(
    html,
    'https://chatgpt.com/c/chat-50',
    null,
    {
      'chat:chatgpt:chat-50': {
        key: 'chatgpt:chat-50',
        site: 'chatgpt',
        siteName: 'ChatGPT',
        title: 'Chat 50',
        updatedAt: 1000,
        messages: msgs30,
      },
    }
  );

  const res = await env.dispatch({ type: 'ctx:capture' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 50, 'Total should be 50');
  assert.strictEqual(res.added, 20, 'Added should be 20 new');
  assert.ok(res.summary.includes('Captured 50 messages (20 new)'), `Unexpected summary: ${res.summary}`);
  assert.strictEqual(env.storage['chat:chatgpt:chat-50'].messages.length, 50);
});

test('capture: saved 30 and capture loads 20 older messages gives total 50 and correct order', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });

  // Stored has messages 21..50 (30 messages)
  const prev = [];
  for (let i = 21; i <= 50; i++) {
    prev.push(m(i % 2 === 1 ? 'user' : 'assistant', `Msg ${i}`));
  }

  // Scraped head window has messages 1..30 (overlap on 21..30)
  const fresh = [];
  for (let i = 1; i <= 30; i++) {
    fresh.push(m(i % 2 === 1 ? 'user' : 'assistant', `Msg ${i}`));
  }

  const merged = w.CTX.merge(prev, fresh);
  assert.strictEqual(merged.length, 50, `Expected 50 messages, got ${merged.length}`);
  assert.strictEqual(merged[0].text, 'Msg 1');
  assert.strictEqual(merged[49].text, 'Msg 50');

  // Verify strict ordering 1..50
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(merged[i].text, `Msg ${i + 1}`);
  }
});

test('merge & capture: repeated "continue" messages gives no duplicates', () => {
  const w = load();
  const m = (r, t) => ({ role: r, text: t });

  const prev = [
    m('user', 'Please write chapter 1'),
    m('assistant', 'continue'),
    m('user', 'continue'),
    m('assistant', 'Chapter 1 text'),
    m('user', 'continue'),
    m('assistant', 'continue'),
    m('user', 'continue'),
    m('assistant', 'Chapter 2 text'),
  ];

  // Fresh window overlapping the last 4 messages
  const fresh = [
    m('user', 'continue'),
    m('assistant', 'continue'),
    m('user', 'continue'),
    m('assistant', 'Chapter 2 text'),
  ];

  const merged = w.CTX.merge(prev, fresh);
  assert.strictEqual(merged.length, 8, `Expected 8 messages, got ${merged.length}`);
  assert.deepStrictEqual(merged.map((x) => x.text), prev.map((x) => x.text));
});

test('capture & autosave: autosave then capture back to back gives no duplicates', async () => {
  const env = loadWithObserver(CHATGPT_HTML, 'https://chatgpt.com/c/abc-123', {
    autosave: { default: true },
  });

  // Mutate DOM to queue autosave
  const div = env.w.document.createElement('div');
  env.w.document.body.appendChild(div);

  // Trigger capture concurrently/back-to-back
  const capturePromise = env.dispatch({ type: 'ctx:capture' });

  const res = await capturePromise;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);

  const saved = env.storage['chat:chatgpt:abc-123'];
  assert.ok(saved);
  assert.strictEqual(saved.messages.length, 2, 'Duplicate messages created when autosave and capture ran back-to-back');
});

// ---------- ISSUE 4: Real Site Logos & Fallback ----------
test('site logos: map covers all four sites and maps to correct logo files', () => {
  const w = load();
  const { SITE_LOGOS } = w.CTX.manager;
  assert.ok(SITE_LOGOS, 'SITE_LOGOS not exported');
  assert.strictEqual(SITE_LOGOS.chatgpt, 'chatgpt-logo.webp');
  assert.strictEqual(SITE_LOGOS.claude, 'claude-logo.png');
  assert.strictEqual(SITE_LOGOS.gemini, 'gemini-logo.webp');
  assert.strictEqual(SITE_LOGOS.kimi, 'kimi-logo.webp');

  // Verify all files exist in extension/icons
  for (const [site, file] of Object.entries(SITE_LOGOS)) {
    const fullPath = path.join(__dirname, '..', 'extension', 'icons', file);
    assert.ok(fs.existsSync(fullPath), `Icon file missing for ${site}: ${file}`);
  }
});

test('site logos: unknown site falls back to text monogram', () => {
  const w = load();
  const { createSiteChip, getSiteMeta } = w.CTX.manager;

  // Unknown site
  const unknownMeta = getSiteMeta('unknown-site');
  assert.strictEqual(unknownMeta.logoFile, null);
  assert.strictEqual(unknownMeta.label, 'AI');

  const unknownChip = createSiteChip('unknown-site', 20);
  assert.ok(unknownChip);
  assert.ok(!unknownChip.classList.contains('logoChip'));
  assert.strictEqual(unknownChip.querySelector('.siteMonogram').textContent, 'AI');
  assert.strictEqual(unknownChip.querySelector('img'), null);

  // Known site
  const chatgptChip = createSiteChip('chatgpt', 20);
  assert.ok(chatgptChip);
  assert.ok(chatgptChip.classList.contains('logoChip'));
  const img = chatgptChip.querySelector('img');
  assert.ok(img);
  assert.strictEqual(img.getAttribute('src'), '../icons/chatgpt-logo.webp');

  // Simulate image load error -> fallback to monogram
  img.onerror();
  assert.ok(!chatgptChip.classList.contains('logoChip'));
  assert.strictEqual(chatgptChip.querySelector('.siteMonogram').textContent, 'CG');
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('  ok  ' + name);
    } catch (e) {
      console.error('FAIL  ' + name + '\n      ' + e.message);
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
  process.exit(process.exitCode || 0);
})();
