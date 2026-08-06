#!/usr/bin/env bun
/**
 * Builds the "migrated" workspace test fixture: a workspace directory whose
 * `data/db/` holds the four assistant databases (main, logs, memory, telemetry)
 * after a full migration run.
 *
 * The test preload copies this fixture into every test process's tmp workspace
 * (see `src/__tests__/test-preload.ts`), so a test that calls `initializeDb()`
 * opens an already-migrated DB and the migration runner no-ops via its
 * checkpoint ledger instead of re-running the whole chain in every one of the
 * ~1800 test processes.
 *
 * `scripts/test.ts` runs this as a subprocess once, before the worker pool
 * starts. It is also runnable directly:
 *   bun run scripts/build-test-fixtures.ts <outWorkspaceDir>
 *
 * Why a standalone script and not preload machinery
 * -------------------------------------------------
 * This script imports `src/` (initializeDb, the DB getters) and runs the real
 * migration chain in a throwaway workspace of its own. That is exactly what
 * preload code must NOT do — importing the persistence graph before the per-test
 * workspace override is set is the "DB-ghost" hazard the test-machinery
 * isolation rule guards against (see `assistant/AGENTS.md`). This file is never
 * imported by the preload; it runs in its own dedicated process, so the coupling
 * is safe here.
 *
 * The databases are captured with `VACUUM INTO` rather than a raw file copy: the
 * live connections run in WAL mode, and a plain copy of the main `.db` would
 * miss `-wal`/`-shm` frames and could read back as `SQLITE_CORRUPT`. `VACUUM
 * INTO` asks SQLite to write a fresh, fully-checkpointed, defragmented database,
 * so the fixture is self-contained and safe to copy with no sidecars.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

async function buildMigratedFixture(outWorkspaceDir: string): Promise<void> {
  // Migrate in a throwaway workspace, then snapshot its DBs into the fixture.
  const buildRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-fixture-build-")),
  );
  const buildWorkspace = join(buildRoot, "workspace");
  mkdirSync(buildWorkspace);
  process.env.VELLUM_WORKSPACE_DIR = buildWorkspace;
  process.env.VELLUM_PLATFORM_URL ??= "https://test-platform.vellum.ai";
  // Match the preload's env hygiene so migrations never route through a live
  // credential store while building the fixture.
  delete process.env.IS_CONTAINERIZED;
  delete process.env.CES_CREDENTIAL_URL;

  const { initializeDb } = await import("../src/persistence/db-init.js");
  const { getSqlite, getLogsSqlite, getMemorySqlite, getTelemetrySqlite } =
    await import("../src/persistence/db-connection.js");
  const { getDbPath } = await import("../src/util/platform.js");
  const { getLogsDbPath } = await import("../src/util/logs-db-path.js");
  const { getMemoryDbPath } = await import("../src/util/memory-db-path.js");
  const { getTelemetryDbPath } =
    await import("../src/util/telemetry-db-path.js");

  const result = await initializeDb();
  if (!result.migrationsOk) {
    throw new Error(
      "fixture build: initializeDb() reported migrationsOk=false",
    );
  }

  const destDbDir = join(outWorkspaceDir, "data", "db");
  mkdirSync(destDbDir, { recursive: true });

  // The four DBs are captured together: the migrated state spans them (e.g.
  // llm_request_logs in `logs`, memory_jobs in `memory`, telemetry_events +
  // flush_checkpoints in `telemetry`), so a partial capture would leave a test
  // with missing tables.
  const captures = [
    [getSqlite(), getDbPath()],
    [getLogsSqlite(), getLogsDbPath()],
    [getMemorySqlite(), getMemoryDbPath()],
    [getTelemetrySqlite(), getTelemetryDbPath()],
  ] as const;

  for (const [sqlite, srcPath] of captures) {
    if (!sqlite) {
      throw new Error(
        `fixture build: connection for ${srcPath} was not opened by initializeDb()`,
      );
    }
    // Dest lives under a machine-generated tmp path (no single quotes), so the
    // simple single-quote quoting below is safe.
    const dest = join(destDbDir, basename(srcPath));
    rmSync(dest, { force: true });
    sqlite.exec(`VACUUM INTO '${dest}'`);
  }

  rmSync(buildRoot, { recursive: true, force: true });
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: build-test-fixtures.ts <outWorkspaceDir>");
    process.exit(1);
  }
  await buildMigratedFixture(outDir);
  process.exit(0);
}
