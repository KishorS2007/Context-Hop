# AI Context Handoff

A free Chrome extension that watches your AI chat, saves it **only on your computer**, and builds a compact,
paste-ready context so you can continue the same work in another account when you hit a usage limit.

Supported sites (in build order): **ChatGPT**, **Claude**, **Gemini**, **Kimi**.

## Install (2 minutes)

1. Unzip the project.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the **`extension`** folder (not the project root).
4. Open a chat on a supported site, chat normally, then click the extension icon.

## Use

1. Open a chat on a supported site. Click the extension icon and click **Capture chat** to save it.
2. To keep an active conversation continuously synced without manual capture, check **Keep this chat updated automatically** under the Capture button.
3. When you are close to the limit, click the extension icon and pick the chat (the one in your current tab is selected).
4. Choose a size limit (2k / 5k / 10k / 20k tokens), optionally add notes, and click **Copy context**.
5. Open the new account, paste, and keep going.

**Manage saved chats:** click **Manage saved chats ↗** in the popup (or right-click extension icon > Options) to open the full manager page. Search conversations, view paginated messages, edit titles, export Markdown or JSON backups, import backups with conflict resolution, prune chats older than N days, and configure platform auto-save defaults.

**Better summaries (free):** click *Copy a prompt that asks the AI for a handoff summary*, paste it into the chat
*before* you hit the limit, then paste the AI's reply into the notes box. The notes go at the top of the handoff.

## How the compression works (no AI, no cost)

When the full chat will not fit, the handoff is built in this priority order:

1. Instruction line + your notes
2. The most recent messages, word for word
3. The latest version of each code block from earlier messages (older versions are dropped)
4. A digest of the older conversation: your questions, plus the most informative sentences of each reply, with
   filler like "Sure, I'd be happy to help" removed and code replaced by a short marker

Token counts are estimates (about 4 characters per token).

## Privacy

- Everything is stored in `chrome.storage.local`, on your machine. No server, no account, no network requests.
- Permissions: `storage` and `unlimitedStorage` only. The extension runs only on the sites listed in `manifest.json`.
- Likely secrets (API keys, tokens, private keys, passwords) are removed **before** anything is saved.
- Use **Delete chat** or **Clear all** in the popup to erase saved data.

## Status and known limits

| Site | Status |
| --- | --- |
| ChatGPT | Verified on chatgpt.com |
| Claude | Verified on claude.ai |
| Gemini | Verified on gemini.google.com |
| Kimi | Verified on kimi.ai |

If **Capture chat** says "No messages found", the popup shows how many user/assistant elements were matched.
Zero means that site's selectors are stale. To find the right ones: right-click a message, **Inspect**, and look for a
stable attribute (`data-*`) or element name on the message wrapper.

Other limits: chats are saved only after the site assigns the chat an id in its URL (so brand-new or temporary chats
are skipped), and very long chats that a site only partly renders are merged with what was saved earlier.

## Develop

```
npm install
npm test
```

All site-specific code is in `extension/src/adapters.js`. Compression is in `extension/src/compress.js`.

## Next ideas

- Optional on-device summarization with Chrome's built-in Summarizer API (Gemini Nano), falling back to the rules above.
- Encrypted exports (Web Crypto).
- Auto-delete chats older than N days.
