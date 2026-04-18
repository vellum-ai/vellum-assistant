---
name: outlook
description: Manage Outlook email — drafting, sending, organizing, rules, vacation replies, and inbox analysis
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📧"
  vellum:
    display-name: "Outlook"
    user-invocable: true
---

This skill provides Outlook-specific operations beyond the shared **messaging** skill. For cross-platform messaging (send, read, search, reply), use the messaging skill. Outlook operations depend on the messaging skill's provider infrastructure - load messaging first if Outlook is not yet connected.

## Script Reference

All operations use CLI scripts that return JSON:
- **Success**: `{ "ok": true, "data": ... }`
- **Failure**: `{ "ok": false, "error": "..." }`

| Script | Operation | Description |
| --- | --- | --- |
| `outlook-email.ts` | `draft` | Create email drafts in the Drafts folder (including reply drafts) |
| `outlook-email.ts` | `send-draft` | Send an existing draft (**requires explicit user confirmation**) |
| `outlook-email.ts` | `forward` | Create forward drafts, preserving attachments |
| `outlook-email.ts` | `trash` | Move messages to Deleted Items |
| `outlook-manage.ts` | `categories` | Manage message categories (add, remove, list available) |
| `outlook-manage.ts` | `follow-up` | Track messages with Outlook's native flag system |
| `outlook-manage.ts` | `attachments` | List and download email attachments |
| `outlook-manage.ts` | `rules` | Create, list, and delete server-side inbox message rules |
| `outlook-manage.ts` | `vacation` | Get, enable, or disable auto-reply (out-of-office) settings |
| `outlook-manage.ts` | `unsubscribe` | Unsubscribe from mailing lists (**requires explicit user confirmation**) |
| `outlook-scan.ts` | `sender-digest` | Scan inbox and group messages by sender for declutter workflows |
| `outlook-scan.ts` | `outreach-scan` | Identify cold outreach senders (no List-Unsubscribe header) |

### Email Operations

```bash
# Draft an email
bun run scripts/outlook-email.ts draft --to "user@example.com" --subject "Hello" --body "Message body"

# Send an existing draft (REQUIRES user confirmation before execution)
bun run scripts/outlook-email.ts send-draft --draft-id "AAMk..."

# Forward a message
bun run scripts/outlook-email.ts forward --message-id "AAMk..." --to "recipient@example.com" --comment "FYI"

# Trash a message
bun run scripts/outlook-email.ts trash --message-id "AAMk..."
```

### Management Operations

```bash
# Categories - add categories to a message
bun run scripts/outlook-manage.ts categories --action add --message-id "AAMk..." --categories "Blue Category,Important"

# Follow-up - flag a message for follow-up
bun run scripts/outlook-manage.ts follow-up --action track --message-id "AAMk..."

# Attachments - list attachments on a message
bun run scripts/outlook-manage.ts attachments --action list --message-id "AAMk..."

# Rules - create a server-side inbox rule
bun run scripts/outlook-manage.ts rules --action create --name "Archive newsletters" --conditions '{"senderContains":["newsletter"]}' --actions '{"moveToFolder":"Archive"}'

# Vacation - enable auto-reply
bun run scripts/outlook-manage.ts vacation --action enable --internal-message "I'm out of office" --external-message "I'm currently away"

# Unsubscribe from a mailing list (REQUIRES user confirmation before execution)
bun run scripts/outlook-manage.ts unsubscribe --message-id "AAMk..."
```

### Scan Operations

```bash
# Sender digest - scan inbox grouped by sender
bun run scripts/outlook-scan.ts sender-digest [--query "..."] [--time-range "90d"] [--account "..."]

# Outreach scan - identify cold outreach senders
bun run scripts/outlook-scan.ts outreach-scan [--time-range "90d"] [--account "..."]
```

Scan scripts store message IDs in the daemon's in-memory cache (via `assistant cache`) and return a lightweight summary with a `cache_key`. This keeps thousands of message IDs out of the conversation context. To retrieve cached message IDs for a specific sender:

```bash
assistant cache get <cache_key> --json
# Returns: { "ok": true, "data": { "sender@example.com": ["msgId1", "msgId2", ...], ... } }
```

