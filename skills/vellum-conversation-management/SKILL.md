---
name: vellum-conversation-management
description: Manage conversation threads (rename)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F4AC"
  vellum:
    display-name: "Conversations"
---

Tools for managing conversation threads.

## Renaming

Run `assistant conversations rename <conversationId> "<title>"` to rename a conversation thread when:
- The topic has shifted significantly from the original title
- The auto-generated title is generic or unhelpful
- The user explicitly asks to rename the thread

Keep titles concise (under 60 characters) and descriptive of the current topic.
