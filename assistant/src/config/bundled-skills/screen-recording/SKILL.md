---
name: "Screen Recording"
description: "Record the user's screen as a video file"
metadata: {"vellum": {"emoji": "🎬", "os": ["darwin"]}}
---

Capture screen recordings as video files attached to the conversation.

## Activation

This skill activates when the user asks to record their screen. Intent is resolved through a two-tier pipeline:

1. **Structured `commandIntent`** (primary path) — The client sends a `commandIntent` payload with `domain: "screen_recording"` and `action: "start" | "stop"`. This bypasses all text parsing and is the preferred routing mechanism. The macOS/iOS client sends this when the user taps a dedicated recording button or uses a keyboard shortcut.

2. **Text resolver fallback** — When no `commandIntent` is present, `resolveRecordingIntent()` analyzes the user's natural-language text through a deterministic pipeline:
   - Strip dynamic assistant name prefixes (e.g., "Nova, ...")
   - Strip leading polite wrappers ("please", "hey", etc.)
   - Interrogative gate — WH-questions ("how do I record?") return `none` (no side effects)
   - Detect start/stop recording patterns via regex
   - Classify as pure intent or extract a remainder for mixed-intent prompts

## Intent Resolution

The text resolver produces a `RecordingIntentResult` with one of these kinds:

- **`start_only`** — Pure recording request with no additional task (e.g., "record my screen")
- **`stop_only`** — Pure stop request with no additional task (e.g., "stop recording")
- **`start_with_remainder`** — Recording intent embedded in a broader task (e.g., "open Safari and record my screen"). The remainder ("open Safari") is forwarded to normal processing while recording starts as a side effect.
- **`stop_with_remainder`** — Stop intent embedded in a broader task (e.g., "stop recording and close the browser")
- **`start_and_stop_only`** — Both start and stop with no remainder (e.g., "stop recording and start a new recording")
- **`start_and_stop_with_remainder`** — Both start and stop with additional task text
- **`none`** — No recording intent detected, or the message is a question about recording

## Routing Examples

**Structured intent (commandIntent path):**
```
{ commandIntent: { domain: "screen_recording", action: "start" } }
  -> Starts recording immediately, no text parsing
{ commandIntent: { domain: "screen_recording", action: "stop" } }
  -> Stops recording immediately, no text parsing
```

**Text resolver (fallback path):**
```
"record my screen"         -> start_only     -> standalone recording route
"stop recording"           -> stop_only      -> standalone recording route
"Nova, start recording"    -> start_only     -> standalone recording route (name stripped)
"please record my screen"  -> start_only     -> standalone recording route (filler stripped)
"how do I record?"         -> none           -> normal routing (interrogative gate)
"open Safari and record"   -> start_with_remainder -> recording starts, "open Safari" continues
"stop recording and close" -> stop_with_remainder  -> recording stops, "close" continues
```

Recording-only intents (`start_only`, `stop_only`, `start_and_stop_only`) are handled by the **standalone recording route** -- they do NOT create a computer-use session.

## Behavior Rules

1. **Do not invoke computer use** for recording-only requests. The daemon handles these directly.
2. **One recording at a time.** If a recording is already active, starting another returns an "already recording" message.
3. **Conversation-scoped.** Each recording is linked to the conversation that started it. Stopping in a different thread does not affect unrelated recordings.
4. **Permission required.** Screen recording requires macOS Screen Recording permission. If denied, the user sees actionable guidance to enable it in System Settings.
5. **Mixed-intent prompts** (recording + other task) start/stop the recording as a side effect while the remainder text proceeds through normal classification and routing.
6. **Questions are not commands.** WH-questions like "how do I stop recording?" are routed to the assistant for a text answer, not treated as recording commands.

## What This Skill Does NOT Do

- This skill does not contain recorder logic -- the `RecordingManager` and `ScreenRecorder` in the macOS app handle the actual recording.
- This skill does not provide shell commands or scripts for recording.
- This skill does not fall back to computer use for recording tasks.
