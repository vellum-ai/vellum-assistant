---
name: "Screen Recording"
description: "Record the user's screen as a video file"
metadata: {"vellum": {"emoji": "🎬"}}
---

Capture screen recordings as video files attached to the conversation.

## Activation

This skill activates when the user asks to record their screen. Common phrases:

**Start recording:**
- "record my screen"
- "start recording"
- "begin recording"
- "capture my screen"
- "capture my display"
- "make a recording"

**Stop recording:**
- "stop recording"
- "end recording"
- "finish recording"
- "halt recording"

## Routing

Recording-only requests are handled by the **standalone recording route** — they do NOT create a computer-use session.

- When the user says "record my screen" (with no other task), the daemon intercepts this and starts a standalone recording directly.
- When the user says "stop recording", the daemon intercepts and stops the active recording for the current conversation.
- The recording is saved as a video file and attached to the conversation thread.

## Behavior Rules

1. **Do not invoke computer use** for recording-only requests. The daemon handles these directly.
2. **One recording at a time.** If a recording is already active, starting another returns an "already recording" message.
3. **Conversation-scoped.** Each recording is linked to the conversation that started it. Stopping in a different thread does not affect unrelated recordings.
4. **Permission required.** Screen recording requires macOS Screen Recording permission. If denied, the user sees actionable guidance to enable it in System Settings.

## What This Skill Does NOT Do

- This skill does not contain recorder logic — the `RecordingManager` and `ScreenRecorder` in the macOS app handle the actual recording.
- This skill does not provide shell commands or scripts for recording.
- This skill does not fall back to computer use for recording tasks.
