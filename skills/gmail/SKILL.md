---
name: gmail
description: Manage Gmail email — drafting, sending, organizing, filters, vacation replies, and inbox analysis
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📨"
  vellum:
    display-name: "Gmail"
    user-invocable: true
---

This skill provides Gmail-specific operations beyond the shared **messaging** skill. For cross-platform messaging (send, read, search, reply), use the messaging skill. Gmail operations depend on the messaging skill's provider infrastructure - load messaging first if Gmail is not yet connected.

## Script Reference

All operations use CLI scripts that return JSON:

- **Success**: `{ "ok": true, "data": ... }`
- **Failure**: `{ "ok": false, "error": "..." }`

| Script             | Operation          | Description                                                                  |
| ------------------ | ------------------ | ---------------------------------------------------------------------------- |
| `gmail-email.ts`   | `draft`            | Create email drafts in the Drafts folder (including reply drafts)            |
| `gmail-email.ts`   | `send-draft`       | Send an existing draft (**requires explicit user confirmation**)             |
| `gmail-email.ts`   | `forward`          | Create forward drafts, preserving attachments                                |
| `gmail-email.ts`   | `trash`            | Move messages to Trash                                                       |
| `gmail-manage.ts`  | `label`            | Add or remove labels on messages                                             |
| `gmail-manage.ts`  | `follow-up`        | Track/untrack messages for follow-up using a dedicated "Follow-up" label     |
| `gmail-manage.ts`  | `attachments`      | List and download email attachments                                          |
| `gmail-manage.ts`  | `filters`          | Create, list, and delete Gmail filters                                       |
| `gmail-manage.ts`  | `vacation`         | Get, enable, or disable the vacation auto-responder                          |
| `gmail-manage.ts`  | `unsubscribe`      | Unsubscribe from mailing lists (**requires explicit user confirmation**)     |
| `gmail-scan.ts`    | `sender-digest`    | Scan inbox and group messages by sender for declutter workflows              |
| `gmail-scan.ts`    | `outreach-scan`    | Identify cold outreach senders (no List-Unsubscribe header)                  |
| `gmail-archive.ts` | `archive`          | Archive messages (single, batch message_ids, cache_key+sender-emails, query) |
| `gmail-prefs.ts`   | `list`             | List blocklist and safelist preferences                                      |
| `gmail-prefs.ts`   | `add-blocklist`    | Add sender emails to the blocklist                                           |
| `gmail-prefs.ts`   | `add-safelist`     | Add sender emails to the safelist                                            |
| `gmail-prefs.ts`   | `remove-blocklist` | Remove sender emails from the blocklist                                      |
| `gmail-prefs.ts`   | `remove-safelist`  | Remove sender emails from the safelist                                       |

### Email Operations

```bash
# Draft an email
bun run scripts/gmail-email.ts draft --to "user@example.com" --subject "Hello" --body "Message body"

# Draft a reply in a thread
bun run scripts/gmail-email.ts draft --to "user@example.com" --subject "Re: Hello" --body "Reply body" --thread-id "18f..." --in-reply-to "18f..."

# Send an existing draft (REQUIRES user confirmation before execution)
bun run scripts/gmail-email.ts send-draft --draft-id "r123..."

# Forward a message
bun run scripts/gmail-email.ts forward --message-id "18f..." --to "recipient@example.com" --text "FYI"

# Trash a message
bun run scripts/gmail-email.ts trash --message-id "18f..."
```

### Management Operations

```bash
# Label - add a label to a message
bun run scripts/gmail-manage.ts label --message-id "18f..." --add-labels "Work,Important"

# Follow-up - track a message for follow-up
bun run scripts/gmail-manage.ts follow-up --action track --message-id "18f..."

# Attachments - list attachments on a message
bun run scripts/gmail-manage.ts attachments --action list --message-id "18f..."

# Attachments - download a specific attachment
bun run scripts/gmail-manage.ts attachments --action download --message-id "18f..." --attachment-id "ANGj..." --filename "report.pdf"

# Filters - create a Gmail filter
bun run scripts/gmail-manage.ts filters --action create --from "newsletter@example.com" --remove-labels "INBOX"

# Vacation - enable auto-responder
bun run scripts/gmail-manage.ts vacation --action enable --message "I'm out of office until Monday"

# Unsubscribe from a mailing list (REQUIRES user confirmation before execution)
bun run scripts/gmail-manage.ts unsubscribe --message-id "18f..."
```