## Email Routing Priority

When the user mentions "email" - sending, reading, checking, decluttering, drafting, or anything else - **always default to the user's own email (Outlook)** unless they explicitly ask about the assistant's own email address (e.g., "set up your email", "send from your address", "check your inbox"). The vast majority of email requests are about the user's Outlook, not the assistant's @vellum.me address.

Do not offer the assistant's own email as an option unless the user specifically asks. If Outlook is not connected, guide them through Outlook setup.

## Connection Setup

### Outlook

1. **Check connection health first.** Run `assistant oauth ping outlook`. This checks whether the user's Outlook/Microsoft account is connected and the token is valid.
2. **If no connection is found or the ping fails:** Load the `vellum-oauth-integrations` skill. The skill will evaluate whether managed or your-own mode is appropriate and guide the user accordingly.

## Communication Style

- **Be action-oriented.** When the user asks to do something ("declutter", "check my email"), start doing it immediately. Don't ask for permission to read their inbox - that's obviously what they want.
- **Keep it human.** Never mention OAuth, tokens, APIs, sandboxes, credential proxies, or other technical internals. If something isn't working, say "Outlook needs to be reconnected" - not "the OAuth2 access token for outlook has expired."
- **Show progress.** When running a script that scans many emails, tell the user what you're doing: "Scanning your inbox for clutter..." Don't go silent.
- **Be brief and warm.** One or two sentences per update is plenty. Don't over-explain what you're about to do - just do it and narrate lightly.

## Error Recovery

When an Outlook script fails with a token or authorization error:

1. **Try to reconnect silently.** Run `assistant oauth ping outlook`. This often resolves expired tokens automatically.
2. **If reconnection fails, go straight to setup.** Don't present options, ask which route the user prefers, or explain what went wrong technically. Just tell the user briefly (e.g., "Outlook needs to be reconnected - let me set that up") and immediately load the `vellum-oauth-integrations` skill. The user came to you to get something done, not to troubleshoot - make it seamless.
3. **Never try alternative approaches.** Don't use curl, browser automation, or any workaround. If the scripts can't do it, the reconnection flow is the answer.
4. **Never expose error details.** The user doesn't need to see error messages about tokens, OAuth, or API failures. Translate errors into plain language.

## Safety: Send-Draft and Unsubscribe

Two operations are **high-risk** and require explicit user confirmation before execution:

- **`send-draft`**: Always show the user what will be sent (recipients, subject, body summary) and wait for explicit confirmation ("yes", "send it", etc.) before running the send-draft script. Never auto-send.
- **`unsubscribe`**: Always tell the user which mailing list will be unsubscribed from and wait for explicit confirmation before running the unsubscribe script. Unsubscribe actions cannot be undone.

If the user has not explicitly confirmed, do not execute these operations. A general instruction like "clean up my inbox" is not confirmation to unsubscribe - it means scan and present options.

## Drafting vs Sending (Outlook)

Outlook uses a **draft-first workflow** where appropriate:

- The messaging skill's send operation sends messages directly via the Graph API.
- The `draft` operation creates a draft in the Outlook Drafts folder for user review before sending.
- The `forward` operation creates a forward draft, preserving attachments.

When the user asks to "draft" or "compose" an email, use the draft script. When they say "send", use the messaging skill's send. If ambiguous, prefer drafting so the user can review first.

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

Outlook inbox rules run server-side and support conditions like sender, subject, body keywords, and importance level. Actions include moving to folders, categorizing, flagging, forwarding, and deleting. When a user asks to "filter" or "auto-sort" email, use the rules operation - do not try to replicate Gmail's label-based filtering with Outlook folders.

### Folders vs Labels

Gmail uses labels - a message can have multiple labels and removing the INBOX label archives it. Outlook uses folders - a message lives in exactly one folder at a time. Moving a message to Archive removes it from Inbox. To tag a message with multiple categories without moving it, use the categories operation. Do not create folder hierarchies to simulate Gmail's multi-label system.

## Email Decluttering

When a user asks to declutter, clean up, or organize their email - start scanning immediately. Don't ask what kind of cleanup they want or request permission to read their inbox. Go straight to scanning - but once results are ready, always present them and let the user choose actions before archiving or unsubscribing.

