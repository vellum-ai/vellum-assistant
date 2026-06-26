# Migration Audit: Synchronous Schema vs. Deferrable Data Migrations

**Question:** Which migrations are schema changes that *must* run synchronously before
the daemon is considered ready, and which are big data migrations that could run in an
async job *after* the daemon reports ready?

**Date:** 2026-06-26

---

## Scope — what "migrations" means here

There are four migration systems in the repo. Only two of them run at daemon startup and
gate readiness:

| System | Location | Runs at startup? | Gates readiness today? |
|---|---|---|---|
| **Memory / DB migrations** | `assistant/src/memory/migrations/` (304 steps in `steps.ts`) | Yes — `initializeDb()` → `runMigrationSteps()` | Yes, sets `dbReady` |
| **Workspace (filesystem) migrations** | `assistant/src/workspace/migrations/` (112 numbered) | Yes — `runWorkspaceMigrations()` after DB init | Yes |
| Credential-Executor (CES) migrations | `credential-executor/src/migrations/` (2) | In the CES process, not the daemon | Gates credential reads only |
| Managed↔self-hosted transfer | `assistant/src/runtime/migrations/` (vbundle import/export wizard) | No — on-demand user flow | N/A |

The CES and vbundle systems are **out of scope** for the sync/async-readiness question
(notes at the bottom). The audit below covers the DB and workspace migrations.

### Current startup sequencing (`daemon/lifecycle.ts`)

```
initializeDb()            → runMigrationSteps(migrationSteps)   [304 DB steps, blocking]
  ↓ dbReady = true
runWorkspaceMigrations()  → 112 filesystem migrations           [blocking]
  ↓
provider-connections backfill, oauth seed, … then serve traffic
```

Both runners already support **async steps** — a step may return a Promise, and the runner
awaits it before checkpointing the next one. Several big backfills already drain in
`await`ed batches so they don't block the event loop *between* batches. But they still all
complete *before the daemon serves traffic*. That is the thing this audit proposes to
relax for the data-only migrations.

---

## The classification rule

**Schema / structure → MUST be synchronous (before ready).**
Any DDL — `CREATE`/`ALTER`/`DROP TABLE`, `CREATE`/`DROP INDEX`, column add/drop/rename,
table rebuilds, FK-cascade rebuilds, FTS virtual-table + trigger creation — and any
filesystem-layout change the runtime reads on boot (config files, required dirs, credential
relocation). Running query/runtime code references these objects immediately on the first
request; if they don't exist yet the daemon throws. These are cheap (mostly `O(schema)`)
but structurally required.

**Pure data migrations → CAN be deferred to an async post-ready job…**
Backfills, re-embeds, value normalizations, content rewrites, dedups, scrubs, cross-DB row
moves. Cost scales with user history. These are the candidates to move after ready.

**…EXCEPT when a data migration is coupled to a later schema migration.**
The common pattern is *backfill a column, then enforce `NOT NULL` / `DROP` the source
column* in the next step. The data half cannot be deferred past the schema half. Those
coupled pairs must stay synchronous as a unit. They are called out explicitly below.

**Small/config data migrations are technically deferrable but pointless to defer** — they
write a handful of rows or a config key in microseconds. Keep them synchronous; they're not
where the startup-time cost lives.

---

## Tally

| Bucket | DB migrations | Workspace migrations |
|---|---:|---:|
| Schema / structure (must be sync) | ~257 | 21 |
| Small data / config (sync by default, trivial) | ~24 | ~80 |
| **Big data (async-deferrable)** | **~23** | **~11** |

The actionable list — the migrations worth moving to an async post-ready job — is small and
is given in full below. Everything not listed there is schema or trivial config and should
stay synchronous.

---

## A. Big data migrations that CAN run async after ready

These iterate over user-scale tables/files and are **not** coupled to a following schema
change. Moving them to a post-ready background job is safe provided the read paths tolerate
the pre-migration state (see per-row caveat).

### DB (`assistant/src/memory/migrations/`)