### Scan Operations

```bash
# Sender digest - scan inbox grouped by sender
bun run scripts/gmail-scan.ts sender-digest [--query "in:inbox category:promotions newer_than:90d"]

# Outreach scan - identify cold outreach senders
bun run scripts/gmail-scan.ts outreach-scan [--time-range "90d"]
```

Scan scripts store message IDs in the assistant's cache and return a lightweight summary with a `cache_key`. This keeps thousands of message IDs out of the conversation context. To retrieve cached message IDs for a specific sender:

```bash
assistant cache get <cache_key> --json
# Returns: { "ok": true, "data": { "sender@example.com": ["msgId1", "msgId2", ...], ... } }
```

### Archive Operations

```bash
# Archive using cache_key + sender emails (preferred for declutter workflows)
bun run scripts/gmail-archive.ts archive --cache-key "scan:abc123" --sender-emails "news@example.com,promo@example.com"

# Archive specific message IDs
bun run scripts/gmail-archive.ts archive --message-ids "18f1...,18f2...,18f3..."

# Archive a single message
bun run scripts/gmail-archive.ts archive --message-id "18f..."

# Archive by query
bun run scripts/gmail-archive.ts archive --query "from:newsletter@example.com in:inbox"
```

### Preferences Operations

```bash
# List all preferences
bun run scripts/gmail-prefs.ts --action list

# Add senders to blocklist
bun run scripts/gmail-prefs.ts --action add-blocklist --emails "spam@example.com,junk@example.com"

# Add senders to safelist
bun run scripts/gmail-prefs.ts --action add-safelist --emails "important@example.com"

# Remove from blocklist
bun run scripts/gmail-prefs.ts --action remove-blocklist --emails "spam@example.com"

# Remove from safelist
bun run scripts/gmail-prefs.ts --action remove-safelist --emails "important@example.com"
```

## Email Routing Priority

When the user mentions "email" - sending, reading, checking, decluttering, drafting, or anything else - **always default to the user's own email (Gmail)** unless they explicitly ask about the assistant's own email address (e.g., "set up your email", "send from your address", "check your inbox"). The vast majority of email requests are about the user's Gmail, not the assistant's @vellum.me address.

Do not offer the assistant's own email as an option unless the user specifically asks. If Gmail is not connected, guide them through Gmail setup.

## Connection Setup

### Gmail

1. **Check connection health first.** Run `assistant oauth status google`. This checks whether the user's Google account is connected and the token is valid.
2. **If no connection is found or the status check fails:** Load the `vellum-oauth-integrations` skill. The skill will evaluate whether managed or your-own mode is appropriate and guide the user accordingly.

## Communication Style

- **Be action-oriented.** When the user asks to do something ("declutter", "check my email"), start doing it immediately. Don't ask for permission to read their inbox - that's obviously what they want.
- **Keep it human.** Never mention OAuth, tokens, APIs, sandboxes, credential proxies, or other technical internals. If something isn't working, say "Gmail needs to be reconnected" - not "the OAuth2 access token for google has expired."
- **Show progress.** When running a script that scans many emails, tell the user what you're doing: "Scanning your inbox for clutter..." Don't go silent.
- **Be brief and warm.** One or two sentences per update is plenty. Don't over-explain what you're about to do - just do it and narrate lightly.

## Error Recovery

When a Gmail script fails with a token or authorization error:

