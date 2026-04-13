---
name: gmail
description: Archive, label, draft, unsubscribe, and manage Gmail
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📨"
  vellum:
    display-name: "Gmail"
---

This skill provides Gmail-specific tools. For cross-platform messaging (send, read, search, reply), use the **messaging** skill. Gmail tools depend on the messaging skill's provider infrastructure - load messaging first if Gmail is not yet connected.

## Email Routing Priority

When the user mentions "email" - sending, reading, checking, decluttering, drafting, or anything else - **always default to the user's own email (Gmail)** unless they explicitly ask about the assistant's own email address (e.g., "set up your email", "send from your address", "check your inbox"). The vast majority of email requests are about the user's Gmail, not the assistant's @vellum.me address.

Do not offer the assistant's own email as an option unless the user specifically asks. If Gmail is not connected, guide them through Gmail setup.

## Communication Style

- **Be action-oriented.** When the user asks to do something ("declutter", "check my email"), start doing it immediately. Don't ask for permission to read their inbox - that's obviously what they want.
- **Keep it human.** Never mention OAuth, tokens, APIs, sandboxes, credential proxies, or other technical internals. If something isn't working, say "Gmail needs to be reconnected" - not "the OAuth2 access token for google has expired."
- **Show progress.** When running a tool that scans many emails, tell the user what you're doing: "Scanning your inbox for clutter..." Don't go silent.
- **Be brief and warm.** One or two sentences per update is plenty. Don't over-explain what you're about to do - just do it and narrate lightly.

## Connection Setup

### Gmail

1. **Try connecting directly first.** Run `assistant oauth status google`. This will show whether or not the user had previously connected their google account. If so, they are ready to go.
2. **If no connections are found:** Call `skill_load` with `skill: "vellum-oauth-integrations"`. The skill will evaluate whether managed or your-own mode is appropriate and guide the user accordingly.

## Error Recovery

When a Gmail tool fails with a token or authorization error:

1. **Try to reconnect silently.** Call `assistant oauth ping google`. This often resolves expired tokens automatically.
2. **If reconnection fails, go straight to setup.** Don't present options, ask which route the user prefers, or explain what went wrong technically. Just tell the user briefly (e.g., "Gmail needs to be reconnected - let me set that up") and immediately load **vellum-oauth-integrations**. The user came to you to get something done, not to troubleshoot OAuth - make it seamless.
3. **Never try alternative approaches.** Don't use bash, curl, browser automation, or any workaround. If the Gmail tools can't do it, the reconnection flow is the answer.
4. **Never expose error details.** The user doesn't need to see error messages about tokens, OAuth, or API failures. Translate errors into plain language.

## Capabilities

### Gmail-specific

- **Archive**: Remove message from inbox
- **Label**: Add/remove labels
- **Trash**: Move to trash
- **Unsubscribe**: Unsubscribe via List-Unsubscribe header
- **Draft (native)**: Create a draft in Gmail's Drafts folder

### Attachments

- **Attachments**: `gmail_attachments` - list or download Gmail attachments. Use `action: "list"` to enumerate attachments on a message (returns filename, MIME type, size, and attachment ID), then `action: "download"` with `attachment_id` and `filename` to save a specific attachment to disk.
- **Send with Attachments**: `messaging_send` with `attachment_paths` - create a Gmail draft with file attachments (reads files from disk, builds multipart MIME)

Workflow: use `gmail_attachments` with `action: "list"` to discover attachments, then `gmail_attachments` with `action: "download"` to save them locally.

### Forward & Thread Operations

- **Forward**: `gmail_forward` - forward a message to another recipient, preserving all attachments. Optionally prepend your own text
- **Follow-up Tracking**: `gmail_follow_up` - track/untrack messages for follow-up using a dedicated "Follow-up" label, or list all tracked messages

### Inbox Automation

- **Filters**: `gmail_filters` - list, create, or delete Gmail filters. Filter criteria include from, to, subject, query, has_attachment. Actions include adding/removing labels and forwarding
- **Vacation Responder**: `gmail_vacation` - get, enable, or disable the vacation auto-responder with custom message, date range, and domain/contact restrictions

## Drafting vs Sending (Gmail)

Gmail uses a **draft-first workflow**. All compose and reply tools create Gmail drafts automatically:

- `messaging_send` (Gmail) → creates a draft in Gmail Drafts
- `messaging_send` with `thread_id` (Gmail) → creates a threaded draft with reply-all recipients
- `gmail_draft` → creates a draft
- `messaging_send` with `attachment_paths` → creates a draft with attachments
- `gmail_forward` → creates a forward draft

