---
name: "Screen Recording"
description: "Record screen activity during computer-use sessions. Supports multi-display selection, audio capture, and automatic video attachment creation."
user-invocable: false
disable-model-invocation: true
---

This skill provides screen recording capabilities for computer-use sessions.

When a user requests recording (e.g., "record my screen while you do X"), the
daemon detects recording intent and routes the task as a computer-use session
with `requiresRecording=true`.

The macOS client handles the actual recording via ScreenCaptureKit. On
multi-display setups, a source picker lets the user choose which display or
window to record.

Recordings are automatically saved as file-backed attachments and linked to
the session's chat thread for inline playback with seek, drag, and save
support.

## Configuration

Add a `recording` block to your assistant config:

```yaml
recording:
  defaultRetentionDays: 30      # 0 = keep forever
  cleanupIntervalMs: 3600000    # 1 hour
  captureScope: display         # display | window
  includeAudio: false
  enforceStartBeforeActions: true
```