| ID | Scans | What it does | Caveat for deferral |
|---|---|---|---|
| `003-memory-fts-backfill` | memory_segments | Backfill segment FTS index | Recall/FTS quality degraded until done |
| `006-scope-salted-fingerprints` | memory_items | Recompute fingerprints with scope salt | Dedup may be imperfect until done |
| `025-messages-fts-backfill` | messages | Backfill message FTS index | Message search degraded until done |
| `036-normalize-phone-identities` | 5 guardian tables | Normalize phone fields to E.164 | Guardian matching must tolerate raw forms meanwhile |
| `140-backfill-usage-cache-accounting` | llm_usage_events, llm_request_logs | Backfill historical cache-aware cost | Pure analytics backfill — safest to defer |
| `144-rename-voice-to-phone` | 21 columns across tables | Rewrite stored `voice`→`phone` values | Read paths must accept both values meanwhile |
| `206-scrub-corrupted-image-attachments` | attachments + disk | Delete HTML-error-page "images" | Cleanup only; no consumer depends on it |
| `220-normalize-user-file-by-principal` | contacts | Unify `user_file` across a principal's channels | Bounded by #principals; persona load tolerates pre-state |
| `222-strip-placeholder-sentinels-from-messages` | messages | Strip sentinel text blocks (already batched) | Cosmetic; render path tolerates sentinels |
| `249-normalize-slack-external-content` | messages | Unwrap legacy Slack content (already batched) | Render path tolerates wrapped form |
| `288-backfill-origin-channel-from-bindings` | conversations, bindings | Backfill `origin_channel`, default `vellum` | Column default covers reads until backfilled |

### Workspace (`assistant/src/workspace/migrations/`)

| ID | Walks | What it does | Caveat for deferral |
|---|---|---|---|
| `009-backfill-conversation-disk-view` | all conversations | Rebuild on-disk conversation view from DB | Disk view (PKB/editor) stale until done |
| `010-app-dir-rename` | all app dirs | UUID dirs → human-readable slugs | App links resolve via DB; FS view lags |
| `012-rename-conversation-disk-view-dirs` | all conv subdirs | Re-format disk-view dir names | Same as 009 |
| `013-repair-conversation-disk-view` | all conversations | Repair missing disk-view folders | Same as 009 |
| `026-backfill-install-meta` | all skills | Infer & write `install-meta.json` | Skill provenance UI lags |
| `028-recover-conversations-from-disk-view` | disk view → DB | Recover convs if DB was lost | **Run early if a DB loss is detected** — see note |
| `031-drop-user-md` | per-user (DB read) | Retire legacy `USER.md` → `users/<slug>.md` | Persona load must prefer new path first |
| `092-backfill-v3-leaves` | all concept pages | Backfill v3 leaf assignments into frontmatter | Memory v3 retrieval degraded until done |
| `093-backfill-leaf-ids` | all v3 leaves | Backfill stable leaf ids into frontmatter | Same as 092 |

