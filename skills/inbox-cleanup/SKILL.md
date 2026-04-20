---
name: inbox-cleanup
description: Run a high-recall, multi-pass email inbox cleanup. Pattern-based subject queries catch 25x more archivable email than sender scans alone. Includes urgency triage, classification signals, and post-cleanup filter setup.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📭"
  vellum:
    display-name: "Inbox Cleanup"
    activation-hints:
      - "When the user asks to clean up, organize, or triage their email inbox"
      - "When the user wants to archive old or unwanted emails in bulk"
      - "When the user asks to set up email filters to prevent inbox clutter"
    avoid-when:
      - "When the user wants to read, send, or draft a specific email"
      - "When the user is setting up email OAuth or connecting a new provider"
---

# Inbox Cleanup Skill

A playbook for large-scale email inbox cleanup. The core insight: sender-based scans are low-recall. Subject/body pattern queries catch 25x more archivable email. This skill is a multi-pass pipeline built around that insight.

Works with any connected email provider. Adapt query syntax to whatever the provider supports — the strategy (what to search for, how to decide what to archive) is universal.

---

## Phase 1: Preference Capture

Do this before touching anything. Ask the user:

**1. Aggressiveness level**
- *Conservative* — newsletters with unsubscribe headers + obvious spam only
- *Standard* — above + cold outreach heuristics (subject patterns, unknown senders)
- *Aggressive* — above + anything from senders with no prior thread history

**2. Age threshold**
Archive everything older than X days? Common choices: 30 / 60 / 90 days. Or no age filter.

**3. VIP senders to protect**
Ask: "Are there any senders that might look like cold outreach but you actually care about? Think: specific individuals at investors, advisors, your lawyer, accountant, recruiters you're actively working with."

Build an explicit keep list. Do not archive anything matching it, ever, regardless of aggressiveness.

**4. Categories to confirm before archiving**
These need a sample + explicit approval before bulk action:
- Financial/billing alerts
- Legal/contracts
- Account suspension notices
- Government/regulatory

---

## Phase 2: Urgency Triage (do this before any archiving)

Scan the inbox first for high-stakes items that should be *surfaced*, not archived. Look for:

| Signal | Why it matters |
|--------|---------------|
| "past due", "overdue", "final notice", "balance due" | Outstanding invoice — financial consequence |
| "will be suspended", "account suspension", "service interruption" | Service shutoff — operational consequence |
| "collections", "case #", "recovery" in sender domain | Collections agency — credit/legal consequence |
| "signature required", "agreement", "DocuSign pending" | Legal action needed |
| Government TLDs (.gov), "IRS", "state of", "department of" | Regulatory — can't be skipped |

Surface these to the user *before* running the cleanup. They're easy to miss buried in a big inbox.

---

## Phase 3: The Query Pipeline

Run these passes in order. Each pass should paginate to exhaustion (keep fetching while more results exist). After each pass, **show the user a count + 5 sample subjects** before archiving anything.

### Pass 1: Age-based bulk (biggest catch)

Search for all inbox messages older than the user's age threshold (e.g. 30 days). Typically 50–80% of the archivable backlog. Always show a sample before bulk archiving.

> **Note on result caps:** Some providers cap query results (e.g. ~5,000). If a query returns exactly at the cap, archive that batch and re-run the same query — the next batch will surface. Repeat until it returns fewer than the cap.

### Pass 2: Personalized cold outreach (subject patterns)

Ask the user for their first name and company name, then search for subject lines containing patterns like:
- `[FirstName] -`, `[FirstName],`, `for [FirstName]`, `hi [FirstName]`, `hey [FirstName]`, `[FirstName] |`
- `[CompanyName] -`, `[CompanyName]?`, `for [CompanyName]`, `re: [CompanyName]`, `[CompanyName] AI`

These are the highest-recall patterns for cold outreach and partnership spam. A startup founder's inbox will see the biggest wins here.

### Pass 3: Generic cold outreach phrases

Search for subject lines containing:
- "quick question", "quick note", "checking in"
- "following up", "just following up", "circling back"
- "would love to connect", "15 minutes", "quick call"
- "intro call", "reaching out", "came across your"
- "are you the right person", "happy to hop on"

### Pass 4: No-reply & newsletters

Search for:
- Messages from noreply/no-reply/donotreply sender addresses
- Subject lines containing "unsubscribe", "newsletter", "weekly digest", "monthly digest"

### Pass 5: Calendar noise

Search for subject lines containing:
- "accepted:", "declined:", "tentative:"
- "has accepted", "has declined", "invitation:"

Calendar response confirmations are pure noise. Safe to bulk archive without review.

### Pass 6: Transactional/receipts

Search for subject lines containing:
- "your order", "order confirmation", "your receipt"
- "shipment", "has shipped", "delivered"

Cross-check against urgency triage first — filter out any "past due" or "final notice" items before archiving this batch.

### Pass 7: Sketchy TLDs

Search for messages from sender domains ending in `.shop`, `.biz`, `.xyz`, `.info`, `.club`, `.online`.

Disproportionately spam. Safe to bulk archive.

### Pass 8: High-volume repeat senders

After the above passes, run a sender frequency count on what remains. Any sender with 3+ emails not on the keep list is a candidate for bulk archive. Show grouped list to user for approval.

---

## Phase 4: Cold Outreach Classification

