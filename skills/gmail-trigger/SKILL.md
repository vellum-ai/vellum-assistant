---
name: gmail-trigger
description: "Beta. Act on new Gmail as it arrives: get pinged only for urgent mail, digest newsletters, forward invoices — any standing instruction, across one or several accounts."
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📬"
  vellum:
    category: "email"
    display-name: "Gmail Triggers (Beta)"
    includes: ["schedule"]
    activation-hints:
      - "User wants hands-off monitoring of their Gmail inbox"
      - "Ping me / tell me when a new email arrives"
      - "Watch my inbox for new messages"
    avoid-when:
      - "Recurring inbox cleanup, archiving, triage, or reply drafting — use inbox-management"
      - "A one-time inbox summary or search, or reading a specific email"
---

# Gmail Triggers (Beta)

Polls the user's Gmail inbox on a cron and escalates to the assistant **only when a new message arrives** — an empty poll spends zero LLM tokens. Installing it means creating a script-mode schedule that runs the schedule's own copy of the shipped poll script. Schedule mechanics (script mode, the `schedules/<id>/` convention, waking the agent loop) are documented in the included `schedule` skill.

## Why this instead of a watcher

A watcher could only be configured through its prompt and its cadence. This
one is a script that belongs to the schedule, so the assistant can change
anything about how it behaves by simply editing the script. And because it
runs as a schedule, its runs, errors, and cost all show up on the Schedules
page in the app.

## Setup

### 1. Ensure Google is connected

The trigger reads Gmail through the user's Google OAuth connection with Gmail read access. Check with:

```bash
assistant oauth status google
```

If no connection is found, load the `vellum-oauth-integrations` skill — it evaluates whether managed or your-own mode is appropriate and guides the user through connecting. Managed (proxy) and your-own OAuth both work — `poll.ts` calls Gmail via `assistant oauth request`, which resolves either automatically.

### 2. Choose the accounts to watch

If `oauth status` shows **more than one** active Google connection, ask the user which inboxes to watch and pass one `--account <email>` flag per chosen inbox. With a single connection the flag can be omitted. One schedule watches all chosen accounts and delivers one combined digest.

### 3. Collect the action prompt

Ask the user what should happen when new email arrives — e.g. "notify me only about emails needing a reply" or "summarize newsletters, flag anything from my boss". If the user doesn't care, omit the flag and the default applies: summarize what's new and flag anything urgent.

### 4. Ask about the first sync

By default the trigger starts from now and never escalates pre-existing email. Ask the user whether the first sync should instead include recent mail; if yes, append `--lookback <duration>` (`90m`/`4h`/`2d`/`1w`).

### 5. Create the schedule

Create a recurring **script-mode** schedule (default cadence every 15 minutes unless the user asks for a different one) whose command runs the schedule's own copy of the poll script with the flags chosen above:

```
bun "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID/poll.ts" --account you@example.com --action-prompt 'Summarize new email; flag anything urgent'
```

Pass `timeout_ms: 900000` — the poll's runtime includes the woken assistant turn. Single-quote the action prompt (the command runs through `sh`). All configuration lives in this command string, so it is visible in the schedule and editable later with `assistant schedules update <id> --script "..."`.

### 6. Copy the poll script into the schedule's directory

Read the schedule id from the create result, then:

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR/schedules/<id>"
cp "$VELLUM_WORKSPACE_DIR/skills/gmail-trigger/scripts/poll.ts" "$VELLUM_WORKSPACE_DIR/schedules/<id>/poll.ts"
```

The schedule owns this copy — customizations made to it are never touched by skill upgrades. `poll.ts` self-provisions its state on first run; create nothing else.

### 7. Verify

```bash
assistant schedules execute <id>
assistant schedules runs <id> --limit 1
```

The first run records `{"ok":true,"new":0,"accounts":[{"account":"you@example.com","baselined":true,...}]}`; later empty polls record `"new":0` without `baselined`.

## How it works

- **Deterministic poll, LLM only on new mail.** `poll.ts` syncs incrementally with Gmail's History API via `assistant oauth request --provider google` (no raw token in the script). Each mailbox's watermark is a Gmail `historyId`, advanced only past history records actually processed, so a truncated poll resumes where it left off. No model call on an empty poll.
- **Per-mailbox state.** Watermarks and dedup are keyed by the email address Gmail reports for the connection, in SQLite under `schedules/<id>/state/`. Accounts baseline, advance, fail, and recover independently — one broken connection doesn't stop the others, and an account switch behind the schedule starts cleanly instead of misreading another mailbox's watermark.
- **At-most-once escalation.** Each account's watermark and reported-message ledger commit _before_ the digest is escalated, so a retried or restarted run never escalates the same message twice; a failed wake surfaces as a failed run instead of a duplicate digest. The ledger is script-local bookkeeping — nothing is written to Gmail, and read/unread state is untouched.
- **Expiry recovery.** Gmail keeps history for roughly a week. If a stored `historyId` has expired, that account re-baselines and catches up with a one-day inbox search; the ledger absorbs the overlap.
- **Fenced escalation.** New mail wakes a fresh conversation with the digest passed via `--external-content` (fenced as untrusted data, never instructions); the user's action prompt goes in `--hint` as the trusted framing. The digest carries full metadata for the 50 newest messages across all accounts (sorted by `internalDate`) plus per-account totals.
- **Self-contained.** Built-ins + the `assistant` CLI only — no dependencies.

## Managing it

- Change cadence: update the schedule's expression.
- Add or remove a watched account: edit the schedule's command string (`--account` flags).
- Customize behavior: edit the schedule's copy of `poll.ts` directly.
- Update to a newer shipped script: re-copy `poll.ts` from the skill directory into `schedules/<id>/`, re-applying any custom edits.
- Pause / resume: disable / enable the schedule.
- Remove: delete the schedule; optionally clean up its `schedules/<id>/` directory.
- If polls start failing on auth, try `assistant oauth ping google` (often refreshes an expired token); if that fails, load the `vellum-oauth-integrations` skill to reconnect.
