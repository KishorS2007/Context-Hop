# Baton Design System (`extension/ui/`)

"Ink canvas, one yellow baton" — a calm, precise, developer-first aesthetic with deep blue-black surfaces, quiet action blue, and a single warm yellow signature baton mark marking the handoff point.

## Design Tokens

Tokens are defined in [`tokens.css`](file:///c:/Users/kisho/OneDrive/Desktop/chrome%20Extension/ai-context-handoff/extension/ui/tokens.css).

### Color Surfaces (Dark Theme Default)
- `--ink-0` (`#0B1220`): Page background canvas
- `--ink-1` (`#111B2E`): Panel backgrounds, cards, sidebar
- `--ink-2` (`#182640`): Raised surfaces, message bubbles, hover states
- `--ink-3` (`#213558`): Selected chat rows, active indicators
- `--line` (`#26385A`): Standard 1px divider lines and borders
- `--line-strong` (`#36507C`): Prominent borders and active outlines

### Typography & Actions
- `--text` (`#E8EDF7`): High-contrast primary text (WCAG AAA)
- `--text-2` (`#A5B2C8`): Secondary body text and labels (WCAG AA)
- `--text-3` (`#7283A0`): Subtle metadata and timestamps
- `--action` (`#3E63F0`): Primary action blue (links `--link` `#8FB0FF`)
- `--baton` (`#FFC83D`): Signature warm yellow handoff indicator (light theme `#E5A200` fill)
- `--ok` (`#3FCB8E`): Success status
- `--warn` (`#F2B544`): Token warning
- `--danger` (`#F0626A`): Destructive actions

### Light Theme
Enabled via `[data-theme="light"]` or automatically with `[data-theme="auto"]` based on system preferences. Uses crisp `#F4F6FA` canvas and `#FFFFFF` panels while maintaining WCAG AA contrast (5.5:1+ for text-2).

### Typography Hierarchy
- Headings & Wordmark: **Bricolage Grotesque** (600/700)
- UI Text: **Hanken Grotesk** (400/500/600) at 13–14px
- Code & Monospace: **JetBrains Mono** (400/500)
- Fallbacks: `system-ui, -apple-system, sans-serif` and `monospace`

### Radii by Role
- Controls (buttons, inputs, selects): `8px` (`--radius-control`)
- Panels & Cards: `12px` (`--radius-panel`)
- Status pills & Chips: `9999px` (`--radius-pill`)
- Code Blocks: `8px` (`--radius-code`)

### Shadows & Depth
- **Zero generic card shadows**. Shadows are reserved strictly for floating layers (menus, dialog modals, toast notifications) using `--floating-shadow`.

### Motion
- `140ms ease-out` (`--transition-fast`). Fully respects `prefers-reduced-motion: reduce`.

---

## Shared UI Components

1. **Baton Signature Lane Line**:
   - 1px divider directly underneath the header with the yellow baton indicator.
   - On context copy, the baton mark slides smoothly from left to right along the lane line.
2. **Site Identity Chips**:
   - Monogram chips (`CG`, `CL`, `GE`, `KI`) with colored platform accent dots:
     - ChatGPT: `#10A37F`
     - Claude: `#D97706`
     - Gemini: `#3B82F6`
     - Kimi: `#06B6D4`
3. **Segmented Size Control**:
   - Token budget switcher (`2k`, `5k`, `10k`, `20k`).
4. **Token Meter**:
   - Live token progress readout showing token count, word-for-word message count, and code blocks count with correct English pluralization.
5. **Toast Notifications**:
   - Accessible notifications rendered with `role="status"` and `aria-live="polite"`.
6. **Modal Dialogs**:
   - Native `<dialog>` elements with focus trapping, `Escape` key dismissal, and two-step confirmation for destructive actions.
