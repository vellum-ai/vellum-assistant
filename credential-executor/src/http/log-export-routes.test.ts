/**
 * Tests for the CES log export route handler.
 *
 * Verifies:
 * - Returns a valid tar.gz archive containing CES log files
 * - Filters log files by startTime query param
 * - Filters log files by endTime query param
 * - Returns an empty archive (manifest only) when no logs exist
 * - Returns 401/403 without a valid service token
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { handleLogExportRoute } from "./log-export-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_TOKEN = "test-ces-service-token-12345";

let tmpLogDir: string;

function makeRequest(
  opts: {
    startTime?: number;
    endTime?: number;
    token?: string | null;
    method?: string;
  } = {},
): Request {
  const params = new URLSearchParams();
  if (opts.startTime !== undefined)
    params.set("startTime", String(opts.startTime));
  if (opts.endTime !== undefined) params.set("endTime", String(opts.endTime));

  const qs = params.toString();
  const url = `http://localhost:8090/v1/logs/export${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {};
  if (opts.token !== null) {
    headers["Authorization"] = `Bearer ${opts.token ?? SERVICE_TOKEN}`;
  }

  return new Request(url, { method: opts.method ?? "GET", headers });
}

/**
 * Extract a tar.gz buffer and return the list of file paths inside.
 */
function extractTarGzEntries(buf: ArrayBuffer): string[] {
  const staging = mkdtempSync(join(tmpdir(), "ces-test-extract-"));
  try {
    const tarGzPath = join(staging, "archive.tar.gz");
    writeFileSync(tarGzPath, Buffer.from(buf));

    const extractDir = join(staging, "out");
    mkdirSync(extractDir, { recursive: true });

    const proc = spawnSync("tar", ["xzf", tarGzPath, "-C", extractDir]);
    if (proc.status !== 0) {
      throw new Error(
        `tar extraction failed: ${proc.stderr?.toString() ?? "unknown"}`,
      );
    }

    // Recursively list all files
    const files: string[] = [];
    function walk(dir: string, prefix: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(full).isDirectory()) {
          walk(full, rel);
        } else {
          files.push(rel);
        }
      }
    }
    walk(extractDir, "");
    return files.sort();
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpLogDir = mkdtempSync(join(tmpdir(), "ces-log-export-test-"));
  process.env["CES_SERVICE_TOKEN"] = SERVICE_TOKEN;
});

afterEach(() => {
  rmSync(tmpLogDir, { recursive: true, force: true });
  delete process.env["CES_SERVICE_TOKEN"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CES log export route", () => {
  it("returns tar.gz with CES log files", async () => {
    // Create test log files
    writeFileSync(join(tmpLogDir, "ces-2025-01-15.log"), "log line 1\n");
    writeFileSync(join(tmpLogDir, "ces-2025-01-16.log"), "log line 2\n");

    const res = await handleLogExportRoute(makeRequest(), tmpLogDir);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("application/gzip");

    const buf = await res!.arrayBuffer();
    const entries = extractTarGzEntries(buf);

    // Should contain the manifest and the two log files
    expect(entries).toContain("ces-export-manifest.json");
    expect(entries).toContain("ces-logs/ces-2025-01-15.log");
    expect(entries).toContain("ces-logs/ces-2025-01-16.log");
  });

  it("filters by startTime query param", async () => {
    // 2025-01-15 = 1736899200000 (start of day UTC)
    // 2025-01-16 = 1736985600000 (start of day UTC)
    // 2025-01-17 = 1737072000000 (start of day UTC)
    writeFileSync(join(tmpLogDir, "ces-2025-01-15.log"), "old log\n");
    writeFileSync(join(tmpLogDir, "ces-2025-01-16.log"), "recent log\n");
    writeFileSync(join(tmpLogDir, "ces-2025-01-17.log"), "newest log\n");

    // startTime at 2025-01-16 12:00:00 UTC — should include 01-16 and 01-17
    // because 01-16 day end (23:59:59.999) >= startTime
    const startTime = new Date("2025-01-16T12:00:00Z").getTime();
    const res = await handleLogExportRoute(
      makeRequest({ startTime }),
      tmpLogDir,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const entries = extractTarGzEntries(await res!.arrayBuffer());
    expect(entries).not.toContain("ces-logs/ces-2025-01-15.log");
    expect(entries).toContain("ces-logs/ces-2025-01-16.log");
    expect(entries).toContain("ces-logs/ces-2025-01-17.log");
  });

  it("filters by endTime query param", async () => {
    writeFileSync(join(tmpLogDir, "ces-2025-01-15.log"), "old log\n");
    writeFileSync(join(tmpLogDir, "ces-2025-01-16.log"), "recent log\n");
    writeFileSync(join(tmpLogDir, "ces-2025-01-17.log"), "newest log\n");

    // endTime at 2025-01-16 00:00:00 UTC — should include 01-15 and 01-16
    // because 01-16 day start (00:00:00) <= endTime, but 01-17 day start > endTime
    const endTime = new Date("2025-01-16T00:00:00Z").getTime();
    const res = await handleLogExportRoute(makeRequest({ endTime }), tmpLogDir);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const entries = extractTarGzEntries(await res!.arrayBuffer());
    expect(entries).toContain("ces-logs/ces-2025-01-15.log");
    expect(entries).toContain("ces-logs/ces-2025-01-16.log");
    expect(entries).not.toContain("ces-logs/ces-2025-01-17.log");
  });

  it("returns empty archive when no logs exist", async () => {
    // tmpLogDir exists but has no log files
    const res = await handleLogExportRoute(makeRequest(), tmpLogDir);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const entries = extractTarGzEntries(await res!.arrayBuffer());
    // Should still contain the manifest
    expect(entries).toContain("ces-export-manifest.json");
    // No log files in ces-logs/
    const logFiles = entries.filter((e) => e.startsWith("ces-logs/"));
    expect(logFiles.length).toBe(0);
  });

  it("returns 401 without Authorization header", async () => {
    const res = await handleLogExportRoute(
      makeRequest({ token: null }),
      tmpLogDir,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);

    const body = await res!.json();
    expect(body.error).toMatch(/Missing Authorization/i);
  });

  it("returns 403 with wrong service token", async () => {
    const res = await handleLogExportRoute(
      makeRequest({ token: "wrong-token-value" }),
      tmpLogDir,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);

    const body = await res!.json();
    expect(body.error).toMatch(/Invalid service token/i);
  });

  it("returns null for non-matching paths", async () => {
    const req = new Request("http://localhost:8090/v1/other", {
      method: "GET",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const res = await handleLogExportRoute(req, tmpLogDir);
    expect(res).toBeNull();
  });

  it("returns 405 for non-GET methods on the export path", async () => {
    const res = await handleLogExportRoute(
      makeRequest({ method: "POST" }),
      tmpLogDir,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(405);
  });

  it("ignores non-log files in the directory", async () => {
    writeFileSync(join(tmpLogDir, "ces-2025-01-15.log"), "real log\n");
    writeFileSync(join(tmpLogDir, "random-file.txt"), "not a log\n");
    writeFileSync(join(tmpLogDir, "ces-bad-date.log"), "bad pattern\n");

    const res = await handleLogExportRoute(makeRequest(), tmpLogDir);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const entries = extractTarGzEntries(await res!.arrayBuffer());
    expect(entries).toContain("ces-logs/ces-2025-01-15.log");
    // Non-matching files should not be included
    const logFiles = entries.filter((e) => e.startsWith("ces-logs/"));
    expect(logFiles.length).toBe(1);
  });
});
