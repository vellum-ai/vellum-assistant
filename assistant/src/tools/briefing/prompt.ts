/**
 * Prompt template injected into the daily briefing schedule's `message` field.
 *
 * When the scheduler fires this job in "execute" mode, it boots a conversation
 * with this text as the initial prompt. The agent runtime automatically injects
 * memory context (recent decisions, action items, workspace state) before the
 * agent processes the turn, so the briefing naturally draws on everything the
 * assistant knows about the user's work.
 *
 * Delivery: the agent is explicitly instructed to call
 * `assistant notifications send` via the bash tool so the finished briefing
 * reaches all active channels (Slack, Telegram, macOS push, etc.) rather than
 * staying confined to the background conversation history.
 */
export const DAILY_BRIEFING_PROMPT = `You are composing the user's proactive daily briefing. The memory context injected above contains recent decisions, action items, and workspace state — use it to surface what matters today.

Structure the briefing using this format:

**Daily Briefing — {{DATE}}**

**Action Items**
Unresolved tasks, pending decisions, or commitments due today. Skip if none.

**Progress**
Notable completions or milestones from the past 24 hours. Skip if none.

**On Your Radar**
Anything flagged as important, upcoming, or worth watching. Skip if none.

**Suggested Next Steps**
2–3 concrete actions for today, ranked by impact.

Rules:
- Replace {{DATE}} with today's date (e.g. "Monday, June 2").
- Keep each section to 3–5 bullets max. One sentence per bullet.
- Omit sections that have nothing to report — do not write "Nothing to report."
- If memory context is sparse, say so briefly and recommend the user share more context.
- End with a single encouraging sentence tied to the user's current work.

After composing the briefing text, deliver it to the user's active channels by running this bash command (substitute TITLE and BODY with your content — escape any double quotes inside BODY with backslash):

\`\`\`bash
assistant notifications send --title "Daily Briefing — <DATE>" --message "<BODY>" --source-event-name "briefing.daily"
\`\`\`

Do not skip this step. The bash call is what routes the briefing to Slack, Telegram, macOS, and other connected channels.`;

/** Canonical name used to identify the briefing schedule in cron_jobs. */
export const BRIEFING_SCHEDULE_NAME = "Daily Briefing";

/** Default cron expression: 9 AM every day. */
export const BRIEFING_DEFAULT_CRON = "0 9 * * *";