1. **Try to reconnect silently.** Run `assistant oauth ping google`. This often resolves expired tokens automatically.
2. **If reconnection fails, go straight to setup.** Don't present options, ask which route the user prefers, or explain what went wrong technically. Just tell the user briefly (e.g., "Gmail needs to be reconnected - let me set that up") and immediately load the `vellum-oauth-integrations` skill. The user came to you to get something done, not to troubleshoot - make it seamless.
3. **Never try alternative approaches.** Don't use curl, browser automation, or any workaround. If the scripts can't do it, the reconnection flow is the answer.
4. **Never expose error details.** The user doesn't need to see error messages about tokens, OAuth, or API failures. Translate errors into plain language.

## Safety: Send-Draft and Unsubscribe

Two operations are **high-risk** and require explicit user confirmation before execution:

- **`send-draft`**: Always show the user what will be sent (recipients, subject, body summary) and wait for explicit confirmation ("yes", "send it", etc.) before running the send-draft script. The script gates on `assistant ui confirm` — it will present a confirmation dialog to the user and only proceed if approved. Never auto-send.
- **`unsubscribe`**: Always tell the user which mailing list will be unsubscribed from and wait for explicit confirmation before running the unsubscribe script. The script gates on `assistant ui confirm`. Unsubscribe actions cannot be undone.

If the user has not explicitly confirmed, do not execute these operations. A general instruction like "clean up my inbox" is not confirmation to unsubscribe - it means scan and present options.

## Drafting vs Sending (Gmail)

Gmail uses a **draft-first workflow**. All compose and reply operations create Gmail drafts automatically:

- `bun run scripts/gmail-email.ts draft` creates a draft in Gmail Drafts
- `bun run scripts/gmail-email.ts draft` with `--thread-id` and `--in-reply-to` creates a threaded reply draft
- `bun run scripts/gmail-email.ts forward` creates a forward draft, preserving attachments
- The messaging skill's send operation with Gmail also creates a draft

**To actually send**: Use `bun run scripts/gmail-email.ts send-draft` with the draft ID after the user has reviewed it. Only run send-draft when the user explicitly says "send it" or equivalent.

## Email Threading (Gmail)

When replying to or continuing an email thread:

- **Preferred**: Use the messaging skill's send with the thread's `thread_id` — it automatically handles threading, reply-all recipients, and subject lines.
- **Manual drafting**: Use `bun run scripts/gmail-email.ts draft` with both `--thread-id` and `--in-reply-to` for full control. The `thread_id` places the draft in the correct Gmail thread; `in_reply_to` sets the RFC 822 threading headers.
- **Getting the Message-ID**: Search and read results include `rfc822MessageId` in message metadata (looks like `<CABx...@mail.gmail.com>`). This is the value to pass as `--in-reply-to`. You can also pass a Gmail message ID directly — the draft script auto-resolves it to the RFC 822 header.

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

When a user asks to declutter, clean up, or organize their email - start scanning immediately. Don't ask what kind of cleanup they want or request permission to read their inbox. Go straight to scanning - but once results are ready, always present them and let the user choose actions before archiving or unsubscribing.

**CRITICAL**: Never archive, unsubscribe, or take similar bulk actions unless the user has explicitly confirmed for that specific batch. Each batch of results requires its own explicit user confirmation. If the user says "keep going" or "keep decluttering," that means scan and present new results - NOT auto-archive. Previous batch approvals do not carry forward, but **deselections DO carry forward**: when the user deselects senders from a cleanup batch, run `bun run scripts/gmail-prefs.ts --action add-safelist` with those sender emails. Before building the next cleanup table, run `bun run scripts/gmail-prefs.ts --action list` and exclude safelisted senders from the table — the user already indicated they want to keep those.

### Workflow

