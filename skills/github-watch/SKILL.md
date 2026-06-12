---
name: github-watch
description: Watch GitHub notifications (review requests, mentions, issue/PR assignments, team mentions) using a tokenless script-mode schedule. Polls every 15 minutes via the GitHub OAuth integration and wakes the conversation only when relevant notifications arrive — quiet polls cost zero tokens. Prototype replacement for the built-in GitHub watcher.
compatibility: "Designed for Vellum personal assistants. Requires the GitHub OAuth integration and script-mode schedules. PROTOTYPE — built to evaluate replacing the watcher primitive with skills + schedules."
metadata:
  emoji: "🐙"
  vellum:
    category: "development"
    display-name: "GitHub Watch"
---

Watch the user's GitHub notifications without a built-in watcher. A script-mode (tokenless) schedule runs `scripts/poll.ts` every 15 minutes; the script polls GitHub through `assistant oauth request` (credentials are injected transparently — neither you nor the script ever handles a raw token), filters to the notification reasons that warrant attention (`assign`, `mention`, `review_requested`, `team_mention`), dedups against previously seen ids, and wakes this conversation with a concise hint only when something new exists. Quiet polls exit silently — no LLM invocation, zero tokens.

> **Prototype note:** This skill exists to prove the watcher pipeline (poll → filter → dedup → watermark → LLM-only-when-events) is expressible with shipped primitives. It intentionally omits production hardening the built-in watcher has (error backoff, credential health gate, event store rows). See the teardown section to remove it cleanly.

## Setup procedure

Follow these steps when the user asks to watch their GitHub notifications.

### 1. Verify the GitHub integration

```bash
assistant oauth status github
```

If GitHub is not connected, walk the user through connecting:

```bash
assistant oauth connect github
```

Do not proceed until the status shows a healthy connection. The GitHub account needs notification read access (the standard managed GitHub integration includes it).

### 2. Create the state directory and config

State lives under the workspace data directory. Write the **current conversation id** (the conversation where the user is setting this up — you know it from your turn context) into `config.json`. That conversation is where new-notification hints will be delivered.

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR/data/github-watch"
cat > "$VELLUM_WORKSPACE_DIR/data/github-watch/config.json" <<EOF
{
  "conversationId": "<current-conversation-id>"
}
EOF
```

### 3. Install the poll script

Copy the bundled script into the state directory so the schedule has a stable path that survives skill upgrades (the schedule runs with the workspace as its working directory, not the skill directory):

```bash
cp scripts/poll.ts "$VELLUM_WORKSPACE_DIR/data/github-watch/poll.ts"
```

Sanity-check it parses the config without touching the daemon:

```bash
bun run "$VELLUM_WORKSPACE_DIR/data/github-watch/poll.ts" "$VELLUM_WORKSPACE_DIR/data/github-watch" --validate
```

Expected output: a single JSON line with `"ok": true` and the conversation id you wrote in step 2.

### 4. Create the script-mode schedule

Use your **`schedule_create` tool** (NOT the `assistant schedules create` CLI — the CLI only supports execute mode; script mode is tool-only). Exact parameters:

| Parameter     | Value                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `GitHub watch poll`                                                                                                                                 |
| `description` | `Polls GitHub notifications for the github-watch skill and wakes the watch conversation only when relevant events exist. Tokenless on quiet polls.` |
| `mode`        | `script`                                                                                                                                            |
| `script`      | `bun run "$VELLUM_WORKSPACE_DIR/data/github-watch/poll.ts" "$VELLUM_WORKSPACE_DIR/data/github-watch"`                                               |
| `syntax`      | `cron`                                                                                                                                              |
| `expression`  | `*/15 * * * *`                                                                                                                                      |
| `quiet`       | `true` (high-frequency job; it reports findings itself via conversation wake)                                                                       |
| `timeout_ms`  | `120000`                                                                                                                                            |

Record the schedule id from the tool result — store it for the user (e.g. mention it, or note it in the config) so teardown is easy.

The first scheduled run initializes the watermark to "now" (no historical replay) and exits. Subsequent runs poll for notifications updated since the watermark.

### 5. Confirm with the user

Tell the user the watch is active: GitHub notifications for review requests, mentions, assignments, and team mentions will surface in this conversation within ~15 minutes of arriving. Everything else (CI chatter, subscribed threads) is filtered out.

## How a poll works

1. Reads `config.json` (wake target) and `state.json` (watermark + seen ids) from the state dir.
2. Fetches `/notifications?all=false&since=<watermark>` through `assistant oauth request --provider github` (paginated, 50/page).
3. Keeps only reasons `assign`, `mention`, `review_requested`, `team_mention`; drops ids already in `seenIds`.
4. If anything new: runs `assistant conversations wake <conversationId> --hint "<summary>" --source github-watch --json`. If the conversation is archived or gone, falls back to `assistant notifications send`. If the conversation is merely busy, leaves state untouched and retries next poll.
5. Advances the watermark to the poll's fetch-start time and caps `seenIds` at 500.
6. Nothing new → exits 0 silently. No daemon wake, no tokens.

## Teardown

When the user asks to stop watching GitHub:

1. Find and delete the schedule:

   ```bash
   assistant schedules list --json
   assistant schedules delete <schedule-id>
   ```

2. Remove the state directory:

   ```bash
   rm -rf "$VELLUM_WORKSPACE_DIR/data/github-watch"
   ```

## Troubleshooting

- **Inspect recent poll runs** (stdout/stderr of each script execution is recorded): `assistant schedules runs <schedule-id>`
- **`oauth request failed` in run output**: check `assistant oauth status github`; reconnect with `assistant oauth connect github` if the connection is unhealthy.
- **Wake target gone**: if the original conversation was archived, polls fall back to plain notifications. To re-point delivery, update `conversationId` in `config.json` to a live conversation id.
- **Force an immediate poll**: `assistant schedules execute <schedule-id>`.
