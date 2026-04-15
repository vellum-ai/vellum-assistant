---
name: meet-join
description: Join a Google Meet call to take notes; only when the user explicitly asks.
metadata:
  emoji: "📹"
  vellum:
    display-name: "Meet Join"
---

Use this skill when the user explicitly asks the assistant to join a Google Meet call (e.g. "join my meet", "can you join this call and take notes", usually with a `https://meet.google.com/...` URL in context). Joining a call causes the assistant to appear as a visible participant — never do it proactively.

## When to join

Trigger on clear, explicit user requests only:

- "Join my meet", "join this call", "hop into this meeting" — paired with a Meet URL in the same turn or earlier in the conversation.
- "Take notes on this Meet: https://meet.google.com/abc-defg-hij".

Do NOT trigger on:

- Ambient references to upcoming meetings on the user's calendar.
- Users discussing a meeting they are in without asking you to join.
- Anything without an explicit request verb and a Meet URL.

If the request is ambiguous (e.g. no URL, or an unrelated URL), ask the user to confirm the Meet link before calling the tool.

## How to join

Call the `meet_join` tool with the Meet URL:

```
meet_join(url: "https://meet.google.com/abc-defg-hij")
```

Validate the URL looks like a Google Meet link before calling — the canonical shape is `https://meet.google.com/xxx-yyyy-zzz`. If the URL does not look like a Meet link, ask the user to confirm or paste the correct one.

On join, the assistant bot announces itself in the Meet chat with the configured consent message so other participants know a note-taker is present. Any participant can ask the bot to leave; the bot auto-leaves when it detects objection keywords in the transcript.

## How to leave

Call `meet_leave` when the user says you can step out (e.g. "thanks, you can go now", "drop out of the call") or when you judge that continued presence is no longer useful:

```
meet_leave(reason: "user-requested")
```

When a single meeting is active, `meetingId` can be omitted — the tool targets that meeting automatically. When multiple meetings are active, pass the `meetingId` explicitly.

## Important constraints

- This skill NEVER joins a meeting based on calendar context alone. Always require an explicit user request.
- Only one set of tools is exposed: `meet_join` and `meet_leave`. Future phases may add chat/speak capabilities; this skill will be updated when they land.
- If the `meet` feature flag is disabled, both tools return a clear error — relay that to the user rather than retrying.