**To actually send**: Use `gmail_send_draft` with the draft ID after the user has reviewed it. Only call `gmail_send_draft` when the user explicitly says "send it" or equivalent.

**Reply-all**: `messaging_send` with `thread_id` for Gmail automatically builds the reply-all recipient list from the thread. You do not need to manually look up recipients.

## Email Threading (Gmail)

When replying to or continuing an email thread:

- Use `messaging_send` with the thread's `thread_id` - it automatically handles threading, reply-all recipients, and subject lines.
- The `in_reply_to` field on `gmail_draft` requires the **RFC 822 Message-ID header** (looks like `<CABx...@mail.gmail.com>`), NOT the Gmail message ID (which looks like `18e4a5b2c3d4e5f6`). Get it by reading the thread messages and extracting the `Message-ID` header.

## Gmail Search Syntax

When searching Gmail, the query uses Gmail's search operators:

| Operator         | Example                  | What it finds                       |
| ---------------- | ------------------------ | ----------------------------------- |
| `from:`          | `from:alice@example.com` | Messages from a specific sender     |
| `to:`            | `to:bob@example.com`     | Messages sent to a recipient        |
| `subject:`       | `subject:meeting`        | Messages with a word in the subject |
| `newer_than:`    | `newer_than:7d`          | Messages from the last 7 days       |
| `older_than:`    | `older_than:30d`         | Messages older than 30 days         |
| `is:unread`      | `is:unread`              | Unread messages                     |
| `has:attachment` | `has:attachment`         | Messages with attachments           |
| `label:`         | `label:work`             | Messages with a specific label      |

## Email Decluttering

When a user asks to declutter, clean up, or organize their email - start scanning immediately. Don't ask what kind of cleanup they want or request permission to read their inbox. Go straight to scanning - but once results are ready, always show them via `ui_show` and let the user choose actions before archiving or unsubscribing.

**CRITICAL**: Never call `gmail_archive`, `gmail_unsubscribe`, or `messaging_archive_by_sender` unless the user has clicked an action button on the table for that specific batch. Each batch of results requires its own explicit user confirmation via the table UI. If the user says "keep going" or "keep decluttering," that means scan and present a new table - NOT auto-archive. Previous batch approvals do not carry forward, but **deselections DO carry forward**: when the user deselects senders from a cleanup table, the system records those deselections as user preferences. Before building the next cleanup table, check `<dynamic-user-profile>` for previously deselected senders and exclude them from future cleanup tables - the user already indicated they want to keep those.

### Workflow

1. **Scan**: Call `gmail_sender_digest`. Default query targets promotions currently in the inbox from the last 90 days (`in:inbox category:promotions newer_than:90d`). Counts shown in the table reflect only what is currently in the inbox — these are the emails that will be archived.
2. **Present**: Show results as a `ui_show` table with `selectionMode: "multiple"`:
   - **Columns (exactly 3)**: Sender, Emails Found, Unsub?
     - **Unsub? cell values**: Use rich cell format: `{ "text": "Yes", "icon": "checkmark.circle.fill", "iconColor": "success" }` when `has_unsubscribe` is true, `{ "text": "No", "icon": "minus.circle", "iconColor": "muted" }` when false.
   - **Pre-select all rows** (`selected: true`) - users deselect what they want to keep
   - **Caption**: Include two parts separated by a newline: (1) data scope, e.g. "Newsletters, notifications, and outreach from last 90 days. Deselect anything you want to keep." (adjusted to match the query used), and (2) the Unsub? column legend: "Unsub? - \"Yes\" means these emails contain an unsubscribe link, so I can opt you out automatically. \"No\" means no unsubscribe link was found - these will be archived but you may continue receiving them."
   - **Action buttons (exactly 2)**: "Archive & Unsubscribe" (primary), "Archive Only" (secondary). **NEVER offer Delete, Trash, or any destructive action.**
3. **Embed scan_id in button data**: When constructing the action buttons in `ui_show`, include the `scan_id` from the `gmail_sender_digest` result in each button's `data` field. This ensures `scan_id` is forwarded automatically when the user clicks — the LLM does not need to recall it from earlier context:
   ```json
   { "id": "archive_unsubscribe", "label": "Archive & Unsubscribe", "style": "primary", "data": { "scan_id": "<scan_id value here>" } }
   ```
