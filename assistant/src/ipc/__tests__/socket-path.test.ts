import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveIpcSocketPath } from "../socket-path.js";

const LONG_WORKSPACE_DIR =
  "/Users/noaflaherty/.local/share/vellum-dev/assistants/vellum-safe-dace-8hrt6e/.vellum/workspace";

let savedWorkspaceDir: string | undefined;
let savedBaseDataDir: string | undefined;

beforeEach(() => {
  savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  savedBaseDataDir = process.env.BASE_DATA_DIR;
});

afterEach(() => {
  if (savedWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
  }
  if (savedBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = savedBaseDataDir;
  }
});

describe("resolveIpcSocketPath", () => {
  test("uses workspace path when it is within the platform limit", () => {
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-workspace-test";
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath("assistant-cli.sock");

    expect(resolved.source).toBe("workspace");
    expect(resolved.path).toBe("/tmp/vellum-workspace-test/assistant-cli.sock");
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to BASE_DATA_DIR/ipc when workspace path is too long", () => {
    process.env.VELLUM_WORKSPACE_DIR = LONG_WORKSPACE_DIR;
    process.env.BASE_DATA_DIR = "/tmp/vellum-instance-test";

    const resolved = resolveIpcSocketPath("assistant-cli.sock");

    expect(resolved.source).toBe("base-data-dir");
    expect(resolved.path).toBe(
      "/tmp/vellum-instance-test/ipc/assistant-cli.sock",
    );
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });

  test("falls back to tmpdir hash path when workspace path is too long and BASE_DATA_DIR is absent", () => {
    process.env.VELLUM_WORKSPACE_DIR = LONG_WORKSPACE_DIR;
    delete process.env.BASE_DATA_DIR;

    const resolved = resolveIpcSocketPath("assistant-cli.sock");

    expect(resolved.source).toBe("tmp-hash");
    expect(resolved.path.startsWith(join(tmpdir(), "vellum-ipc"))).toBe(true);
    expect(resolved.path.endsWith("assistant-cli.sock")).toBe(true);
    expect(Buffer.byteLength(resolved.path, "utf8")).toBeLessThanOrEqual(
      resolved.maxPathBytes,
    );
  });
});
