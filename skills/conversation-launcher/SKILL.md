---
name: conversation-launcher
description: Render an inline card where each button creates a new focused conversation seeded with specific context, then opens it. Use when the user asks "what are my open threads", "what's pending", "loose ends", "what should I work on next", or whenever you want to offer the user multiple branching conversation paths from the current one. Surfaces N options as clickable actions; on click, creates a new conversation, seeds it with the option's context, and navigates to it.
compatibility: Designed for Vellum personal assistants
metadata:
  vellum:
    display-name: "Conversation Launcher"
---

Use this skill whenever you want the user to pick one of several threads or topics to work on, and each pick should become its own focused conversation rather than continuing in the current one.

## When this fits

- "What are my open threads?" / "What's pending?" / "Loose ends?" — list the threads, let the user click one.
- "What should I work on next?" — surface prioritized options, each launching a focused conversation.
- "Here are three research directions" / "Here are the drafts I could write" — each direction becomes its own conversation with seeded context.
- "Here are the emails I could respond to" — each one opens a conversation for drafting that reply.

Good fit: the options are distinct enough that continuing in one thread would bleed context. Poor fit: the user wants a quick inline answer, or the options share context and should stay in one conversation.

## Shape

For each option you plan to surface, prepare:

- `label` — short button text (≤ 4 words, ≤ 30 chars)
- `title` — the new conversation's title (user-facing, shown in the sidebar)
- `seed_prompt` — the first user message the new conversation will contain. Written in first-person as if the user typed it. Include enough context that the new conversation can pick up without re-asking. Example: "Let's keep working on the sleep schedule shift. Here's where we left off: we agreed 7 AM wake, Monday start, with a 7:30 AM Tuesday push if the first day slips."

## Steps

1. **Render the card.** Call the structured UI tool with a card containing one action per option. The action payload (`data` field) carries `{ title, seed_prompt }`. Block until the user clicks.

   ```json
   {
     "surface_type": "card",
     "display": "inline",
     "await_action": true,
     "data": {
       "title": "Open threads",
       "body": "<one-sentence lead-in explaining what the user is picking between>"
     },
     "actions": [
       { "id": "opt-1", "label": "<label>", "style": "primary", "data": { "title": "<title>", "seed_prompt": "<seed>" } },
       { "id": "opt-2", "label": "<label>", "data": { "title": "<title>", "seed_prompt": "<seed>" } }
     ]
   }
   ```

2. **Parse the action result.** When the user clicks a button, you receive the `actionId` and its `data` payload. Extract `title` and `seed_prompt`.

3. **Create the new conversation.** Generate a fresh idempotency key (any unique string, e.g. a UUID or timestamp-based slug) and call:

    ```bash
    curl -sf -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/conversations" \
      -H "Content-Type: application/json" \
      -d "{\"conversationKey\":\"launcher-$(date +%s)-$RANDOM\"}"
    ```

    Capture the returned `id` as `NEW_CONV_ID`.

4. **Seed the new conversation.** Post the seed prompt to it:

    ```bash
    curl -sf -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/messages" \
      -H "Content-Type: application/json" \
      -d "{\"conversationKey\":\"${NEW_CONV_ID}\",\"content\":\"${SEED_PROMPT}\"}"
    ```

    (`conversationKey` here accepts either the idempotency key or the conversation ID — the resolver handles both.)

5. **Open the new conversation in the UI.** Write a JSON event to the signals directory; the assistant's config watcher publishes it to connected clients:

    ```bash
    cat > "${HOME}/.vellum/workspace/signals/emit-event" <<EOF
    {"type":"open_conversation","conversationId":"${NEW_CONV_ID}","title":"${NEW_CONV_TITLE}"}
    EOF
    ```

    Use the conversation's `title` so the client can stub a sidebar entry if the conversation isn't in its list yet.

6. **Don't say anything else.** The UI switch is the signal. No chat response needed after the launch.

## Notes

- If the user hasn't named the threads, name them concisely yourself (3–5 words, specific not generic).
- Don't invent threads. Only surface what the user has actually discussed or what they asked about.
- If there's only one reasonable option, do not use this skill — just continue in the current conversation.
- Keep the card body brief (one sentence). The buttons carry the payload; the body just frames the choice.
