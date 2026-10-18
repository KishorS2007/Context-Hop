# AI Context Handoff - Project Context & Architecture

## Overview
**AI Context Handoff** is a privacy-first, zero-cost Google Chrome Extension (Manifest V3) designed to solve the conversational continuity problem across AI chat platforms (ChatGPT, Claude, Gemini, Kimi). When users encounter usage caps or rate limits on one account, this extension enables frictionless handoff to another account or model by compressing the conversation history into a paste-ready, token-budgeted prompt while redacting private credentials.

---

## Key Principles & Design Philosophy
1. **100% Local & Privacy-First**:
   - All chat extraction and storage happens strictly within `chrome.storage.local`.
   - Zero external telemetry, zero backend servers, and zero network calls.
2. **Pre-Storage Secret Redaction**:
   - Sensitive credentials (API keys, Private Keys, JWTs, AWS credentials, Bearer tokens, passwords) are scrubbed before messages reach browser storage.
3. **Zero-Cost Heuristic Compression**:
   - Compresses chats into selectable budgets (~2k, 5k, 10k, 20k tokens) using pure deterministic JavaScript (extractive summarization, code deduplication, verbatim recency preservation) without requiring an LLM API.
4. **Resilient DOM Virtualization Handling**:
   - Handles modern infinite-scrolling / virtualized DOMs by merging newly scraped DOM message windows with historically stored messages.

---

## Directory Structure
```
ai-context-handoff/
├── .gitignore               # Git exclusions (node_modules, zip bundles)
├── README.md                # Quickstart, usage instructions, known limitations
├── package.json             # Dev dependencies (jsdom) and test script
├── tests/
│   └── run.js               # Node.js test runner using JSDOM (89 unit/integration tests as of 2026-10-18)
└── extension/
    ├── manifest.json        # MV3 manifest with storage & host permissions, options_page
    ├── popup/
    │   ├── popup.html       # Extension popup structure
    │   ├── popup.css        # Minimalist responsive UI with system dark mode
    │   └── popup.js         # Popup logic, chat selection, live preview, export, clipboard
    ├── manager/
    │   ├── manager.html     # Options page: saved chats manager, list, conversation, handoff
    │   ├── manager.css      # Options page styles with dark mode & accessibility
    │   └── manager.js       # Options page UI controller, backup validation, merge, bulk actions
    └── src/
        ├── redact.js        # Content-level secret masking regexes
        ├── extract.js       # HTML-to-Markdown parser, DOM filter, merge logic
        ├── adapters.js      # Site-specific selectors & metadata handlers
        ├── observer.js      # MutationObserver, debounced autosave, storage sync
        └── compress.js      # Extractive compression algorithm & token budgeting
```

---

## Architectural Breakdown

### 1. Injected Content Pipeline (`extension/src/`)
Injected into target AI chat domains at `document_idle`:

| File | Responsibilities | Key Functions / Constants |
|---|---|---|
| `redact.js` | Sanitizes sensitive tokens, keys, and credentials | `CTX.redact(text)` |
| `extract.js` | Parses DOM to Markdown, strips UI noise, code block header exclusion, multi-window merge | `CTX.scrape()`, `CTX.merge()`, `CTX.diagnose()` |
| `adapters.js` | Defines platform selectors, ID extractors, and streaming checks | `CTX.adapters` (ChatGPT, Claude, Gemini, Kimi) |
| `observer.js` | Opt-in MutationObserver, live storage listener, debounced autosave, manual capture | `MutationObserver`, `hashOf()`, `capture()`, `save()`, `syncAutosaveState()` |

### 2. Compression & Handoff Pipeline (`extension/src/compress.js`)
When generating a handoff prompt, `CTX.buildHandoff(chat, opts)` enforces priority tiers:
1. **Instruction Header & User Notes**: Pinned at the top (notes allocated up to 35% of token budget).
2. **Most Recent Messages (Verbatim)**: Allocates up to 50% of available space to the final messages (minimum 2 messages retained word-for-word).
3. **Latest Code Blocks**: Scans all earlier messages; deduplicates code blocks by comparing language and the first 2 lines. Only the latest iteration of each file/function is retained; earlier versions are discarded.
4. **Compressed Digest of Older Turns**:
   - Strips generic conversational filler (`"Sure, I'd be happy to help..."`).
   - Replaces inline code blocks with metadata placeholders (e.g., `[code: js, 25 lines]`).
   - Scores sentences using term frequency + positional bonus + decision/action keywords (`should`, `must`, `fix`, `error`, `decid`, `need`).
   - Progressively omits the oldest turns if the result exceeds the remaining token budget.
5. **Iterative Fallback Scaling**: If the prompt still exceeds budget, it loops up to 8 times scaling down non-verbatim sections by `0.8x`.
6. **Continuation Footer**: Concludes with instruction to acknowledge briefly, wait for user input, or continue if the previous turn was an active request.

### 3. Extension Interface (`extension/popup/`)
- Interacts with `chrome.storage.local` to list saved chats sorted by `updatedAt`.
- Queries the active tab via `chrome.tabs.sendMessage` (`ctx:key`) to automatically select the current tab's chat.
- Live preview recalculates on input changes (budget switch, notes typing).
- **Capture chat**: Merges instant viewport scraping with smart auto-scroll for virtualized/lazy-loaded transcripts (`[role="feed"][data-perf-region="transcript"]` on Claude, `div.overflow-y-auto` on ChatGPT, `infinite-scroller[data-test-id="chat-history-container"]` on Gemini). Skips scrolling when not needed, shows real-time progress and a Cancel button while scrolling, restores initial scroll position, and refuses streaming turns.
- Actions: **Capture chat**, **Manage saved chats ↗** (opens options page), **Copy context**, **Export .md**, **Delete chat**, and **Clear all**.

