---
name: meet-join
description: Join a Google Meet call to take notes; only when the user explicitly asks.
metadata:
  emoji: "📹"
  feature-flag: meet
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
- If the `meet` feature flag is disabled, the meet tools return a clear error — relay that to the user rather than retrying.

## Transcription

Transcription quality and latency reflect the user's configured `services.stt.provider`. Deepgram and Gemini stream over a WebSocket and return sub-second partials; Whisper approximates streaming with ~400 ms polls and therefore produces finals slightly later. Speaker attribution in meeting transcripts is derived from the Meet DOM active-speaker signal — it is independent of the STT provider.

## Participating in chat

The `meet_send_chat` tool posts a message into the active meeting's chat:

```
meet_send_chat(text: "The doc we were looking for is https://example.com/spec")
```

When a single meeting is active, `meetingId` can be omitted. If no meeting is active, the tool fails with a clear error — surface the error back to the user rather than retrying.

Chat is appropriate when:

- The user explicitly asked the assistant to say something in chat.
- A participant addressed the assistant by name with a direct question.
- A short, highly relevant resource would help (e.g. a link participants are trying to recall).
- A brief factual clarification is warranted — something concrete and verifiable, not an opinion.

Avoid chat for:

- Long messages (roughly >500 characters) — if the answer does not fit in a short line, it probably belongs in a follow-up doc or DM, not chat.
- Multiple messages in quick succession. One message, then wait.
- Commentary on tone, mood, or the dynamic of the conversation.
- Responding to passing mentions of the assistant that were not actual questions.
- Jokes, pleasantries, or meta-commentary about the assistant's own presence.

### Proactive chat opportunities

A background chat-opportunity detector watches the meeting transcript and, when it judges that the moment might warrant a response from the assistant, wakes the agent loop with a hint. The hint is delivered as an internal user message prepended with `[opportunity:meet-chat-opportunity] <reason>`. At that point the assistant can call `meet_send_chat` if appropriate.

Key points:

- **The detector flags opportunities; the final decision is the assistant's.** Being woken does not mean the assistant must respond. Doing nothing — no tool call, no user-visible output — is a valid and frequent outcome. Prefer silence when the meeting can resolve the moment without external input.
- **There is a 30-second cooldown between proactive escalations**, enforced by the system regardless of detector signal. The assistant does not need to track this itself, but should know that rapid follow-ups to the same opportunity are not possible by design — one well-chosen message is better than trying to layer on corrections.
- **Prefer brevity** — aim for under 200 characters when responding to an opportunity hint.
- **Prefer concrete information over pleasantries.** If there is no specific fact, link, or clarification to contribute, stay silent.

## Participating by voice

The `meet_speak` tool synthesizes text to speech and plays it through the bot's microphone in the meeting:

```
meet_speak(text: "Yes, the meeting is scheduled to end in 30 seconds.")
```

When a single meeting is active, `meetingId` can be omitted. The `voice` parameter is optional — when omitted, the configured TTS voice is used.

Voice is appropriate when:

- A participant directly addressed the assistant by name and a spoken answer is clearly what they want (not a chat reply).
- The user gave explicit permission for the assistant to chime in verbally.
- A safety or time-critical update warrants interrupting audibly (e.g. "the meeting is ending in 30 seconds per your calendar").

Avoid voice for:

- Unsolicited commentary or observations.
- Long responses — keep voice turns under roughly 20 seconds. If the answer is longer, use `meet_send_chat` instead.
- Anything where participants have not signalled they want voice output from the assistant. When in doubt, prefer chat or silence.

Barge-in is automatic: if a human speaks while the assistant is talking, the assistant's audio is cancelled mid-utterance. Treat being interrupted as normal — do not retry the cancelled utterance or apologize for it.
