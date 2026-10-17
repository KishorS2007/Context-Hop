# Work Log — Capture completeness and conversation isolation

## Goal

Fix popup **Capture chat** so it reliably collects the full available transcript, and fix manager **Conversation** rendering so one selected chat cannot display messages from another. Current continuation case: ChatGPT share titled “Networking Study” captures only the bottom portion and omits middle turns. Add regression coverage in `tests/run.js`; run `npm test` and refine until the full suite passes.

## Repository state at handoff/start

- Workspace: `C:\Users\kisho\OneDrive\Desktop\chrome Extension\ai-context-handoff`
- Existing uncommitted edits predate this task: `extension/popup/popup.js`, `extension/src/adapters.js`, `extension/src/observer.js`. Preserve these changes and build on them.
- `report.txt` is a prior deliverable from the preceding task; preserve it.
- Test runner is `tests/run.js` (`npm test` -> `node tests/run.js`). It already contains broad extraction, merge, scroll-capture, autosave, and manager coverage.

## Initial investigation

- Capture implementation and scroll-container discovery are in `extension/src/observer.js`; site selectors/IDs are in `extension/src/adapters.js`; parsing and virtualized-window reconciliation are in `extension/src/extract.js`.
- Capture currently has separate paths for a non-overflowing page (saves the initial scrape as complete) and a scrolling page (walks upward, merges windows, then persists). These paths need close review for cases where the site virtualizes content but the extension fails to identify its scroller, or where scroll windows overlap ambiguously.
- Manager loads each `chat:*` storage record into `allChats`; `renderConversation(chat)` itself pages and renders that record's `messages`. `renderDetail(key)` awaits notes from storage before rendering. A stale async detail render may therefore finish after the user selected another chat; add a regression test and guard against rendering a no-longer-selected record if confirmed.
- The current tree has tests for a synthetic 100-message lazy-loading page and several capture streaming cases. Need add tests specifically for capture fallback/history preservation and rapid manager selection isolation, based on reproduced defects.

## Work completed

- Created this work log before implementation, as requested.
- Read the capture pipeline, adapter selectors, extraction/merge implementation, manager data loading/rendering, and relevant existing tests.
- Confirmed `findScroller()` does not currently consult the Gemini adapter's declared `scrollContainer` selectors; it infers a candidate from the first message's ancestors and CSS overflow. This can miss custom-scroll containers and lead to incomplete capture.
- Confirmed the no-overflow capture branch writes only the current DOM scrape as if the transcript were complete, even when an older stored record has additional virtualized history. This can truncate a previously captured transcript.
- Confirmed `renderDetail(key)` awaits a notes lookup and then renders without checking whether the user selected another chat during that await. This creates a real cross-chat rendering race.
- Added regression tests in `tests/run.js` for preserving a fuller stored transcript when the current page does not yield a usable scroller, and for out-of-order notes reads during rapid manager selection.
- `extension/src/observer.js`: added adapter-declared scroll container selectors to scroller candidates; changed no-scroll fallback to reconcile with the stored transcript both before and inside the serialized write queue, preserving longer prior history rather than replacing it with a short rendered window.
- `extension/manager/manager.js`: `renderDetail` checks that its key is still selected after awaiting notes storage; stale async renders now exit before touching notes/conversation UI.
- `extension/src/extract.js`: reconciliation now marks an overlap ambiguous rather than pairing unmatched intervening messages only because role/length happen to match; repeated low-information anchors return ambiguous rather than risking silent omission/misalignment.
- Made the existing 200-message randomized merge property test use a fixed-seed PRNG. It exposed a reproducible silent loss at message 127 with repeated short messages; after the merge fix it passes and stays reproducible.
- Focused regressions pass: `TEST_FILTER='no-scroll fallback'`, `TEST_FILTER='slow notes lookup'`, `TEST_FILTER='property test - 200'`, and `TEST_FILTER='merge:'`.
- Final full `npm test` passes: 87 tests.
- `git diff --check` passes. Git reported expected LF-to-CRLF conversion warnings for source files; no whitespace errors were found.

