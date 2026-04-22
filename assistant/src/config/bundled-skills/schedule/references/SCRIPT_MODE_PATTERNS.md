# Script Mode Patterns

Script mode runs shell commands without LLM involvement, but scripts can escalate to the assistant or notify the user via CLI commands when conditions are met. This makes script mode a building block for conditional automation — fast, deterministic checks that only invoke heavier machinery when needed.

## Script → LLM Escalation

Use `assistant conversations wake` to hand off to the assistant when a script detects something that needs LLM reasoning. The wake command injects a hint into an existing conversation without creating a user-visible message.

Example: poll an API and wake the assistant only when results change.

```sh
LAST="/workspace/data/api-status-last.txt"
CURRENT=$(curl -sf https://api.example.com/status)
[ "$CURRENT" = "$(cat "$LAST" 2>/dev/null)" ] && exit 0
echo "$CURRENT" > "$LAST"
assistant conversations wake CONVERSATION_ID --hint "API status changed: $CURRENT" --source scheduled-poll
```

Example: check disk usage and escalate to the assistant when it's high.

```sh
USAGE=$(df /workspace --output=pcent | tail -1 | tr -d ' %')
[ "$USAGE" -lt 90 ] && exit 0
assistant conversations wake CONVERSATION_ID --hint "Disk usage at ${USAGE}% — investigate and clean up" --source disk-monitor
```

## Script → Notification

Use `assistant notifications send` to alert the user directly when a script detects something noteworthy. No LLM is involved — the notification goes straight to the user's connected channels.

Example: check if a service is down and notify the user.

```sh
if ! curl -sf --max-time 5 https://myapp.example.com/health > /dev/null; then
  assistant notifications send \
    --source-channel scheduler \
    --source-event-name schedule.notify \
    --message "myapp.example.com health check failed" \
    --urgency high \
    --dedupe-key "myapp-health-$(date +%Y%m%d)"
fi
```

Example: notify when a long-running background job finishes.

```sh
if [ -f /workspace/data/export-complete.flag ]; then
  assistant notifications send \
    --source-channel scheduler \
    --source-event-name schedule.notify \
    --message "Data export finished — file ready at /workspace/data/export.csv" \
    --no-requires-action
  rm /workspace/data/export-complete.flag
fi
```

## Tips

Both patterns keep scheduled runs fast and cheap — the script exits immediately when nothing interesting happens, and only reaches for the assistant or notification system when there's something to act on. Use `quiet: true` on the schedule to suppress the per-run completion noise.