**Already effectively async (the pattern you're describing already exists):**
`075-memory-v2-bm25-b-default-reembed` and `085-memory-v2-bm25-b-reembed-disabled-v2-pages`
do **not** re-embed inline — they merely **enqueue a `memory_v2_reembed` job**. The heavy
re-embedding is performed by the memory worker *after* the daemon is ready. This is the
exact "schema sync, data async" split, already in production for re-embedding. It's the
model to copy for the rows in section A.

---

## B. Big data migrations that must STAY synchronous (coupled to schema)

These touch user-scale data but **cannot** be split from an adjacent schema step that
depends on the data being in final form first. Keep each pair together, synchronous.

| Data step | Coupled schema step | Why it can't be deferred |
|---|---|---|
| `007-assistant-id-to-self` | `008-remove-assistant-id-columns` | Must normalize values before the column is dropped |
| `020-rename-macos-ios-channel-to-vellum` | `019` new notification schema | New schema only understands `vellum` |
| `024-embedding-vector-blob` (backfill) | `026a-embeddings-nullable-vector-json` (rebuild) | Rebuild fixes the `NOT NULL` the backfill needs relaxed |
| `126-backfill-guardian-principal-id` | `127-guardian-principal-id-not-null` | `NOT NULL` enforced right after backfill |
| `131-safety-sync-to-contacts` | `129`/legacy-table drop | Data salvaged before legacy tables dropped |
| `135-backfill-contact-interaction-stats` | `136-drop-assistant-id-columns` | Stats derived before columns dropped |
| `147-migrate-reminders-to-schedules` | `148-drop-reminders-table` | Rows copied before source table dropped |
| `289-contact-channels dedup` | `291-renormalize` → `294-drop-external-user-id` | Dedup must precede re-address + column drop |

**Cross-DB moves — schema + data, keep sync:**
`297-move-llm-request-logs-to-logs-db` and `298-move-memory-jobs-to-memory-db` create the
target table in another DB file and drain rows in batches. They must complete before the
code that reads `llm_request_logs` on the logs connection / before the memory-jobs worker
starts. Treat as synchronous (they already batch internally to stay responsive).

**Privacy/correctness deletions — prefer sync:**
`229-delete-private-conversations` deletes across 15+ tables. It's data-heavy but is a
privacy guarantee; it should complete before private content could be surfaced. Keep sync.

**Likely-deferrable-but-verify-the-read-path:**
`180-backfill-inline-attachments-to-disk` and `209-strip-thinking-from-consolidated` are
data rewrites currently sequenced before ready. They can move to async **only if** the
attachment read path is dual-mode (inline OR on-disk) and the message render path tolerates
un-stripped thinking blocks, respectively. Confirm before deferring.

---

## C. Must be synchronous — schema / structure (the bulk)

Everything not named in A or B. Summarized rather than enumerated (≈278 migrations):

**DB schema (must be sync):** all `CREATE TABLE` / table-bootstrap migrations
(`000`, `101`–`121`, `149`, `170`–`177`, `202b` memory-graph, `230`–`303` feature tables),
all `ALTER TABLE ADD/DROP COLUMN`, all `CREATE`/`DROP INDEX`, all column/table renames
(`141`–`174`), FK-cascade rebuilds (`002`, `120`, `162`, `241`), and FTS table+trigger
creation (`116`, drop `154`). Running code references these on the first request.

**Workspace structure (must be sync)** — the filesystem analog of schema, because the
runtime reads these paths/config on boot:
`001` (avatar canonicalization), `003` (device id), `006` (services config / inference
routing), `011` (installation id), `016` (feature flags → protected), `018` (credential
rekey), `021`–`024` (move signals/hooks/config/runtime-state into the workspace volume),
`041`/`042` (oauth scope backfill), `059`/`061` (pid / backup key into workspace),
`060` (memory v2 dir scaffold), `083` (system-prompt-prefix → file), `084` (skills index
cleanup), `088`/`089` (prompt/ tree relocation). These must land before the subsystems that
read them initialize.

**Small data / config (sync by default — trivial, not worth deferring):** the large run of
config seeds, callsite defaults, inference-profile pins, model-id swaps, release-note
`UPDATES.md` edits, and persona/dir seeds (`004`, `005`, `007*`, `029`–`058`, `062`–`112`
on the workspace side; `143`, `168`, `169`, `181`, `191`, `196b`, `204`, `216`, `231`,
`246`, `257`, `270a`, `292`, `296`, `302` on the DB side). Each writes a bounded number of
rows/keys in microseconds.

---

## Recommendation

1. **Keep all of section C synchronous.** Schema + structure must be in place before the
   first request; trivial config seeds aren't worth the complexity of deferral.
2. **Keep section B synchronous** as coupled units (and verify the two "likely-deferrable"
   ones' read paths before moving them).
3. **Move section A to a post-ready background job**, following the existing
   `memory_v2_reembed` precedent: the synchronous migration becomes "enqueue job + mark a
   `needs_backfill` flag," and a worker drains it after readiness. Guard each consumer to
   tolerate the pre-migration state (the caveats column lists exactly what each one needs).
4. **Special-case `028-recover-conversations-from-disk-view`:** it's a disaster-recovery
   path, not routine backfill — gate it on "DB was empty/lost," and when triggered it
   should run early (it reconstructs the DB), not deferred.

The win is concentrated in section A's table/file walks (FTS backfills, disk-view rebuilds,
v3 leaf backfills, attachment scrubs) — these are the only ones whose cost grows with a
heavy user's history. The other ~280 migrations are bounded and belong in the synchronous
boot path.
