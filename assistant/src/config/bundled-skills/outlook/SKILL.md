---
name: outlook
description: Archive, categorize, draft, unsubscribe, and manage Outlook email
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F4E7"
  vellum:
    display-name: "Outlook"
---

This skill provides Outlook-specific tools beyond the shared **messaging** skill. For cross-platform messaging (send, read, search, reply), use the messaging skill. Outlook tools depend on the messaging skill's provider infrastructure - load messaging first if Outlook is not yet connected.

## Tool Reference

| Tool | Description |
| --- | --- |
| `outlook_attachments` | List and download email attachments |
| `outlook_trash` | Move messages to Deleted Items |
| `outlook_categories` | Manage message categories (add, remove, list available) |
| `outlook_follow_up` | Track messages with Outlook's native flag system |
| `outlook_draft` | Create email drafts in the Drafts folder (including reply drafts) |
| `outlook_send_draft` | Send an existing draft (high-risk - requires explicit user confirmation) |
| `outlook_forward` | Create forward drafts, preserving attachments |
| `outlook_unsubscribe` | Unsubscribe from mailing lists via List-Unsubscribe header |
| `outlook_sender_digest` | Scan inbox and group messages by sender for declutter workflows |
| `outlook_outreach_scan` | Identify cold outreach senders (no List-Unsubscribe header) |
| `outlook_rules` | Create, list, and delete server-side inbox message rules |
| `outlook_vacation` | Get, enable, or disable auto-reply (out-of-office) settings |

All tools above are Outlook-specific. For shared operations (send, read, search, reply, archive), use `messaging_send`, `messaging_search`, etc. from the messaging skill.

## Email Routing Priority

When the user mentions "email" - sending, reading, checking, decluttering, drafting, or anything else - **always default to the user's own email (Outlook)** unless they explicitly ask about the assistant's own email address (e.g., "set up your email", "send from your address", "check your inbox"). The vast majority of email requests are about the user's Outlook, not the assistant's AgentMail address.

Do not offer AgentMail as an option or mention it unless the user specifically asks. If Outlook is not connected, guide them through Outlook setup - do not suggest AgentMail as an alternative.

## Communication Style

- **Be action-oriented.** When the user asks to do something ("declutter", "check my email"), start doing it immediately. Don't ask for permission to read their inbox - that's obviously what they want.
- **Keep it human.** Never mention OAuth, tokens, APIs, sandboxes, credential proxies, or other technical internals. If something isn't working, say "Outlook needs to be reconnected" - not "the OAuth2 access token for outlook has expired."
- **Show progress.** When running a tool that scans many emails, tell the user what you're doing: "Scanning your inbox for clutter..." Don't go silent.
- **Be brief and warm.** One or two sentences per update is plenty. Don't over-explain what you're about to do - just do it and narrate lightly.

## Error Recovery

When an Outlook tool fails with a token or authorization error:

1. **Try to reconnect silently.** Call `assistant oauth ping outlook`. This often resolves expired tokens automatically.
2. **If reconnection fails, go straight to setup.** Don't present options, ask which route the user prefers, or explain what went wrong technically. Just tell the user briefly (e.g., "Outlook needs to be reconnected - let me set that up") and immediately follow the connection setup flow for Outlook. The user came to you to get something done, not to troubleshoot OAuth - make it seamless.
3. **Never try alternative approaches.** Don't use bash, curl, browser automation, or any workaround. If the Outlook tools can't do it, the reconnection flow is the answer.
4. **Never expose error details.** The user doesn't need to see error messages about tokens, OAuth, or API failures. Translate errors into plain language.

## Drafting vs Sending (Outlook)

Outlook uses a **draft-first workflow** where appropriate:

- `messaging_send` (Outlook) sends messages directly via the Graph API.
- `outlook_draft` creates a draft in the Outlook Drafts folder for user review before sending.
- `outlook_forward` creates a forward draft, preserving attachments.

When the user asks to "draft" or "compose" an email, use `outlook_draft`. When they say "send", use `messaging_send`. If ambiguous, prefer drafting so the user can review first.

## Differences from Gmail

Outlook and Gmail have different organizational models. Keep these distinctions in mind:

