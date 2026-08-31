---
name: inbox-management
description: Ongoing Gmail inbox management via scheduled runs. Archives known noise, flags urgent items, drafts replies in-thread (never auto-sends), and catches stale follow-ups. Empty polls spend no model tokens. Starts in flag-only mode.
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "📬"
  vellum:
    category: "email"
    display-name: "Inbox Management"
    includes: ["gmail", "schedule"]
    activation-hints:
      - "When the user explicitly asks for ongoing or automatic inbox management"
      - "When the user wants periodic email triage, archiving, or follow-up tracking on a schedule"
      - "When the user says 'manage my inbox automatically' or 'set up inbox management'"
    avoid-when:
      - "When the user wants a one-time inbox cleanup (use inbox-cleanup instead)"
      - "When the user wants a quick inbox check, summary, or unread count"
      - "When the user wants to read, send, or draft a specific email"
      - "When the user is setting up email OAuth or connecting a new provider"
---

# Inbox Management Skill

Companion to `inbox-cleanup`. Cleanup drains the backlog once. **Management keeps the inbox clean on a schedule**: archiving noise, flagging urgents, drafting replies, and catching stale follow-ups.

Runs as a **script-mode schedule**. Each fire polls Gmail deterministically. An empty poll (no new inbox or sent mail) exits without waking the assistant, so leftover Stage 0 mail is not re-judged every few hours. The assistant runs only when the poll attaches a digest of new messages.

> **Default posture:** high recall on noise archiving, high precision on user interruption. Archive aggressively on known-safe patterns. Ping sparingly. Never auto-send a reply. When unsure, flag instead of archiving.

---

## Trust Ladder

A single wrong archive of an important email kills trust. Earn autonomy in stages:

| Stage                      | Archive behavior                                                                                                                                         | Draft behavior                                | Alerts              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------- |
| **0. Flag-only** (default) | Nothing archived. All archive calls use `--dry-run`. Summary shows what _would_ be archived for user review.                                             | Drafts created in-thread, listed in summary.  | Urgent scan active. |
| **1. Standard**            | Silent archive of known-safe categories only (calendar responses, no-reply, newsletters). Cold outreach still flagged. Batches > 1,000 ops auto-dry-run. | Drafts created in-thread, summarized per run. | Urgent scan active. |
| **2. Aggressive**          | Above + cold outreach archived by LLM judgment (default archive, flag only when relevant to user). All ops logged for reversal.                          | Same as Stage 1.                              | Urgent scan active. |

**Graduation requires the user to explicitly say "graduate me" or equivalent.** Do not infer from silence.

**Never auto-send a draft. No toggle for this rule.**

---

## Setup (one-time, before enabling schedule)

### 0. Informed consent

Before anything else, explain what the user is opting into. Be direct:

> "Here's what inbox management does: on a schedule you choose (e.g. every few hours on weekdays), I'll scan new mail and take action based on a trust level you control. Quiet polls (no new mail) do not use the model.
>
> **Stage 0 (the default starting point):** I watch but don't touch. I'll tell you what I _would_ archive among new mail, show you draft replies I wrote, and flag urgent items, but I won't move or delete anything. This lasts until you explicitly tell me to graduate.
>
> **Stage 1 (you opt in):** I silently archive obvious noise (calendar responses, no-reply senders, newsletters). Everything else is still flagged for your review.
>
> **Stage 2 (you opt in):** I also archive cold outreach using my judgment. Higher autonomy, slightly higher risk of a wrong call.
>
> At every stage: I will never send an email on your behalf. I create drafts for you to review. You can pause or stop this at any time."

Wait for explicit confirmation before proceeding. If the user hesitates or asks clarifying questions, answer them. Don't rush past this step.

### 1. Stage

Default to **Stage 0** (flag-only). When the user (directly or via a caller like
`admin-copilot` setup) has made an explicit, informed choice to start higher,
honor it: **Stage 1** (silent archive of known-safe categories only) or **Stage 2**
(also cold outreach by judgment). Do not infer a higher stage from enthusiasm;
require an explicit choice made after the §0 consent framing for that stage. Store
the chosen stage via `gmail-prefs.ts --action set-management-config --stage <0|1|2>`.

