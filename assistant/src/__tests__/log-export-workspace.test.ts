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
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// Set up temp directories before mocking
const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
mkdirSync(testWorkspaceDir, { recursive: true });

// Mock getSecureKeyAsync to avoid credential store access during tests
mock.module("../util/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
}));

import { getDb, getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversations,
  llmRequestLogs,
  toolInvocations,
} from "../persistence/schema/index.js";
import { RouteError } from "../runtime/routes/errors.js";
import {
  MAX_EXPORT_LLM_REQUEST_LOG_ROWS,
  ROUTES,
} from "../runtime/routes/log-export-routes.js";
import {
  MAX_SWEEP_FILE_BYTES,
  OVERSIZED_FILE_NOTE,
  redactStagedExportFiles,
} from "../runtime/routes/redact-staged-export.js";
import {
  OPENAI_PROJECT_KEY_REDACTION_MARKER,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

await initializeDb();

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
// acp.agents env value is a synthetic secret that must be redacted from the
// exported snapshot. Unlike the shared `SYNTHETIC_OPENAI_PROJECT_KEY`, it is
// deliberately below the secret scanner's 40-char minimum, so the export-time
// sweep cannot see it — only the config snapshot's structural env redaction
// can keep it out of the archive, meaning a sanitizer regression cannot be
// masked by the sweep.
const SWEEP_INVISIBLE_SYNTHETIC_KEY = "sk-proj-synthetic-test-key-000000";
writeFileSync(
  join(testWorkspaceDir, "config.json"),
  JSON.stringify({
    provider: "anthropic",
    acp: {
      agents: {
        codex: {
          env: {
            OPENAI_API_KEY: SWEEP_INVISIBLE_SYNTHETIC_KEY,
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
      expect(configContent).not.toContain(SWEEP_INVISIBLE_SYNTHETIC_KEY);
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
      // Clean daemon log files must also ship byte-identical — the secret
      // sweep does no gratuitous rewrites.
      for (const logFile of ["assistant-2025-01-10.log", "vellum.log"]) {
        expect(readFileSync(join(dir, "daemon-logs", logFile), "utf-8")).toBe(
          readFileSync(join(logsDir, logFile), "utf-8"),
        );
      }
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
// Export manifest row-cap truncation
// ---------------------------------------------------------------------------

describe("POST /v1/export — manifest truncatedSections", () => {
  async function readManifest(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await callExport(body);
    const dir = await extractArchive(res);
    try {
      return JSON.parse(
        readFileSync(join(dir, "export-manifest.json"), "utf-8"),
      ) as Record<string, unknown>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("omits truncatedSections when no section hits its row cap", async () => {
    const manifest = await readManifest({ full: true });
    expect(manifest.type).toBe("full-export");
    expect(manifest).not.toHaveProperty("truncatedSections");
  });

  test("surfaces truncatedSections when a full-export dump exceeds its row cap", async () => {
    // Seed limit + 1 rows for the cheapest capped section (llm-request-logs)
    // so capRows detects truncation without a COUNT query.
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({ id: "conv-cap-test", createdAt: now, updatedAt: now })
      .run();
    const rows = Array.from(
      { length: MAX_EXPORT_LLM_REQUEST_LOG_ROWS + 1 },
      (_, i) => ({
        id: `llm-log-cap-${i}`,
        conversationId: "conv-cap-test",
        requestPayload: "{}",
        responsePayload: "{}",
        createdAt: now + i,
      }),
    );
    getLogsDb()!.insert(llmRequestLogs).values(rows).run();

    const manifest = await readManifest({ full: true });
    expect(manifest.truncatedSections).toEqual(["llm-request-logs"]);
  });
});

// ---------------------------------------------------------------------------
// Export-time secret sweep
// ---------------------------------------------------------------------------

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

      expect(result).toEqual({
        filesScanned: 3,
        filesRedacted: 0,
        filesOmitted: 0,
      });
      for (const [rel, content] of Object.entries(seeded)) {
        expect(readFileSync(join(staging, rel), "utf-8")).toBe(content);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("redacts .jsonl files line-wise, keeping each valid line parseable", () => {
    const staging = mkdtempSync(join(tmpdir(), "redact-staged-jsonl-"));
    try {
      const filePath = join(staging, "conversation-filtered.jsonl");
      const validLine = JSON.stringify({
        msg: `token ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
      });
      const malformedLine = `not json but carries ${SYNTHETIC_OPENAI_PROJECT_KEY}`;
      const cleanLine = JSON.stringify({ msg: "clean" });
      writeFileSync(
        filePath,
        `${validLine}\n${malformedLine}\n${cleanLine}\n`,
        "utf-8",
      );

      const result = redactStagedExportFiles(staging);
      expect(result).toEqual({
        filesScanned: 1,
        filesRedacted: 1,
        filesOmitted: 0,
      });

      const lines = readFileSync(filePath, "utf-8").split("\n");
      expect(lines[0]).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      // The valid line stays valid JSON, marker stored as a string value.
      const parsed = JSON.parse(lines[0]) as { msg: string };
      expect(parsed.msg).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
      // The unparseable line falls back to plain-text redaction.
      expect(lines[1]).toBe(
        `not json but carries ${OPENAI_PROJECT_KEY_REDACTION_MARKER}`,
      );
      // The clean line is untouched.
      expect(lines[2]).toBe(cleanLine);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("sweeps arbitrary-extension staged files that sniff as text; leaves binary files untouched", () => {
    const staging = mkdtempSync(join(tmpdir(), "redact-staged-sniff-"));
    try {
      // Conversation attachments are staged wholesale with arbitrary user
      // extensions — sweep eligibility is decided by content sniffing, not
      // file extension, so they must still be swept when they sniff as text.
      const attachmentsDir = join(
        staging,
        "workspace",
        "conversations",
        "2025-01-10T00-00-00.000Z_conv-jan10",
        "attachments",
      );
      mkdirSync(attachmentsDir, { recursive: true });
      writeFileSync(
        join(attachmentsDir, "creds.env"),
        `OPENAI_API_KEY=${SYNTHETIC_OPENAI_PROJECT_KEY}\n`,
        "utf-8",
      );
      writeFileSync(
        join(attachmentsDir, "no-extension"),
        `key: ${SYNTHETIC_OPENAI_PROJECT_KEY}\n`,
        "utf-8",
      );
      // Binary sniff: a NUL byte in the head exempts the file from the
      // sweep even though scanner-matching bytes appear later in it.
      const binary = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        Buffer.from(SYNTHETIC_OPENAI_PROJECT_KEY, "utf-8"),
      ]);
      writeFileSync(join(attachmentsDir, "image.png"), binary);

      const result = redactStagedExportFiles(staging);

      expect(result).toEqual({
        filesScanned: 2,
        filesRedacted: 2,
        filesOmitted: 0,
      });
      for (const file of ["creds.env", "no-extension"]) {
        const content = readFileSync(join(attachmentsDir, file), "utf-8");
        expect(content).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
        expect(content).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      }
      expect(readFileSync(join(attachmentsDir, "image.png"))).toEqual(binary);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("replaces oversized sweep-eligible files with an omission note (fail closed)", () => {
    const staging = mkdtempSync(join(tmpdir(), "redact-staged-oversize-"));
    try {
      // One byte over the cap. The content must never ship unswept — it is
      // replaced wholesale with the omission note. An omitted file was never
      // actually scanned or redacted, so it only counts as omitted.
      writeFileSync(
        join(staging, "messages.json"),
        Buffer.alloc(MAX_SWEEP_FILE_BYTES + 1, 0x61),
      );

      const result = redactStagedExportFiles(staging);

      expect(result).toEqual({
        filesScanned: 0,
        filesRedacted: 0,
        filesOmitted: 1,
      });
      expect(readFileSync(join(staging, "messages.json"), "utf-8")).toBe(
        OVERSIZED_FILE_NOTE,
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("redacts BOM-prefixed .json files via the JSON-aware path, preserving the BOM", () => {
    const staging = mkdtempSync(join(tmpdir(), "redact-staged-bom-"));
    try {
      // A UTF-8 BOM (common in user attachments) makes JSON.parse throw, so
      // without BOM handling the file would take the plain-text fallback and
      // the quoted marker would corrupt the JSON string it lands in.
      const filePath = join(staging, "attachment.json");
      writeFileSync(
        filePath,
        "\uFEFF" +
          JSON.stringify({ key: SYNTHETIC_OPENAI_PROJECT_KEY }, null, 2),
        "utf-8",
      );

      const result = redactStagedExportFiles(staging);
      expect(result).toEqual({
        filesScanned: 1,
        filesRedacted: 1,
        filesOmitted: 0,
      });

      const content = readFileSync(filePath, "utf-8");
      expect(content.startsWith("\uFEFF")).toBe(true);
      expect(content).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      // Stripping the preserved BOM yields valid JSON with the marker stored
      // as a proper string value.
      const parsed = JSON.parse(content.slice(1)) as { key: string };
      expect(parsed.key).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  // Root bypasses file permission checks, so chmod 0o444 cannot make the
  // file read-only — skip rather than assert a fail-closed path that cannot
  // be exercised.
  test.skipIf(process.getuid?.() === 0)(
    "redacts a read-only staged file in place instead of shipping the raw secret",
    () => {
      const staging = mkdtempSync(join(tmpdir(), "redact-staged-readonly-"));
      try {
        // A read-only workspace attachment is staged with its mode bits
        // preserved (cpSync). The sweep must still rewrite it — the chmod
        // path — so the raw secret never reaches the tar step.
        const readonlyPath = join(staging, "creds.env");
        writeFileSync(
          readonlyPath,
          `OPENAI_API_KEY=${SYNTHETIC_OPENAI_PROJECT_KEY}\n`,
          "utf-8",
        );
        chmodSync(readonlyPath, 0o444);
        // A clean read-only file needs no rewrite, so it must keep its
        // content AND its mode bits (no gratuitous chmod).
        const cleanPath = join(staging, "clean.txt");
        writeFileSync(cleanPath, "nothing secret here\n", "utf-8");
        chmodSync(cleanPath, 0o444);

        const result = redactStagedExportFiles(staging);

        expect(result).toEqual({
          filesScanned: 2,
          filesRedacted: 1,
          filesOmitted: 0,
        });
        const content = readFileSync(readonlyPath, "utf-8");
        expect(content).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
        expect(content).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
        expect(readFileSync(cleanPath, "utf-8")).toBe("nothing secret here\n");
        expect(statSync(cleanPath).mode & 0o777).toBe(0o444);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  );

  // Root bypasses file permission checks, so chmod 0o000 cannot make the
  // file unreadable — skip rather than assert a degraded path that cannot
  // be exercised.
  test.skipIf(process.getuid?.() === 0)(
    "sweep continues past an unreadable staged file (degraded, not failed)",
    () => {
      const staging = mkdtempSync(join(tmpdir(), "redact-staged-unreadable-"));
      const unreadablePath = join(staging, "unreadable.log");
      try {
        writeFileSync(
          join(staging, "readable.log"),
          `key ${SYNTHETIC_OPENAI_PROJECT_KEY}\n`,
          "utf-8",
        );
        writeFileSync(unreadablePath, "any content\n", "utf-8");
        chmodSync(unreadablePath, 0o000);

        // Must return normally: the unreadable file is logged and skipped,
        // and every other staged file is still swept.
        const result = redactStagedExportFiles(staging);

        expect(result).toEqual({
          filesScanned: 1,
          filesRedacted: 1,
          filesOmitted: 0,
        });
        const content = readFileSync(join(staging, "readable.log"), "utf-8");
        expect(content).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
        expect(content).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      } finally {
        chmodSync(unreadablePath, 0o600);
        rmSync(staging, { recursive: true, force: true });
      }
    },
  );

  test("redacts raw keys from workspace conversation files in the archive", async () => {
    seedConversation(
      "2025-01-30T00-00-00.000Z_conv-secret",
      JSON.stringify({
        role: "user",
        content: `export OPENAI_API_KEY="${SYNTHETIC_OPENAI_PROJECT_KEY}"`,
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
      expect(content).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      // Line-wise JSON-aware redaction: every redacted line must still
      // JSON.parse, with the marker stored as a proper JSON string value
      // (its quotes are escaped on serialization).
      const lines = content.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      const parsedLines = lines.map(
        (line) => JSON.parse(line) as { content?: string },
      );
      expect(
        parsedLines.some((record) =>
          record.content?.includes(OPENAI_PROJECT_KEY_REDACTION_MARKER),
        ),
      ).toBe(true);
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
          command: `export OPENAI_API_KEY="${SYNTHETIC_OPENAI_PROJECT_KEY}"`,
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
      expect(content).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      // The sweep must keep the file parseable — redaction goes through a
      // JSON-aware path rather than splicing quoted markers into raw JSON.
      const rows = JSON.parse(content) as Array<{ id: string; input: string }>;
      const row = rows.find((r) => r.id === "ti-legacy-audit");
      expect(row).toBeDefined();
      expect(row!.input).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
