# ContextHop Engineering & Architectural Report

**Date:** October 17, 2026  
**Product:** ContextHop (formerly Baton / AI Context Handoff)  
**Document:** `report.md`

---

## 1. Executive Summary

This report covers two key areas requested for review:
1. **Manager Page Brand Logo Resolution**: Root cause diagnosis and fix for why the brand logo was not rendering the updated ContextHop design.
2. **Architectural Analysis of the "Your summary / notes (optional)" Box**: Detailed investigation into whether this input is a generic notepad or serves a fundamental purpose in the extension's core AI compression pipeline.

---

## 2. Issue 1: Manager Page Logo Update

### Root Cause
In `extension/manager/manager.html` and `extension/popup/popup.html`, the brand logo header was rendered using an SVG symbol reference:
```html
<svg class="signature-logo" width="22" height="22" aria-hidden="true">
  <use href="../assets/icons.svg#icon-signature-logo"></use>
</svg>
```
While the symbol ID was previously renamed from `#icon-baton-logo` to `#icon-signature-logo`, the internal `<rect>` geometries inside `extension/assets/icons.svg` still contained the old diagonal rectangle mark (`<rect ... transform="rotate(-45 12 12)" fill="#FFC83D" />`). Consequently, the browser continued to render the old diagonal graphic instead of the new ContextHop design.

### Changes Implemented
1. **Direct SVG Asset Embedding**:
   Updated both `extension/manager/manager.html` and `extension/popup/popup.html` to reference the dedicated `logo-tile.svg` asset:
   ```html
   <div class="brand">
     <img class="brandLogo" src="../assets/icons/logo-tile.svg" width="22" height="22" alt="ContextHop">
     <span class="brandName">ContextHop</span>
   </div>
   ```
2. **Updated Symbol in `icons.svg`**:
   Replaced the internal SVG markup of `#icon-signature-logo` inside `extension/assets/icons.svg` with the official ContextHop hopping chat-bubbles design (`viewBox="0 0 128 128"`), ensuring any SVG `<use>` fallbacks display the correct iconography.
3. **CSS Styling**:
   Added `.brandLogo` sizing, flex-shrink, and border-radius rules in `extension/manager/manager.css` and `extension/popup/popup.css`.
4. **Verification**:
   Verified both dark and light modes. The logo displays crisply with the gold hopping arc and dual chat bubbles on a dark rounded tile.

---

## 3. Issue 2: "Your summary / notes (optional)" Analysis

### Verdict: **DO NOT REMOVE**
> [!IMPORTANT]
> The "Your summary / notes (optional)" box is **not** a generic notepad or scratchpad. It is a **foundational component** of ContextHop's core compression engine and context handoff protocol. Removing it would severely cripple the extension's ability to transfer long, complex conversations across AI accounts.

---

### Core Purpose & Architecture

ContextHop is designed to operate **100% locally on the user's browser with zero external servers, zero telemetry, and zero paid API keys**. 

When a user hits a rate limit or message cap in one AI service (e.g., Claude, ChatGPT, Gemini, Kimi) and needs to continue the work in another, the full transcript often exceeds the target model's input context limit or budget (2k, 5k, 10k, or 20k tokens).

The "Your summary / notes" field serves three vital functions:

```
+-------------------------------------------------------------------------+
|                  CONTEXT COMPRESSION PIPELINE (Priority Order)          |
+-------------------------------------------------------------------------+
|  [PRIORITY 1 - ALWAYS KEPT]                                             |
|  # Continuing a previous conversation...                                |
|  ## Goal and summary (written by me) <-- USER SUMMARY / NOTES INJECTED  |
+-------------------------------------------------------------------------+
|  [PRIORITY 2 - HIGH]                                                    |
|  Recent messages verbatim (at least the last 2 turns)                   |
+-------------------------------------------------------------------------+
|  [PRIORITY 3 - MEDIUM]                                                  |
|  Latest version of each code block (earlier versions pruned)            |
+-------------------------------------------------------------------------+
|  [PRIORITY 4 - LOW / AGGRESSIVELY COMPRESSED]                           |
|  Algorithmic digest of older conversation (fillers stripped, sentences) |
+-------------------------------------------------------------------------+
```

---

### Detailed Mechanics

