---
name: slack-digest-setup
description: Set up recurring Slack channel digests with scanning schedules, channel configuration, and delivery — codifies best practices for high-quality automated summaries
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📊"
  vellum:
    display-name: "Slack Digest Setup"
    user-invocable: true
    includes: ["slack", "schedule"]
---

You are helping your user set up a recurring Slack digest: automated channel scanning on a schedule that delivers prose-style summaries of what's happening across their workspace. This skill walks through configuration, scheduling, and — critically — the execution protocol that ensures every digest is actually useful.

## Prerequisites

Before starting, verify:

1. **Slack is connected.** The `slack_scan_digest` tool must be available. If not, load the `slack-app-setup` skill first.
2. **Bot has channel access.** The Slack bot must be invited to each channel it needs to scan. Users can do this with `/invite @BotName` in each channel.

## Step 1: Configure Channels

Help the user decide which channels to scan. Ask what channels matter most to them, then use `slack_configure_channels` with `action: "set"` to save their preferences.

Tips for channel selection:

- Start with 5-10 high-signal channels (team channels, engineering, announcements)
- Skip noisy bot/CI channels unless the user specifically wants them
- Private channels work too, as long as the bot is invited
- The user can update this list anytime with `slack_configure_channels`

If the user already has preferred channels configured, show the current list and ask if they want to adjust.

## Step 2: Set Up the Schedule

Create a recurring schedule using `schedule_create`. The recommended default is **hourly, 7am-7pm in the user's timezone**, with the overnight gap.

**Cron expression:** `0 7-19 * * *` (fires at the top of each hour, 7am through 7pm)

**Determine the delivery target.** Ask the user where digests should be delivered — typically their Slack DM or a dedicated channel like `#alex-agent-messages`. Use `messaging_read` or the Slack API to resolve the `conversation_id` for the target. This ID gets baked into the schedule message so scheduled sessions know where to post.

**The schedule message is critical.** Scheduled sessions have no memory of this setup conversation. The message must be completely self-contained with every instruction needed to execute properly. Use the Scan Execution Protocol below as the template for the schedule message content.

### Scan Window Logic

- The **first scan of the day** (e.g. 7am) covers everything since the last scan the previous evening. If the last scan was at 7pm, that's 12 hours of overnight activity.
- All **subsequent scans** cover since the previous hourly scan (roughly 1 hour).
- The scan reads `data/last_slack_scan.json` for the timestamp of the last scan and calculates `hours_back` accordingly.

## Step 3: Create Tracking Files

Set up two files for scan state and history:

**`data/last_slack_scan.json`** — Stores the timestamp of the last successful scan:

```json
{ "timestamp": "2026-01-01T12:00:00Z", "hours_back": 1, "channels_scanned": 0 }
```

**`data/slack_scan_log.md`** — Running log of scan activity:

```markdown
# Slack Scan Log

## YYYY-MM-DD HH:MM ET | Window: Xh | N channels scanned

Summary of what was found, or "All clear."
```

Create both files during setup with initial values. The scheduled scan sessions update them after each run.

## Step 4: Scan Execution Protocol

**This is the most important section.** Every scheduled scan MUST follow this exact protocol. Embed these instructions directly in the schedule message so the session cannot deviate.

### The Protocol

1. **Load the Slack skill.** Call `skill_load` with `skill: "slack"` to ensure scan tools are available.

2. **Call `slack_scan_digest` with `include_threads: true`.** Check `data/last_slack_scan.json` for the last scan timestamp and calculate the appropriate `hours_back`. Actually call the tool. Do not skip this step. Do not assume nothing happened.

3. **Read the actual results.** Look at what the scan returned before deciding what to report. If the tool returned messages, proceed to step 4a. If it returned zero messages, proceed to step 4b.

4a. **If there are messages: Write a full prose digest.** Break down by channel. For each channel with activity, include:

- Channel name
- Who's talking (real names, not user IDs)
- What's being discussed (specific topics, not vague summaries)
- Reply counts on notable threads
- Decisions made, questions asked, action items
- Anything that looks like it needs the user's attention or a reply

Write in prose style, conversational. Not bullet lists of channel names. Highlight what matters, skip noise, but be specific about what's quiet too.

4b. **If genuinely zero messages: Name the channels you scanned.** The user needs to know coverage was complete. Example: "Scanned team-atlas, team-illuminati, ask-eng, team-jarvis, and 3 others. Nothing new in the last hour."

