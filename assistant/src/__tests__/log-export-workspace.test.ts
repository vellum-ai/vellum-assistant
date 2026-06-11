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

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { conversations, toolInvocations } from "../memory/schema.js";
import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/log-export-routes.js";
import { redactStagedExportFiles } from "../runtime/routes/redact-staged-export.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const exportRoute = ROUTES.find((r) => r.endpoint === "export")!;

async function callExport(
  body: Record<string, unknown> = {},
): Promise<Response> {
  try {
    const result = await exportRoute.handler({ body });

    // The handler returns a Uint8Array — wrap in a Response with the expected
    // headers so existing test assertions (res.status, res.headers, res.arrayBuffer())
    // keep working.
    if (result instanceof Uint8Array) {
      return new Response(result as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="logs.tar.gz"',
          "Content-Length": String(result.byteLength),
        },
      });
    }
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: message },
      { status: err instanceof RouteError ? err.statusCode : 500 },
    );
  }
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

// config.json at workspace root — needed for config-snapshot tests. The
// acp.agents env values are obviously-synthetic secrets that must be redacted
// from the exported snapshot.
const SYNTHETIC_ACP_API_KEY = "sk-proj-synthetic-test-key-000000";
writeFileSync(
  join(testWorkspaceDir, "config.json"),
  JSON.stringify({
    provider: "anthropic",
    acp: {
      agents: {
        codex: {
          env: {
            OPENAI_API_KEY: SYNTHETIC_ACP_API_KEY,
            PATH: "/data/.bun/bin",
          },
        },
      },
    },
  }),
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

  test("config-snapshot.json redacts acp.agents env values", async () => {
    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const configContent = readFileSync(
        join(dir, "config-snapshot.json"),
        "utf-8",
      );
      const parsed = JSON.parse(configContent);
      const env = parsed.acp.agents.codex.env as Record<string, string>;
      expect(Object.keys(env).sort()).toEqual(["OPENAI_API_KEY", "PATH"]);
      for (const value of Object.values(env)) {
        expect(value).toBe("(set)");
      }
      expect(configContent).not.toContain(SYNTHETIC_ACP_API_KEY);
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

  test("treats empty-string conversationId as no filter", async () => {
    const res = await callExport({ conversationId: "" });
    const dir = await extractArchive(res);
    try {
      // With conversationId === "" (which the rest of handleExport treats as
      // unfiltered), workspace conversations should also be unfiltered. All
      // four canonical conversation dirs should be present.
      const conversationsDir = join(dir, "workspace", "conversations");
      const entries = readdirSync(conversationsDir);
      expect(entries).toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(entries).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(entries).toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(entries).toContain("2025-01-25T00-00-00.000Z_conv-jan25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treats startTime=0 and endTime=0 as no filter", async () => {
    const res = await callExport({ startTime: 0, endTime: 0 });
    const dir = await extractArchive(res);
    try {
      const conversationsDir = join(dir, "workspace", "conversations");
      const entries = readdirSync(conversationsDir);
      // All four canonical conversation dirs should be present (no filtering).
      expect(entries).toContain("2025-01-10T00-00-00.000Z_conv-jan10");
      expect(entries).toContain("2025-01-15T00-00-00.000Z_conv-jan15");
      expect(entries).toContain("2025-01-20T00-00-00.000Z_conv-jan20");
      expect(entries).toContain("2025-01-25T00-00-00.000Z_conv-jan25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Export-time secret sweep
// ---------------------------------------------------------------------------

// A synthetic OpenAI project key that matches the scanner's
// `sk-proj-[A-Za-z0-9\-_]{40,}` pattern while deliberately dodging its
// placeholder filtering: no "test"/"example"/"xxxx"-style segments, not a
// repeated character, and it ends with an alphanumeric so the trailing `\b`
// boundary holds.
const RAW_OPENAI_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh";
const REDACTION_MARKER = '<redacted type="OpenAI Project Key" />';

// NOTE: these tests intentionally run after every other describe block in
// this file — they seed a workspace conversation and an audit DB row that
// contain a raw secret, which would otherwise leak into the exports made by
// the earlier (clean-state) tests.
describe("POST /v1/export — staged-file secret sweep", () => {
  test("clean staged files are left byte-identical and report filesRedacted: 0", () => {
    const staging = mkdtempSync(join(tmpdir(), "redact-staged-clean-"));
    try {
      mkdirSync(join(staging, "daemon-logs"), { recursive: true });
      const seeded: Record<string, string> = {
        "audit-data.json": JSON.stringify(
          [{ id: "ti-1", toolName: "bash", input: "{}" }],
          null,
          2,
        ),
        "daemon-logs/assistant-2025-01-10.log": "log entry from Jan 10\n",
        "notes.md": "# clean notes\n",
      };
      for (const [rel, content] of Object.entries(seeded)) {
        writeFileSync(join(staging, rel), content, "utf-8");
      }

      const result = redactStagedExportFiles(staging);

      expect(result).toEqual({ filesScanned: 3, filesRedacted: 0 });
      for (const [rel, content] of Object.entries(seeded)) {
        expect(readFileSync(join(staging, rel), "utf-8")).toBe(content);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("redacts raw keys from workspace conversation files in the archive", async () => {
    seedConversation(
      "2025-01-30T00-00-00.000Z_conv-secret",
      JSON.stringify({
        role: "user",
        content: `export OPENAI_API_KEY="${RAW_OPENAI_PROJECT_KEY}"`,
      }) + "\n",
    );

    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const content = readFileSync(
        join(
          dir,
          "workspace",
          "conversations",
          "2025-01-30T00-00-00.000Z_conv-secret",
          "messages.jsonl",
        ),
        "utf-8",
      );
      expect(content).toContain(REDACTION_MARKER);
      expect(content).not.toContain(RAW_OPENAI_PROJECT_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redacts legacy audit rows and keeps audit-data.json valid JSON", async () => {
    // Simulate a row written before write-time input redaction shipped: the
    // raw key sits in the persisted `input` column, where no structural
    // sanitizer can retroactively fix it.
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({ id: "conv-legacy-audit", createdAt: now, updatedAt: now })
      .run();
    db.insert(toolInvocations)
      .values({
        id: "ti-legacy-audit",
        conversationId: "conv-legacy-audit",
        toolName: "bash",
        input: JSON.stringify({
          command: `export OPENAI_API_KEY="${RAW_OPENAI_PROJECT_KEY}"`,
        }),
        result: "{}",
        decision: "allow",
        riskLevel: "low",
        durationMs: 5,
        createdAt: now,
      })
      .run();

    const res = await callExport();
    const dir = await extractArchive(res);
    try {
      const content = readFileSync(join(dir, "audit-data.json"), "utf-8");
      expect(content).not.toContain(RAW_OPENAI_PROJECT_KEY);
      // The sweep must keep the file parseable — redaction goes through a
      // JSON-aware path rather than splicing quoted markers into raw JSON.
      const rows = JSON.parse(content) as Array<{ id: string; input: string }>;
      const row = rows.find((r) => r.id === "ti-legacy-audit");
      expect(row).toBeDefined();
      expect(row!.input).toContain(REDACTION_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