**CRITICAL**: Never archive, unsubscribe, or take similar bulk actions unless the user has explicitly confirmed for that specific batch. Each batch of results requires its own explicit user confirmation. If the user says "keep going" or "keep decluttering," that means scan and present new results - NOT auto-archive. Previous batch approvals do not carry forward, but **deselections DO carry forward**: when the user deselects senders from a cleanup batch, record those as user preferences and exclude them from future cleanup batches.

### Workflow

1. **Scan**: Run `bun run scripts/outlook-scan.ts sender-digest`. The script returns a `cache_key` plus a lightweight sender summary (counts, unsubscribe availability, sample subjects). Message IDs are stored daemon-side — do NOT ask for them unless needed for archiving.
2. **Present**: Show results to the user — senders, email counts, and whether unsubscribe is available for each. Pre-select all senders so users deselect what they want to keep.
3. **Wait for user action**: Stop and wait. Do NOT proceed to archiving or unsubscribing until the user explicitly confirms which senders to clean up and which action to take ("Archive & Unsubscribe" or "Archive Only").
4. **Act on selection**: After confirmation, use `messaging_archive_by_sender` with `from:<email>` queries to archive selected senders. For unsubscribe, run the unsubscribe script for senders with `has_unsubscribe: true`. If you need specific message IDs (e.g., for targeted operations), retrieve them via `assistant cache get <cache_key> --json`.
5. **Accurate summary**: Report exact counts: "Cleaned up [total_archived] emails from [sender_count] senders. Unsubscribed from [unsub_count]."
6. **Ongoing protection offer**: After reporting results, offer inbox rules:
   - "Want me to set up inbox rules so future emails from these senders skip your inbox?"
   - If yes, run the rules script with `--action create` for each sender.
   - Then offer a recurring declutter schedule.

### Edge Cases

- **Zero results**: Tell the user "No newsletter emails found" and suggest broadening the query (e.g. extending the date range)
- **Unsubscribe failures**: Report per-sender success/failure
- **Truncation handling**: If `truncated` is true, the top senders are still captured - don't offer to scan more. Tell the user: "Scanned [N] messages - here are your top senders."
- **Time budget exceeded**: If the scan returns `time_budget_exceeded: true`, present whatever results were collected. Do not retry or continue - the partial results are useful as-is.

## Common Workflows

### Declutter Inbox

1. Run `bun run scripts/outlook-scan.ts sender-digest` to scan for newsletters and promotions
2. Present results showing senders, message counts, and unsubscribe availability
3. Wait for user to select senders and confirm an action
4. Archive selected senders and unsubscribe where available (if user chose "Archive & Unsubscribe")
5. Offer to create inbox rules for ongoing protection

### Create a Mail Rule

1. User says "auto-archive emails from newsletters@example.com"
2. Run `bun run scripts/outlook-manage.ts rules --action create --name "..." --conditions '...' --actions '...'`
3. Confirm the rule was created and explain what it does

### Set Vacation Auto-Reply

1. User says "set my out-of-office for next week"
2. Run `bun run scripts/outlook-manage.ts vacation --action enable --internal-message "..." --external-message "..."`
3. Confirm the auto-reply is active and when it expires

### Manage Follow-ups

1. User says "flag this email for follow-up" - run `bun run scripts/outlook-manage.ts follow-up --action track --message-id "..."`
2. User says "what emails am I tracking?" - run `bun run scripts/outlook-manage.ts follow-up --action list`
3. User says "mark that as done" - run `bun run scripts/outlook-manage.ts follow-up --action complete --message-id "..."`

### Identify Cold Outreach

1. Run `bun run scripts/outlook-scan.ts outreach-scan` to find senders without unsubscribe headers
2. Present results for review - these are likely cold outreach or unsolicited emails
3. User can choose to archive, create rules to block, or ignore

## Confidence Scores

Medium and high risk operations require a confidence score between 0 and 1:

- **0.9-1.0**: User explicitly requested this exact action
- **0.7-0.8**: Action is strongly implied by context
- **0.5-0.6**: Reasonable inference but some ambiguity
- **Below 0.5**: Ask the user to confirm before proceeding
