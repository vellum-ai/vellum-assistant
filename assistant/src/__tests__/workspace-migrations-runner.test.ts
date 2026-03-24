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
const logWarnFn = mock(() => {});
const logInfoFn = mock(() => {});
const logErrorFn = mock((..._args: unknown[]) => {});

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../util/fs.js", () => ({
  readTextFileSync: readTextFileSyncFn,
  ensureDir: ensureDirFn,
}));

// Bun's mock.module for "../util/logger.js" doesn't intercept the runner's
// transitive import due to a Bun limitation. Mocking pino at the package level
// works because the runner's real getLogger uses a Proxy that lazily creates
// a pino child logger — so intercepting pino itself captures all log calls.
const mockChildLogger = {
  debug: () => {},
  info: logInfoFn,
  warn: logWarnFn,
  error: logErrorFn,
  child: () => mockChildLogger,
};
const mockPinoLogger = Object.assign(() => mockChildLogger, {
  destination: () => ({}),
  multistream: () => ({}),
});
mock.module("pino", () => ({ default: mockPinoLogger }));
mock.module("pino-pretty", () => ({ default: () => ({}) }));

mock.module("node:fs", () => ({
  writeFileSync: writeFileSyncFn,
  renameSync: renameSyncFn,
}));

// Import after mocking
import {
  loadCheckpoints,
  rollbackWorkspaceMigrations,
  runWorkspaceMigrations,
} from "../workspace/migrations/runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/tmp/test-workspace";

function makeMigration(id: string): WorkspaceMigration {
  return {
    id,
    description: `Migration ${id}`,
    run: mock(() => {}),
    down: mock(() => {}),
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
    logWarnFn.mockClear();
    logInfoFn.mockClear();
    logErrorFn.mockClear();
  });

  test("runs migrations in order", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const callOrder: string[] = [];
    (m1.run as ReturnType<typeof mock>).mockImplementation(() => {
      callOrder.push("001");
    });
    (m2.run as ReturnType<typeof mock>).mockImplementation(() => {
      callOrder.push("002");
    });

    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["001", "002"]);
  });

  test("skips already-applied migrations", async () => {
    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z" },
      },
    });

    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).not.toHaveBeenCalled();
    expect(m2.run).toHaveBeenCalledTimes(1);
  });

  test("writes checkpoint after each migration", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    (m2.run as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("migration 002 failed");
    });

    // Runner no longer throws — it marks failed migrations and continues
    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    // m1 ran successfully, m2 was attempted
    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);

    // Checkpoints saved: started m1, completed m1, started m2, failed m2 = 4 writes
    expect(writeFileSyncFn).toHaveBeenCalledTimes(4);
    expect(renameSyncFn).toHaveBeenCalledTimes(4);

    // Verify the completed checkpoint contains m1
    // The second write is the "completed" marker for m1
    const completedWrite = (
      writeFileSyncFn.mock.calls[1] as unknown[]
    )[1] as string;
    const parsed = JSON.parse(completedWrite);
    expect(parsed.applied["001"]).toBeDefined();
    expect(parsed.applied["001"].status).toBe("completed");

    // Verify m2 is marked as failed
    const failedWrite = (
      writeFileSyncFn.mock.calls[3] as unknown[]
    )[1] as string;
    const failedParsed = JSON.parse(failedWrite);
    expect(failedParsed.applied["002"]).toBeDefined();
    expect(failedParsed.applied["002"].status).toBe("failed");
  });

  test("idempotent on re-run", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    // First run — no checkpoint file exists
    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

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

    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).not.toHaveBeenCalled();
    expect(m2.run).not.toHaveBeenCalled();
  });

  test("handles missing checkpoint file gracefully", async () => {
    // mockCheckpointContents is already null (no file on disk)
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
  });

  test("handles malformed checkpoint file", async () => {
    mockCheckpointContents = "this is not valid JSON {{{}}}";

    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    await runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]);

    // Malformed checkpoint is treated as fresh state — all migrations run
    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
  });

  test("throws on duplicate migration IDs", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("001"); // duplicate
    await expect(
      runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]),
    ).rejects.toThrow('Duplicate workspace migration id: "001"');
    expect(m1.run).not.toHaveBeenCalled();
  });

  test("re-runs migration that was interrupted (started marker)", async () => {
    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "started" },
      },
    });

    const m1 = makeMigration("001");
    await runWorkspaceMigrations(WORKSPACE_DIR, [m1]);

    // Migration should re-run because "started" status means it was interrupted
    expect(m1.run).toHaveBeenCalledTimes(1);
  });

  test("skips completed migration with explicit status", async () => {
    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "completed" },
      },
    });

    const m1 = makeMigration("001");
    await runWorkspaceMigrations(WORKSPACE_DIR, [m1]);

    expect(m1.run).not.toHaveBeenCalled();
  });

  test("supports async migrations", async () => {
    const asyncMigration: WorkspaceMigration = {
      id: "001",
      description: "Async migration",
      run: mock(async () => {
        // Simulate async work
        await Promise.resolve();
      }),
      down: mock(() => {}),
    };

    await runWorkspaceMigrations(WORKSPACE_DIR, [asyncMigration]);

    expect(asyncMigration.run).toHaveBeenCalledTimes(1);
  });

  test("propagates saveCheckpoints failure", async () => {
    const m1 = makeMigration("001");

    // Make writeFileSync throw (simulating disk full)
    writeFileSyncFn.mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    await expect(runWorkspaceMigrations(WORKSPACE_DIR, [m1])).rejects.toThrow(
      "ENOSPC",
    );

    // The migration itself did not run because the "started" checkpoint failed
    expect(m1.run).not.toHaveBeenCalled();
  });

  test("warns on malformed checkpoint file", async () => {
    mockCheckpointContents = "not valid json";

    // loadCheckpoints handles the malformed file and returns fresh state
    const checkpoints = loadCheckpoints(WORKSPACE_DIR);
    expect(checkpoints).toEqual({ applied: {} });

    // Verify the warn log was emitted for the malformed checkpoint
    expect(logWarnFn).toHaveBeenCalledWith(
      expect.stringContaining("malformed"),
    );

    // Also verify the full runner handles it gracefully (migrations run)
    logWarnFn.mockClear();
    const m1 = makeMigration("001");
    await runWorkspaceMigrations(WORKSPACE_DIR, [m1]);
    expect(m1.run).toHaveBeenCalledTimes(1);

    // The runner calls loadCheckpoints internally, which should warn again
    expect(logWarnFn).toHaveBeenCalledWith(
      expect.stringContaining("malformed"),
    );
  });
});