### 2. Safe-list

Ask for senders/domains that may look like outreach but matter. Seed categories:

- Financial advisors, lawyers, accountants
- Active investors and VCs
- Customer domains
- Family/personal contacts
- Paid subscriptions (billing addresses)

Store via `gmail-prefs.ts --action add-safelist --emails "..."`. The safe-list is shared with `inbox-cleanup`.

### 3. Interrupt threshold

Default urgency bar for alerts:

- Customer at risk (churn, renewal, escalation)
- Investor/board with time-sensitive ask
- Legal/compliance deadline
- Team member flagging urgency
- Explicit markers ("EOD today", "ASAP", "urgent") from real humans

Store threshold level via `gmail-prefs.ts --action set-management-config --interrupt-threshold "default"`.

### 4. Schedule

Do not create an execute-mode job. Empty inbox fires must not start an agent turn.

1. If a leftover execute-mode job still uses the stock pipeline message, convert it (see **Migrate leftover execute jobs** below) instead of creating a second schedule.
2. Otherwise create a recurring **script-mode** schedule:

- Name: `Inbox Management`
- Default cadence: `0 */3 * * 1-5` (every 3 hours on weekdays)
- Mode: `script`
- Script: `bun "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID/poll.ts"`
- `timeout_ms: 900000` (the poll's runtime includes the woken assistant turn)
- `inference_profile: "cost-optimized"` (applies to wake handoff turns)
- `quiet: true`
- `reuse_conversation: false` (each wake is a fresh conversation)

If `assistant oauth status google` shows more than one active connection, ask which inbox to watch and append one `--account user@example.com` flag per chosen mailbox.

By default the first poll baselines at now and does not escalate pre-existing mail (that is what stops the leftover Stage 0 pile from being re-billed). If the user wants the first sync to include recent mail, append `--lookback <duration>` (`90m`/`4h`/`2d`/`1w`).

3. Copy the shipped poll script into the schedule's directory. Read the id from the create result:

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR/schedules/<id>"
cp "$VELLUM_WORKSPACE_DIR/skills/inbox-management/scripts/poll.ts" \
   "$VELLUM_WORKSPACE_DIR/skills/inbox-management/scripts/poll-lib.ts" \
   "$VELLUM_WORKSPACE_DIR/schedules/<id>/"
```

The schedule owns this copy. `poll.ts` self-provisions state on first run.

4. Verify with `assistant schedules execute <id>`. The first run records `{"ok":true,"new":0,...,"baselined":true}`. Later empty polls record `"new":0` without waking the assistant.

Confirm cadence with the user. Overnight wakes (when the digest is non-empty): urgent-scan only.

### 5. Voice profile

Run `messaging_analyze_style` on the user's recent sent mail. Store the style profile in the Personal Knowledge Base for draft generation.

### 6. Draft preference

Confirm the user wants drafts generated. Some prefer flag-only forever.

### Migrate leftover execute jobs

An already-enabled execute-mode job keeps burning model tokens on every fire, including empty inboxes. Convert it the next time this skill is loaded in that conversation, or during setup if one exists. Idempotent: no-op when no matching execute job remains.

```sh
STOCK='Load the inbox-management skill and run the inbox management pipeline.'
assistant schedules list --json | jq -r --arg stock "$STOCK" '
  .schedules[]
  | select(.mode == "execute")
  | select(.message == $stock)
  | .id
' | while read -r id; do
  [ -z "$id" ] && continue
  mkdir -p "$VELLUM_WORKSPACE_DIR/schedules/$id"
  cp "$VELLUM_WORKSPACE_DIR/skills/inbox-management/scripts/poll.ts" \
     "$VELLUM_WORKSPACE_DIR/skills/inbox-management/scripts/poll-lib.ts" \
     "$VELLUM_WORKSPACE_DIR/schedules/$id/"
  assistant schedules update "$id" \
    --mode script \
    --script 'bun "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID/poll.ts"' \
    --timeout-ms 900000 \
    --profile cost-optimized \
    --no-reuse-conversation \
    --quiet
done
```

After converting, **stop**. Do not run the inbox pipeline on this turn. The leftover pile is why the job was converted; the next script fire baselines it.

---

## Pipeline (only when the poll wakes you)

The poll attached a digest as untrusted external content. Run these steps **only against message ids in that digest**. Do not search `in:inbox` or `in:sent` for the whole mailbox. Do not re-judge mail that is not in the digest.

Each step is silent unless something qualifies for interrupt.

### Step 0: Missed-run check & resume

**Resume interrupted runs first.** Before starting a new pipeline pass, check `bun run scripts/gmail-runs.ts list`. If the most recent run has `status: "interrupted"`, resume it via `bun run scripts/gmail-archive.ts archive --resume "<run-id>"` before proceeding. Also run `bun run scripts/gmail-runs.ts prune` to clean up logs older than 30 days.

If this conversation is still an execute-mode leftover (stock pipeline message, no digest), run **Migrate leftover execute jobs** and stop.

Read the last-run timestamp via `gmail-prefs.ts --action get-management-config`. If `last-run` is more than 2x the scheduled interval ago (e.g. >6 hours for a 3-hour schedule), notify the user:

- **Slack:** "📬 Inbox management hasn't run since [time]. I'm catching up now."
- **No Slack:** In-app notification.

Then update `last-run` to now via `gmail-prefs.ts --action set-management-config --last-run "..."` before continuing.

### Step 1: Archive known noise (Stage 1+ only)

Restrict the usual archive queries to digest inbox ids (or `--dry-run` the matching ids). Queries for context:

```
subject:(Accepted: OR Declined: OR Tentative: OR "has accepted" OR "has declined") in:inbox
from:(noreply OR no-reply OR donotreply) in:inbox
subject:("newsletter" OR "weekly digest" OR "monthly digest") in:inbox
```

**Cross-check the safe-list before each batch.** Use `gmail-prefs.ts --action list` to load the safe-list. Remove any safe-listed sender from the batch before archiving.

**Stage 0:** Collect digest matches but do not archive. Include in summary with "would archive" label.

### Step 2: Cold outreach judgment (Stage 2: archive / Stage 0-1: flag)

Use `gmail-scan.ts --action outreach-scan` only for digest inbox senders. For each result, judge: is this person/offer potentially relevant to the user?

- **Relevant** → leave in inbox, include in summary
- **Not relevant** → archive (Stage 2) / flag as "would archive" (Stage 0-1)

### Step 3: Urgent scan (all stages)

Scan digest inbox messages (unread or not) for urgency signals:

| Signal                                                                 | Why                             |
| ---------------------------------------------------------------------- | ------------------------------- |
| "past due", "overdue", "final notice", "balance due"                   | Financial consequence           |
| "will be suspended", "service interruption", "account closure"         | Operational consequence         |
| "signature required", "agreement", "DocuSign pending" from real sender | Legal action needed             |
| .gov domain, "IRS", "state of", "department of"                        | Regulatory                      |
| Safe-list sender with deadline language                                | Known-important, urgent framing |

If any qualify, send **one** alert:

- **Slack connected:** Slack DM with `🚨 urgent email`: count + per-item bullets (sender · subject · why)
- **Slack not connected:** In-app notification via notification pipeline
- If nothing qualifies: skip silently. **Never ping just to ping.**

Overnight wakes: stop after this step.

### Step 4: Draft replies (all stages, if enabled)

From digest inbox messages, filter out anything caught by Steps 1-2, calendar responses, receipts, no-reply senders, one-way FYIs.

For each remaining email from real humans expecting a response:

1. Check for existing draft in the thread: call `list_drafts`, filter results by thread ID. If draft exists, skip.
2. Read full thread context via `get_thread`.
3. Decide: does this need a reply? If no, skip.
4. Create draft in-thread via `gmail-email.ts draft --thread-id "..." --in-reply-to "..."`. Draft must be fully written in the user's voice (use Personal Knowledge Base style profile), substantive, no placeholders. **Never auto-send.**

After the pass, send one summary:

- **Slack:** `[N] drafts ready for review:` + per-item bullets
- **No Slack:** In-app notification

### Step 5: Follow-up scanner (all stages)

Look only at digest **sent** messages. For each thread where the user sent the last message and no reply has arrived:

Ask: did this email **clearly expect a response**? Only flag if **2+ signals** are present:

- The email contains a direct question
- The email proposes a meeting, call, or next step
- The email requests a deliverable or decision
- The recipient is on the safe-list (known-important contact)

**Do not flag:** cold outreach the user sent, intros where silence is normal, thank-yous, FYIs, one-line acknowledgments, or threads where the user's last message was itself a reply to a no-reply sender.

If yes, alert with: recipient, subject, date sent, and a ready-to-send follow-up draft.

---

## Stage 0 Summary

At Stage 0, send one summary for **this digest** (not the historical leftover pile). On the last working-hours wake of the day, include the day's digest items:

```
📬 Today's inbox (flag-only mode):

Would archive ([N]):
• [category]: [count] ([sample sender/subject])

Cold outreach flagged ([N]):
• [sender] · [subject] · relevant: [y/n]

Drafts ready ([N]):
• [sender] · [subject]: [one-line summary]

Follow-ups suggested ([N]):
• [recipient] · [subject] · sent [date]
```

User responds with:

- "approve X": graduates a category to auto-archive
- "safe-list X": permanently protects a sender/domain
- "graduate me": advances to Stage 1

Capture every correction: add protected senders to safe-list immediately.

---

## How the poll works

- **Deterministic poll, LLM only on new mail.** `poll.ts` syncs incrementally with Gmail's History API via `assistant oauth request --provider google`. New INBOX or SENT messages wake the assistant. Drafts, spam, and other non-inbox/non-sent additions are ignored. No model call on an empty poll.
- **Baseline skips the leftover pile.** The first run stores the current `historyId` and reports `new: 0` unless `--lookback` was set. Mail already sitting in the inbox is not attached to a digest.
- **At-most-once escalation.** Watermark and reported-id ledger commit before the wake, so a retried run never escalates the same message twice.
- **Fenced escalation.** New mail wakes a fresh conversation. The digest goes through `--external-content` (untrusted data). The pipeline hint is the trusted framing.
- **Expiry recovery.** If a stored `historyId` has expired, the account re-baselines and catches up with a one-day inbox+sent search; the ledger absorbs the overlap.

## Managing it

- Change cadence: update the schedule's expression.
- Add or remove a watched account: edit the schedule's command string (`--account` flags).
- Customize behavior: edit the schedule's copy of `poll.ts` / `poll-lib.ts`.
- Update to a newer shipped script: re-copy both files from the skill directory into `schedules/<id>/`, re-applying any custom edits.
- Pause / resume: disable / enable the schedule.
- Remove: delete the schedule; optionally clean up its `schedules/<id>/` directory.
- If polls start failing on auth, try `assistant oauth ping google`; if that fails, load the `vellum-oauth-integrations` skill to reconnect.

---

## Safe-List Rules

1. Every batch archive cross-references the safe-list. No exceptions.
2. Any user correction ("don't archive this") auto-adds to safe-list permanently.
3. Supports exact sender (`name@domain`) and domain-level (`example.com`) matches.
4. Safe-list entries never expire.
5. Shared with `inbox-cleanup`. Both skills read/write the same store via `gmail-prefs.ts`.

---

## Integration

- **Run `inbox-cleanup` first.** Management assumes the backlog is drained.
- **Auto-filters bridge the gap.** Cleanup Phase 6 runs `gmail-auto-filters.ts generate` to propose Gmail filters for safe categories (no-reply, calendar, sketchy TLDs, confirmed newsletters). The user confirms before any filter is created. These filters prevent re-accumulation immediately. Management Step 1 handles only new digest mail that slips through.
- **Shared safe-list and blocklist** via `gmail-prefs.ts`.
- **Filter dedup is automatic.** If auto-filters already cover a category, new matching mail never reaches the inbox, so it never appears in a digest.
