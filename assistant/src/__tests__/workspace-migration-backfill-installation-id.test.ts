/**
 * Tests for workspace migration `011-backfill-installation-id`.
 *
 * Backfills a per-user `installationId` into the lockfile entry, sourcing it
 * from the `telemetry:installation_id` row in the assistant DB's
 * `memory_checkpoints` table (or a fresh UUID when absent), then deletes the
 * stale checkpoint row. The lockfile is read from the user's home directory;
 * the checkpoint lives in `<workspace>/data/db/assistant.db`.
 *
 * `node:os.homedir` is mocked to a temp directory so the lockfile paths never
 * resolve to the developer's real `~`. The checkpoint is exercised against a
 * real temp SQLite database, so the migration's inlined `bun:sqlite` access —
 * including the table-missing fallback paths — runs for real.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockHome = "";
const homedirFn = mock((): string => mockHome);
mock.module("node:os", () => ({ homedir: homedirFn }));

import { backfillInstallationIdMigration } from "../workspace/migrations/011-backfill-installation-id.js";

const CHECKPOINT_KEY = "telemetry:installation_id";
const ASSISTANT_NAME = "my-assistant";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The preload sets VELLUM_WORKSPACE_DIR under a per-process temp root; its
// parent is a writable temp base we can carve fresh dirs out of.
const TMP_BASE = dirname(process.env.VELLUM_WORKSPACE_DIR ?? "");

let workspaceDir: string;
let dbPath: string;
let lockPath: string;
let legacyLockPath: string;
let originalAssistantName: string | undefined;

beforeEach(() => {
  originalAssistantName = process.env.VELLUM_ASSISTANT_NAME;
  process.env.VELLUM_ASSISTANT_NAME = ASSISTANT_NAME;

  mockHome = mkdtempSync(join(TMP_BASE, "vellum-migration-011-home-"));
  workspaceDir = mkdtempSync(join(TMP_BASE, "vellum-migration-011-ws-"));
  homedirFn.mockClear();

  lockPath = join(mockHome, ".vellum.lock.json");
  legacyLockPath = join(mockHome, ".vellum.lockfile.json");

  const dbDir = join(workspaceDir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  dbPath = join(dbDir, "assistant.db");
});

afterEach(() => {
  if (originalAssistantName === undefined) {
    delete process.env.VELLUM_ASSISTANT_NAME;
  } else {
    process.env.VELLUM_ASSISTANT_NAME = originalAssistantName;
  }
  for (const dir of [mockHome, workspaceDir]) {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createCheckpointsTable(): void {
  const db = new Database(dbPath);
  try {
    db.run(`
      CREATE TABLE memory_checkpoints (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  } finally {
    db.close();
  }
}

/** Seed the installation-ID checkpoint row, creating the table if needed. */
function seedCheckpoint(value: string): void {
  if (!existsSync(dbPath)) {
    createCheckpointsTable();
  }
  const db = new Database(dbPath);
  try {
    db.run(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, 0)`,
      [CHECKPOINT_KEY, value],
    );
  } finally {
    db.close();
  }
}

/** Read the checkpoint value directly, or null when the table/row is absent. */
function readCheckpoint(): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  const db = new Database(dbPath);
  try {
    const row = db
      .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
      .get(CHECKPOINT_KEY) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Create an empty DB file with no tables. */
function createEmptyDb(): void {
  new Database(dbPath).close();
}

function makeLockfile(assistants: Array<Record<string, unknown>>): string {
  return JSON.stringify({ assistants });
}

function writeLock(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

function readLockAssistants(path: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path, "utf-8")).assistants;
}

describe("011-backfill-installation-id migration", () => {
  test("no-op when no lockfile exists", () => {
    backfillInstallationIdMigration.run(workspaceDir);

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(legacyLockPath)).toBe(false);
  });

  test("no-op when lockfile has no assistants array", () => {
    writeLock(lockPath, JSON.stringify({ version: 1 }));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual({ version: 1 });
  });

  test("no-op when lockfile is malformed JSON", () => {
    writeLock(lockPath, "{{not json");

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readFileSync(lockPath, "utf-8")).toBe("{{not json");
  });

  test("no-op when lockfile is an array", () => {
    writeLock(lockPath, JSON.stringify([1, 2, 3]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual([1, 2, 3]);
  });

  test("no-op when no matching assistant entry found", () => {
    writeLock(lockPath, makeLockfile([{ assistantId: "other-assistant" }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toBeUndefined();
  });

  test("backfills installationId from SQLite checkpoint", () => {
    seedCheckpoint("sqlite-install-id");
    writeLock(lockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toBe(
      "sqlite-install-id",
    );
  });

  test("generates a new UUID when the checkpoint row is absent", () => {
    createCheckpointsTable(); // table exists, no row
    writeLock(lockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toMatch(UUID_RE);
  });

  test("generates a new UUID when the assistant DB does not exist", () => {
    writeLock(lockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toMatch(UUID_RE);
  });

  test("falls back to a UUID and does not throw when the memory_checkpoints table is absent", () => {
    createEmptyDb(); // DB file exists but has no memory_checkpoints table
    writeLock(lockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    expect(() =>
      backfillInstallationIdMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readLockAssistants(lockPath)[0].installationId).toMatch(UUID_RE);
  });

  test("skips lockfile write when entry already has installationId", () => {
    writeLock(
      lockPath,
      makeLockfile([
        { assistantId: ASSISTANT_NAME, installationId: "existing-id" },
      ]),
    );

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toBe("existing-id");
  });

  test("deletes the checkpoint row when entry already has installationId", () => {
    seedCheckpoint("stale-id");
    writeLock(
      lockPath,
      makeLockfile([
        { assistantId: ASSISTANT_NAME, installationId: "existing-id" },
      ]),
    );

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readCheckpoint()).toBeNull();
  });

  test("deletes the checkpoint row after writing the lockfile", () => {
    seedCheckpoint("sqlite-id");
    writeLock(lockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toBe("sqlite-id");
    expect(readCheckpoint()).toBeNull();
  });

  test("reads from legacy .vellum.lockfile.json when primary is absent", () => {
    seedCheckpoint("sqlite-id");
    writeLock(legacyLockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(legacyLockPath)[0].installationId).toBe(
      "sqlite-id",
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  test("prefers primary lockfile over legacy when both exist", () => {
    seedCheckpoint("sqlite-id");
    writeLock(lockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));
    writeLock(legacyLockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(lockPath)[0].installationId).toBe("sqlite-id");
    expect(
      readLockAssistants(legacyLockPath)[0].installationId,
    ).toBeUndefined();
  });

  test("falls through to legacy lockfile when primary is malformed", () => {
    seedCheckpoint("sqlite-id");
    writeLock(lockPath, "{{not json");
    writeLock(legacyLockPath, makeLockfile([{ assistantId: ASSISTANT_NAME }]));

    backfillInstallationIdMigration.run(workspaceDir);

    expect(readLockAssistants(legacyLockPath)[0].installationId).toBe(
      "sqlite-id",
    );
  });

  test("preserves other assistants in lockfile when writing", () => {
    seedCheckpoint("sqlite-id");
    writeLock(
      lockPath,
      makeLockfile([
        { assistantId: "other-assistant", installationId: "other-id" },
        { assistantId: ASSISTANT_NAME },
      ]),
    );

    backfillInstallationIdMigration.run(workspaceDir);

    const assistants = readLockAssistants(lockPath);
    expect(assistants[0].installationId).toBe("other-id");
    expect(assistants[1].installationId).toBe("sqlite-id");
  });

  test("has migration id 011-backfill-installation-id", () => {
    expect(backfillInstallationIdMigration.id).toBe(
      "011-backfill-installation-id",
    );
  });
});