#### 1. Priority #1 in the Compression Pipeline (`extension/src/compress.js`)
In `extension/src/compress.js` (lines 132–138):
```javascript
function assemble(chat, msgs, notes, budget, scale) {
  const header = headerText(chat.siteName || 'AI', chat.title);
  const footer = '\n---\nAcknowledge briefly, then wait for my next message...\n';
  const notesBlock = notes ? '\n## Goal and summary (written by me)\n' + clipSafe(notes, Math.floor(budget * 0.35 * 4)) + '\n' : '';
  const fixed = tok(header) + tok(notesBlock) + tok(footer) + 40;
  const R = Math.max(0, Math.floor((budget - fixed) * scale));
  ...
}
```
- The notes block is allocated up to 35% of the total token budget.
- It is placed at the **very top of the generated prompt**, directly preceding the conversation transcript.
- When an AI model reads the handoff prompt in the new chat, it reads this section first as the overarching context and governing constraints.

#### 2. The "Better Summaries (Free)" Peer-AI Workflow
ContextHop cannot run an LLM locally to summarize a 100-message chat without heavy dependencies. Instead, it utilizes the user's **existing active AI session** before the limit is reached:

1. The UI provides a dedicated button: **"Copy summary prompt"** (`#copyPromptBtn`).
2. Clicking it copies this curated meta-prompt to the clipboard:
   > *"Write a handoff summary of our conversation so I can continue it in a new chat. Include: 1) the goal, 2) key decisions and why, 3) the current state of the work, 4) the latest version of any code, 5) open problems and the exact next step. Be concise."*
3. The user pastes this prompt into their active ChatGPT/Claude/Gemini chat *before* switching accounts.
4. The AI produces a dense, structured 5-point summary.
5. The user pastes that reply into the **"Your summary / notes"** box.
6. When ContextHop generates the handoff prompt, this dense summary bridges the gap for all older turns that would otherwise be discarded by token compression.

#### 3. Storage Schema & Persistence
- Stored in `chrome.storage.local` under the dedicated key `notes:<site>:<chatId>`.
- Preserved during full JSON backups (`contexthop-backup-*.json`) and Markdown exports (`contexthop-*.md`).
- Removing this box would orphan existing stored user summaries and leave unused storage keys across user devices.

#### 4. Test Suite Dependencies
Existing unit tests explicitly validate this behavior in `tests/run.js`:
- `compress: user notes appear near the top and are clipped when huge`
- `manager: merge-by-key handles new chats and conflict overwrite/skip choices`

---

### Comparison: Removing vs. Retaining & Clarifying

| Aspect | If Removed | If Retained & Clarified (Recommended) |
| :--- | :--- | :--- |
| **Handoff Quality** | **Degraded**: Long chats (50+ turns) lose key early architectural decisions and background context when compressed. | **Optimal**: Preserves high-density context even under small token limits (2k / 5k). |
| **Zero-Cost AI Summarization** | **Broken**: The "Copy summary prompt" feature becomes useless without an input to receive the result. | **Preserved**: Works seamlessly with the "Copy summary prompt" workflow. |
| **Storage & Exports** | Leaves orphaned `notes:*` keys in storage; Markdown and JSON exports lose summary blocks. | Fully compatible with storage schema and export files. |
| **User Clarity** | Removes one UI box. | Changing the label to *"Handoff Summary / AI Instructions (optional)"* eliminates the misconception that it is a personal notepad. |

---

### Implemented Solution

As requested, we addressed the ambiguity of the box across both extension surfaces (manager and popup):

1. **Clarified Label**:
   Renamed from the ambiguous `"Your summary / notes (optional)"` to:
   ```html
   <label class="fieldLabel">Handoff summary & instructions <span class="optionalTag">(optional)</span></label>
   ```
2. **Interactive Info Button & Icon**:
   Added a dedicated, subtle info button (`#notesInfoBtn`) with an SVG info icon next to the label.
3. **Explaining Pop-Up Dialog (`#notesInfoModal`)**:
   Clicking the info icon displays an accessible, informative pop-up card explaining:
   - **Priority #1 (Never Dropped)**: Content in this box is injected at the very top of the prompt (`## Goal and summary`).
   - **3-Step AI Workflow (Free)**: How to use the *"Copy summary prompt"* button, paste it to their active chat, and paste the AI's 5-point reply back into this box.
   - **Custom Directives**: How they can also manually write architecture rules, stack choices, or next steps for the target model.
   - Includes a **"Got it"** dismissal button, close icon (`×`), Escape key handling, and outside click dismiss.

---

## 4. Current Repository Status & Verification

1. **Test Suite**:
   ```
   70 passed (100% passing)
   node tests/run.js
   ```
2. **Logic Hashes (`extension/src/**`)**:
   All 5 core files (`adapters.js`, `compress.js`, `extract.js`, `observer.js`, `redact.js`) match their baseline SHA-256 hashes 100%. No logic or protocol changes occurred.
3. **Permissions & Manifest**:
   Strict MV3 compliance: `storage` and `unlimitedStorage` only. No remote scripts, no inline scripts, no unauthorized permissions.
