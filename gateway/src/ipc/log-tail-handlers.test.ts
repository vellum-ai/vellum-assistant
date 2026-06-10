/**
 * Tests for gateway log-tail IPC routes.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayConfig } from "../config.js";

mock.module("../logger.js", () => {
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
    LOG_FILE_JSON_PATTERN: /^gateway-(\d{4}-\d{2}-\d{2})\.jsonl$/,
  };
});

const { createLogTailRoutes } = await import("./log-tail-handlers.js");

let tmpDir: string | undefined;

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

function makeLogLine(level: number, msg: string): string {
  return JSON.stringify({ level, msg, time: Date.now() });
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("createLogTailRoutes", () => {
  test("registers gateway_logs_tail with optional params", () => {
    const route = createLogTailRoutes(makeConfig(undefined))[0];

    expect(route.method).toBe("gateway_logs_tail");
    expect(route.schema?.safeParse(undefined).success).toBe(true);
    expect(route.schema?.safeParse({ level: "INVALID" }).success).toBe(false);
  });

  test("tails gateway logs through the IPC handler", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gw-ipc-log-tail-test-"));
    writeFileSync(
      join(tmpDir, "gateway-2026-05-04.jsonl"),
      [
        makeLogLine(30, "info msg"),
        makeLogLine(40, "warn msg"),
        makeLogLine(50, "error msg"),
      ].join("\n"),
    );

    const route = createLogTailRoutes(makeConfig(tmpDir))[0];
    const result = route.handler({ n: 2, level: "warn" }) as {
      lines: Array<{ msg: string }>;
      truncated: boolean;
    };

    expect(result.truncated).toBe(false);
    expect(result.lines.map((line) => line.msg)).toEqual([
      "warn msg",
      "error msg",
    ]);
  });
});