## Current findings / hypotheses to validate

1. Capture completeness: explicit adapter selector and no-scroll preservation fixes are in place; existing synthetic lazy-loading test covers 100 messages and scroll restoration. Full suite will check interactions with older capture/scroll edge cases.
2. Manager isolation: stale async detail renders are guarded and the delayed-lookup regression passes.

## Next steps

1. If continuing, validate the modified extension on current live ChatGPT/Claude/Gemini/Kimi DOMs because site-side markup and virtualization behavior cannot be fully simulated in jsdom.
2. Preserve the user-requested source changes and this log; initial popup/adapters/observer modifications existed before this task.
3. Final response should report the two reproduced causes, implementation changes, and passing full test run.

## Tests and verification

- Passed: focused no-scroll capture regression.
- Passed: focused stale manager detail regression.
- Passed: deterministic 200-message merge property test.
- Passed: focused merge tests (5 tests).
- Passed: final `npm test` (87 passed).
- Passed: `git diff --check`.

## Outstanding risks/questions

- DOM virtualization differs among supported sites; jsdom fixtures can verify algorithmic behavior but cannot prove current live site selectors/scroll behavior. A live browser validation remains the only open verification item.
- Preserve the pre-existing working-tree modifications; do not revert or overwrite unrelated edits.

## Continuation: Networking Study capture report

- User provided shared URL `https://chatgpt.com/share/6ad39dbd-4dc0-83ee-825f-d84b1c6676af` and attached `Pasted text.txt`.
- Opened the share URL via web and the in-app browser. The title (“ChatGPT - Networking Study”) is visible, but the page body has no rendered transcript in the browser, so no full remote transcript comparison was possible.
- The pasted file is a large generated handoff containing only the “Most recent messages (verbatim)” section and shows topic jumps, consistent with the reported incomplete/misaligned transcript but insufficient to identify exact missing source turns.
- Confirmed code hypothesis and added a regression: ChatGPT fallback selectors can find multiple same-role messages under one turn wrapper. `extractId()` used to return the shared `data-turn-key` / `conversation-turn-N`; `sameMsg()` trusts role + ID and ignores text, so distinct assistant chunks could collapse during overlap merging.
- `extension/src/extract.js`: turn-level fallback IDs now include role-local message index while true message/search-unit IDs remain untouched.
- `tests/run.js`: added a single-turn fixture with two assistant messages and verified both IDs are distinct and merging overlapping windows preserves all three messages. Focused test passes.
- Final `npm test` after this follow-up passes all 88 tests.
- Shared page remains unavailable for full transcript inspection (title loads; page body is empty in this browsing session). The root cause is supported by the ChatGPT fallback selector/ID behavior and regression fixture, but the exact omitted turns from the linked chat could not be compared.

## Continuation: repeated capture output

- User clarified the pasted text is generated by ContextHop and reports repeated text after clicking **Capture chat** multiple times.
- The attached output contains identical assistant explanations repeated at different points, sometimes after repeated user turns. This could be duplicate transcript persistence or a bad merge of repeated virtualized windows; it should not be “fixed” by globally deduplicating identical text because users can legitimately repeat prompts/answers.
- Parsed the attached generated prompt: 62 message entries, 54 unique role/text pairs, 8 exact duplicate entries, and zero adjacent duplicate pairs. This does not look like a simple whole-transcript append on each click; duplicates are interspersed, so global text deduplication could delete legitimate repeated turns.
- Extended the existing 100-message lazy-loading regression: after a full capture it runs two captures concurrently and asserts both report 100 messages/0 new and the stored sequence remains exactly messages 1–50 in order. The test passes; sequential repeated capture had also passed before being strengthened to concurrent runs.
- Ran full `npm test` after the regression update: all 88 tests pass.
- No additional production change was justified by this attachment alone: repeated click capture is idempotent in the existing realistic virtualized fixture, while the shared source transcript could not be inspected in browser. Need a failing real DOM/storage trace to distinguish source conversation repeats, stale already-saved duplicates, and a ChatGPT selector/merge-specific interleaving issue.
