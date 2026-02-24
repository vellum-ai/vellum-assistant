---
name: "Screen Recording"
description: "Capture screen recordings during computer-use sessions. Records the display or a specific window as H.264 MP4 video with optional audio."
user-invocable: false
disable-model-invocation: false
metadata:
  vellum:
    emoji: "🎥"
    os: ["darwin"]
---

# Screen Recording

You have access to a screen recording capability that captures what happens on the user's Mac during computer-use sessions.

## How It Works

- **Automatic in QA mode**: When a QA/test session starts, recording begins automatically before any destructive actions (clicks, typing, etc.)
- **Can be requested explicitly**: Sessions can be configured with `requiresRecording: true` to enable recording outside of QA mode
- **Recording gate**: When recording is required, destructive actions are blocked until the first video frame is confirmed captured

## Recording Details

- **Format**: H.264 MP4 video at 30 fps
- **Resolution**: 1920×1080
- **Bitrate**: 4 Mbps video, 128 kbps AAC audio (when audio is enabled)
- **Capture scope**: Either the full display or a specific window
- **Storage**: Files are saved to `~/Library/Application Support/vellum-assistant/recordings/`
- **Naming**: `qa-recording-{timestamp}.mp4`

## Health Checks

A first-frame handshake verifies the capture pipeline is healthy within 5 seconds of starting. If no frames arrive:
- **Required recording**: The session fails immediately with a clear error
- **Optional recording**: A warning is shown but the session continues

## After Recording

When a recording completes:
1. The video file is saved to disk
2. A file-backed attachment is created (metadata in DB, file stays on disk)
3. The attachment is linked to the originating chat message
4. The video appears inline in the conversation for playback

## Retention

Recordings have an expiration timestamp (default: 7 days, configurable). An automatic cleanup worker runs periodically (every 6 hours) and deletes expired recording files from disk.

## Limitations

- Requires Screen Recording permission in System Settings > Privacy & Security
- Only available on macOS
- One recording at a time per session
- Recording must be stopped explicitly (or stops when the session ends)
- Large recordings consume disk space until cleanup runs

## When to Mention Recording

- Tell users their QA session is being recorded when relevant
- Offer to analyze recordings using the media-processing skill (keyframe extraction, event detection)
- Mention retention period if users ask about storage or cleanup
- If recording fails, explain the specific error (permission denied, no display found, etc.)
