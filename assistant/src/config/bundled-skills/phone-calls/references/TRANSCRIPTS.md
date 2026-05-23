# Retrieving Past Call Transcripts

After a call ends, the full bidirectional transcript (caller speech, assistant responses, tool calls, and tool results) is stored in the SQLite database. The assistant logs only contain caller-side transcripts and lifecycle events at the default log level, so they are **not sufficient** for full transcript reconstruction.

Logs rotate daily as `$VELLUM_WORKSPACE_DIR/data/logs/assistant-YYYY-MM-DD.log`. The commands below use today's UTC log file; if a call happened on a previous day, swap the date in or grep across `assistant-*.log`.

## Finding the conversation

1. **Get the call session ID and voice conversation ID** from today's log by searching for recent session creation entries:

```bash
grep "voiceConversationId" "$VELLUM_WORKSPACE_DIR/data/logs/assistant-$(date -u +%Y-%m-%d).log" | tail -5
```

The `voiceConversationId` field in the `Created new inbound voice session` (or outbound equivalent) log line is the key you need.

2. **Query the messages table** in the SQLite database using the voice conversation ID:

```bash
sqlite3 "$VELLUM_WORKSPACE_DIR/data/db/assistant.db" \
  "SELECT role, content FROM messages WHERE conversation_id = '<voiceConversationId>' ORDER BY created_at ASC;"
```

This returns all messages in chronological order with:

- `role: "user"` - caller speech (prefixed with `[SPEAKER]` tags) and system events
- `role: "assistant"` - assistant responses, including `text` content and any `tool_use`/`tool_result` blocks

## Quick one-liner for the most recent call

```bash
CONV_ID=$(grep -h "voiceConversationId" "$VELLUM_WORKSPACE_DIR"/data/logs/assistant-*.log | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.readline().strip())['voiceConversationId'])")

sqlite3 "$VELLUM_WORKSPACE_DIR/data/db/assistant.db" \
  "SELECT role, content FROM messages WHERE conversation_id = '$CONV_ID' ORDER BY created_at ASC;"
```

## Additional tables for call metadata

| Table                     | What it contains                                               |
| ------------------------- | -------------------------------------------------------------- |
| `call_sessions`           | Session metadata (start time, duration, phone numbers, status) |
| `call_events`             | Granular event log for the call lifecycle                      |
| `notification_decisions`  | Whether notifications were evaluated during the call           |
| `notification_deliveries` | Notification delivery attempts                                 |

## Key paths

| Resource                                      | Path                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| Assistant logs (caller-side transcripts only) | `$VELLUM_WORKSPACE_DIR/data/logs/assistant-*.log`     |
| Full conversation database                    | `$VELLUM_WORKSPACE_DIR/data/db/assistant.db`          |
| Messages table                                | `messages` (keyed by `conversation_id`)               |
| Call sessions table                           | `call_sessions`                                       |
| Call events table                             | `call_events`                                         |

## Important

Assistant log files at the default log level do **not** contain assistant responses, TTS text, or LLM completions for voice calls. Always use the `messages` table in `assistant.db` as the source of truth for complete call transcripts.
