/**
 * Tests for workspace file collection in the log export route handler.
 *
 * Validates that `POST /v1/export` includes workspace files with correct
 * filtering: text files included, SQLite DB files dumped as SQL, excluded
 * directories (embedding-models/, data/qdrant/) absent, binary files skipped.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

// Set up temp directories before mocking
const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "log-export-workspace-test-")),
);
const testWorkspaceDir = join(testDir, "workspace");
const testDbDir = join(testDir, "db");
const testDbPath = join(testDbDir, "assistant.db");

mkdirSync(testWorkspaceDir, { recursive: true });
mkdirSync(testDbDir, { recursive: true });

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getWorkspaceDir: () => testWorkspaceDir,
  getWorkspaceConfigPath: () => join(testWorkspaceDir, "config.json"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => testDbPath,
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock getSecureKeyAsync to avoid keychain access during tests
mock.module("../util/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
}));

import { initializeDb, resetDb } from "../memory/db.js";
import { logExportRouteDefinitions } from "../runtime/routes/log-export-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const routes = logExportRouteDefinitions();
const exportRoute = routes.find((r) => r.endpoint === "export")!;

async function callExport(): Promise<Response> {
  const req = new Request("http://localhost/v1/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const url = new URL(req.url);
  return exportRoute.handler({
    req,
    url,
    server: null as never,
    authContext: {} as never,
    params: {},
  });
}

// ---------------------------------------------------------------------------
// Seed workspace files
// ---------------------------------------------------------------------------

// Text files — should be included
writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), "# My Identity\nHello");
mkdirSync(join(testWorkspaceDir, "notes"), { recursive: true });
writeFileSync(join(testWorkspaceDir, "notes", "daily.txt"), "Some daily notes");

// SQLite DB file — should be dumped as .sql
mkdirSync(join(testWorkspaceDir, "data", "db"), { recursive: true });
// Create a real sqlite db with a table
import { Database } from "bun:sqlite";
const wsDbPath = join(testWorkspaceDir, "data", "db", "assistant.db");
const wsDb = new Database(wsDbPath);
wsDb.run("CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)");
wsDb.run("INSERT INTO test_table (name) VALUES ('hello')");
wsDb.close();

// Excluded directory: embedding-models/
mkdirSync(join(testWorkspaceDir, "embedding-models"), { recursive: true });
writeFileSync(
  join(testWorkspaceDir, "embedding-models", "model.bin"),
  "large binary model data",
);

// Excluded directory: data/qdrant/
mkdirSync(join(testWorkspaceDir, "data", "qdrant"), { recursive: true });
writeFileSync(
  join(testWorkspaceDir, "data", "qdrant", "index.bin"),
  "vector index data",
);

// Binary file — should be skipped
writeFileSync(
  join(testWorkspaceDir, "binary-file.dat"),
  Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]), // contains null byte
);

// config.json at workspace root — should be skipped (already in configSnapshot)
writeFileSync(
  join(testWorkspaceDir, "config.json"),
  JSON.stringify({ provider: "anthropic" }),
);

// Symlink pointing outside workspace — should be skipped
const outsideFile = join(testDir, "outside-secret.txt");
writeFileSync(outsideFile, "sensitive data outside workspace");
try {
  symlinkSync(outsideFile, join(testWorkspaceDir, "sneaky-link.txt"));
} catch {
  // Symlink creation may fail on some platforms; tests will still pass
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/export — workspace files", () => {
  test("includes text files in workspaceFiles", async () => {
    const res = await callExport();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    expect(body.workspaceFiles["IDENTITY.md"]).toBe("# My Identity\nHello");
    expect(body.workspaceFiles["notes/daily.txt"]).toBe("Some daily notes");
  });

  test("dumps SQLite DB files as .sql text", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    const sqlKey = "data/db/assistant.db.sql";
    expect(body.workspaceFiles[sqlKey]).toBeDefined();
    expect(body.workspaceFiles[sqlKey]).toContain("CREATE TABLE");
    expect(body.workspaceFiles[sqlKey]).toContain("test_table");
    // The raw .db file should NOT be present
    expect(body.workspaceFiles["data/db/assistant.db"]).toBeUndefined();
  });

  test("excludes embedding-models/ directory", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    const embeddingKeys = Object.keys(body.workspaceFiles).filter((k) =>
      k.startsWith("embedding-models/"),
    );
    expect(embeddingKeys).toHaveLength(0);
  });

  test("excludes data/qdrant/ directory", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    const qdrantKeys = Object.keys(body.workspaceFiles).filter((k) =>
      k.startsWith("data/qdrant/"),
    );
    expect(qdrantKeys).toHaveLength(0);
  });

  test("skips binary files containing null bytes", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    expect(body.workspaceFiles["binary-file.dat"]).toBeUndefined();
  });

  test("excludes config.json at workspace root", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    expect(body.workspaceFiles["config.json"]).toBeUndefined();
  });

  test("skips symlinks", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      workspaceFiles: Record<string, string>;
    };
    expect(body.workspaceFiles["sneaky-link.txt"]).toBeUndefined();
  });

  test("response includes workspaceFiles field", async () => {
    const res = await callExport();
    const body = (await res.json()) as {
      success: boolean;
      workspaceFiles: Record<string, string>;
    };
    expect(body.success).toBe(true);
    expect(body.workspaceFiles).toBeDefined();
    expect(typeof body.workspaceFiles).toBe("object");
  });
});
