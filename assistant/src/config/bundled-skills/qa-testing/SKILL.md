---
name: "QA Testing"
description: "Run QA and testing workflows with automatic screen recording, strict focus management, and post-session video analysis."
user-invocable: false
disable-model-invocation: false
includes: ["screen-recording", "media-processing"]
metadata: {"vellum": {"emoji": "🧪", "os": ["darwin"]}}
---

# QA Testing

This skill orchestrates QA and testing workflows by composing screen recording and media analysis capabilities.

## How QA Mode Works

QA mode is activated automatically when the user's message indicates a testing intent — phrases like "test the login flow", "QA the checkout", "verify the form works", etc. You do NOT need to explicitly activate it.

### What happens in QA mode:

1. **Screen recording starts automatically** before any destructive actions
2. **Strict focus management** ensures the target app stays frontmost throughout
3. **Recording gate** blocks clicks/typing until the first video frame is captured
4. **Post-action focus drift** is terminal — if the target app loses focus, the session fails immediately
5. **On completion**, the recording is attached to the chat as a playable video

### QA Latch

Once QA mode is activated for a conversation, it "latches" — subsequent tasks in the same thread inherit QA mode automatically. The user can opt out with phrases like "stop QA mode" or "disable recording."

## Strict Visual QA

When a target app is specified (bundle ID or app name), strict visual QA activates:

- **Pre-action**: Focus is verified before every destructive action
- **Post-action**: Focus is re-verified after every action
- **open_app verification**: After opening an app, FocusManager confirms it's actually frontmost
- **Failure is terminal**: Any focus drift immediately fails the session (no retry, no continue)

This ensures the recording captures exactly what happened in the target app, with no accidental interactions in other apps.

## Post-Session Analysis

After a QA session completes, you can offer to analyze the recording:

1. **Ingest** the recording using the media-processing skill's `ingest_media` tool
2. **Extract keyframes** to see what happened at each step
3. **Analyze keyframes** to detect UI changes, errors, or unexpected states
4. **Detect events** to find specific moments (button clicks, form submissions, errors)
5. **Generate clips** of interesting segments for sharing

### Example follow-up offers:
- "Would you like me to analyze the recording to identify any issues?"
- "I can extract keyframes from the recording to create a visual summary of the test."
- "Want me to check if any error dialogs appeared during the test?"

## Target App Scoping

QA sessions are scoped to a specific app. The system:
- Injects the target app as a soft constraint in the system prompt
- Does NOT automatically open the app (you decide based on what's on screen)
- Blocks cross-app actions via the proxy resolver
- Uses FocusManager with multi-strategy activation (unhide, NSRunningApplication.activate, AX window raise)

## Recording Lifecycle in QA

```
Session Start
  -> ScreenRecorder.startRecording()
  -> Wait for first frame (5s timeout)
  -> If required and no frames: FAIL immediately
  -> If optional and no frames: warn and continue

During Session
  -> Recording runs continuously
  -> Focus verified before/after each action

Session End
  -> ScreenRecorder.stopRecording() -> RecordingResult
  -> createFileBackedAttachment() stores metadata
  -> linkAttachmentToMessage() ties video to chat
  -> Video appears inline for playback
  -> Cleanup worker deletes after retention period (default: 7 days)
```

## Error Handling

When recording or focus issues occur, communicate specific errors to the user:
- "Screen Recording permission is not granted" — direct them to System Settings
- "First frame not received within 5 seconds" — capture pipeline issue
- "Target app lost focus during testing" — another app stole focus
- "Could not activate [app] after N attempts" — app may be unresponsive

Do NOT use generic error messages. Always surface the specific failure reason.
