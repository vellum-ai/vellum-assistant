---
name: vellum-migration-checklist
description: Validate Vellum Assistant database and workspace migrations. Use when adding, editing, reviewing, or testing migrations, release-note migrations, persisted schemas, workspace file formats, or data backfills.
---

# Vellum Migration Checklist

## When A Migration Is Required

Use a migration for shipped interfaces and persisted data:

- DB schema changes, indexes, backfills, or persisted row shape changes.
- Workspace file renames, moves, format changes, or namespace changes.
- Stored config or data that existing installs must keep reading.

Do not delete migration files. Migrations are append-only, even when their logic becomes obsolete.

## DB Migrations

For DB migrations:

1. Add a new file under `assistant/src/memory/migrations/`.
2. Make it idempotent and safe to retry after interruption.
3. Register it in the migration index or registry used by DB init.
4. Update schema modules if the runtime schema changed.
5. Add or update a focused `db-*migration*.test.ts` test.

Check for ordering drift and never reorder existing migrations.

## Workspace Migrations

For workspace migrations:

1. Add a new numbered file under `assistant/src/workspace/migrations/`.
2. Append it to `WORKSPACE_MIGRATIONS` in `assistant/src/workspace/migrations/registry.ts`.
3. Make the migration idempotent.
4. Add or update a focused `workspace-migration-*.test.ts` test.

Never reuse or reorder existing migration IDs.

## Release Notes Migrations

Release notes are workspace migrations that append to `UPDATES.md`.

Required:

- Only add release notes for GA user-facing changes.
- Do not add release notes for default-disabled, rollout-only, or feature-flagged features.
- Include an HTML marker such as `<!-- release-note-id:<migration-id> -->`.
- Read `UPDATES.md` first and skip the append if the marker already exists.

The runner checkpoint is not enough to prevent duplicate appends after crash or partial failure.

## Verification

Run the focused migration test first. Add package typecheck when migration exports, schema types, or registry wiring changed:

```bash
cd assistant && bun test src/__tests__/workspace-migration-example.test.ts
cd assistant && bun test src/__tests__/db-example-migrations.test.ts
cd assistant && bunx tsc --noEmit
```

Replace example paths with the actual test files related to the change.
