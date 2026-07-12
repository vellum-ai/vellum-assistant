/**
 * Guard tests for `readAppFileBytes` — the byte-reading helper behind the app
 * asset endpoint (`GET /v1/apps/:appId/asset/:path*`, served to sandboxed apps
 * via `window.vellum.asset`).
 *
 *   - Bytes round-trip intact (the point of the helper: utf-8 decoding would
 *     corrupt binary media).
 *   - Path validation still rejects traversal, absolute paths, and the
 *     protected `records/` directory.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createApp,
  getAppDirPath,
  readAppFileBytes,
} from "../apps/app-store.js";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `vellum-app-asset-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.VELLUM_WORKSPACE_DIR = testDir;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeApp(): string {
  return createApp({
    name: "Asset Test",
    schemaJson: "{}",
    htmlDefinition: "<h1>hi</h1>",
  }).id;
}

describe("readAppFileBytes", () => {
  test("reads binary bytes without utf-8 corruption", () => {
    const appId = makeApp();
    // Includes 0xFF/0x80 — bytes that are not valid utf-8 and would be
    // mangled by a text read.
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x42]);
    const abs = join(getAppDirPath(appId), "assets", "clip.bin");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);

    const read = readAppFileBytes(appId, "assets/clip.bin");
    expect(Buffer.compare(read, bytes)).toBe(0);
  });

  test("rejects traversal, absolute paths, and the records/ directory", () => {
    const appId = makeApp();
    expect(() => readAppFileBytes(appId, "../../etc/passwd")).toThrow();
    expect(() => readAppFileBytes(appId, "/etc/passwd")).toThrow();
    expect(() => readAppFileBytes(appId, "records/secret.json")).toThrow();
  });

  test("throws for a missing file", () => {
    const appId = makeApp();
    expect(() => readAppFileBytes(appId, "assets/nope.png")).toThrow(
      /not found/i,
    );
  });
});
