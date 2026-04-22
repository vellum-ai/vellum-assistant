import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveIpcSocketPath } from "../socket-path.js";

const LONG_BASE_DIR =
  "/Users/noaflaherty/.local/share/vellum-dev/assistants/vellum-safe-dace-8hrt6e/.vellum/workspace";

let savedBaseDataDir: string | undefined;

beforeEach(() => {
  savedBaseDataDir = process.env.BASE_DATA_DIR;
});

afterEach(() => {
  if (savedBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = savedBaseDataDir;
  }
});

describe("resolveIpcSocketPath", () => {
  test("uses protected dir path when it is within the platform limit", () => {
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath(
      "assistant-cli.sock",
      "/tmp/vellum-test",
    );

    expect(resolved.source).toBe("protected");
    expect(resolved.path).toBe("/tmp/vellum-test/assistant-cli.sock");
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to BASE_DATA_DIR/ipc when preferred path is too long", () => {
    process.env.BASE_DATA_DIR = "/tmp/vellum-instance-test";

    const resolved = resolveIpcSocketPath("assistant-cli.sock", LONG_BASE_DIR);

    expect(resolved.source).toBe("base-data-dir");
    expect(resolved.path).toBe(
      "/tmp/vellum-instance-test/ipc/assistant-cli.sock",
    );
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to tmpdir hash path when preferred path is too long and BASE_DATA_DIR is absent", () => {
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath("assistant-cli.sock", LONG_BASE_DIR);

    expect(resolved.source).toBe("tmp-hash");
    expect(resolved.path.startsWith(join(tmpdir(), "vellum-ipc"))).toBe(true);
    expect(resolved.path.endsWith("assistant-cli.sock")).toBe(true);
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });
});
