# Assistant CLI command inventory

**Source of truth.** Hand-maintained. CI-validated by
`assistant/scripts/check-cli-inventory.ts`.

Every `registerCommand({ name, transport })` call under
`assistant/src/cli/commands/` must have exactly one row here, and every row
must correspond to one such call. The script enforces that mapping by source
file path (the rightmost column).

## Format

| Column | Meaning |
|---|---|
| `Command` | User-facing command path. The literal `name` passed to `registerCommand` (may include a positional like `bash <command>` or `defer [conversationId]`). For files inside a namespace dir (e.g. `oauth/apps.ts`), the full path `oauth apps` is shown for readability — the check matches on `Source`, not on `Command`. |
| `Class` | Transport class: `ipc`, `local`, or `bootstrap`. Matches the `transport` field of the `registerCommand` call. |
| `Subcommands` | Top-level subcommands defined inside the `build` callback. Informational; not validated. |
| `Operation IDs` | IPC operation IDs called by this command (via `cliIpcCall*`). Informational; not validated. |
| `Status` | Lifecycle stage. See enum below. |
| `Source` | Path relative to repo root. **Canonical key** the check uses for set-equality. |

## Status enum

- `THIN` — pure IPC wrapper. No daemon-internal imports. Lint-clean against `cli/no-daemon-internals`.
- `LOCAL` — `transport: "local"`. Runs entirely in the CLI process; touches local-filesystem helpers (e.g. secure-keystore, CES bridge) by design.
- `BOOTSTRAP` — `transport: "bootstrap"`. Pre-daemon bootstrap. None currently.
- `MIGRATING` — mid-migration. None currently.
- `LEGACY` — pre-refactor structure. None currently.

## Adding a new command

1. Author the route handler in `assistant/src/runtime/routes/`.
2. Add the CLI verb in `assistant/src/cli/commands/<name>.ts` using
   `registerCommand({ name, transport: "ipc", ... })`.
3. Add a row here. The `Source` cell is the canonical key — match the
   actual file path under `assistant/src/cli/commands/`.
4. Run `bun run lint:inventory` locally to verify.

## Inventory

