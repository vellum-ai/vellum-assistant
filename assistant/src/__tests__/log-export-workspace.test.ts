/**
 * Tests for the log export route handler.
 *
 * Validates that `POST /v1/export` returns a tar.gz archive containing:
 * - audit-data.json with tool invocation records
 * - daemon-logs/ with log file contents
 * - config-snapshot.json with sanitized config
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// Set up temp directories before mocking
const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
mkdirSync(testWorkspaceDir, { recursive: true });

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

import { initializeDb } from "../memory/db.js";
import { logExportRouteDefinitions } from "../runtime/routes/log-export-routes.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const routes = logExportRouteDefinitions();
const exportRoute = routes.find((r) => r.endpoint === "export")!;

async function callExport(
  body: Record<string, unknown> = {},
): Promise<Response> {
  const req = new Request("http://localhost/v1/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

// ---------------------------------------------------------------------------
// Seed test data
// ---------------------------------------------------------------------------

// config.json at workspace root — needed for config-snapshot test
writeFileSync(
  join(testWorkspaceDir, "config.json"),
  JSON.stringify({ provider: "anthropic" }),
);

// Conversation directories — used for workspace allowlist tests
const conversationsDir = join(testWorkspaceDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

function seedConversation(name: string, body: string) {
  const dir = join(conversationsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), "{}\n");
  writeFileSync(join(dir, "messages.jsonl"), body);
}

seedConversation(
  "2025-01-10T00-00-00.000Z_conv-jan10",
  '{"role":"user","content":"jan 10"}\n',
);
seedConversation(
  "2025-01-15T00-00-00.000Z_conv-jan15",
  '{"role":"user","content":"jan 15"}\n',
);
seedConversation(
  "2025-01-20T00-00-00.000Z_conv-jan20",
  '{"role":"user","content":"jan 20"}\n',
);
seedConversation(
  "2025-01-25T00-00-00.000Z_conv-jan25",
  '{"role":"user","content":"jan 25"}\n',
);
seedConversation("malformed-name", '{"role":"user","content":"x"}\n');

// Daemon log files — used for date filtering tests
const logsDir = join(testWorkspaceDir, "data", "logs");
mkdirSync(logsDir, { recursive: true });
writeFileSync(
  join(logsDir, "assistant-2025-01-10.log"),
  "log entry from Jan 10\n",
);
writeFileSync(
  join(logsDir, "assistant-2025-01-15.log"),
  "log entry from Jan 15\n",
);
writeFileSync(
  join(logsDir, "assistant-2025-01-20.log"),
  "log entry from Jan 20\n",
);
writeFileSync(
  join(logsDir, "assistant-2025-01-25.log"),
  "log entry from Jan 25\n",
);
// Non-dated log file — should always be included regardless of time filter
writeFileSync(join(logsDir, "vellum.log"), "non-dated log content\n");

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

describe("POST /v1/export — daemon log date filtering", () => {
  test("excludes log files before startTime", async () => {
    // startTime = Jan 14 — should exclude assistant-2025-01-10.log
    const startTime = new Date("2025-01-14T00:00:00.000Z").getTime();
    const res = await callExport({ startTime });
    const dir = await extractArchive(res);
    try {
      const logFiles = readdirSync(join(dir, "daemon-logs"));
      expect(logFiles).not.toContain("assistant-2025-01-10.log");
      expect(logFiles).toContain("assistant-2025-01-15.log");
      expect(logFiles).toContain("assistant-2025-01-20.log");
      expect(logFiles).toContain("assistant-2025-01-25.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes log files after endTime", async () => {
    // endTime = Jan 22 — should exclude assistant-2025-01-25.log
    const endTime = new Date("2025-01-22T00:00:00.000Z").getTime();
    const res = await callExport({ endTime });
    const dir = await extractArchive(res);
    try {
      const logFiles = readdirSync(join(dir, "daemon-logs"));
      expect(logFiles).toContain("assistant-2025-01-10.log");
      expect(logFiles).toContain("assistant-2025-01-15.log");
      expect(logFiles).toContain("assistant-2025-01-20.log");
      expect(logFiles).not.toContain("assistant-2025-01-25.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters log files by both startTime and endTime", async () => {
    // startTime = Jan 14, endTime = Jan 22 — should only include Jan 15 and Jan 20
    const startTime = new Date("2025-01-14T00:00:00.000Z").getTime();
    const endTime = new Date("2025-01-22T00:00:00.000Z").getTime();
    const res = await callExport({ startTime, endTime });
    const dir = await extractArchive(res);
    try {
      const logFiles = readdirSync(join(dir, "daemon-logs"));
      expect(logFiles).not.toContain("assistant-2025-01-10.log");
      expect(logFiles).toContain("assistant-2025-01-15.log");
      expect(logFiles).toContain("assistant-2025-01-20.log");
      expect(logFiles).not.toContain("assistant-2025-01-25.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("always includes non-dated log files regardless of time filter", async () => {
    const startTime = new Date("2025-01-14T00:00:00.000Z").getTime();
    const endTime = new Date("2025-01-22T00:00:00.000Z").getTime();
    const res = await callExport({ startTime, endTime });
    const dir = await extractArchive(res);
    try {
      const logFiles = readdirSync(join(dir, "daemon-logs"));
      expect(logFiles).toContain("vellum.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includes all log files when no time filter is specified", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const logFiles = readdirSync(join(dir, "daemon-logs"));
      expect(logFiles).toContain("assistant-2025-01-10.log");
      expect(logFiles).toContain("assistant-2025-01-15.log");
      expect(logFiles).toContain("assistant-2025-01-20.log");
      expect(logFiles).toContain("assistant-2025-01-25.log");
      expect(logFiles).toContain("vellum.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/export — workspace allowlist", () => {
  test("includes all valid conversation dirs by default", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const convs = readdirSync(join(dir, "workspace", "conversations"));
      expect(convs).toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(convs).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(convs).toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(convs).toContain("2025-01-25T00-00-00.000Z_conv-jan25");
      expect(convs).not.toContain("malformed-name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips malformed conversation dir names", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const convs = readdirSync(join(dir, "workspace", "conversations"));
      expect(convs).not.toContain("malformed-name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters conversation dirs by startTime", async () => {
    const startTime = Date.parse("2025-01-14T00:00:00Z");
    const res = await callExport({ startTime });
    const dir = await extractArchive(res);
    try {
      const convs = readdirSync(join(dir, "workspace", "conversations"));
      expect(convs).not.toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(convs).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(convs).toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(convs).toContain("2025-01-25T00-00-00.000Z_conv-jan25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters conversation dirs by endTime", async () => {
    const endTime = Date.parse("2025-01-22T00:00:00Z");
    const res = await callExport({ endTime });
    const dir = await extractArchive(res);
    try {
      const convs = readdirSync(join(dir, "workspace", "conversations"));
      expect(convs).toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(convs).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(convs).toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(convs).not.toContain("2025-01-25T00-00-00.000Z_conv-jan25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters conversation dirs by both startTime and endTime", async () => {
    const startTime = Date.parse("2025-01-14T00:00:00Z");
    const endTime = Date.parse("2025-01-22T00:00:00Z");
    const res = await callExport({ startTime, endTime });
    const dir = await extractArchive(res);
    try {
      const convs = readdirSync(join(dir, "workspace", "conversations"));
      expect(convs).not.toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(convs).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(convs).toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(convs).not.toContain("2025-01-25T00-00-00.000Z_conv-jan25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters conversation dirs by conversationId", async () => {
    const res = await callExport({ conversationId: "conv-jan15" });
    const dir = await extractArchive(res);
    try {
      const convs = readdirSync(join(dir, "workspace", "conversations"));
      expect(convs).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(convs).not.toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(convs).not.toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(convs).not.toContain("2025-01-25T00-00-00.000Z_conv-jan25");
      expect(convs).not.toContain("malformed-name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conversationId + time filter intersect", async () => {
    const res = await callExport({
      conversationId: "conv-jan15",
      startTime: Date.parse("2025-02-01T00:00:00Z"),
    });
    const dir = await extractArchive(res);
    try {
      const conversationsPath = join(dir, "workspace", "conversations");
      let convs: string[] = [];
      try {
        convs = readdirSync(conversationsPath);
      } catch {
        // Directory does not exist — acceptable per the test contract.
      }
      expect(convs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conversation dir contents survive the round trip", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const messagesPath = join(
        dir,
        "workspace",
        "conversations",
        "2025-01-15T00-00-00.000Z_conv-jan15",
        "messages.jsonl",
      );
      const content = readFileSync(messagesPath, "utf-8");
      expect(content).toBe('{"role":"user","content":"jan 15"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