1. **Scan**: Run `bun run scripts/gmail-scan.ts sender-digest`. Default query targets promotions currently in the inbox from the last 90 days (`in:inbox category:promotions newer_than:90d`). The script returns a `cache_key` plus a lightweight sender summary (counts, unsubscribe availability, sample subjects). Message IDs are stored in the assistant's cache — do NOT ask for them unless needed for archiving. Counts shown in the table reflect only what is currently in the inbox — these are the emails that will be archived.
2. **Present**: Show results as a table with `selectionMode: "multiple"`:
   - **Columns (exactly 3)**: Sender, Emails Found, Unsub?
     - **Unsub? cell values**: Use rich cell format: `{ "text": "Yes", "icon": "checkmark.circle.fill", "iconColor": "success" }` when `hasUnsubscribe` is true, `{ "text": "No", "icon": "minus.circle", "iconColor": "muted" }` when false.
   - **Pre-select all rows** (`selected: true`) - users deselect what they want to keep
   - **Caption**: Include two parts separated by a newline: (1) data scope, e.g. "Newsletters, notifications, and outreach from last 90 days. Deselect anything you want to keep." (adjusted to match the query used), and (2) the Unsub? column legend: "Unsub? - \"Yes\" means these emails contain an unsubscribe link, so I can opt you out automatically. \"No\" means no unsubscribe link was found - these will be archived but you may continue receiving them."
   - **Action buttons (exactly 2)**: "Archive & Unsubscribe" (primary), "Archive Only" (secondary). **NEVER offer Delete, Trash, or any destructive action.**
3. **Embed cache_key in button data**: When constructing the action buttons, include the `cache_key` from the scan result in each button's `data` field. This ensures `cache_key` is forwarded automatically when the user clicks — the LLM does not need to recall it from earlier context:
   ```json
   {
     "id": "archive_unsubscribe",
     "label": "Archive & Unsubscribe",
     "style": "primary",
     "data": { "cache_key": "<cache_key value here>" }
   }
   ```
4. **Wait for user action**: Stop and wait. Do NOT proceed to archiving or unsubscribing until the user explicitly confirms which senders to clean up and which action to take. When the user clicks an action button you will receive an action message containing `action data: { cache_key, selectedIds }`:
   - `selectedIds` are **sender IDs** (base64-encoded email addresses) — NOT Gmail message IDs. Always use them as sender emails with `cache_key`, never as `message_ids`.
   - **Show progress** with steps for each phase (e.g., "Archiving 89 senders (2,400 emails)", "Unsubscribing from 72 senders"). Update each step as each phase finishes.
5. **Act on selection** - batch, don't loop:
   - **Archive all at once**: Run `bun run scripts/gmail-archive.ts archive --skip-confirm` **once** with `--cache-key` (from action data) + `--sender-emails` set to all selected sender emails. The script resolves message IDs from the cache and batches the Gmail API calls internally - never loop sender-by-sender. Use `--skip-confirm` because the user already confirmed via the UI table.
   - **Unsubscribe in bulk**: If the action is "Archive & Unsubscribe", run `bun run scripts/gmail-manage.ts unsubscribe` for each sender that has `hasUnsubscribe: true` — but emit **all** unsubscribe calls in a **single assistant response** (parallel tool use) rather than one-at-a-time across separate turns.
6. **Accurate summary**: The scan counts are exact - the `messageCount` shown in the table matches the number of messages archived. Format: "Cleaned up [total_archived] emails from [sender_count] senders. Unsubscribed from [unsub_count]."
7. **Ongoing protection offer**: After reporting results, offer auto-archive filters:
   - "Want me to set up auto-archive filters so future emails from these senders skip your inbox?"
   - If yes, run `bun run scripts/gmail-manage.ts filters --action create` for each sender with `--from` set to the sender's email and `--remove-labels "INBOX"`.
   - Then offer a recurring declutter schedule: "Want me to scan for new clutter monthly?"

### Cold Outreach Cleanup

After the newsletter/promotions pass, offer to clean up cold outreach — unsolicited emails from senders without unsubscribe links. This catches sales pitches, recruiting spam, and mass outreach that newsletter filters miss.

