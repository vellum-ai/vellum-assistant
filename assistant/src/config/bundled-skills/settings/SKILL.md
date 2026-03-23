---
name: settings
description: Manage assistant voice, avatar, and system settings
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\u2699\uFE0F"
  vellum:
    display-name: "Settings"
---

Tools for managing assistant settings: voice configuration (TTS voice, PTT activation key, conversation timeout), avatar management, system settings navigation, and in-app settings tab navigation.

## Avatar

When the user asks to set, change, or update your avatar to an image they provide:

1. Find the uploaded image in the conversation attachments directory
2. Use the `set_avatar` tool with the `image_path` parameter set to the workspace-relative path (e.g. `conversations/<id>/attachments/Dropped Image.png`)

The tool copies the image to the canonical location (`data/avatar/avatar-image.png`), removes any native character files, and notifies the app to refresh automatically. **Do NOT use `bash` or `cp` to set the avatar** — always use the `set_avatar` tool so the app is properly notified.