| Concept | Gmail | Outlook |
| --- | --- | --- |
| **Organization** | Labels (multiple per message) | Folders (one per message) + Categories (multiple per message) |
| **Categorization** | Labels serve dual purpose | Categories are color-coded tags independent of folder location |
| **Follow-up** | Label-based tracking | Native flag system (`flagged`, `complete`, `notFlagged`) |
| **Inbox rules** | Gmail filters | Outlook inbox rules (server-side) |
| **Archive** | Remove INBOX label | Move to Archive folder |

### Categories

Categories are Outlook's tagging system for organizing messages. Unlike Gmail labels, categories are independent of folder structure - a message can be in any folder and have multiple categories. Categories are color-coded (Blue, Green, Orange, Purple, Red, Yellow, or custom names). Use categories to tag and organize messages without moving them between folders.

### Follow-up Flags

Outlook uses a native flag system for follow-up tracking:

- `flagged` - message is marked for follow-up
- `complete` - follow-up is done
- `notFlagged` - no follow-up tracking

This replaces Gmail's label-based follow-up approach. Use the Outlook flag system directly rather than creating custom folder-based workarounds.

### Inbox Rules vs Gmail Filters

Outlook inbox rules (`outlook_rules`) run server-side and support conditions like sender, subject, body keywords, and importance level. Actions include moving to folders, categorizing, flagging, forwarding, and deleting. Gmail filters (`gmail_filters`) are similar but use Gmail's query syntax and label-based actions. When a user asks to "filter" or "auto-sort" email, use `outlook_rules` - do not try to replicate Gmail's label-based filtering with Outlook folders.

### Folders vs Labels

Gmail uses labels - a message can have multiple labels and removing the INBOX label archives it. Outlook uses folders - a message lives in exactly one folder at a time. Moving a message to Archive removes it from Inbox. To tag a message with multiple categories without moving it, use `outlook_categories`. Do not create folder hierarchies to simulate Gmail's multi-label system.

## Email Decluttering

When a user asks to declutter, clean up, or organize their email - start scanning immediately. Don't ask what kind of cleanup they want or request permission to read their inbox. Go straight to scanning - but once results are ready, always show them via `ui_show` and let the user choose actions before archiving or unsubscribing.

**CRITICAL**: Never call `messaging_archive_by_sender`, `outlook_unsubscribe`, or similar bulk actions unless the user has clicked an action button on the table for that specific batch. Each batch of results requires its own explicit user confirmation via the table UI. If the user says "keep going" or "keep decluttering," that means scan and present a new table - NOT auto-archive. Previous batch approvals do not carry forward, but **deselections DO carry forward**: when the user deselects senders from a cleanup table, the system records those deselections as user preferences. Before building the next cleanup table, check `<dynamic-user-profile>` for previously deselected senders and exclude them from future cleanup tables - the user already indicated they want to keep those.

### Workflow

1. **Scan**: Call `outlook_sender_digest`. Default query targets promotional messages from the last 90 days.
2. **Present**: Show results as a `ui_show` table with `selectionMode: "multiple"`:
   - **Columns (exactly 3)**: Sender, Emails Found, Unsub?
     - **Unsub? cell values**: Use rich cell format: `{ "text": "Yes", "icon": "checkmark.circle.fill", "iconColor": "success" }` when `has_unsubscribe` is true, `{ "text": "No", "icon": "minus.circle", "iconColor": "muted" }` when false.
   - **Pre-select all rows** (`selected: true`) - users deselect what they want to keep
   - **Caption**: Include two parts separated by a newline: (1) data scope, e.g. "Newsletters, notifications, and outreach from last 90 days. Deselect anything you want to keep." (adjusted to match the query used), and (2) the Unsub? column legend: "Unsub? - \"Yes\" means these emails contain an unsubscribe link, so I can opt you out automatically. \"No\" means no unsubscribe link was found - these will be archived but you may continue receiving them."
   - **Action buttons (exactly 2)**: "Archive & Unsubscribe" (primary), "Archive Only" (secondary). **NEVER offer Delete, Trash, or any destructive action.**
3. **Wait for user action**: Stop and wait. Do NOT proceed to archiving or unsubscribing until the user clicks one of the action buttons on the table. When the user clicks an action button:
   - **Dismiss the table immediately** with `ui_dismiss` - it collapses to a completion chip
   - **Show a `task_progress` card** with steps for each phase (e.g., "Archiving 89 senders (2,400 emails)", "Unsubscribing from 72 senders"). Update each step from `in_progress` to `completed` as each phase finishes.
   - When all senders are processed, set the progress card's `status: "completed"`.
