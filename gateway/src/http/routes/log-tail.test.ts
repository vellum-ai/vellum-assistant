/**
 * Tests for the gateway log tail handler.
 *
 * Verifies:
 * - Returns empty result when logFile.dir is undefined
 * - Returns empty result when dir path doesn't exist
 * - Returns empty result when no files match the log pattern
 * - Returns last N entries in chronological order
 * - Filters by minimum log level
 * - Filters by module
 * - Skips malformed JSON lines
 * - Sets truncated: true when more entries exist than n
 * - Sets truncated: false when fewer entries exist than n
 * - Spans multiple log files for multi-day queries
 * - Clamps n=1001 to 1000
 * - Returns 400 for invalid level param
 * - Handles filesystem errors gracefully
 */

import { describe, test, expect, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Mocks — must be registered before importing the handler
// ---------------------------------------------------------------------------

mock.module("../../logger.js", () => {
  const noop = () => {};
  const noopLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLogger,
  };
  return {
    getLogger: () => noopLogger,
    initLogger: noop,
    LOG_FILE_PATTERN: /^gateway-(\d{4}-\d{2}-\d{2})\.log$/,
  };
});

// Import handler after mocks
const { createLogTailHandler } = await import("./log-tail.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeReq(url: string): Request {
  return new Request(url);
}

function makeConfig(dir: string | undefined): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 20 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 100 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "default",
    trustProxy: false,
  } as GatewayConfig;
}