5. **Deliver via `messaging_send`.** Call `messaging_send` with `platform: "slack"` and the target `conversation_id` (determined during setup — typically the user's preferred DM or a dedicated digest channel). The `message` field MUST contain the full prose digest you wrote in step 4. Do NOT use `send_notification` for digests — the notification router's decision engine rewrites content into short alerts, stripping the actual digest.

6. **Update tracking files.** Write the current timestamp to `data/last_slack_scan.json` and append a log entry to `data/slack_scan_log.md`.

### Template Schedule Message

Use this as the schedule message when creating the schedule. Adjust the delivery target and channel exclusions per the user's preferences:

```
Run the Slack digest scan. Follow every instruction exactly:

1. Load the Slack skill.
2. Call slack_scan_digest with include_threads: true to scan preferred channels. Check data/last_slack_scan.json for the time window.
3. Read the actual results. Do NOT skip this or assume nothing happened.
4. Build the digest:
   - If there are messages: write a prose-style digest broken down by channel with channel names, who's talking (real names), specific topics, reply counts, decisions, questions, and anything needing attention.
   - If zero messages: list which channels were scanned so coverage is clear.
5. Send using messaging_send with platform "slack" and conversation_id "<target_channel_id>". The MESSAGE field must contain the full digest from step 4. Never send a generic status like "scan completed." Do NOT use send_notification — it rewrites content into short alerts.
6. Update data/last_slack_scan.json and append to data/slack_scan_log.md.
```

## Step 5: HEARTBEAT.md Integration (Optional)

If the user has the heartbeat feature enabled (`heartbeat.enabled: true` in config.json), add the scan protocol to `HEARTBEAT.md` as a checklist item instead of (or in addition to) using `schedule_create`. The heartbeat runs on its own interval and reads HEARTBEAT.md for instructions.

Either approach works. The key is that the execution instructions are explicit and self-contained regardless of where they live.

## Quality Standard

Every digest, whether it covers 1 hour or 12 hours, must meet the same quality bar:

- **Prose style, conversational.** Not bullet lists of channel names. Write like you're briefing a busy person.
- **Specific.** Name the people, name the topics, give reply counts. "Team-atlas had some discussion" is useless. "Marina and Emmie discussed the CI pipeline fix in team-atlas (7 replies, still in progress)" is useful.
- **Prioritized.** Lead with what matters. Decisions, blockers, and things needing the user's attention come first. Background chatter comes last or gets skipped.
- **Honest about quiet periods.** If nothing happened, say so, but name what you scanned.

The morning overnight digest is not a different format. It just covers more time and will naturally be longer.

## Privacy Rules

- Content from `isPrivate: true` channels MUST NEVER appear in digests delivered to other channels or external destinations.
- If the user designates specific channels as sensitive (e.g. a war-room), exclude them from digests entirely. Document these exclusions in the schedule message so scheduled sessions respect them.
- When in doubt about whether content can be shared, err on the side of omission.

## Common Pitfalls

These are hard-won lessons from debugging digest quality issues. They exist here so other assistants don't repeat the same mistakes.

### Pitfall: Skipping the scan call

The `slack_scan_digest` tool is what fetches messages. Without calling it, you have nothing to summarize. Never report "all clear" or "0 channels active" without having actually called the scan tool and confirmed zero messages came back. The scan does the fetching. You do the summarizing.

### Pitfall: Using `send_notification` for digests

The notification router's decision engine rewrites `send_notification` content into short alerts (title ≤ 8 words, body ≤ 2 sentences). If you put a full prose digest in `send_notification`, it will be truncated or rewritten. Always use `messaging_send` with the target `conversation_id` for digest delivery. The `messaging_send` message field is delivered verbatim.

### Pitfall: Not naming channels in quiet reports

Even when nothing happened, the user needs to know the scan actually ran and what it covered. "All clear" by itself could mean you scanned 12 channels and found nothing, or it could mean you didn't scan at all. List the channels.

### Pitfall: Losing context between sessions

Scheduled sessions start fresh with no memory of the setup conversation. They don't know what format to use, where to deliver, or what channels to skip unless you tell them. The schedule message must contain every instruction needed to execute properly. If it's not in the message, it won't happen.

### Pitfall: Different quality for hourly vs overnight

There is no "hourly format" vs "overnight format." Every digest follows the same structure. The overnight one is just longer because it covers more time. Don't phone in the hourly scans with one-line summaries while giving the overnight scan full channel-by-channel treatment.

## Verification

After setup is complete, suggest the user test the digest by temporarily setting the schedule to run every 2 minutes (`*/2 * * * *`). Watch for the first notification, verify it contains actual content (not a generic status), then switch back to hourly.
