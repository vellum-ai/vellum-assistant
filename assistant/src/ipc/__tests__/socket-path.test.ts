import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveIpcSocketPath } from "../socket-path.js";

const LONG_BASE_DIR =
  "/Users/alice-johnson/.local/share/vellum-dev/assistants/vellum-safe-dace-8hrt6e/.vellum/workspace";

describe("resolveIpcSocketPath", () => {
  test("uses protected dir path when it is within the platform limit", () => {
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

  test("falls back to tmpdir hash path when preferred path is too long", () => {
    const resolved = resolveIpcSocketPath("assistant-cli.sock", LONG_BASE_DIR);

    expect(resolved.source).toBe("tmp-hash");
    expect(resolved.path.startsWith(join(tmpdir(), "vellum-ipc"))).toBe(true);
    expect(resolved.path.endsWith("assistant-cli.sock")).toBe(true);
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });
});
