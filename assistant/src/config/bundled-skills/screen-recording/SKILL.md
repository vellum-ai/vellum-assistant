---
name: screen-recording
description: Record the user's screen as a video file
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🎬","vellum":{"display-name":"Screen Recording","os":["darwin"]}}
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

## Intent Classification

Recording prompts are classified by `resolveRecordingIntent` into one of 11 intent kinds:

### Pure commands (handled by the standalone recording route)

- **`start_only`** — Pure start request with no additional task (e.g., "record my screen").
- **`stop_only`** — Pure stop request (e.g., "stop recording").
- **`restart_only`** — Pure restart request (e.g., "restart recording", "stop recording and start a new one").
- **`pause_only`** — Pure pause request (e.g., "pause the recording").
- **`resume_only`** — Pure resume request (e.g., "resume the recording").

### Recording + additional task (recording action is deferred and executed alongside the task)

- **`start_with_remainder`** — Start recording embedded in a broader task. The recording clause is stripped, and the remainder is processed as a separate task. Example: "open Safari and record my screen" produces remainder "open Safari".
- **`stop_with_remainder`** — Stop recording embedded in a broader task. Example: "close the browser and stop recording" produces remainder "close the browser".
- **`restart_with_remainder`** — Restart recording embedded in a broader task. Example: "restart recording and open Safari" produces remainder "open Safari".

### Both start and stop detected

- **`start_and_stop_only`** — Both start and stop patterns present with no additional task (e.g., "stop recording and record my screen").
- **`start_and_stop_with_remainder`** — Both start and stop patterns present alongside additional task text.

### No recording intent

- **`none`** — No recording intent detected. Normal routing.

Dynamic name prefixes (from IDENTITY.md) are stripped during classification, so "Nova, record my screen" classifies the same as "record my screen".

## Routing

Recording intent resolution follows a precedence chain:

### 1. `commandIntent` (structured IPC) — highest priority

The macOS client can send structured intents with `domain: 'screen_recording'` and `action: 'start' | 'stop' | 'restart' | 'pause' | 'resume'`. These bypass text parsing entirely. The assistant checks for `commandIntent` before any text analysis.

### 2. Deterministic text resolver (`resolveRecordingIntent`)

A regex-based pipeline that classifies the user's text. The pipeline:

1. Strips dynamic assistant names (leading vocative like "Nova, ...")
2. Strips leading polite wrappers ("please", "can you", etc.)
3. Applies the interrogative guard — WH-questions return `none`
4. Checks restart compound patterns (before independent start/stop, so "stop recording and start a new one" is recognized as restart)
5. Checks pause/resume patterns
6. Checks start and stop patterns independently
7. Determines if the intent is pure or has a remainder by stripping recording clauses and checking for substantive remaining content

### 3. Normal processing

If no recording intent is detected (kind is `none`), the message flows to the classifier and computer-use session as usual.

## Interrogative Guard

Questions about recording are NOT treated as commands. The resolver filters out WH-questions to prevent side effects from informational queries.

**Filtered (no recording action triggered):**

- "how do I stop recording?"
- "what does screen recording do?"
- "why is the recording paused?"
- "when should I stop recording?"

**Preserved as commands (recording action IS triggered):**

- "can you stop recording?" — polite imperative
- "could you record my screen?" — polite imperative
- "please stop recording" — direct command with filler

The guard checks for WH-question starters (how, what, why, when, where, who, which) at the beginning of the text, after stripping dynamic names and polite prefixes.

## Mixed-Intent Examples

When a recording intent is combined with another task, the recording clause is stripped from the text, and both parts are handled:

- **"open Safari and record my screen"** — `start_with_remainder` with remainder "open Safari". Recording starts alongside the Safari task.
- **"stop recording and start a new one and open Safari"** — `restart_with_remainder` with remainder "open Safari". Restart executes and the remainder is processed separately.
- **"close the browser and stop recording"** — `stop_with_remainder` with remainder "close the browser". Stop executes and the remainder is processed.

The remainder preserves the user's original phrasing (stripping is applied to the original text, not the normalized form).

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
