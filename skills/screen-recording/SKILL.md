---
name: screen-recording
description: Record the user's screen as a video file
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎬"
  vellum:
    display-name: "Screen Recording"
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
- "Nova, record my screen" (where Nova is the assistant's identity name)
- "hey Nova, start recording"

**Stop recording:**

- "stop recording"
- "end recording"
- "finish recording"
- "halt recording"

**Restart recording:**

- "restart recording"
- "redo the recording"
- "stop recording and start a new one"
- "stop recording and start a new recording"
- "stop and restart the recording"

**Pause recording:**

- "pause recording"
- "pause the recording"

**Resume recording:**

- "resume recording"
- "unpause the recording"

## Routing

Recording is managed through dedicated HTTP endpoints (`/v1/recordings/*`) rather than text-based intent detection. Two routing mechanisms exist:

### 1. `commandIntent` (structured command) — highest priority

The macOS client can send structured intents with `domain: 'screen_recording'` and `action: 'start' | 'stop' | 'restart' | 'pause' | 'resume'`. These bypass text parsing entirely. The assistant checks for `commandIntent` before any text analysis.

### 2. HTTP endpoints

Clients call the recording HTTP endpoints directly:

- `POST /v1/recordings/start` — start a screen recording
- `POST /v1/recordings/stop` — stop the active recording
- `POST /v1/recordings/pause` — pause the active recording
- `POST /v1/recordings/resume` — resume a paused recording
- `GET /v1/recordings/status` — get current recording status
- `POST /v1/recordings/status` — recording lifecycle callback from the client

### 3. Normal processing

If no recording intent is detected, the message flows to the classifier and computer-use session as usual.

## Behavior Rules

1. **Do not invoke computer use** for recording-only requests. The assistant handles these directly.
2. **One recording at a time.** If a recording is already active, starting another returns an "already recording" message.
3. **Conversation-linked.** Each recording is linked to the conversation that started it for attachment purposes. However, since only one recording can be active at a time, stop commands from any conversation will stop the active recording regardless of which conversation started it.
4. **Permission required.** Screen recording requires macOS Screen Recording permission. If denied, the user sees actionable guidance to enable it in System Settings.
5. **Mixed-intent prompts** (recording + other task) are NOT intercepted by the standalone route — the recording action is deferred and executed alongside the task.
6. **Restart always reopens the source picker** and requires source reselection.
7. **Restart cancel** (user closes the source picker) leaves state idle — no false "recording started" message.
8. **Pause/resume toggle the recording** without stopping it. The HUD shows paused state.

## What This Skill Does NOT Do

- This skill does not contain recorder logic — the `RecordingManager` and `ScreenRecorder` in the macOS app handle the actual recording.
- This skill does not provide shell commands or scripts for recording.
- This skill does not fall back to computer use for recording tasks.
- This skill does not handle informational questions about recording — those flow through to normal AI response.
