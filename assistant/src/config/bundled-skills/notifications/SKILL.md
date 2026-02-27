---
name: "Notifications"
description: "Send notifications through the unified notification router"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udd14"}}
---

Use `send_notification` for user-facing alerts and notifications. This tool routes through the unified notification pipeline, which handles channel selection, delivery, deduplication, and audit logging.

## Routing Behavior

- `preferred_channels` are **routing hints**, not hard channel forcing. The notification router makes the final delivery decision based on user preferences, channel availability, and urgency.
- Channel selection and delivery are handled entirely by the notification router -- do not attempt to control delivery manually.

## Deduplication (`dedupe_key`)

- `dedupe_key` suppresses duplicate signals. A second notification with the same key is **dropped entirely** within a **1-hour window**. After the window expires, the same key is accepted again.
- Never reuse a `dedupe_key` across logically distinct notifications, even if they are related. The key means "this exact event already fired," not "these events are in the same category."
- If you omit `dedupe_key`, the LLM decision engine may generate one automatically based on signal context. This means even keyless signals can be deduplicated if the engine considers them duplicates of a recent event.

## Threading

Thread grouping is handled by the LLM-powered decision engine, not by any parameter you pass. There is no explicit "post to thread X" parameter — thread reuse is inferred, not commanded.

**How it works:** The engine evaluates recent notification thread candidates and chooses `reuse_existing` when a new signal looks like a continuation of an existing thread (same title, same `source_event_name`, related context).

**To encourage thread reuse:**
- Use a consistent `title` across related notifications.
- Use a `source_event_name` that reflects the same event type (e.g. `dog.news.thread.reply` rather than a brand new name each time).

**To force a new thread:**
- Use a distinct `title` or a clearly different `source_event_name`.

**Practical constraints:**
- Thread candidates are scoped to the **last 24 hours** (max 5 per channel). You cannot reuse an old thread from days ago.
- The engine will only reuse conversations originally created by the notification system (`source === 'notification'`). It will never append to a user-initiated conversation, even if it looks related.

## Important

- Do **NOT** use AppleScript `display notification` or other OS-level notification commands for assistant-managed alerts. Always use `send_notification`.
- For sending messages into a specific chat, email, or SMS destination, use the messaging skill's `messaging_send` instead.