For emails not caught by pattern queries, use LLM-based classification in Standard/Aggressive mode. Flag as cold outreach if **3+ signals** are present:

- Sender domain not in user's contact/thread history
- No prior reply from user to this sender
- Subject contains user's name + company together (personalization ≠ trust)
- Body contains: "came across your company", "I help companies like", "reaching out because", "15 minutes", "quick call", "are you the right person"
- Sender domain is a known outreach tool: `apollo.io`, `outreach.io`, `lemlist.com`, `instantly.ai`, `salesloft.com`
- Email is not a reply (no `Re:` prefix, no quoted text from user in body)

---

## Dry-Run Defaults

When the user's inbox management trust stage is 0 (flag-only), or when a batch exceeds 1,000 operations at stage 1, default to `--dry-run` mode:

1. Run the pipeline with `--dry-run` on all archive calls
2. At the end, show a summary: counts by phase with example subjects
3. Ask the user to confirm before committing: "This would archive X,XXX emails across Y passes. Commit?"
4. If confirmed, commit via `bun run scripts/gmail-commit.ts commit --run-id "<run-id>"`
5. If rejected, cancel via `bun run scripts/gmail-commit.ts cancel --run-id "<run-id>"`

At stage 2 or for small batches at stage 1, archive directly (but still log for audit/reversal).

---

## Error Recovery & Resume

Archive operations are logged to an operation log for resumability. If a pass fails mid-run (rate limit, daily quota, OAuth expiry, crash):

1. **Check for interrupted runs** before starting a new cleanup: `bun run scripts/gmail-runs.ts list`. If a recent run shows `status: "interrupted"`, offer to resume it.
2. **Resume**: `bun run scripts/gmail-archive.ts archive --resume "<run-id>"`. This skips already-committed chunks and retries pending ones.
3. **Daily quota (403)**: The archive script detects daily quota exhaustion and writes an `interrupted` log entry with a resume hint. Do not retry until after midnight PT — offer to resume the run later.
4. **Rate limit (429)**: Handled automatically with exponential backoff (up to 5 retries for batch operations). No user intervention needed.

All archive outputs now include a `run_id`. Pass `--run-id` to group multiple passes under one run, and `--phase` to label the pipeline phase (e.g. `--phase "noise_archive"`).

---

## Phase 5: Post-Cleanup

1. **Report totals** — how many archived per pass, which categories, and the `run_id` for each pass
2. **Update blocklist** — remember which senders/domains were archived; use for faster future passes
3. **Surface any urgents found** — if financial/legal/suspension items surfaced during the pass, present them now with recommended actions
4. **Mention reversal** — remind the user: "If any of these archives were wrong, I can reverse specific threads: `bun run scripts/gmail-reverse.ts --run-id <id> --thread <message-id>`"

---

## Phase 6: Permanent Filter Setup

After cleanup, offer to create email filters/rules so the same categories don't re-accumulate. Shifts the workflow from reactive (periodic cleanup) to proactive (prevention).

> **Note:** Filter creation capabilities vary by provider. Check what's available before attempting. If the provider doesn't support programmatic filter creation, give the user manual instructions instead.

### Which patterns are safe as permanent filters

One-time bulk archiving and permanent auto-archiving are different risk levels. Be explicit:

| Pattern | Safe as permanent filter? | Notes |
|---------|--------------------------|-------|
| noreply / no-reply / donotreply senders | Yes | Automated senders, never personal |
| Calendar responses (accepted/declined in subject) | Yes | Pure noise |
| Specific spam domains identified during cleanup | Yes | Domain-level, not pattern-level |
| Sketchy TLDs (.shop, .biz, .xyz, .info) | Yes | High spam signal, low false positive risk |
| Known newsletter senders confirmed during cleanup | Yes | User just explicitly confirmed unwanted |
| Generic phrases ("quick question", "checking in") | Risky | Real colleagues use these — don't filter |
| Name/company subject patterns ("for [Name]", "[Company] -") | No | Too broad — will catch real emails |
| Age-based | No | Not generally supported as a filter condition |

### Creating the filters

One filter per logical category — don't bundle unrelated patterns, it makes individual removal impossible later.

For each filter:
- **Criteria:** the matching condition
- **Action:** skip inbox (archive), optionally mark as read

### Label strategy (recommended)

Rather than silently archiving, apply a label like `auto/calendar` or `auto/newsletter`. Gives the user an audit trail and builds trust that nothing important is disappearing invisibly. Offer this before creating any filter.

### After filter creation

Tell the user:
- How many filters were created and what each covers
- How to find auto-archived emails (search by label)
- How to remove a filter if it's too aggressive (provider settings)

---

## Reference: Proven Catch Rates

From a single cleanup session on a startup founder's inbox (April 2026):

| Pass | Approx. catch |
|------|--------------|
| Older than 30 days | ~7,200 |
| Name-personalized subject patterns | ~35,000 |
| Company-name subject patterns | ~50,000 |
| Sketchy TLDs (.shop/.biz/.xyz) | ~3,741 |
| Newsletters/digests | ~1,014 |
| Calendar responses | ~142 |
| Generic cold outreach phrases | ~23 |
| Completed DocuSigns | ~34 |

**Total: ~90,000+ emails in one session.** The name/company pattern passes alone accounted for ~85k. This is why patterns dominate sender scans.