1. **Scan**: Run `bun run scripts/gmail-scan.ts outreach-scan` (default: last 90 days, senders without `List-Unsubscribe` headers). The scan includes a `hasPriorReply` flag per sender — true means the user has previously replied to that sender.
2. **Filter out known contacts**: Exclude senders where `hasPriorReply: true` — these are conversations, not cold outreach. If the `contacts` skill is loaded, also cross-reference against Google Contacts and exclude matches.
3. **Classify senders** using sample subjects, email domains, and message patterns. Categorize into:
   - **Clear junk** (pre-select for archive): loan/LOC offers, generic SaaS pitches, mass marketing from unknown domains, senders with random/concatenated domain names
   - **Sales outreach** (pre-select for archive): targeted product pitches with personalised subject lines ("Hi [name]", "for [company]"), outreach tool domains (apollo.io, outreach.io, lemlist.com, instantly.ai, etc.)
   - **Potentially useful** (deselect / keep by default): recruiting, investor outreach, partnership proposals, vendor introductions that reference the user's specific product or role
   - **Ambiguous** (deselect / keep by default): anything you're not confident about
4. **Present as a table** following the same pattern as the newsletter workflow. Use two visual sections:
   - Pre-selected rows: clear junk + sales outreach
   - Deselected rows: potentially useful + ambiguous senders (user reviews these)
   - **Caption**: "Cold outreach from the last 90 days (senders without unsubscribe links). Pre-selected senders look like spam or sales pitches. Deselected senders may be useful — review before archiving."
5. **Archive on user action**: Same flow as newsletter cleanup — wait for explicit user confirmation, then batch archive.

**Key principle**: Not all cold outreach is unwanted. Recruiting, investor, and partnership emails can be valuable. When uncertain, default to keeping the sender (deselected) and let the user decide.

### Large Inbox Handling

When a scan returns `truncated: true` or `timeBudgetExceeded: true`, the inbox has more messages than a single scan pass can cover. Split subsequent scans by date range to ensure full coverage:

```
Pass 1: in:inbox older_than:90d                     (oldest backlog)
Pass 2: in:inbox newer_than:90d older_than:30d      (recent months)
Pass 3: in:inbox newer_than:30d older_than:7d       (recent weeks)
Pass 4: in:inbox newer_than:7d                      (this week)
```

Merge results from all passes before presenting the final table. Each pass covers a smaller window, reducing per-scan message count and avoiding timeouts. Only split when a scan actually reports truncation — most inboxes are handled fine in a single pass.

### Edge Cases

- **Zero results**: Tell the user "No newsletter emails found" and suggest broadening the query (e.g. removing the category filter or extending the date range)
- **Unsubscribe failures**: Report per-sender success/failure; the unsubscribe script handles edge cases
- **Truncation handling**: The scan covers up to 1,000 messages by default (cap 2,000). If `truncated` is true, the top senders are still captured. Offer to run additional date-range passes to cover the remaining messages (see Large Inbox Handling above).
- **Time budget exceeded**: If the scan returns `timeBudgetExceeded: true`, present whatever results were collected. Offer to run additional date-range passes for uncovered periods.

## Cleanup Preferences (Blocklist & Safelist)

The `gmail-prefs.ts` script persists sender preferences across cleanup sessions:

- **Blocklist**: Sender emails archived in previous sessions. On future cleanups, pre-pass archive all blocklisted senders before scanning (use `bun run scripts/gmail-archive.ts archive --query "from:email1 OR from:email2 ... in:inbox"`). The user will see a confirmation prompt for the archive — once approved, the script proceeds.
- **Safelist**: Sender emails the user explicitly deselected (chose to keep). Exclude these senders from future cleanup tables entirely.

### Workflow integration

1. **Before scanning**: Run `bun run scripts/gmail-prefs.ts --action list`. If blocklisted senders exist, offer to auto-archive them first ("I have N previously archived senders — want me to clean those up first?"). Remove safelisted senders from scan results before presenting the table.
2. **After archiving**: Run `bun run scripts/gmail-prefs.ts --action add-blocklist` with the archived sender emails to persist them for future sessions.
3. **After user deselects**: When the user deselects senders from a cleanup table, run `bun run scripts/gmail-prefs.ts --action add-safelist` with the deselected sender emails.
4. **User overrides**: If the user asks to stop blocking or stop keeping a sender, use `remove-blocklist` or `remove-safelist` accordingly.

