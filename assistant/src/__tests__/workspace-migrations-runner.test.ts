import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { WorkspaceMigration } from "../workspace/migrations/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCheckpointContents: string | null = null;

const readTextFileSyncFn = mock((path: string): string | null => {
  void path;
  return mockCheckpointContents;
});
const ensureDirFn = mock(() => {});
const writeFileSyncFn = mock(() => {});
const renameSyncFn = mock(() => {});

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../util/fs.js", () => ({
  readTextFileSync: readTextFileSyncFn,
  ensureDir: ensureDirFn,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module("node:fs", () => ({
  writeFileSync: writeFileSyncFn,
  renameSync: renameSyncFn,
}));

// Import after mocking
import { runWorkspaceMigrations } from "../workspace/migrations/runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/tmp/test-workspace";

function makeMigration(id: string): WorkspaceMigration {
  return {
    id,
    description: `Migration ${id}`,
    run: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWorkspaceMigrations", () => {
  beforeEach(() => {
    mockCheckpointContents = null;
    readTextFileSyncFn.mockClear();
    ensureDirFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
  });

  test("runs migrations in order", () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const callOrder: string[] = [];
    (m1.run as ReturnType<typeof mock>).mockImplementation(() => {
      callOrder.push("001");
    });
    (m2.run as ReturnType<typeof mock>).mockImplementation(() => {
      callOrder.push("002");
    });

    runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["001", "002"]);
  });

  test("skips already-applied migrations", () => {
    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z" },
      },
    });

    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).not.toHaveBeenCalled();
    expect(m2.run).toHaveBeenCalledTimes(1);
  });

  test("writes checkpoint after each migration", () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    (m2.run as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("migration 002 failed");
    });

    expect(() => runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2])).toThrow(
      "migration 002 failed",
    );

    // m1 ran successfully before the error
    expect(m1.run).toHaveBeenCalledTimes(1);

    // Checkpoint was saved after m1 (writeFileSync + renameSync pair)
    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn).toHaveBeenCalledTimes(1);

    // Verify the checkpoint contains m1 but not m2
    const written = (writeFileSyncFn.mock.calls[0] as unknown[])[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.applied["001"]).toBeDefined();
    expect(parsed.applied["002"]).toBeUndefined();
  });

  test("idempotent on re-run", () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    // First run — no checkpoint file exists
    runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);

    // Capture the last checkpoint that was written
    const lastWriteCall = writeFileSyncFn.mock.calls.at(-1) as unknown[];
    const savedCheckpoint = lastWriteCall[1] as string;

    // Reset mocks for second run
    (m1.run as ReturnType<typeof mock>).mockClear();
    (m2.run as ReturnType<typeof mock>).mockClear();

    // Simulate reading back the saved checkpoint
    mockCheckpointContents = savedCheckpoint;

    runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).not.toHaveBeenCalled();
    expect(m2.run).not.toHaveBeenCalled();
  });

  test("handles missing checkpoint file gracefully", () => {
    // mockCheckpointContents is already null (no file on disk)
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
  });

  test("handles malformed checkpoint file", () => {
    mockCheckpointContents = "this is not valid JSON {{{}}}";

    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    // Malformed checkpoint is treated as fresh state — all migrations run
    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
  });
});
