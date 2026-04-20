---
name: inbox-management
description: Ongoing Gmail inbox management via scheduled runs. Archives known noise, flags urgent items, drafts replies in-thread (never auto-sends), and catches stale follow-ups. Starts in flag-only mode — earns autonomy through a three-stage trust ladder.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📬"
  vellum:
    display-name: "Inbox Management"
    includes: ["gmail"]
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

Companion to `inbox-cleanup`. Cleanup drains the backlog once. **Management keeps the inbox clean on a schedule** — archiving noise, flagging urgents, drafting replies, and catching stale follow-ups.

Runs as a **scheduled task** (via the `schedule` skill). Each run should be silent unless something is worth interrupting the user for.

> **Default posture:** high recall on noise archiving, high precision on user interruption. Archive aggressively on known-safe patterns. Ping sparingly. Never auto-send a reply. When unsure, flag instead of archiving.

---

## Trust Ladder

A single wrong archive of an important email kills trust. Earn autonomy in stages:

| Stage | Archive behavior | Draft behavior | Alerts |
|-------|------------------|----------------|--------|
| **0 — Flag-only** (default) | Nothing archived. Everything that *would* be archived is listed in a summary for user review. | Drafts created in-thread, listed in summary. | Urgent scan active. |
| **1 — Standard** | Silent archive of known-safe categories only (calendar responses, no-reply, newsletters). Cold outreach still flagged. | Drafts created in-thread, summarized per run. | Urgent scan active. |
| **2 — Aggressive** | Above + cold outreach archived by LLM judgment (default archive, flag only when relevant to user). | Same as Stage 1. | Urgent scan active. |

**Graduation requires the user to explicitly say "graduate me" or equivalent.** Do not infer from silence.

**Never auto-send a draft. No toggle for this rule.**

---

## Setup (one-time, before enabling schedule)

### 0. Informed consent

Before anything else, explain what the user is opting into. Be direct:

> "Here's what inbox management does: on a schedule you choose (e.g. every few hours on weekdays), I'll scan your inbox and take action based on a trust level you control.
>
> **Stage 0 (where everyone starts):** I watch but don't touch. I'll tell you what I *would* archive, show you draft replies I wrote, and flag urgent items — but I won't move or delete anything. This lasts until you explicitly tell me to graduate.
>
> **Stage 1 (you opt in):** I silently archive obvious noise — calendar responses, no-reply senders, newsletters. Everything else is still flagged for your review.
>
> **Stage 2 (you opt in):** I also archive cold outreach using my judgment. Higher autonomy, slightly higher risk of a wrong call.
>
> At every stage: I will never send an email on your behalf. I create drafts for you to review. You can pause or stop this at any time."

Wait for explicit confirmation before proceeding. If the user hesitates or asks clarifying questions, answer them — don't rush past this step.

### 1. Stage

Start at **Stage 0**. Store via `gmail-prefs.ts --action set-management-config --stage 0`.

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

Create a recurring schedule via `schedule_create`:
- Default: `0 */3 * * 1-5` (every 3 hours on weekdays)
- Message: `"Load the inbox-management skill and run the inbox management pipeline."`
- Mode: `execute`
- Set `reuse_conversation: true` for context accumulation across runs

Confirm cadence with user. Overnight: urgent-scan only.

### 5. Voice profile

Run `messaging_analyze_style` on the user's recent sent mail. Store the style profile in the Personal Knowledge Base for draft generation.

### 6. Draft preference

Confirm the user wants drafts generated. Some prefer flag-only forever.

---

## Pipeline (each scheduled run)

Each step is silent unless something qualifies for interrupt. Run these in order.

### Step 0: Missed-run check

Read the last-run timestamp via `gmail-prefs.ts --action get-management-config`. If `last-run` is more than 2x the scheduled interval ago (e.g. >6 hours for a 3-hour schedule), notify the user:
- **Slack:** "📬 Inbox management hasn't run since [time]. I'm catching up now."
- **No Slack:** In-app notification.

Then update `last-run` to now via `gmail-prefs.ts --action set-management-config --last-run "..."` before continuing.

### Step 1: Archive known noise (Stage 1+ only)

Run these queries via `gmail-archive.ts --action archive --query "..."` and bulk archive results:

```
subject:(Accepted: OR Declined: OR Tentative: OR "has accepted" OR "has declined") in:inbox
from:(noreply OR no-reply OR donotreply) in:inbox
subject:("newsletter" OR "weekly digest" OR "monthly digest") in:inbox
```

