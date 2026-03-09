---
name: playbooks
description: Trigger-action automation rules for handling incoming messages
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"📖","vellum":{"display-name":"Playbooks"}}
---

Playbooks are trigger-action automation rules that tell the assistant how to handle incoming messages matching a pattern.

## Structure

Each playbook has:

- **Trigger**: Pattern or description that activates the rule (e.g. "meeting request", "from:ceo@*")
- **Action**: What to do when triggered (natural language description)
- **Channel**: Which channel the rule applies to ("*" = all channels, or specific like "email", "slack")
- **Category**: Free-form grouping label (e.g. "scheduling", "triage")
- **Autonomy level**: How much autonomy the assistant has
  - `auto` -- execute immediately without asking
  - `draft` -- prepare a response for user review (default)
  - `notify` -- alert the user only
- **Priority**: Numeric priority for overlapping rules (higher = takes precedence)

## Lifecycle

1. Create a playbook with `playbook_create` specifying trigger and action.
2. List existing playbooks with `playbook_list`, optionally filtering by channel or category.
3. Update rules with `playbook_update` or remove them with `playbook_delete`.

## Storage

Playbooks are stored as memory items with semantic retrieval, enabling fuzzy matching of incoming messages against trigger patterns.