4. **Wait for user action**: Stop and wait. Do NOT proceed to archiving or unsubscribing until the user clicks one of the action buttons on the table. When the user clicks an action button you will receive a surface action message containing `action data: { scan_id, selectedIds }`:
   - `selectedIds` are **sender IDs** (the `id` values from the scan result rows, base64-encoded email addresses) — NOT Gmail message IDs. Always use them as `sender_ids` with `scan_id`, never as `message_ids`.
   - **Dismiss the table immediately** with `ui_dismiss` - it collapses to a completion chip
   - **Show a `task_progress` card** with steps for each phase (e.g., "Archiving 89 senders (2,400 emails)", "Unsubscribing from 72 senders"). Update each step from `in_progress` → `completed` as each phase finishes.
   - When all senders are processed, set the progress card's `status: "completed"`.
5. **Act on selection** - batch, don't loop:
   - **Archive all at once**: Call `gmail_archive` **once** with `scan_id` (from action data) + `sender_ids` set to all `selectedIds` from the action data. The tool resolves message IDs server-side and batches the Gmail API calls internally - never loop sender-by-sender. **Never** pass `selectedIds` as `message_ids` — they are sender IDs, not Gmail message IDs.
   - **Unsubscribe in bulk**: If the action is "Archive & Unsubscribe", call `gmail_unsubscribe` for each sender that has `has_unsubscribe: true` - but emit **all** unsubscribe tool calls in a **single assistant response** (parallel tool use) rather than one-at-a-time across separate turns.
6. **Accurate summary**: The scan counts are exact - the `message_count` shown in the table matches the number of messages archived. Format: "Cleaned up [total_archived] emails from [sender_count] senders. Unsubscribed from [unsub_count]."
7. **Ongoing protection offer**: After reporting results, offer auto-archive filters:
   - "Want me to set up auto-archive filters so future emails from these senders skip your inbox?"
   - If yes, call `gmail_filters` with `action: "create"` for each sender with `from` set to the sender's email and `remove_label_ids: ["INBOX"]`.
   - Then offer a recurring declutter schedule: "Want me to scan for new clutter monthly?" If yes, use `schedule_create` to set up a monthly declutter check.

### Edge Cases

- **Zero results**: Tell the user "No newsletter emails found" and suggest broadening the query (e.g. removing the category filter or extending the date range)
- **Unsubscribe failures**: Report per-sender success/failure; the existing `gmail_unsubscribe` tool handles edge cases
- **Truncation handling**: The scan covers up to 5,000 messages by default (cap 10,000). If `truncated` is true, the top senders are still captured - don't offer to scan more. Tell the user: "Scanned [N] messages - here are your top senders."
- **Time budget exceeded**: If the scan returns `time_budget_exceeded: true`, present whatever results were collected. Do not retry or continue - the partial results are useful as-is.

## Scan ID

Scan tools (`gmail_sender_digest`, `gmail_outreach_scan`) return a `scan_id` that references message IDs stored server-side. This keeps thousands of message IDs out of the conversation context. `gmail_outreach_scan` is a pure data aggregation tool - it finds senders without List-Unsubscribe headers (potential cold outreach) and does not use LLM classification.

- Pass `scan_id` + `sender_ids` to `gmail_archive` instead of `message_ids`
- Scan results expire after **30 minutes** - if archiving fails with an expiration error, re-run the scan
- Raw `message_ids` still work as a fallback for non-scan workflows

## Batch Operations

- `gmail_archive` supports `scan_id` + `sender_ids` (preferred for declutter workflows) or raw `message_ids`.
- `gmail_label` supports `message_id` or `message_ids` only - it does not accept `scan_id`.
- First scan to get a `scan_id`, then use `gmail_archive` to batch-archive by sender.
- Always confirm with the user before batch operations on large numbers of messages.

## Date Verification

Before composing any email that references a date or time:

1. Check the `current_time:` field in the `<turn_context>` block for today's date and timezone
2. Verify that "tomorrow" means the day after today's date, "next week" means the upcoming Monday–Friday, etc.
3. If the email references a date from another message, cross-check it against the turn context to ensure it's in the future

## Confidence Scores

Medium and high risk tools require a confidence score between 0 and 1:

- **0.9-1.0**: User explicitly requested this exact action
- **0.7-0.8**: Action is strongly implied by context
- **0.5-0.6**: Reasonable inference but some ambiguity
- **Below 0.5**: Ask the user to confirm before proceeding
