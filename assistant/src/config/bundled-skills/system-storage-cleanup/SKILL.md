---
name: system-storage-cleanup
description: "Handle disk pressure, critically low storage, safe storage limits, and storage cleanup mode by inspecting disk usage and proposing safe cleanup steps."
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F9F9"
  vellum:
    activation-hints:
      - "Critical disk usage or disk-pressure lock is blocking normal work"
      - "The assistant is in storage cleanup mode or normal work is suspended due to low storage"
      - "User asks to inspect large files or find what is using disk space"
      - "User asks to free workspace storage safely"
      - "User asks to delete caches, logs, temp files, Docker artifacts, or other storage safely"
---

You are operating under a critical storage cleanup contract. Your only goal is to free enough storage for the assistant to resume normal work without damaging user data.

## Cleanup Contract

Start by warning the user that storage is critically low and normal work is suspended until storage cleanup mode clears. Stay scoped to freeing storage until the disk-pressure lock clears or the guardian explicitly overrides it.

Prefer foreground inspection with available cleanup-safe tools before any mutation. Identify both the target volume that is actually full and the workspace path before proposing deletions. Do not work on unrelated tasks, refactors, installs, upgrades, or product changes while the storage lock is active.

Ask for explicit approval before deleting files, caches, logs, package caches, Docker artifacts, or any other data unless the user has already approved that exact action. Before asking, present each proposed deletion with:

- Exact path or artifact name.
- Estimated reclaimable size.
- Expected consequence, including whether it is regenerable or may remove user-visible history.

If the user approves a broad category, narrow it to exact paths or artifacts before deleting. If the user approves one exact path, do not treat that as approval for adjacent paths.

Never delete credentials, security material, workspace database files, config files, active profiler runs, migrations, skill source, app source, conversation records, memory graph nodes or segments, `journal/`, `data/reflections/`, PKB files, backups, or backup keys unless the user explicitly names that path and accepts the consequence.

## Inspection Procedure

Use local/container-visible inspection first. Prefer `df -h` on the current workspace path and on `VELLUM_WORKSPACE_DIR` when that variable is available. In Docker/container mode, `/workspace` is the persistent volume and cleanup should normally focus there.

Use `du` one level at a time and sort by size to identify large directories before drilling deeper. Keep each pass readable and bounded to the volume or workspace that is actually full. Avoid whole-filesystem scans unless the target volume cannot be isolated.

Use `host_bash` only when the sandbox cannot see the volume that is actually full and host-level inspection is necessary. Explain why host-level inspection is needed before using it.

## SQLite Diagnosis Only

If `data/db/assistant.db` dominates disk usage, inspect it only through read-only `sqlite3` access. Diagnostics may use `PRAGMA` and `SELECT` queries for:

- `page_size`
- `page_count`
- `freelist_count`
- `dbstat` object-size breakdowns

The purpose is to determine whether growth comes from specific tables/indexes or from free-page bloat. Do not edit the database manually.

Never run ad hoc `DELETE`, `UPDATE`, `INSERT`, `DROP`, `REINDEX`, schema changes, `VACUUM`, `PRAGMA writable_schema`, or any other mutating SQLite command from this skill. If SQLite tables are the main culprit, tell the user this needs product-owned retention or maintenance work rather than manual database editing.

## Safer Cleanup Candidates

Good candidates to inspect and propose, when they are clearly nonessential and user-approved, include:

- Scratch or temporary downloads created by the assistant.
- Generated build artifacts.
- Old logs.
- Stale temporary directories.
- Completed profiler runs that are no longer active.
- Stale caches.
- Large old diagnostic text attachments such as spindumps.
- Package cache cleanup or Docker cache/artifact cleanup after the user approves the exact package manager or Docker action.

Treat source files, persistent records, and user-authored content as protected unless the user explicitly names them for deletion and accepts the consequence.

## Non-Goals

ATL-450 product work is out of scope for this skill. Do not implement configurable trace or audit retention jobs, attachment retention or compression jobs, upload-time image re-encoding, first-class disk-usage UI, one-click cleanup buttons, or scheduled SQLite vacuuming. If inspection shows those are needed, report that as follow-up product work after the immediate storage cleanup path is safe.
