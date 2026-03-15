---
name: notifications
description: Send notifications through the unified notification router
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔔"
  vellum:
    display-name: "Notifications"
---

Use `send_notification` for user-facing alerts and notifications. This tool routes through the unified notification pipeline, which handles channel selection, delivery, deduplication, and audit logging.

## Routing Behavior

- `preferred_channels` are **routing hints**, not hard channel forcing. The notification router makes the final delivery decision based on user preferences, channel availability, and urgency.
- Channel selection and delivery are handled entirely by the notification router -- do not attempt to control delivery manually.

## Deduplication (`dedupe_key`)

- `dedupe_key` suppresses duplicate signals **permanently**. A second notification with the same key is **dropped entirely** for the lifetime of the assistant's event store. Once a key has been used, it cannot be reused — any future notification with the same key will be silently discarded.
- Never reuse a `dedupe_key` across logically distinct notifications, even if they are related. The key means "this exact event already fired," not "these events are in the same category."
- If you omit `dedupe_key`, the LLM decision engine may generate one automatically based on signal context. This means even keyless signals can be deduplicated if the engine considers them duplicates of a recent event.

## Conversation Grouping

Conversation grouping is handled by the LLM-powered decision engine, not by any parameter you pass. There is no explicit "post to conversation X" parameter — conversation reuse is inferred, not commanded.

**How it works:** The engine evaluates recent notification conversation candidates and decides whether a new signal is a continuation of an existing conversation based on `source_event_name`, provenance metadata, and message content. Use natural, descriptive titles and bodies — the engine groups by semantic relatedness, not string matching.

**`source_event_name` is the primary grouping signal.** Use a stable event name for notifications that belong to the same logical stream (e.g. `dog.news.thread.reply` for all replies in a thread). Use a distinct event name when the notification represents a genuinely different kind of event.

**Practical constraints:**

- Conversation candidates are scoped to the **last 24 hours** (max 5 per channel). You cannot reuse an old conversation from days ago.
- The engine will only reuse conversations originally created by the notification system (`source === 'notification'`). It will never append to a user-initiated conversation, even if it looks related.

## Important

- Do **NOT** use AppleScript `display notification` or other OS-level notification commands for assistant-managed alerts. Always use `send_notification`.
- For sending rich content (digests, summaries, reports) to a specific chat or email destination, use the messaging skill's `messaging_send` instead. The decision engine rewrites `send_notification` content into short alerts, which strips rich formatting.
