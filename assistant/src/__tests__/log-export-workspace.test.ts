/**
 * Tests for the log export route handler.
 *
 * Validates that `POST /v1/export` returns a tar.gz archive containing:
 * - audit-data.json with tool invocation records
 * - daemon-logs/ with log file contents
 * - config-snapshot.json with sanitized config
 * - workspace/ with text files, SQL dumps for .db files, and proper
 *   filtering (excluded directories, binary files, symlinks).
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

// Mock getSecureKeyAsync to avoid credential store access during tests
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

/** Extracts a tar.gz response into a temp directory and returns the path. */
async function extractArchive(res: Response): Promise<string> {
  const extractDir = mkdtempSync(join(tmpdir(), "log-export-extract-"));
  const archiveBytes = Buffer.from(await res.arrayBuffer());
  const archivePath = join(extractDir, "archive.tar.gz");
  writeFileSync(archivePath, archiveBytes);

  const proc = spawnSync("tar", ["xzf", archivePath, "-C", extractDir]);
  if (proc.status !== 0) {
    throw new Error(
      `tar extraction failed: ${proc.stderr?.toString() ?? "unknown error"}`,
    );
  }

  return extractDir;
}

/** Recursively lists all files under a directory as relative paths. */
function listFiles(dir: string, base = dir): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(full, base));
    } else {
      result.push(full.slice(base.length + 1));
    }
  }
  return result;
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

describe("POST /v1/export — tar.gz archive", () => {
  test("returns a valid tar.gz archive with correct headers", async () => {
    const res = await callExport();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="logs.tar.gz"',
    );

    // Verify the response body is valid gzip (starts with gzip magic bytes)
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  test("archive contains audit-data.json", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const auditPath = join(dir, "audit-data.json");
      const content = readFileSync(auditPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive contains workspace text files", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const identity = readFileSync(
        join(dir, "workspace", "IDENTITY.md"),
        "utf-8",
      );
      expect(identity).toBe("# My Identity\nHello");

      const daily = readFileSync(
        join(dir, "workspace", "notes", "daily.txt"),
        "utf-8",
      );
      expect(daily).toBe("Some daily notes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive contains SQLite DB dumps as .sql files", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const sqlContent = readFileSync(
        join(dir, "workspace", "data", "db", "assistant.db.sql"),
        "utf-8",
      );
      expect(sqlContent).toContain("CREATE TABLE");
      expect(sqlContent).toContain("test_table");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive excludes embedding-models/ and data/qdrant/", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const files = listFiles(join(dir, "workspace"));
      const embeddingFiles = files.filter((f) =>
        f.startsWith("embedding-models/"),
      );
      const qdrantFiles = files.filter((f) => f.startsWith("data/qdrant/"));
      expect(embeddingFiles).toHaveLength(0);
      expect(qdrantFiles).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive excludes binary files and config.json at workspace root", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const files = listFiles(join(dir, "workspace"));
      expect(files).not.toContain("binary-file.dat");
      expect(files).not.toContain("config.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive excludes symlinks", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const files = listFiles(join(dir, "workspace"));
      expect(files).not.toContain("sneaky-link.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive contains config-snapshot.json when config exists", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const configContent = readFileSync(
        join(dir, "config-snapshot.json"),
        "utf-8",
      );
      const parsed = JSON.parse(configContent);
      expect(parsed.provider).toBe("anthropic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
