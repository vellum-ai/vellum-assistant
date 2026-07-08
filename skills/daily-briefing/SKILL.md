---
name: daily-briefing
description: Proactive daily briefing that fires on a recurring schedule, pulls recent memory and workspace context, composes a structured summary (action items, progress, radar, next steps), and delivers it to all active channels. Enable with a time like "set up my daily briefing at 9am". Disable, reschedule, or check status at any time.
compatibility: Designed for Vellum personal assistants
metadata:
  emoji: "📋"
  vellum:
    category: productivity
    display-name: "Daily Briefing"
---

Send yourself a structured morning briefing every day — without asking for it. The briefing pulls your recent memory, decisions, and workspace context, composes a concise summary, and delivers it to all your active channels (Slack, Telegram, macOS, etc.).

## Setup

Enable the briefing by telling your assistant:

> "Set up my daily briefing at 9am"

The assistant will create a recurring schedule. On first run you will receive a briefing in all connected channels.

You can also say:

- "Set my daily briefing to 7:30am"
- "What time is my daily briefing?"
- "Pause my daily briefing"
- "Turn off my morning briefing"

## What the briefing covers

Each briefing is structured into up to four sections, each capped at 3–5 bullets:

**Action Items** — Unresolved tasks, pending decisions, or commitments due today.

**Progress** — Notable completions or milestones from the past 24 hours.

**On Your Radar** — Anything flagged as important, upcoming, or worth watching.

**Suggested Next Steps** — 2–3 concrete actions ranked by impact.

Sections with nothing to report are omitted entirely.

## How to enable

Run this skill and follow the prompts, or tell your assistant directly:

```bash
bun scripts/setup.ts
```

The setup script asks for your preferred delivery time and timezone, then creates the schedule.

## Managing the schedule

Once enabled, all management is conversational — just tell your assistant:

| What you want | Say                            |
| ------------- | ------------------------------ |
| Change time   | "Move my briefing to 8am"      |
| Check status  | "When is my next briefing?"    |
| Pause         | "Pause my daily briefing"      |
| Resume        | "Resume my daily briefing"     |
| Disable       | "Turn off my morning briefing" |

## How it works

Setup runs `scripts/setup.ts` via bash, which calls `assistant schedules create` to register a recurring `execute`-mode schedule. When the schedule fires each day:

1. The scheduler boots a background conversation with the briefing prompt as the initial message.
2. The agent runtime injects your recent memory, decisions, and workspace context automatically.
3. The agent composes the briefing and runs `assistant notifications send` to deliver it.
4. The notification routes to all your connected channels — the same pipeline as any other Vellum notification.

The briefing conversation is reused across runs so context accumulates over time (the agent sees prior briefings when composing today's).

## Privacy

The briefing only reads context already stored in your memory and workspace. It does not connect to external calendars or task managers unless you have those integrations configured separately.
