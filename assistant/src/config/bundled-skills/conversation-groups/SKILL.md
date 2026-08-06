---
name: conversation-groups
description: Organize conversations into custom sidebar groups — list groups, create new ones, and file conversations into them
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🗂️"
  vellum:
    display-name: "Conversation Groups"
    category: "productivity"
---

Organize the user's conversations into sidebar groups. Groups are the sections shown in the conversation sidebar; each conversation belongs to exactly one group.

## Groups

- **Custom groups** are user-defined sections (e.g. "Work", "Travel planning"). Create them with `conversation_group_create` and file conversations with `conversation_move_to_group`.
- **System groups** are built in and cannot be created, renamed, or deleted:
  - `system:pinned` (Pinned) — moving a conversation here pins it; moving it elsewhere unpins it.
  - `system:all` (Recents) — the default ungrouped section. Move a conversation here to "remove" it from a custom group.
  - `system:scheduled` (Scheduled) and `system:background` (Background) — hold automated conversations. Moving a conversation into these demotes it out of the Recents listing; avoid unless the user explicitly asks.

## Usage

- `conversation_move_to_group` defaults to the **current** conversation, so "file this chat under Work" needs no conversation id.
- Groups can be referenced by name (case-insensitive) or id. Prefer names; fall back to ids when names are ambiguous.
- When the user asks to organize their conversations, check the existing groups first (`conversation_group_list`) and reuse a fitting group rather than creating near-duplicates ("Work" vs "Work stuff").
- Creating a group whose name already exists reuses the existing group instead of creating a duplicate.
- Moves only affect sidebar organization — no conversation content changes, and every move is reversible.
- Subagent and background conversations are hidden from the sidebar regardless of group; moving them has no visible effect.
