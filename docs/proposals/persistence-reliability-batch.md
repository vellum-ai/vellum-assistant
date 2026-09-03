# Persistence reliability batch

Internal planning notes for five related tickets about conversation persistence: structural SQLite corruption, oversized history rows, skipped migrations, provider-limit poisoning, and conversation retention.

This is a planning artifact, not an architecture spec. Implementation PRs should stay one logical change each. Ticket order below is the intended attack order.

| Ticket | Title | Linear state | Kind |
| --- | --- | --- | --- |
| [ATL-1309](https://linear.app/vellum/issue/ATL-1309/define-recovery-behavior-when-sqlite-corruption-blocks-conversation) | Define recovery behavior when SQLite corruption blocks conversation history | Needs Product Spec | Product decision, then implementation |
| [ATL-1268](https://linear.app/vellum/issue/ATL-1268/cap-tool-result-body-size-at-persistence-write-time-and-expose-an) | Cap `tool_result` body size at persistence write time and expose an admin prune path | Needs Product Spec (groomed as actionable) | Implementation |
| [ATL-1264](https://linear.app/vellum/issue/ATL-1264/detect-and-heal-missing-persistence-migrations-on-assistant-boot) | Detect and heal missing persistence migrations on assistant boot | Needs Product Spec (groomed as actionable) | Investigation + implementation |
| [ATL-1258](https://linear.app/vellum/issue/ATL-1258/reject-oversized-content-blocks-before-serializing-to-the-provider) | Reject oversized content blocks before serializing to the provider | Needs Product Spec (groomed as actionable) | Implementation |
| [ATL-1205](https://linear.app/vellum/issue/ATL-1205/decide-whether-to-ship-a-conversation-retention-ttl-with-summarize) | Decide whether to ship a conversation retention TTL with summarize-then-purge | Needs Product Spec | Product decision only |

Do not treat ATL-1268 or ATL-1258 as SQLite file corruption. Both are provider `string_above_max_length` failures caused by oversized persisted content. ATL-1309 is structural `SQLITE_CORRUPT`.

---

## ATL-1309: SQLite corruption recovery

### Evidence

Doctor session `bf2a0768-8c19-40c9-a729-862a0fe8e265` captured `SQLiteError: database disk image is malformed` (`SQLITE_CORRUPT`) while `getMessagesPaginated` served `GET /v1/messages`. The route returned HTTP 500. The client surfaces a generic "Failed to load conversation history. Please try again." The platform restored the latest ready scheduled PVC snapshot. After restore, machine health and `assistant conversations list` succeeded, and a follow-up corruption grep returned zero hits.

This is structural SQLite damage, not ATL-1268's oversized-message path.

### Current boundaries

- `assistant/src/daemon/sqlite-corruption-watchdog.ts` detects `SQLITE_CORRUPT` / `SQLITE_NOTADB` on any failed statement and emits `sqlite_corrupted`. It observes. It does not recover.
- `assistant/src/monitoring/db-integrity-check.ts` runs a read-only daily `PRAGMA quick_check`. It detects. It does not mutate.
- `assistant/src/cli/commands/db/repair-step-integrity.ts` runs a full read-only `PRAGMA integrity_check`. Despite the command name, structural repair is not implemented.
- `handleListMessages` in `assistant/src/runtime/routes/conversation-routes.ts` calls `getMessagesPaginated` with no corruption-specific catch. The HTTP adapter only maps `RouteError`. Anything else is rethrown and becomes HTTP 500 via `withErrorHandling`.
- `assistant/src/daemon/startup-error.ts` already categorizes startup `SQLITE_CORRUPT` as `DB_CORRUPT`, but that path is boot-only.
- Doctor `list_assistant_backups` / `restore_assistant_backup` restore the entire PVC. Newer workspace, database, and config changes are lost. Restore requires a confirmed snapshot name.

### Determination (2026-08-28)

**Bug:** When `SQLITE_CORRUPT` hits the conversation-history read path, the assistant returns a generic HTTP 500 and the client offers retry, even though retry cannot heal a malformed database image. Detection and telemetry exist. Recovery does not, so the conversation stays unreadable until a human Doctor session performs a destructive whole-volume restore.

**Proposed fix:** Ship user-confirmed guided rollback, not automatic restore and not salvage-first. Classify history-path `SQLITE_CORRUPT` as a structured `DB_CORRUPT` error, keep the assistant reachable in degraded mode, and route the user (or Doctor) to a confirmation that names the selected snapshot timestamp and maximum rollback window before any PVC restore. Automatic rollback silently discards post-snapshot workspace and config. In-place SQLite salvage is not implemented today and is too uncertain for v1.

### Open questions before implementation

1. Confirmation UI owner: in-chat error card with a restore CTA, or Doctor-only for v1?
2. Self-hosted path: Doctor and PVC snapshots are platform-hosted only. Self-hosted recovery still needs an explicit local-backup story.
3. Snapshot eligibility: what freshness/health criteria make a snapshot selectable, and how do we show the data-loss window?
4. Incident record: persist whether recovery was user-confirmed and which snapshot window was discarded.

Acceptance criteria after the decision stay as written in ATL-1309: one deterministic recovery flow, snapshot timestamp shown before mutate, post-restore health + `PRAGMA quick_check` + history reads pass, and an end-to-end test covering watchdog detection through restore.

---

## ATL-1268: Persist-time cap + admin prune

### Evidence

Conversation "Visa5 Offsets Scanner" on assistant `019fecfb-f6d2-7472-b68e-3af7002272ff` is bricked. Every turn fails with OpenAI `string_above_max_length`: expected max `10485760` bytes, observed `50884287` (~50 MB) at `input[231].content[1].text`. Doctor session `c78ead61-0bba-409b-a833-f5d51eeacffe` found one uncompacted tool result in history. Doctor has no command to trim a live message.

Runtime truncation already exists (`HARD_MAX_TOOL_RESULT_CHARS = 400_000` in `tool-result-truncate`, plus `spoolAndStubOversizedToolResults` in the agent loop). The oversized write still reached persistence. Either the producing tool predates that hook, bypassed it, or ran when the hook was misconfigured.

### Expected state

1. Persistence rejects or auto-compacts any single message whose `content` exceeds a provider-safe cap (proposed `MAX_PERSISTED_MESSAGE_BYTES = 8_000_000`, under the OpenAI 10 MB string cap).
2. An admin CLI can trim or redact an oversized message in a live conversation without deleting the row or the conversation.

### How to close

1. Add a per-row check on message inserts in `assistant/src/persistence/`. On oversize, log `{conversationId, messageId, bytes, source}` and compact to a tail marker or fail the write with a UI-visible error.
2. Confirm every `tool_result` path hits `POST_TOOL_USE`. Persistence cap remains the last line of defense for spool-exempt tools.
3. Add `assistant conversations prune-oversized <conv-id> --yes` that scans, optionally exports the full body to a workspace file, then truncates in place.
4. Unit tests for the persist cap and a CLI test for prune.

Verify on conversation `9f866ca3-539b-432c-87a7-231916ba71b0` after the CLI ships.

---

## ATL-1264: Heal missing persistence migrations on boot

### Evidence

Doctor session `ab094ddc-bc84-4b32-885f-62fb419ec765` on assistant `019fa8b1-cf25-74be-8a21-53fa55719dc8`. Messages blocked with `table conversations has no column named fork_strategy`. Migration `assistant/src/persistence/migrations/365-add-conversation-fork-strategy.ts` exists and is idempotent (`tableHasColumn` guard). The column is missing, so migration 365 never applied for that instance: interrupted sequence, skipped checkpoint, or app code newer than the applied migration set.

Doctor ran 35 tool calls and closed without applying a fix.

### Expected state

If app code references a schema element, the migration that adds it has run before the assistant accepts messages. A mismatch either self-heals by re-running pending/idempotent migrations, or refuses messages with a clear "pending schema update" error instead of a raw `no such column`.

### How to close

1. Investigate why 365 did not run. Check `runMigrationSteps` / checkpointing in `assistant/src/persistence/`. Determine whether a recorded version or `step:` checkpoint can skip a migration whose schema change is absent.
2. On boot, after the existing migration runner, verify required columns (at least `conversations.fork_strategy`) or re-invoke idempotent migrations. Do not hide new migrations behind a single already-checkpointed wrapper (see root `AGENTS.md` migration rules).
3. Replace the raw SQL error on the message path with a user-facing schema-mismatch message.

Verify: boot a DB whose checkpoint claims 365 ran but `fork_strategy` is missing. Either the column is added, or startup refuses with a clear message.

---

## ATL-1258: Reject oversized content blocks before provider serialize

### Evidence

Doctor session `15349b97-9e09-4ee3-aadb-4230016631ff`. User attached a ~40 MB video that was stored as a text-string content block. Every later turn failed with `string_above_max_length` at `input[99].content[2].text` (observed `40577009` vs max `10485760`). The conversation is dead because every retry resends the poisoned block. Doctor recommended starting a new conversation.

The runtime already recognizes this error class (`chat-completions-provider.ts`, `provider-rejection-log-fields.ts`) and does not repair it.

Related: ATL-1300 (reject unsupported image formats before send) is the same pre-send validation pattern, different dimension.

### Expected state

1. Attach-time rejection for content over the provider max, with a user-visible reason, before history is poisoned.
2. Pre-send validation that refuses to dispatch an already-poisoned block and surfaces a recoverable error card.
3. Retroactive prune of oversized blocks (history-repair or user action) so the conversation survives.

### How to close

1. Pre-send size check in the OpenAI serializer / `chat-completions-provider.ts` before dispatch.
2. Composer attach-time cap so videos and files never enter history above the limit.
3. Extend `assistant/src/agent/history-repair/history-repair.ts` to strip blocks over the current provider byte cap, behind an explicit user action or on-detect prompt.
4. Tests for pre-send reject and history-repair prune.

ATL-1268 and ATL-1258 share the "poisoned history row" remediation. Prefer one prune/repair primitive if both land close together, but keep persist-time tool-result caps (1268) separate from attach-time / pre-send attachment caps (1258).

---

## ATL-1205: Conversation retention TTL with summarize-then-purge

### Evidence

Doctor session `8c81b63a-20fa-4011-b660-28c091e062b6`. User asked to free disk space (Doctor freed ~490 MB via scratch, tool-cache, and git cleanup), then asked for a two-week conversation TTL that keeps a summary and deletes the rest. Doctor tried to build it via scheduled-task CLI, got tangled in quoting, and the session cut off. There is no built-in conversation retention primitive.

Existing adjacent pieces: `clearAllConversations`, `conversation-deleted` plugin hook, `conversation-memory-purge.ts`, memory retrospective summaries, and lock-friendly batched delete (`conversation-row-batch-delete.ts`). Voice-session and subagent bounds are not conversation TTL.

### Product decision needed

1. Scope: supported product feature, documented user-scripted CLI pattern, or out of scope?
2. Defaults if in-scope: TTL length, minimum preserved summary, opt-in per assistant vs global.
3. Interaction with memory retrospective: avoid double-summarizing.
4. Recovery: soft delete plus later purge, or immediate hard delete?

### Provisional recommendation

Do not ship a product TTL in this batch. File the feature call separately. If accepted later, sequence is: retrospective writes a durable memory summary, TTL sweep runs only after that write is confirmed, then conversation rows purge through the existing batched-delete path. Adjacent: ATL-1210 (same delete path) and ATL-1211 (user-config hygiene).

---

## Suggested sequencing

1. **ATL-1309** first: lock the recovery policy, then implement structured `DB_CORRUPT` + confirmed restore. Unblocks a real user class that cannot load history at all.
2. **ATL-1268** and **ATL-1258** next, possibly as sibling PRs: both stop provider-limit conversation death. Share a prune/repair primitive if the overlap is real.
3. **ATL-1264** after the write-path work, or in parallel if a second owner is available: boot-time schema heal is independent of message-body caps.
4. **ATL-1205** stays a product-spec exit unless product explicitly accepts the feature.

---

## Cross-cutting constraints

- One PR equals one logical change.
- Migrations stay idempotent and append-only. Do not wrap new steps in an already-checkpointed function name.
- User-facing copy says "assistant", not "daemon". No em dashes.
- Examples in code and docs stay generic (`Alice`, `user@example.com`, `conv-xyz`). Operational IDs from tickets (Doctor session, assistant, conversation) may be cited as evidence keys.
- Platform restore is whole-volume. Any recovery copy must say that workspace and config since the snapshot are lost.
- Companion platform work is required if ATL-1309 adds a new restore coordinator or confirmation API in Django/Vembda. Feature-flag Terraform stays a separate PR if a flag is added.
