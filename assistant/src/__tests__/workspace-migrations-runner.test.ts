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

    await expect(
      runWorkspaceMigrations(WORKSPACE_DIR, [m1, m2]),
    ).rejects.toThrow("migration 002 failed");

    // m1 ran successfully before the error
    expect(m1.run).toHaveBeenCalledTimes(1);

    // Checkpoints saved: started m1, completed m1, started m2 = 3 writes
    expect(writeFileSyncFn).toHaveBeenCalledTimes(3);
    expect(renameSyncFn).toHaveBeenCalledTimes(3);

    // Verify the completed checkpoint contains m1
    // The second write is the "completed" marker for m1
    const completedWrite = (
      writeFileSyncFn.mock.calls[1] as unknown[]
    )[1] as string;
    const parsed = JSON.parse(completedWrite);
    expect(parsed.applied["001"]).toBeDefined();
    expect(parsed.applied["001"].status).toBe("completed");
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
