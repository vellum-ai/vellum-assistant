---
name: watcher
description: Polling watcher system for monitoring external sources
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"👀","vellum":{"display-name":"Watcher"}}
---

Create and manage watchers that poll external services for events and process them with an action prompt.

## Concepts

- **Provider** — The external service to poll (e.g. "gmail"). Each provider defines how to fetch and parse events.
- **Action prompt** — LLM instructions for handling detected events. Sent along with event data to a background conversation.
- **Poll interval** — How often to check for new events (minimum 15 seconds, default 60 seconds).
- **Digest** — Summary of recent watcher activity, grouped by watcher with time-based filtering.

## Lifecycle

1. Create a watcher with a name, provider, and action prompt.
2. The system polls the provider at the configured interval.
3. Detected events are processed according to the action prompt.
4. Use `watcher_digest` to review recent activity.

## Usage Notes

- Use `watcher_create` when the user wants to monitor an external source (e.g. "watch my Gmail for important emails").
- `watcher_digest` is the go-to tool when the user asks "what happened with my email?" or similar questions about watcher activity.
- Watchers can be enabled/disabled via `watcher_update` without deleting them.
