/**
 * Tests for the gateway debug-export IPC route.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayConfig } from "../config.js";

// The database snapshot is the only piece that needs a live gateway DB;
// stand it in with a file write so the archive shape can be checked.
const snapshotGatewayDbMock = mock((destPath: string) => {
  writeFileSync(destPath, "SQLite format 3 (fake)");
});
mock.module("../db/connection.js", () => ({
  snapshotGatewayDb: snapshotGatewayDbMock,
}));

const { buildDebugExportArchive, createDebugExportRoutes } =
  await import("./debug-export-handlers.js");

function makeConfig(logDir: string | undefined): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: logDir, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 1,
      slack: 1,
      whatsapp: 1,
      default: 1,
    },
    maxAttachmentConcurrency: 1,
    maxWebhookPayloadBytes: 1,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 1,
    runtimeMaxRetries: 0,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 1000,
    shutdownDrainMs: 1,
    trustProxy: false,
  } as GatewayConfig;
}

async function listArchive(archiveBase64: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "debug-export-test-"));
  try {
    const archivePath = join(dir, "export.tar.gz");
    writeFileSync(archivePath, Buffer.from(archiveBase64, "base64"));
    const tar = Bun.spawn(["/usr/bin/tar", "tzf", archivePath], {
      stdout: "pipe",
    });
    const listing = await new Response(tar.stdout).text();
    await tar.exited;
    return listing
      .split("\n")
      .map((line) => line.replace(/^\.\//, ""))
      .filter((line) => line && line !== ".");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  snapshotGatewayDbMock.mockClear();
});

describe("gateway_debug_export", () => {
  test("registers the method with no params", () => {
    const route = createDebugExportRoutes(makeConfig(undefined))[0];
    expect(route.method).toBe("gateway_debug_export");
    expect(route.schema?.safeParse(undefined).success).toBe(true);
    expect(route.schema?.safeParse({ extra: 1 }).success).toBe(false);
  });

  test("packs a consistent database copy and the gateway's log files", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "gateway-logs-"));
    writeFileSync(join(logDir, "gateway-2026-09-18.log"), "line\n");
    try {
      const result = await buildDebugExportArchive(makeConfig(logDir));

      expect(snapshotGatewayDbMock).toHaveBeenCalledTimes(1);
      expect(result.size_bytes).toBeGreaterThan(0);
      const entries = await listArchive(result.archive_base64);
      expect(entries).toContain("gateway.sqlite");
      expect(entries).toContain("gateway-logs/gateway-2026-09-18.log");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("still exports the database when there is no log directory", async () => {
    const result = await buildDebugExportArchive(makeConfig(undefined));
    const entries = await listArchive(result.archive_base64);
    expect(entries).toContain("gateway.sqlite");
    expect(entries.some((entry) => entry.startsWith("gateway-logs/"))).toBe(
      false,
    );
  });
});
