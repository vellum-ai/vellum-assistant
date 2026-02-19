---
name: "Contacts"
description: "Contact and relationship graph with multi-channel tracking and importance scoring"
metadata: {"vellum": {"emoji": "\ud83d\udcca"}}
---

Manage the user's contact and relationship graph. Each contact can have multiple communication channels, an importance score, and interaction tracking.

## Contact Fields

- **display_name** -- the contact's name (required)
- **relationship** -- e.g. colleague, friend, manager, client, family
- **importance** -- score from 0 to 1 (default 0.5), higher means more important
- **response_expectation** -- expected response speed: immediate, within_hours, within_day, casual
- **preferred_tone** -- communication tone: formal, casual, friendly, professional
- **channels** -- list of communication channels (email, slack, whatsapp, phone, telegram, discord, other)

## Channel Types

Supported channel types: `email`, `slack`, `whatsapp`, `phone`, `telegram`, `discord`, `other`

Each channel has:
- **type** -- one of the supported channel types
- **address** -- the channel-specific identifier (email address, phone number, handle, etc.)
- **is_primary** -- whether this is the primary channel for its type

## Merging Contacts

When you discover two contacts are the same person (e.g. same person on email and Slack), use `contact_merge` to consolidate them. Merging:
- Combines all channels from both contacts
- Keeps the higher importance score
- Sums interaction counts
- Deletes the donor contact

## Tips

- Use `contact_search` with `channel_address` to find contacts by their email, phone, or handle.
- When creating follow-ups, provide a `contact_id` to link the follow-up to a specific contact for grace period calculations.
- Contacts with higher importance scores get shorter default response deadlines.
