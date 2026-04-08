/**
 * Regression test for the `result.entries` contract on `collectWorkspaceData`.
 *
 * Consumers and telemetry rely on `collectWorkspaceData` always returning at
 * least one entry summary for the `conversations` allowlist entry — even when
 * something throws partway through the candidate loop. This file pins that
 * contract by mocking `parseConversationDirName` to return a malicious object
 * whose `createdAtMs` getter throws. That throw escapes the inner per-iteration
 * try/catch (it happens during sort + filter expression evaluation, not inside
 * the wrapped parser call), bubbles up to the outer try/catch in
 * `collectWorkspaceData`, and verifies that `result.entries` still contains
 * exactly one `conversations` entry summary.
 *
 * Lives in its own file because `mock.module` is a global module override and
 * we don't want it bleeding into the rest of the workspace-allowlist tests.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../memory/conversation-directories.js", () => ({
  parseConversationDirName: (_name: string) => {
    // Return an object whose `createdAtMs` accessor throws. This bypasses the
    // inner try/catch wrapping `parseConversationDirName(name)` (which only
    // catches synchronous throws from the call itself, not from later property
    // accesses) and triggers the unwrapped sort/filter comparisons further
    // down in `collectConversations`.
    return {
      conversationId: "evil",
      get createdAtMs(): number {
        throw new Error("simulated parser corruption");
      },
    };
  },
}));

import { getConversationsDir } from "../../../../util/platform.js";
import { collectWorkspaceData } from "../workspace-allowlist.js";

let staging: string;

beforeEach(() => {
  // Fresh staging directory for each test.
  const conversationsDir = getConversationsDir();
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });

  staging = join(
    process.env.VELLUM_WORKSPACE_DIR ?? "/tmp",
    "ws-allowlist-error-staging",
  );
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Seed a single canonical-looking dir so the loop has something to chew on.
  const dirName = "2025-01-15T00-00-00.000Z_conv-jan15";
  const dir = join(conversationsDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ name: dirName }),
    "utf-8",
  );
});

afterEach(() => {
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  try {
    rmSync(getConversationsDir(), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("collectWorkspaceData — entry contract on unexpected error", () => {
  test("synthesizes a conversations entry summary even when the loop throws", () => {
    // The mocked parser returns a poisoned object whose `createdAtMs` accessor
    // throws. The first read happens inside the time-filter checks in the
    // candidate-collection loop, which is NOT wrapped in a per-iteration
    // try/catch. The throw should propagate up to the outer try/catch in
    // `collectWorkspaceData`, where it must be swallowed without dropping
    // the entry summary.
    const result = collectWorkspaceData({
      staging,
      // Force the time-filter branch to read `createdAtMs`.
      startTime: 0,
    });

    // Contract: exactly one entry, named "conversations", regardless of error.
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.entry).toBe("conversations");
    expect(entry.itemCount).toBe(0);
    expect(entry.bytes).toBe(0);
    expect(entry.skippedDueToCap).toBe(0);
    expect(result.totalBytes).toBe(0);
  });
});
