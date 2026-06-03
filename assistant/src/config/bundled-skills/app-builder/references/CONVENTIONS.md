# App Conventions

The interaction baselines every app must meet, and the standard patterns for wiring the app back to the assistant. These apply to all apps (not slides — see SLIDES.md for that domain). Read this when building or iterating; the SKILL.md workflow points here.

---

## Interaction standards

Every app must meet these baselines:

- **Feedback for every action** — use `vellum.widgets.toast()` after creates, deletes, updates, and errors
- **Confirmation for destructive actions** — use `window.vellum.confirm(title, message)` before deleting or resetting. Returns `Promise<boolean>`
- **Form validation** — validate before submit, show errors inline, disable submit during async operations
- **Loading states** — never show a blank screen while data loads. Use skeleton shimmer or spinners
- **Keyboard navigation** — `Tab` between elements, `Enter` to submit, `Escape` to close/cancel. De-prioritized on mobile-first builds

---

## Error handling

- Wrap every `window.vellum.fetch()` call in `try/catch` with user-friendly feedback. Check `res.ok` before parsing the body
- Never let a failed operation pass silently — always show a toast or inline error
- Show a designed empty state (`.v-empty-state`) when there's no data
- Show validation errors inline next to the relevant form field

---

## App interaction hooks

Proactively wire `window.vellum.sendAction()` so the assistant stays aware of meaningful user interactions. Two patterns:

- **Reactive hooks** — trigger an assistant response. Use for selections that warrant explanation, level completions, form submissions
- **Silent hooks** (`state_update`) — accumulate context without interrupting. Use for tab navigation, filter changes, score updates

Wire hooks during the initial build, not after the user asks. Full examples and per-app-type guidance in `{baseDir}/references/INTERACTION_HOOKS.md` (read with `host_file_read`).

---

## Actionable UI

When the user wants to triage or bulk-act on items, render an interactive UI with selectable items and action buttons:

1. Fetch data with relevant tools
2. Render a `dynamic_page` with selectable items and action buttons
3. User selects + clicks action → UI sends `surfaceAction` with action ID and selected IDs
4. Execute tools, update UI with `ui_update`, show feedback via `widgets.toast()`
5. Use `window.vellum.confirm()` for destructive actions

---

## External links

Use `vellum.openLink(url, metadata)` to make items clickable. Construct deep-link URLs when possible. Include `metadata.provider` and `metadata.type` for context.
