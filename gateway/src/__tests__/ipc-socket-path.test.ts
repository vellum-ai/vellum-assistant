import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIpcSocketPath } from "../ipc/socket-path.js";

const LONG_WORKSPACE_DIR =
  "/Users/alice-johnson/.local/share/vellum-dev/assistants/vellum-safe-dace-8hrt6e/.vellum/workspace";

describe("resolveIpcSocketPath", () => {
  test("uses workspace path when it is within the platform limit", () => {
    const resolved = resolveIpcSocketPath(
      "gateway.sock",
      "/tmp/vellum-workspace-test",
    );

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe("/tmp/vellum-workspace-test/gateway.sock");
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to tmpdir hash path when workspace path is too long", () => {
    const resolved = resolveIpcSocketPath("gateway.sock", LONG_WORKSPACE_DIR);

    expect(resolved.source).toBe("tmp-hash");
    expect(resolved.path.startsWith(join(tmpdir(), "vellum-ipc"))).toBe(true);
    expect(resolved.path.endsWith("gateway.sock")).toBe(true);
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });
});
