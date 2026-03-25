---
name: settings
description: Manage assistant voice, avatar (set, remove, view, show), and system settings
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\u2699\uFE0F"
  vellum:
    display-name: "Settings"
---

Tools for managing assistant settings: voice configuration (TTS voice, PTT activation key, conversation timeout), avatar management (set, remove, view/show current avatar), system settings navigation, and in-app settings tab navigation.

## Avatar

When the user asks to set, change, or update your avatar to an image they provide:

1. Find the uploaded image in the conversation attachments directory
2. Use the `set_avatar` tool with the `image_path` parameter set to the workspace-relative path (e.g. `conversations/<id>/attachments/Dropped Image.png`)

The tool copies the image to the canonical location (`data/avatar/avatar-image.png`) and notifies the app to refresh automatically.

When the user asks to remove, clear, or reset their avatar, use the `remove_avatar` tool. It deletes only the custom image and preserves the native character traits so the character avatar is restored automatically.

When the user asks to see, view, or show their current avatar, use the `get_avatar` tool. It returns the avatar image inline. If no custom image exists but character traits are set, it regenerates the static PNG from traits and returns that.

**Do NOT use `bash`, `cp`, `rm`, or `file_read` for avatar operations** — always use `set_avatar` / `remove_avatar` / `get_avatar` so the app is properly notified and character traits are preserved.
