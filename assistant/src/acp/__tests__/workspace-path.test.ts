/**
 * Tests for `resolveAcpWorkspaceDir` — the stable per-project workspace
 * resolver that pins an ACP session's default `cwd` to a durable directory
 * under the persistent workspace volume.
 *
 * The contract: for a given conversation id the resolved path is
 * deterministic, lives under the workspace volume (so it survives turns,
 * respawns, and idle-sleep), is never an ephemeral temp dir, and is created
 * on disk. We drive the workspace root via `VELLUM_WORKSPACE_DIR` (the same
 * override containerized deployments use to point at the PVC) so the test
 * doesn't touch the real `~/.vellum/workspace`.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveAcpWorkspaceDir } from "../workspace-path.js";

let workspaceRoot: string;
let prevOverride: string | undefined;

beforeEach(() => {
  // The temp dir is only the test's stand-in for the persistent PVC mount;
  // the helper under test never derives paths from os.tmpdir itself.
  workspaceRoot = mkdtempSync(join(tmpdir(), "acp-workspace-test-"));
  prevOverride = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceRoot;
});

afterEach(() => {
  if (prevOverride === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
  else process.env.VELLUM_WORKSPACE_DIR = prevOverride;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("resolveAcpWorkspaceDir", () => {
  test("resolves to a stable path under the workspace volume", () => {
    const conversationId = "11111111-2222-3333-4444-555555555555";
    const dir = resolveAcpWorkspaceDir(conversationId);

    const expected = join(workspaceRoot, "acp", conversationId);
    expect(dir).toBe(expected);
    expect(dir.startsWith(workspaceRoot + sep)).toBe(true);
  });

  test("returns the SAME path for repeated calls (across turns/respawns)", () => {
    const conversationId = "conv-abc";
    const first = resolveAcpWorkspaceDir(conversationId);
    const second = resolveAcpWorkspaceDir(conversationId);
    expect(second).toBe(first);
  });

  test("creates the directory if it does not exist", () => {
    const dir = resolveAcpWorkspaceDir("fresh-conversation");
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test("keys distinct conversations to distinct directories", () => {
    const a = resolveAcpWorkspaceDir("conversation-a");
    const b = resolveAcpWorkspaceDir("conversation-b");
    expect(a).not.toBe(b);
  });

  test("derives from the workspace volume, not os.tmpdir", () => {
    // The path must be anchored to the configured workspace root. (The
    // workspace root happens to be a temp dir in this test, but the helper
    // never reaches for os.tmpdir on its own — it only uses getWorkspaceDir.)
    const dir = resolveAcpWorkspaceDir("conv-1");
    expect(dir.startsWith(workspaceRoot + sep)).toBe(true);
  });

  test("sanitizes path-traversal in the conversation id", () => {
    const dir = resolveAcpWorkspaceDir("../../etc/passwd");
    // Must stay confined under the acp workspace root — no escape.
    const acpRoot = join(workspaceRoot, "acp");
    expect(dir.startsWith(acpRoot + sep)).toBe(true);
    // The id collapses to exactly one segment under the acp root — slashes
    // are stripped, so there is no separator to traverse out of, and the
    // segment can never equal a bare ".." (guarded by the resolver).
    const segment = dir.slice(acpRoot.length + 1);
    expect(segment.includes(sep)).toBe(false);
    expect(segment).not.toBe("..");
  });

  test("maps a degenerate id to a safe single segment", () => {
    const dir = resolveAcpWorkspaceDir("..");
    expect(dir).toBe(join(workspaceRoot, "acp", "_"));
  });
});
