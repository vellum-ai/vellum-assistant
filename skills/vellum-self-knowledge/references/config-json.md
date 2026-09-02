# Workspace `config.json`

This is the spec the assistant should use when a user asks what `$VELLUM_WORKSPACE_DIR/config.json` is, which keys exist, or what a setting does.

Do not recite a remembered key list. Query the live schema and current values, then explain those results.

## What the file is

`config.json` is the workspace runtime configuration. It lives at `$VELLUM_WORKSPACE_DIR/config.json`.

The file is optional. Missing keys are filled from schema defaults at load time. A missing or empty file therefore means "use shipped defaults", not "no configuration exists".

The assistant validates the file against `AssistantConfigSchema` (Zod). Invalid files are quarantined and replaced with defaults. Never invent keys. If a path is absent from `assistant config schema`, it is not a supported setting.

## How to explain the spec

1. Confirm the file path: `$VELLUM_WORKSPACE_DIR/config.json`.
2. Query the schema for the path the user asked about:

   ```bash
   assistant config schema
   assistant config schema memory.cleanup
   assistant config schema <dotted.path>
   ```

3. Query the current value:

   ```bash
   assistant config get <dotted.path>
   assistant config list
   ```

4. Explain using the schema metadata (`type`, `description`, `default`) plus the current value. If the user wants a change, do not edit the file by hand and do not use this skill to apply it. Use in-chat config (`/config` or the settings UI).

`assistant config schema` without a path prints the full tree. Prefer a dotted path so the answer stays focused.

## Defaults and "off"

A key omitted from the file still has a default. Quote that default from `assistant config schema`, not from memory.

Common off conventions in this schema:

- `0` often means disabled / keep forever (retention windows, some intervals).
- `null` on some optional fields also means disabled or unset. Trust the schema description for that key.

When a user asks whether a feature exists, check the schema first. A setting can exist and still be off.

## Conversation retention (TTL)

Conversation auto-delete already exists. Do not invent a second conversations TTL key.

| Item | Value |
| --- | --- |
| Path | `memory.cleanup.conversationRetentionDays` |
| Type | non-negative integer |
| Default | `0` |
| Off | `0` keeps conversations indefinitely |
| On | positive N deletes conversations whose `updated_at` is older than N days |
| Also required | `memory.cleanup.enabled` must be true (it defaults true) |
| Scope | Ages on last activity (`updated_at`). Archived conversations are included. |

Confirm the live description and default with:

```bash
assistant config schema memory.cleanup.conversationRetentionDays
assistant config get memory.cleanup.conversationRetentionDays
```

Related cleanup keys live under the same `memory.cleanup` object (job enablement, interval, and other retention windows). Query `assistant config schema memory.cleanup` rather than listing them from memory.

This is not conversation compaction / summarize. Retention deletes old conversation rows. Compaction shortens context inside a conversation that still exists.

There is no dedicated conversations settings UI for this key today. Changing it is a workspace config change (`assistant config set` / in-chat config), not an `assistant conversations` CLI flag.

## Neighboring retention settings (do not confuse)

These are not conversation TTL. Query schema before explaining any of them:

- `memory.cleanup.llmRequestLogRetentionMs`: LLM request-log cleanup window. Default is a finite duration, not forever.
- `auditLog.retentionDays`: audit-log retention. `0` means keep forever.
- Device / client LLM log retention in the app UI is a client preference, not a `config.json` key.

## Editing

Prefer in-chat config or `assistant config set <path> <value>` over rewriting the JSON file. Hand edits must remain valid JSON and must use keys the schema accepts.

If `assistant config schema <path>` errors or returns nothing, the path is not part of the spec. Say so instead of suggesting a new key.
