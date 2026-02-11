# History Repair

The Anthropic Messages API enforces strict message ordering: every `tool_use` block in an assistant message must be immediately followed by a user message containing a matching `tool_result` block. Invalid ordering causes the provider to reject the request.

History corruption can occur when:
- The daemon is killed mid-tool-execution, leaving tool_use without persisted tool_result.
- Legacy data contains `tool_result` blocks inside assistant messages.
- Abort/cancellation synthesizes results that are not flushed to the database.

The history-repair system provides a multi-layered defense.

## Repair rules

`repairHistory(messages)` applies three pure transformations:

| Rule | Trigger | Action |
|------|---------|--------|
| Strip assistant tool_result | `tool_result` block inside an assistant message | Remove the block |
| Inject missing tool_result | `tool_use` in assistant with no matching `tool_result` in the next user message | Append a synthetic `tool_result` (is_error=true, content: `[synthesized: tool result missing from history]`) |
| Downgrade orphan tool_result | `tool_result` in a user message whose `tool_use_id` doesn't match any pending `tool_use` | Convert to a `text` block: `[orphaned tool_result for <id>]: <content>` |

The function is deterministic and idempotent — running it twice on the same input produces the same output with zero-stat counters on the second run.

## Repair phases

### 1. Load-time repair (`phase=load`)

When a session is loaded from the database (`loadFromDb`), messages are parsed from JSON and then passed through `repairHistory()`. This heals any corruption that was persisted during previous sessions. Invalid JSON content falls back to a safe text block.

### 2. Pre-run repair (`phase=pre_run`)

Immediately before `agentLoop.run()`, the runtime message array is repaired again. This catches any drift that may have occurred between load and the current model call (e.g., from context window compaction or memory injection).

### 3. Abort reconciliation

After `agentLoop.run()` completes, the session scans the appended history tail for `tool_result` blocks that were synthesized by the agent loop during abort (e.g., "Cancelled by user") but never fired as events. These are added to `pendingToolResults` so the existing flush path persists them to the database.

### 4. One-shot retry (`phase=retry`)

If the provider still returns a strict ordering error (detected by pattern matching on the error message), the session runs `repairHistory()` one more time and retries the model call exactly once. If the retry also fails, the original error is propagated.

## Synthetic tool_result format

```json
{
  "type": "tool_result",
  "tool_use_id": "<original-tool-use-id>",
  "content": "[synthesized: tool result missing from history]",
  "is_error": true
}
```

## Observability

All repair activity is logged as structured JSON via the `session` logger module. Logs are emitted only when at least one repair counter is non-zero.

### Log fields

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `load` / `pre_run` / `retry` | Which repair phase triggered the log |
| `assistantToolResultsRemoved` | number | tool_result blocks stripped from assistant messages |
| `missingToolResultsInserted` | number | Synthetic tool_result blocks injected |
| `orphanToolResultsDowngraded` | number | Orphan tool_result blocks converted to text |

### Example log entry

```json
{
  "level": 40,
  "module": "session",
  "conversationId": "abc-123",
  "phase": "load",
  "assistantToolResultsRemoved": 0,
  "missingToolResultsInserted": 2,
  "orphanToolResultsDowngraded": 0,
  "msg": "Repaired persisted history"
}
```

### Expected counters

- **Healthy system**: All counters stay at 0 — no repair logs emitted.
- **Post-crash recovery**: `missingToolResultsInserted > 0` during `phase=load`. Expected after daemon kill.
- **Legacy data migration**: `assistantToolResultsRemoved > 0` during `phase=load`. Expected for sessions created before the tool_result fix.
- **Runtime drift**: Any counter > 0 during `phase=pre_run`. Rare; indicates an in-memory corruption path that should be investigated.
- **Retry triggered**: `phase=retry` log entry. The provider rejected the history despite pre-run repair. If the retry also fails, an error-level log follows.

## Troubleshooting

1. **Repeated `phase=pre_run` repairs**: The in-memory history is being corrupted between loads. Check context window compaction and memory injection paths.
2. **Retry failures**: The repair function could not fix the history. Inspect the full message array for unusual patterns (e.g., empty content arrays, unexpected block types).
3. **High `orphanToolResultsDowngraded`**: Multiple orphan tool_result blocks suggest a tool executor or agent loop bug where tool IDs are mismatched.