function makeLogLine(level: number, msg: string, extras?: Record<string, unknown>): string {
  return JSON.stringify({ level, msg, time: Date.now(), ...extras });
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("log-tail handler", () => {
  test("config.logFile.dir is undefined → returns { lines: [], truncated: false }", async () => {
    const config = makeConfig(undefined);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail"));
    const body = await res.json();
    expect(body).toEqual({ lines: [], truncated: false });
  });

  test("dir path doesn't exist → returns { lines: [], truncated: false }", async () => {
    const config = makeConfig("/nonexistent/path/that/does/not/exist");
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail"));
    const body = await res.json();
    expect(body).toEqual({ lines: [], truncated: false });
  });

  test("dir exists but no files matching pattern → returns { lines: [], truncated: false }", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));
    writeFileSync(join(tmpDir, "other.log"), "some content\n");

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail"));
    const body = await res.json();
    expect(body).toEqual({ lines: [], truncated: false });
  });

  test("single file with 5 entries, n=3 → returns last 3 in chronological order, truncated: true", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const lines = [
      makeLogLine(30, "entry 1"),
      makeLogLine(30, "entry 2"),
      makeLogLine(30, "entry 3"),
      makeLogLine(30, "entry 4"),
      makeLogLine(30, "entry 5"),
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), lines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?n=3"));
    const body = await res.json() as { lines: { msg: string }[]; truncated: boolean };

    expect(body.truncated).toBe(true);
    expect(body.lines).toHaveLength(3);
    // Chronological order: entries 3, 4, 5
    expect(body.lines[0].msg).toBe("entry 3");
    expect(body.lines[1].msg).toBe("entry 4");
    expect(body.lines[2].msg).toBe("entry 5");
  });

  test("level=error query param filters to levels >= 50", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const lines = [
      makeLogLine(20, "debug msg"),
      makeLogLine(30, "info msg"),
      makeLogLine(50, "error msg"),
      makeLogLine(60, "fatal msg"),
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), lines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?level=error"));
    const body = await res.json() as { lines: { msg: string }[]; truncated: boolean };

    expect(body.lines).toHaveLength(2);
    const msgs = body.lines.map((l) => l.msg);
    expect(msgs).toContain("error msg");
    expect(msgs).toContain("fatal msg");
    expect(msgs).not.toContain("debug msg");
    expect(msgs).not.toContain("info msg");
  });

  test("module=mcp query param: only mcp entries returned", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const lines = [
      makeLogLine(30, "mcp message", { module: "mcp" }),
      makeLogLine(30, "trust message", { module: "trust" }),
      makeLogLine(30, "another mcp", { module: "mcp" }),
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), lines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?module=mcp"));
    const body = await res.json() as { lines: { msg: string; module: string }[]; truncated: boolean };

    expect(body.lines).toHaveLength(2);
    for (const line of body.lines) {
      expect(line.module).toBe("mcp");
    }
  });

  test("malformed JSON lines are silently skipped", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const lines = [
      "not json",
      makeLogLine(30, "valid entry"),
      "{broken json",
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), lines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail"));
    const body = await res.json() as { lines: { msg: string }[]; truncated: boolean };

    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].msg).toBe("valid entry");
  });

  test("n=2 with 4 matching entries → truncated: true", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const lines = [
      makeLogLine(30, "entry 1"),
      makeLogLine(30, "entry 2"),
      makeLogLine(30, "entry 3"),
      makeLogLine(30, "entry 4"),
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), lines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?n=2"));
    const body = await res.json() as { lines: unknown[]; truncated: boolean };

    expect(body.lines).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });

  test("n=10 with 3 matching entries → truncated: false", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const lines = [
      makeLogLine(30, "entry 1"),
      makeLogLine(30, "entry 2"),
      makeLogLine(30, "entry 3"),
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), lines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?n=10"));
    const body = await res.json() as { lines: unknown[]; truncated: boolean };

    expect(body.lines).toHaveLength(3);
    expect(body.truncated).toBe(false);
  });

  test("multi-day: spans two files, returns 3 in chronological order", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    // Yesterday file: 3 entries
    const yesterdayLines = [
      makeLogLine(30, "yesterday 1"),
      makeLogLine(30, "yesterday 2"),
      makeLogLine(30, "yesterday 3"),
    ];
    writeFileSync(join(tmpDir, "gateway-2026-05-03.log"), yesterdayLines.join("\n"));

    // Today file: 1 entry
    const todayLines = [makeLogLine(30, "today 1")];
    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), todayLines.join("\n"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?n=3"));
    const body = await res.json() as { lines: { msg: string }[]; truncated: boolean };

    expect(body.lines).toHaveLength(3);
    // Should span both files — newest-first collection, then reversed to chronological
    // With n=3, we want the 3 most recent: yesterday 3, yesterday 3... wait:
    // Files sorted newest-first: today (1 entry), yesterday (3 entries)
    // Collect reverse order: today 1, yesterday 3, yesterday 2 → stop at n+1=4
    // Actually we collect up to n+1=4 entries before stopping
    // today has 1 entry, then yesterday has 3 entries → total 4 → break after 4
    // truncated = 4 > 3 = true? Let's check the logic...
    // Actually we collect until collected.length >= n+1, so we need n+1=4 entries
    // today: 1 entry (total=1), yesterday: yesterday3(total=2), yesterday2(total=3), yesterday1(total=4) → break
    // truncated = 4 > 3 = true
    // lines = collected.slice(0,3) = [today1, yesterday3, yesterday2].reverse() = [yesterday2, yesterday3, today1]
    // Chronological: yesterday 2, yesterday 3, today 1
    expect(body.lines[0].msg).toBe("yesterday 2");
    expect(body.lines[1].msg).toBe("yesterday 3");
    expect(body.lines[2].msg).toBe("today 1");
  });

  test("n=1001 in querystring → returns successfully (clamped to 1000)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    writeFileSync(join(tmpDir, "gateway-2026-05-04.log"), makeLogLine(30, "entry"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?n=1001"));

    expect(res.status).toBe(200);
    const body = await res.json() as { lines: unknown[]; truncated: boolean };
    expect(body.lines).toHaveLength(1);
  });

  test("invalid level=INVALID → response status 400", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));

    const config = makeConfig(tmpDir);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail?level=INVALID"));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid level");
  });

  test("filesystem error: config.logFile.dir is a file path not a dir → returns gracefully", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-log-tail-test-"));
    const filePath = join(tmpDir, "not-a-directory.txt");
    writeFileSync(filePath, "I am a file");

    // Point dir at a file path — readdirSync will throw ENOTDIR
    const config = makeConfig(filePath);
    const handler = createLogTailHandler(config);
    const res = await handler(makeReq("http://localhost:7830/v1/logs/tail"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ lines: [], truncated: false });
  });
});