## Scan Operations

Scan scripts (`gmail-scan.ts sender-digest`, `gmail-scan.ts outreach-scan`) return a `cache_key` that references message IDs stored in the assistant's cache. This keeps thousands of message IDs out of the conversation context.

- Pass `cache_key` + sender emails to `bun run scripts/gmail-archive.ts archive` instead of individual `message_ids`
- Cache entries expire after **30 minutes**. When a cache entry expires, archiving automatically falls back to query-based archiving per sender.
- To retrieve cached data: `assistant cache get <cache_key> --json`
- Raw `message_ids` still work as a fallback for non-scan workflows

The `outreach-scan` operation enriches each sender with `hasPriorReply` (whether the user has ever sent an email to that address). Use this signal to filter out legitimate correspondents before classifying cold outreach.

## Batch Operations

- `bun run scripts/gmail-archive.ts archive` supports `--cache-key` + `--sender-emails` (preferred for declutter workflows), `--message-ids`, `--message-id`, or `--query`.
- `bun run scripts/gmail-manage.ts label` supports `--message-id` or `--message-ids` only — it does not accept `cache_key`.
- First scan to get a `cache_key`, then use the archive script to batch-archive by sender.
- Always confirm with the user before batch operations on large numbers of messages.

## Attachments

- **List attachments**: `bun run scripts/gmail-manage.ts attachments --action list --message-id "18f..."` — returns filename, MIME type, size, and attachment ID for each attachment on a message.
- **Download attachment**: `bun run scripts/gmail-manage.ts attachments --action download --message-id "18f..." --attachment-id "ANGj..." --filename "report.pdf"` — saves a specific attachment to disk.

Workflow: use `attachments --action list` to discover attachments, then `attachments --action download` to save them locally.

## Common Workflows

### Declutter Inbox

1. Run `bun run scripts/gmail-scan.ts sender-digest` to scan for newsletters and promotions
2. Present results showing senders, message counts, and unsubscribe availability
3. Wait for user to select senders and confirm an action
4. Archive selected senders and unsubscribe where available (if user chose "Archive & Unsubscribe")
5. Offer to create filters for ongoing protection

### Create a Gmail Filter

1. User says "auto-archive emails from newsletters@example.com"
2. Run `bun run scripts/gmail-manage.ts filters --action create --from "newsletters@example.com" --remove-labels "INBOX"`
3. Confirm the filter was created and explain what it does

### Set Vacation Auto-Reply

1. User says "set my out-of-office for next week"
2. Run `bun run scripts/gmail-manage.ts vacation --action enable --message "I'm out of office until Monday"`
3. Confirm the auto-reply is active and when it expires

### Manage Follow-ups

1. User says "flag this email for follow-up" — run `bun run scripts/gmail-manage.ts follow-up --action track --message-id "18f..."`
2. User says "what emails am I tracking?" — run `bun run scripts/gmail-manage.ts follow-up --action list`
3. User says "mark that as done" — run `bun run scripts/gmail-manage.ts follow-up --action untrack --message-id "18f..."`

### Identify Cold Outreach

1. Run `bun run scripts/gmail-scan.ts outreach-scan` to find senders without unsubscribe headers
2. Present results for review — these are likely cold outreach or unsolicited emails
3. User can choose to archive, create filters to block, or ignore

## Date Verification

Before composing any email that references a date or time:

1. Check the `current_time:` field in the `<turn_context>` block for today's date and timezone
2. Verify that "tomorrow" means the day after today's date, "next week" means the upcoming Monday–Friday, etc.
3. If the email references a date from another message, cross-check it against the turn context to ensure it's in the future

## Confidence Scores

Medium and high risk operations require a confidence score between 0 and 1:

- **0.9-1.0**: User explicitly requested this exact action
- **0.7-0.8**: Action is strongly implied by context
- **0.5-0.6**: Reasonable inference but some ambiguity
- **Below 0.5**: Ask the user to confirm before proceeding
