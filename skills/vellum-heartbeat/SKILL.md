---
name: vellum-heartbeat
description: Configure periodic background checklist runs
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F493"
  vellum:
    display-name: "Heartbeat"
    activation-hints:
      - "Set up a heartbeat, periodic checklist, background health check, or recurring background task"
    avoid-when:
      - "One-off or recurring schedules with specific payloads - use the schedule skill instead"
---

The heartbeat feature runs your `HEARTBEAT.md` checklist periodically in a background conversation. Each run, the assistant works through the checklist and flags anything that needs attention.

## Setup

Edit `config.json` using `file_edit`:

1. **Enable heartbeat**: Set `heartbeat.enabled` to `true`.
2. **Set interval**: Set `heartbeat.intervalMs` (milliseconds between runs, default: 3600000 = 1 hour).
3. **Optional active hours**: Set `heartbeat.activeHoursStart` and `heartbeat.activeHoursEnd` (0-23) to restrict runs to certain hours. Both must be set together.

Example config.json heartbeat section:
```json
{
  "heartbeat": {
    "enabled": true,
    "intervalMs": 1800000,
    "activeHoursStart": 8,
    "activeHoursEnd": 22
  }
}
```

Then edit `HEARTBEAT.md` with the checklist items. The assistant will work through this file each heartbeat run.

## Notes

- Toggling `heartbeat.enabled` requires an assistant restart to take effect.
- Changes to `HEARTBEAT.md` take effect on the next heartbeat run (no restart needed).
- The heartbeat runs in a separate background conversation, not the user's active chat.
