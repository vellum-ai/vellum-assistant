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

1. Add a new file under `assistant/src/persistence/migrations/`.
2. Make it idempotent and safe to retry after interruption.
3. Register it in the `migrationSteps` array in `assistant/src/persistence/steps.ts`.
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

There is currently no release-note surfacing mechanism. The update-bulletin feature (workspace migrations appending to a workspace bulletin file, processed by a background conversation at daemon startup) was removed. Do not add new `0XX-release-notes-*` workspace migrations — the historical set is frozen by `workspace-release-notes-feature-flag-guard.test.ts`. If a release needs user-facing notes, design an explicit on-demand surfacing mechanism first.

## Verification

Run the focused migration test first. Add package typecheck when migration exports, schema types, or registry wiring changed:

```bash
cd assistant && bun test src/__tests__/workspace-migration-example.test.ts
cd assistant && bun test src/__tests__/db-example-migrations.test.ts
cd assistant && bunx tsc --noEmit
```

Replace example paths with the actual test files related to the change.