4. **Act on selection** - batch, don't loop:
   - **Archive all at once**: Call `messaging_archive_by_sender` **once** with `scan_id` + **all** selected senders' `id` values in the `sender_ids` array. The tool resolves message IDs server-side and batches the API calls internally - never loop sender-by-sender.
   - **Unsubscribe in bulk**: If the action is "Archive & Unsubscribe", call `outlook_unsubscribe` for each sender that has `has_unsubscribe: true` - but emit **all** unsubscribe tool calls in a **single assistant response** (parallel tool use) rather than one-at-a-time across separate turns.
5. **Accurate summary**: The scan counts are exact - the `message_count` shown in the table matches the number of messages archived. Format: "Cleaned up [total_archived] emails from [sender_count] senders. Unsubscribed from [unsub_count]."
6. **Ongoing protection offer**: After reporting results, offer inbox rules:
   - "Want me to set up inbox rules so future emails from these senders skip your inbox?"
   - If yes, call `outlook_rules` with `action: "create"` for each sender.
   - Then offer a recurring declutter schedule: "Want me to scan for new clutter monthly?" If yes, use `schedule_create` to set up a monthly declutter check.

### Edge Cases

- **Zero results**: Tell the user "No newsletter emails found" and suggest broadening the query (e.g. extending the date range)
- **Unsubscribe failures**: Report per-sender success/failure; the `outlook_unsubscribe` tool handles edge cases
- **Truncation handling**: If `truncated` is true, the top senders are still captured - don't offer to scan more. Tell the user: "Scanned [N] messages - here are your top senders."
- **Time budget exceeded**: If the scan returns `time_budget_exceeded: true`, present whatever results were collected. Do not retry or continue - the partial results are useful as-is.

## Scan ID

Scan tools (`outlook_sender_digest`, `outlook_outreach_scan`) return a `scan_id` that references message IDs stored server-side. This keeps thousands of message IDs out of the conversation context.

- Pass `scan_id` + `sender_ids` to `messaging_archive_by_sender` instead of `message_ids`
- Scan results expire after **30 minutes** - if archiving fails with an expiration error, re-run the scan
- Raw `message_ids` still work as a fallback for non-scan workflows

## Batch Operations

- `messaging_archive_by_sender` supports `scan_id` + `sender_ids` (preferred for declutter workflows) or raw `message_ids`.
- First scan to get a `scan_id`, then use `messaging_archive_by_sender` to batch-archive by sender.
- Always confirm with the user before batch operations on large numbers of messages.

## Common Workflows

### Declutter Inbox

1. Call `outlook_sender_digest` to scan for newsletters and promotions
2. Present results via `ui_show` table (see Email Decluttering section for full workflow)
3. Wait for user to select senders and click an action button
4. Call `messaging_archive_by_sender` with `scan_id` + selected `sender_ids`
5. If "Archive & Unsubscribe", also call `outlook_unsubscribe` for senders with `has_unsubscribe: true`
6. Offer to create inbox rules for ongoing protection

### Create a Mail Rule

1. User says "auto-archive emails from newsletters@example.com"
2. Call `outlook_rules` with `action: "create"`, specifying the sender condition and the move-to-folder action
3. Confirm the rule was created and explain what it does

### Set Vacation Auto-Reply

1. User says "set my out-of-office for next week"
2. Call `outlook_vacation` with `action: "enable"`, the date range, and the auto-reply message
3. Confirm the auto-reply is active and when it expires

### Manage Follow-ups

1. User says "flag this email for follow-up" - call `outlook_follow_up` with `action: "track"` and the message ID
2. User says "what emails am I tracking?" - call `outlook_follow_up` with `action: "list"` to show all flagged messages
3. User says "mark that as done" - call `outlook_follow_up` with `action: "complete"` to clear the flag

### Identify Cold Outreach

1. Call `outlook_outreach_scan` to find senders without unsubscribe headers
2. Present results for review - these are likely cold outreach or unsolicited emails
3. User can choose to archive, create rules to block, or ignore

## Confidence Scores

Medium and high risk tools require a confidence score between 0 and 1:

- **0.9-1.0**: User explicitly requested this exact action
- **0.7-0.8**: Action is strongly implied by context
- **0.5-0.6**: Reasonable inference but some ambiguity
- **Below 0.5**: Ask the user to confirm before proceeding
