---
name: webcam-snapshot
description: Request one user-approved webcam snapshot from the connected macOS or Tauri desktop client and return a concise text summary. Use when the user explicitly asks Jarvis to look through the webcam, see what is in front of the camera, or answer a question about the current camera view.
compatibility: "Designed for Vellum personal assistants. Requires the webcam-snapshot feature flag and a connected macOS or Tauri client."
metadata:
  emoji: "📷"
  vellum:
    display-name: "Webcam Snapshot"
    feature-flag: "webcam-snapshot"
    activation-hints:
      - "User asks the assistant to look through the webcam once"
      - "User asks what the camera can see right now"
      - "User asks a question about the current physical scene in front of the camera"
    avoid-when:
      - "User wants ambient or continuous camera monitoring"
      - "Task can be answered without camera access"
---

This skill exposes a single request-scoped host proxy tool for one webcam
snapshot. Each use asks the desktop client for one still frame, summarizes that
frame, and discards the raw image.

## Tool

Use `describe_camera_once` only when the user has explicitly asked for camera
access or when the current task clearly requires a one-shot camera view.

Pass a short `prompt` describing what to focus on, for example:

```json
{ "prompt": "Describe what is visible on the desk." }
```

The user-visible approval should be clear that Jarvis is requesting one webcam
snapshot. Do not claim continuous camera access, recording, or persistent image
storage.