**Cross-check the safe-list before each batch.** Use `gmail-prefs.ts --action list` to load the safe-list. Remove any safe-listed sender from the batch before archiving.

**Stage 0:** Collect results but do not archive. Include in summary with "would archive" label.

### Step 2: Cold outreach judgment (Stage 2: archive / Stage 0-1: flag)

Use `gmail-scan.ts --action outreach-scan` to identify cold outreach senders. For each result, judge: is this person/offer potentially relevant to the user?

- **Relevant** → leave in inbox, include in summary
- **Not relevant** → archive (Stage 2) / flag as "would archive" (Stage 0-1)

### Step 3: Urgent scan (all stages)

Search `in:inbox is:unread newer_than:1d`. Scan each for urgency signals:

| Signal | Why |
|--------|-----|
| "past due", "overdue", "final notice", "balance due" | Financial consequence |
| "will be suspended", "service interruption", "account closure" | Operational consequence |
| "signature required", "agreement", "DocuSign pending" from real sender | Legal action needed |
| .gov domain, "IRS", "state of", "department of" | Regulatory |
| Safe-list sender with deadline language | Known-important, urgent framing |

If any qualify, send **one** alert:
- **Slack connected:** Slack DM with `🚨 urgent email` — count + per-item bullets (sender · subject · why)
- **Slack not connected:** In-app notification via notification pipeline
- If nothing qualifies: skip silently. **Never ping just to ping.**

### Step 4: Draft replies (all stages, if enabled)

Search `in:inbox is:unread newer_than:7d`. Filter out anything caught by Steps 1-2, calendar responses, receipts, no-reply senders, one-way FYIs.

For each remaining email from real humans expecting a response:

1. Check for existing draft in the thread — call `list_drafts`, filter results by thread ID. If draft exists, skip.
2. Read full thread context via `get_thread`.
3. Decide: does this need a reply? If no, skip.
4. Create draft in-thread via `gmail-email.ts draft --thread-id "..." --in-reply-to "..."`. Draft must be fully written in the user's voice (use Personal Knowledge Base style profile), substantive, no placeholders. **Never auto-send.**

After the pass, send one summary:
- **Slack:** `[N] drafts ready for review:` + per-item bullets
- **No Slack:** In-app notification

### Step 5: Follow-up scanner (all stages)

Search `in:sent newer_than:14d`. For each thread where the user sent the last message and no reply has arrived:

Ask: did this email **clearly expect a response**? Only flag if **2+ signals** are present:
- The email contains a direct question
- The email proposes a meeting, call, or next step
- The email requests a deliverable or decision
- The recipient is on the safe-list (known-important contact)

**Do not flag:** cold outreach the user sent, intros where silence is normal, thank-yous, FYIs, one-line acknowledgments, or threads where the user's last message was itself a reply to a no-reply sender.

If yes, alert with: recipient, subject, date sent, and a ready-to-send follow-up draft.

---

## Stage 0 Summary

At Stage 0, send one end-of-day summary (last scheduled run of working hours):

```
📬 Today's inbox (flag-only mode):

Would archive ([N]):
• [category]: [count] — [sample sender/subject]

Cold outreach flagged ([N]):
• [sender] · [subject] · relevant: [y/n]

Drafts ready ([N]):
• [sender] · [subject] — [one-line summary]

Follow-ups suggested ([N]):
• [recipient] · [subject] · sent [date]
```

User responds with:
- "approve X" — graduates a category to auto-archive
- "safe-list X" — permanently protects a sender/domain
- "graduate me" — advances to Stage 1

Capture every correction — add protected senders to safe-list immediately.

---

## Safe-List Rules

1. Every batch archive cross-references the safe-list. No exceptions.
2. Any user correction ("don't archive this") auto-adds to safe-list permanently.
3. Supports exact sender (`name@domain`) and domain-level (`example.com`) matches.
4. Safe-list entries never expire.
5. Shared with `inbox-cleanup` — both skills read/write the same store via `gmail-prefs.ts`.

---

## Integration

- **Run `inbox-cleanup` first.** Management assumes the backlog is drained.
- **Shared safe-list and blocklist** via `gmail-prefs.ts`.
- **Filters from cleanup** reduce management's workload — fewer messages hit the inbox at all.
