# App Interaction Hooks

A sandboxed app talks to the assistant and arranges itself on screen through
`window.vellum.sendAction(actionId, data)`. The app host handles **two**
actions — `relay_prompt` and `set_view`. Wire them during the build so the
app can pull the assistant in and control the layout. (Other action ids are
not routed from an opened app — see "What is NOT delivered" below.)

## `relay_prompt` — send a message to the assistant

Sends `prompt` into the conversation as if the user typed it; the assistant
then responds in chat. This is **the** channel for involving the assistant
from an app — there is no separate structured-event or silent-state channel,
so phrase the intent as natural language.

```javascript
// A button in a dashboard: "Explain this anomaly"
window.vellum.sendAction("relay_prompt", {
  prompt: "Revenue dropped 40% on the 14th — what happened?",
});

// Start a fresh conversation instead of using the open one
window.vellum.sendAction("relay_prompt", {
  prompt: "Draft a follow-up email to this customer.",
  conversation: "new", // "active" (default) | "new"
});
```

- **`prompt`** (required) — the message text. Empty or missing → ignored.
- **`conversation`** — `"active"` (default: the open conversation) or
  `"new"` (a fresh draft). With `"active"` and nothing open, it's a no-op.
- **The layout is left exactly as-is.** Relaying never opens, closes, or
  resizes the app — if the user has chat and app side by side, it stays that
  way. Each relay is delivered even when the same text is sent repeatedly.

The assistant can't see the app's internal state, so make every prompt
**self-contained**: include the numbers, selection, or row the user is acting
on. "Summarize these" won't work; "Summarize these 3 expenses: $42 lunch,
$118 hotel, $30 taxi" will.

Good triggers: "explain this chart," "what should I focus on," "turn these
into tasks," "compare the two selected plans." Wire them on the buttons and
selections where the assistant's help is the actual point.

### Triage / bulk-action UIs

Render selectable items + an action button, then relay the user's choice as a
prompt the assistant can act on:

```javascript
function runBulkAction(selected) {
  const list = selected.map((s) => `- ${s.title} (${s.id})`).join("\n");
  window.vellum.sendAction("relay_prompt", {
    prompt: `Archive these ${selected.length} items:\n${list}`,
  });
}
```

## `set_view` — arrange the app and chat

Moves the app panel. Independent of `relay_prompt`; use it only when the app
itself should change the layout.

```javascript
window.vellum.sendAction("set_view", { view: "split" }); // app + chat side by side
window.vellum.sendAction("set_view", { view: "full" });  // app full-width
window.vellum.sendAction("set_view", { view: "chat" });  // close app, back to chat
```

- **`"split"`** — side by side with the conversation. Desktop only; ignored on
  mobile, which has no side-by-side layout.
- **`"full"`** — the app takes the full width.
- **`"chat"`** — closes the app and returns to the conversation.

Most apps never need this — the user controls the layout from the app's nav
bar. Reach for it only when an in-app action implies a layout change (e.g. a
"Discuss with assistant" button that opens `split` so the reply lands beside
the app).

## What is NOT delivered

Only `relay_prompt` and `set_view` reach the host from an opened app. Custom
event names (`city_selected`, `form_submitted`, …) and silent `state_update`
pings are **dropped** — there is no background "the assistant quietly
observes the app" channel today. If you want the assistant to know or do
something, relay it as a prompt. Don't wire hooks that depend on a response
that will never come.
