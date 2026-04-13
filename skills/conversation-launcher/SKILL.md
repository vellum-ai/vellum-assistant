---
name: conversation-launcher
description: Offer the user several spin-off conversations as clickable buttons on a single persistent card. Each click spawns a fresh seeded conversation in the sidebar; the user keeps their place in the current conversation. Use when you want to branch into N focused threads (research directions, draft choices, pending replies, triage of N items) without losing the current context. Not for single-destination pivots — just reply inline.
compatibility: Designed for Vellum personal assistants
metadata:
  emoji: "🧭"
  vellum:
    display-name: "Conversation Launcher"
---

Use this skill when you want to offer the user several spin-off conversations from the current one. You render **one** persistent card. Each button on the card spawns its own seeded conversation in the sidebar. The user can click multiple buttons without losing their place — the origin conversation (this one) keeps focus.

## When this fits

- Research branches — "here are three angles to pursue"
- Draft choices — "here are the reply drafts I could write"
- Triaging N items — "here are the five threads with pending replies"
- Pending-reply fan-out — each sender gets their own drafting conversation

## When this does NOT fit

- Single-destination pivots — if there's one obvious next conversation, just reply inline or navigate there directly. One button is not a menu.
- Options that share context and should stay in one thread — keep them here.
- Inline Q&A the user can skim in place — answer; don't fan out.

## How to render

Emit exactly one `ui_show` call with a card shaped like this, then end your turn:

```json
{
  "surface_type": "card",
  "display": "inline",
  "persistent": true,
  "data": {
    "title": "<framing headline>",
    "body": "<one short sentence framing the choice>"
  },
  "actions": [
    {
      "id": "opt-1",
      "label": "<short button label>",
      "style": "primary",
      "data": {
        "_action": "launch_conversation",
        "title": "<short conversation title>",
        "seedPrompt": "<full first-user-message seed>",
        "anchorMessageId": "<optional anchor message id from this conversation>"
      }
    },
    {
      "id": "opt-2",
      "label": "<short button label>",
      "style": "secondary",
      "data": {
        "_action": "launch_conversation",
        "title": "<short conversation title>",
        "seedPrompt": "<full first-user-message seed>"
      }
    }
  ]
}
```

Field notes:

- `persistent: true` keeps the card visible after a click so the user can fire more buttons.
- Each action's `data` must contain `_action: "launch_conversation"`, `title`, and `seedPrompt`. `anchorMessageId` is optional — include it when the spawned conversation should thread off a specific message in this one.
- `label` is the button text (short, ≤ 4 words, ≤ 30 chars). `title` is the new conversation's sidebar name (3–5 words, specific not generic). `seedPrompt` is the first user message of the new conversation — written in first-person as if the user typed it, with enough context that the new conversation can pick up without re-asking.
- Use `style: "primary"` for the recommended option (at most one), `style: "secondary"` for the rest.

## Do nothing else

After rendering the card, end your turn. The click pipeline handles everything:

- Do NOT run a follow-up step, issue any HTTP request, or write any file.
- Do NOT send a chat message after the card. The card is the response.
- Do NOT re-render the card on each click — it stays visible.

## UX contract the client enforces

- The card stays open and clickable for the lifetime of the live conversation — multiple buttons can be fired in succession without losing the user's place. If the conversation is closed and reopened later from history, the restored card reverts to single-click behavior (history rehydration drops the `persistent` flag — out of scope for this skill).
- Each `action.id` fires at most once per card lifetime; sibling actions remain clickable.
- Each spawned conversation inherits this conversation's guardian / trust context automatically.
- Sidebar focus stays on this conversation. The user sees new entries appear and can navigate in at their pace.

## Authoring tips

- Don't invent options. Only surface branches the user has actually discussed or implied.
- 2–5 buttons is the sweet spot. One option? Just reply inline. More than five? Trim or group.
- Keep the card body to one sentence. The buttons carry the payload; the body just frames the choice.
