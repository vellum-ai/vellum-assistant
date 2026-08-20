---
name: vellum-conversation-management
description: Manage conversation threads (rename, list, search, export)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    category: "productivity"
    display-name: "Conversations"
---

Tools for managing conversation threads via the `assistant conversations` CLI.

## Renaming

Rename the current conversation thread when:

- The topic has shifted significantly from the original title
- The auto-generated title is generic or unhelpful
- The user explicitly asks to rename the thread

Keep titles concise (under 60 characters) and descriptive of the current topic.

```bash
assistant conversations rename <conversationId> "<new title>"
```

## Listing

List all conversations with their IDs and titles:

```bash
assistant conversations list
```

## Searching

Search conversation titles and message content. Quote multi-word terms. Archived conversations are excluded, matching `assistant conversations list`.

```bash
assistant conversations search "project planning"
assistant conversations search flux --limit 5
assistant conversations search "quarterly metrics" --json
```

## Exporting

Export a conversation as markdown or JSON:

```bash
assistant conversations export [conversationId] [--format md|json] [-o file]
```