describe("rollbackWorkspaceMigrations", () => {
  beforeEach(() => {
    mockCheckpointContents = null;
    readTextFileSyncFn.mockClear();
    ensureDirFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
    logWarnFn.mockClear();
    logInfoFn.mockClear();
    logErrorFn.mockClear();
  });

  test("rolls back migrations in reverse order", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const m3 = makeMigration("003");

    // All three migrations are marked as completed in checkpoints
    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "completed" },
        "002": { appliedAt: "2025-01-02T00:00:00.000Z", status: "completed" },
        "003": { appliedAt: "2025-01-03T00:00:00.000Z", status: "completed" },
      },
    });

    const callOrder: string[] = [];
    (m2.down as ReturnType<typeof mock>).mockImplementation(() => {
      callOrder.push("002");
    });
    (m3.down as ReturnType<typeof mock>).mockImplementation(() => {
      callOrder.push("003");
    });

    // Roll back to m1 — should reverse m3 then m2, but not m1
    await rollbackWorkspaceMigrations(WORKSPACE_DIR, [m1, m2, m3], "001");

    expect(m3.down).toHaveBeenCalledTimes(1);
    expect(m2.down).toHaveBeenCalledTimes(1);
    expect(m1.down).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["003", "002"]);
  });

  test("handles crash during rollback (rolling_back status)", async () => {
    const m1 = makeMigration("001");

    // Simulate a crash during a previous rollback — m1 is left in rolling_back state
    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": {
          appliedAt: "2025-01-01T00:00:00.000Z",
          status: "rolling_back",
        },
      },
    });

    // runWorkspaceMigrations should clear the rolling_back status and re-run forward
    await runWorkspaceMigrations(WORKSPACE_DIR, [m1]);

    // The runner treats "rolling_back" like "started" — it clears the entry and re-runs
    expect(m1.run).toHaveBeenCalledTimes(1);
  });

  test("removes checkpoints for rolled-back migrations", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const m3 = makeMigration("003");

    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "completed" },
        "002": { appliedAt: "2025-01-02T00:00:00.000Z", status: "completed" },
        "003": { appliedAt: "2025-01-03T00:00:00.000Z", status: "completed" },
      },
    });

    await rollbackWorkspaceMigrations(WORKSPACE_DIR, [m1, m2, m3], "001");

    // The last checkpoint write should only contain m1 (002 and 003 were rolled back)
    const lastWriteCall = writeFileSyncFn.mock.calls.at(-1) as unknown[];
    const finalCheckpoint = JSON.parse(lastWriteCall[1] as string);
    expect(finalCheckpoint.applied["001"]).toBeDefined();
    expect(finalCheckpoint.applied["002"]).toBeUndefined();
    expect(finalCheckpoint.applied["003"]).toBeUndefined();
  });

  test("no-op when already at target", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const m3 = makeMigration("003");

    mockCheckpointContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "completed" },
        "002": { appliedAt: "2025-01-02T00:00:00.000Z", status: "completed" },
        "003": { appliedAt: "2025-01-03T00:00:00.000Z", status: "completed" },
      },
    });

    // Target is the last migration — nothing to roll back
    await rollbackWorkspaceMigrations(WORKSPACE_DIR, [m1, m2, m3], "003");

    expect(m1.down).not.toHaveBeenCalled();
    expect(m2.down).not.toHaveBeenCalled();
    expect(m3.down).not.toHaveBeenCalled();

    // No checkpoint writes should have occurred (no rollback happened)
    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });
});