### 4. Saved Chats Manager (`extension/manager/`)
- Full options page registered as `"options_page": "manager/manager.html"`.
- Two-column responsive interface with dark mode and zero remote resources/frameworks.
- **Left Column**: Live search (title + messages), site filter chips, sorting (newest, oldest, most messages, title), bulk selection, auto-saving badges.
- **Right Pane**:
  - **Conversation Tab**: Role-labeled message boxes with untrusted text rendered strictly via `textContent`, paginated in chunks of 50.
  - **Handoff Tab**: Dynamic token budgeting (~2k, 5k, 10k, 20k), user notes syncing, live preview, clipboard copy, and Markdown export.
- **Toolbar & Actions**: Rename with `titleEdited: true` protection against observer overwrites, single delete, bulk delete, bulk JSON export, open original chat link.
- **Top Bar**: Live `chrome.storage.local.getBytesInUse` meter, JSON backup import with validation (<25MB, schema checks) and interactive conflict overwrite/skip resolution, prune chats older than N days, and platform auto-save settings modal.

---

## Platform Support Matrix

| Platform | URL Patterns | Status | Verification Notes |
|---|---|---|---|
| **ChatGPT** | `chatgpt.com/*`, `chat.openai.com/*` | Verified (Live DOM) | Uses `data-chatgpt-search-unit-key$=":user"/":assistant"`, `data-user-message-bubble`, `data-talvt-turn-state`, and legacy fallbacks |
| **Claude** | `claude.ai/*` | Verified (Live DOM) | Uses `[data-testid="user-message"]`, `[data-testid="assistant-message"]`, multi-block `[data-perf-reply-text]`, `span[data-code-line-group]`, and streaming indicators |
| **Gemini** | `gemini.google.com/*` | Verified (Live DOM) | Uses `<user-query>` (joins `p.query-text-line` with single `\n`, strips `.cdk-visually-hidden` and `mat-icon`), `<model-response>` (`#model-response-message-content`, `<code-block>` header stripping, markdown tables), multi-account `/u/<n>/app/<id>`, `[aria-label*="Stop"]`, and `infinite-scroller[data-test-id="chat-history-container"]` capture |
| **Kimi** | `kimi.ai/*`, `www.kimi.ai/*`, `kimi.com/*`, `www.kimi.com/*`, `kimi.moonshot.cn/*` | Verified (Live DOM) | Uses `.chat-content-item-user` (`.user-content__text`), `.chat-content-item-assistant` (`.toolcall-rollup__part > .markdown-container`), `.segment-code` fences, excludes `.toolcall-flow` thinking, and double-scrape streaming check |

---

## Development & Test Commands
- **Install dependencies**: `npm install`
- **Run test suite**: `npm test` (executes 89 tests in `tests/run.js` via `jsdom`, as of 2026-10-18)
- **Load in Chrome**:
  1. Navigate to `chrome://extensions`.
  2. Toggle **Developer mode**.
  3. Click **Load unpacked** and select the `extension/` folder.

---

## Codex — Current Capture Investigation (2026-10-18)

### Current user report
- Short conversations capture correctly. Long conversations may capture only the newest portion, omit middle messages, or contain repeats.
- This points toward long-chat-specific behavior (virtualized/recycled DOM, lazy loading, scroll-container behavior, or multi-window merge identity) rather than a universal failure of the basic selectors.

### Verified from the current implementation
- `extension/src/extract.js`: every `CTX.scrape(adapter)` call re-runs `document.querySelectorAll(...)` and reads current element text. There is no `WeakSet`, `WeakMap`, or node-level “already processed” cache. Reusing a DOM node alone does not make the scraper skip it.
- Message IDs may come from first-party message/search keys or turn-level fallback IDs. Turn fallback IDs include role-local index to distinguish multiple messages inside a turn.
- `sameMsg()` in `extract.js` trusts matching role + ID without comparing text. If a virtualizer reuses a row but fails to update its identity attributes, merge may treat different text as one message. This is a plausible risk; it has not been confirmed on the user's live page.
- In manual capture, the loop scrolls, waits for DOM quiet, then scrapes. These steps are sequential. A network request can still be pending while the DOM appears quiet.
- A proposed 750 ms post-scroll wait was tried and then reverted at the user's request. Do not reintroduce it unless asked.
- The existing test named “fake virtualized list that reuses nodes” actually prepends newly created nodes. Its name has been corrected. A separate regression now retains the same physical node, changes its turn ID and text, and verifies a new scrape reads the updated content.

### Current validation and next diagnostic
- `npm test`: 89 tests pass after the recycled-node extraction regression.
- Short-chat success does not establish completeness for long virtualized chats; jsdom tests cannot confirm current live-site behavior.
- To localize a real failure, compare each capture step's fresh scraped window (message IDs, roles, text fingerprints, first/last messages, scrollTop, scrollHeight) with the merge result and final stored sequence. This separates failure to render/load a message from failure to merge a message that was already scraped.
- Avoid global text deduplication: users may legitimately repeat identical prompts or answers.