| Command | Class | Subcommands | Operation IDs | Status | Source |
|---|---|---|---|---|---|
| `attachment` | `ipc` | `lookup`, `register` | `attachment_lookup`, `attachment_register` | `THIN` | `assistant/src/cli/commands/attachment.ts` |
| `audit` | `ipc` | — | `audit_list` | `THIN` | `assistant/src/cli/commands/audit.ts` |
| `auth` | `ipc` | `info` | `auth_info` | `THIN` | `assistant/src/cli/commands/auth.ts` |
| `avatar` | `ipc` | `ascii`, `character`, `components`, `generate`, `get`, `remove`, `set`, `update` | `avatar_character_ascii`, `avatar_character_components`, `avatar_generate`, `avatar_get`, `avatar_remove`, `avatar_render_from_traits`, `avatar_set` | `THIN` | `assistant/src/cli/commands/avatar.ts` |
| `backup` | `ipc` | `destinations`, `disable`, `enable`, `list`, `status` | `backup_destinations_add`, `backup_destinations_remove`, `backup_destinations_set_encrypt`, `backup_disable`, `backup_enable` | `THIN` | `assistant/src/cli/commands/backup.ts` |
| `bash <command>` | `ipc` | — | `debug_bash` | `THIN` | `assistant/src/cli/commands/bash.ts` |
| `browser` | `ipc` | — | `browser_execute` | `THIN` | `assistant/src/cli/commands/browser.ts` |
| `cache` | `ipc` | `delete`, `get`, `set` | `cache_delete`, `cache_get`, `cache_set` | `THIN` | `assistant/src/cli/commands/cache.ts` |
| `channel-verification-sessions` | `ipc` | `cancel`, `create`, `resend`, `revoke`, `status` | `channel_verification_sessions_cancel`, `channel_verification_sessions_create`, `channel_verification_sessions_resend`, `channel_verification_sessions_revoke`, `channel_verification_sessions_status` | `THIN` | `assistant/src/cli/commands/channel-verification-sessions.ts` |
| `clients` | `ipc` | `disconnect`, `list` | `disconnect_client`, `list_clients` | `THIN` | `assistant/src/cli/commands/clients.ts` |
| `completions` | `local` | — | — | `LOCAL` | `assistant/src/cli/commands/completions.ts` |
| `config` | `ipc` | `get`, `list`, `schema`, `set`, `validate-allowlist` | `config_schema_get`, `config_set`, `config_allowlist_validate` | `THIN` | `assistant/src/cli/commands/config.ts` |
| `contacts` | `ipc` | `channels`, `create`, `get`, `invites`, `list`, `merge`, `prompt`, `redeem`, `revoke`, `update-status`, `upsert` | `contacts_prompt`, `getContact`, `invites_create`, `invites_redeem`, `invites_revoke`, `listContacts`, `merge_contacts`, `updateContactChannel`, `upsert_contact` | `THIN` | `assistant/src/cli/commands/contacts.ts` |
| `conversations` | `ipc` | `clear`, `export`, `list`, `new`, `rename`, `wake`, `wipe` | `conversation_create_cli`, `conversation_export_cli`, `conversations_clear_cli`, `rename_conversation`, `wake_conversation`, `wipe_conversation` | `THIN` | `assistant/src/cli/commands/conversations.ts` |
| `credential-execution` | `local` | `audit`, `grants`, `list`, `revoke` | — | `LOCAL` | `assistant/src/cli/commands/credential-execution.ts` |
| `credentials` | `ipc` | `delete`, `inspect`, `list`, `prompt`, `reveal`, `set`, `status` | `credentials_delete`, `credentials_list`, `credentials_prompt`, `credentials_reveal`, `credentials_set`, `credentials_status` | `THIN` | `assistant/src/cli/commands/credentials.ts` |
| `defer [conversationId]` | `ipc` | `cancel`, `list` | `defer_cancel`, `defer_create` | `THIN` | `assistant/src/cli/commands/conversations-defer.ts` |
| `domain` | `ipc` | `register`, `status` | `domain_register`, `domain_status` | `THIN` | `assistant/src/cli/commands/domain.ts` |
| `email` | `ipc` | `attachment`, `download`, `list`, `register`, `send`, `status`, `unregister` | `email_attachment_get`, `email_attachment_list`, `email_download`, `email_list`, `email_register`, `email_send`, `email_status`, `email_unregister` | `THIN` | `assistant/src/cli/commands/email.ts` |
| `gateway` | `ipc` | `logs` | `gateway_logs_tail` | `THIN` | `assistant/src/cli/commands/gateway.ts` |
| `image-generation` | `ipc` | `generate` | — | `THIN` | `assistant/src/cli/commands/image-generation.ts` |
| `import` | `ipc` | — | `conversations_import` | `THIN` | `assistant/src/cli/commands/conversations-import.ts` |
| `inference` | `ipc` | `llm`, `providers`, `send`, `session` | `inference_send` | `THIN` | `assistant/src/cli/commands/inference.ts` |
| `keys` | `local` | `delete`, `list`, `set` | — | `LOCAL` | `assistant/src/cli/commands/keys.ts` |
| `mcp` | `ipc` | `add`, `auth`, `list`, `reload`, `remove` | `internal_mcp_add`, `internal_mcp_auth_start`, `internal_mcp_auth_status`, `internal_mcp_list`, `internal_mcp_reload`, `internal_mcp_remove` | `THIN` | `assistant/src/cli/commands/mcp.ts` |
| `notifications` | `ipc` | `list`, `send` | `emit_notification_signal` | `THIN` | `assistant/src/cli/commands/notifications.ts` |
| `oauth` | `ipc` | `apps`, `connect`, `disconnect`, `mode`, `ping`, `providers`, `request`, `status`, `token` | — | `THIN` | `assistant/src/cli/commands/oauth/index.ts` |
| `oauth apps` | `ipc` | `delete`, `get`, `list`, `upsert` | `oauth_apps_by_query_get`, `oauth_apps_delete`, `oauth_apps_get`, `oauth_apps_upsert` | `THIN` | `assistant/src/cli/commands/oauth/apps.ts` |
| `oauth providers` | `ipc` | `delete`, `get`, `list`, `register`, `update` | `oauth_providers_by_providerKey_delete`, `oauth_providers_by_providerKey_get`, `oauth_providers_by_providerKey_patch`, `oauth_providers_post` | `THIN` | `assistant/src/cli/commands/oauth/providers.ts` |
| `pending` | `ipc` | `list` | `pending_interactions` | `THIN` | `assistant/src/cli/commands/pending.ts` |
| `platform` | `ipc` | `callback-routes`, `connect`, `disconnect`, `status` | `platform_callback_routes_register`, `platform_status` | `THIN` | `assistant/src/cli/commands/platform/index.ts` |
| `routes` | `ipc` | `inspect`, `list` | `user_routes_inspect`, `user_routes_list` | `THIN` | `assistant/src/cli/commands/routes.ts` |
| `sequence` | `ipc` | `cancel-enrollment`, `get`, `guardrails`, `list`, `pause`, `resume`, `set`, `show`, `stats` | `sequence_cancel_enrollment`, `sequence_guardrails_set`, `sequence_guardrails_show`, `sequence_list`, `sequence_pause`, `sequence_resume`, `sequence_stats` | `THIN` | `assistant/src/cli/commands/sequence.ts` |
| `skills` | `ipc` | `add`, `inspect`, `install`, `list`, `search`, `uninstall` | `deleteSkill`, `installSkill` | `THIN` | `assistant/src/cli/commands/skills.ts` |
| `status` | `ipc` | — | `health` | `THIN` | `assistant/src/cli/commands/status.ts` |
| `stt` | `ipc` | `transcribe` | `stt_transcribe_file` | `THIN` | `assistant/src/cli/commands/stt.ts` |
| `task` | `ipc` | `add`, `delete`, `list`, `queue`, `remove`, `run`, `save`, `show`, `update` | `task_delete`, `task_list`, `task_queue_add`, `task_queue_remove`, `task_queue_run`, `task_queue_show`, `task_queue_update`, `task_run`, `task_save` | `THIN` | `assistant/src/cli/commands/task.ts` |
| `trust` | `ipc` | `list` | `trust_rules_list` | `THIN` | `assistant/src/cli/commands/trust.ts` |
| `tts` | `ipc` | `synthesize` | `tts_synthesize_cli` | `THIN` | `assistant/src/cli/commands/tts.ts` |
| `ui` | `ipc` | `confirm`, `request` | `ui_request` | `THIN` | `assistant/src/cli/commands/ui.ts` |
| `usage` | `ipc` | `breakdown`, `daily`, `totals` | `usage_breakdown`, `usage_daily`, `usage_totals` | `THIN` | `assistant/src/cli/commands/usage.ts` |
| `v2` (under `memory`) | `ipc` | `activation`, `reembed`, `reembed-skills`, `validate` | `memory_v2_backfill`, `memory_v2_reembed_skills`, `memory_v2_validate` | `THIN` | `assistant/src/cli/commands/memory-v2.ts` |
| `watchers` | `ipc` | `create`, `delete`, `digest`, `list`, `update` | `watcher_create`, `watcher_delete`, `watcher_list`, `watcher_update` | `THIN` | `assistant/src/cli/commands/watchers.ts` |
| `webhooks` | `ipc` | `list`, `register` | `webhooks_register` | `THIN` | `assistant/src/cli/commands/webhooks.ts` |
