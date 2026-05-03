/**
 * Tests for the `vellum backup` CLI command tree.
 *
 * These tests mock out the config loader (so state lives in an in-memory
 * record), the backup/restore libraries (so we don't touch the filesystem or
 * rely on a real workspace), and the memory checkpoint store (so `status`
 * can be driven with a known last-run timestamp). Each test drives the
 * handlers either directly (for fine-grained assertions on persisted state)
 * or via a commander program (for end-to-end arg parsing).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { Command } from "commander";

import type {
  BackupConfig,
  BackupDestination,
} from "../../../config/schema.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The raw `config.json` record the command sees, shared across mocks. */
let mockRawConfig: Record<string, unknown> = {};

/** History of `saveRawConfig` calls so tests can assert persist-order. */
let mockSaveRawConfigCalls: Array<Record<string, unknown>> = [];

/** Memory checkpoint the mocked `getMemoryCheckpoint` should return. */
let mockLastRunAt: string | null = null;

/** Snapshot listings per directory, keyed by absolute path. */
let mockSnapshots: Record<
  string,
  Array<{
    path: string;
    filename: string;
    createdAt: Date;
    sizeBytes: number;
    encrypted: boolean;
  }>
> = {};

/** Result returned by the stubbed `verifySnapshot`. */
let mockVerifyResult: {
  valid: boolean;
  manifest?: {
    schema_version: string;
    created_at: string;
    source?: string;
    description?: string;
    files: unknown[];
    manifest_sha256: string;
  };
  error?: string;
} = { valid: true };

/** Result returned by the stubbed `restoreFromSnapshot`. */
let mockRestoreResult: {
  manifest: {
    schema_version: string;
    created_at: string;
    source?: string;
    files: unknown[];
    manifest_sha256: string;
  };
  restoredFiles: number;
} = {
  manifest: {
    schema_version: "1.0.0",
    created_at: "2026-04-11T09:30:00Z",
    source: "test",
    files: [],
    manifest_sha256: "abc",
  },
  restoredFiles: 42,
};

/** Result returned by the stubbed `createSnapshotNow`. */
let mockCreateSnapshotResult: {
  local: {
    path: string;
    filename: string;
    createdAt: Date;
    sizeBytes: number;
    encrypted: boolean;
  };
  offsite: Array<{
    destination: BackupDestination;
    entry: {
      path: string;
      filename: string;
      createdAt: Date;
      sizeBytes: number;
      encrypted: boolean;
    } | null;
    skipped?: "parent-missing";
    error?: string;
  }>;
  durationMs: number;
} = {
  local: {
    path: "/tmp/local/backup-20260411-093000.vbundle",
    filename: "backup-20260411-093000.vbundle",
    createdAt: new Date("2026-04-11T09:30:00Z"),
    sizeBytes: 1024,
    encrypted: false,
  },
  offsite: [],
  durationMs: 123,
};

/** Whether `createSnapshotNow` should throw concurrency error. */
let mockCreateShouldThrow: Error | null = null;

/** Whether the stubbed `isDaemonRunning` should report the assistant as alive. */
let mockDaemonRunning = false;

/** Sequence of recovery calls so tests can assert ordering. */
const recoveryCallOrder: string[] = [];

/** Number of times each recovery helper was invoked. */
let _mockResetDbCalls = 0;
let _mockInvalidateConfigCacheCalls = 0;

/** Log calls captured by the mocked logger. */
let mockLogInfo: string[] = [];
let mockLogError: string[] = [];

// ---------------------------------------------------------------------------
// Mocks (must be registered before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../../../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
  saveRawConfig: (config: Record<string, unknown>) => {
    mockRawConfig = structuredClone(config);
    mockSaveRawConfigCalls.push(structuredClone(config));
  },
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    const keys = path.split(".");
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (current[key] == null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]!] = value;
  },
  getConfig: () => ({
    backup: getComputedBackupConfig(),
  }),
  invalidateConfigCache: () => {
    _mockInvalidateConfigCacheCalls += 1;
    recoveryCallOrder.push("invalidateConfigCache");
  },
}));

mock.module("../../../daemon/daemon-control.js", () => ({
  isDaemonRunning: () => mockDaemonRunning,
}));

mock.module("../../../memory/db-connection.js", () => ({
  resetDb: () => {
    _mockResetDbCalls += 1;
    recoveryCallOrder.push("resetDb");
  },
}));

mock.module("../../../permissions/trust-store.js", () => ({
  clearCache: () => {  },
}));

mock.module("../../../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) =>
    key === "backup:last_run_at" ? mockLastRunAt : null,
}));

mock.module("../../../backup/list-snapshots.js", () => ({
  listSnapshotsInDir: async (dir: string) => mockSnapshots[dir] ?? [],
}));

mock.module("../../../backup/paths.js", () => ({
  getLocalBackupsDir: (override?: string | null) =>
    override ?? "/tmp/local",
  getBackupKeyPath: () => "/tmp/backup.key",
  resolveOffsiteDestinations: (
    override?: BackupDestination[] | null,
  ): BackupDestination[] => {
    if (override == null) {
      return [{ path: "/icloud/default", encrypt: true }];
    }
    return override;
  },
  getDefaultOffsiteBackupsDir: () => "/icloud/default",
  formatBackupFilename: (
    date: Date,
    { encrypted }: { encrypted: boolean },
  ) => `backup-${date.toISOString()}${encrypted ? ".vbundle.enc" : ".vbundle"}`,
  parseBackupTimestamp: () => null,
}));

mock.module("../../../backup/backup-key.js", () => ({
  readBackupKey: async () => Buffer.alloc(32),
  ensureBackupKey: async () => Buffer.alloc(32),
}));

mock.module("../../../backup/restore.js", () => ({
  verifySnapshot: async () => mockVerifyResult,
  restoreFromSnapshot: async () => {
    recoveryCallOrder.push("restoreFromSnapshot");
    return mockRestoreResult;
  },
}));

mock.module("../../../backup/backup-worker.js", () => ({
  createSnapshotNow: async () => {
    if (mockCreateShouldThrow) throw mockCreateShouldThrow;
    return mockCreateSnapshotResult;
  },
}));

mock.module("../../../runtime/migrations/vbundle-import-analyzer.js", () => ({
  DefaultPathResolver: class {
    constructor(..._args: unknown[]) {}
    resolve(): null {
      return null;
    }
  },
}));

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/workspace",
  getWorkspaceHooksDir: () => "/tmp/workspace/hooks",
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (msg: string) => mockLogInfo.push(msg),
    warn: () => {},
    error: (msg: string) => mockLogError.push(msg),
    debug: () => {},
  }),
}));

mock.module("../../logger.js", () => ({
  log: {
    info: (msg: string) => mockLogInfo.push(msg),
    warn: () => {},
    error: (msg: string) => mockLogError.push(msg),
    debug: () => {},
  },
  getCliLogger: () => ({
    info: (msg: string) => mockLogInfo.push(msg),
    warn: () => {},
    error: (msg: string) => mockLogError.push(msg),
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the "validated" backup config the command sees via `getConfig`.
 * Reads the shared `mockRawConfig` record and applies schema defaults for
 * any missing keys. We can't use the real Zod schema here because the
 * config/loader mock above intercepts the whole module.
 */
function getComputedBackupConfig(): BackupConfig {
  const raw =
    (mockRawConfig.backup as Record<string, unknown> | undefined) ?? {};
  const offsite = (raw.offsite as Record<string, unknown> | undefined) ?? {};
  return {
    enabled: (raw.enabled as boolean | undefined) ?? false,
    intervalHours: (raw.intervalHours as number | undefined) ?? 6,
    retention: (raw.retention as number | undefined) ?? 3,
    offsite: {
      enabled: (offsite.enabled as boolean | undefined) ?? true,
      destinations:
        (offsite.destinations as BackupDestination[] | null | undefined) ??
        null,
    },
    localDirectory:
      (raw.localDirectory as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const backupMod = await import("../backup.js");
const {
  handleEnable,
  handleDisable,
  handleDestinationsAdd,
  handleDestinationsRemove,
  handleDestinationsSetEncrypt,
  handleDestinationsList,
  handleStatus,
  handleList,
  registerBackupCommand,
} = backupMod;

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockRawConfig = {};
  mockSaveRawConfigCalls = [];
  mockLastRunAt = null;
  mockSnapshots = {};
  mockLogInfo = [];
  mockLogError = [];
  mockCreateShouldThrow = null;
  mockDaemonRunning = false;
  _mockResetDbCalls = 0;
  _mockInvalidateConfigCacheCalls = 0;
  recoveryCallOrder.length = 0;
  process.exitCode = 0;
  mockVerifyResult = { valid: true };
  mockRestoreResult = {
    manifest: {
      schema_version: "1.0.0",
      created_at: "2026-04-11T09:30:00Z",
      source: "test",
      files: [],
      manifest_sha256: "abc",
    },
    restoredFiles: 42,
  };
  mockCreateSnapshotResult = {
    local: {
      path: "/tmp/local/backup-20260411-093000.vbundle",
      filename: "backup-20260411-093000.vbundle",
      createdAt: new Date("2026-04-11T09:30:00Z"),
      sizeBytes: 1024,
      encrypted: false,
    },
    offsite: [],
    durationMs: 123,
  };
});

afterEach(() => {
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

describe("handleEnable", () => {
  test("persists backup.enabled=true and no other overrides", () => {
    handleEnable({});
    expect(mockSaveRawConfigCalls.length).toBe(1);
    const saved = mockSaveRawConfigCalls[0]!;
    expect(
      (saved.backup as Record<string, unknown>).enabled,
    ).toBe(true);
    expect(
      (saved.backup as Record<string, unknown>).intervalHours,
    ).toBeUndefined();
  });

  test("applies --interval and --retention overrides", () => {
    handleEnable({ interval: "12", retention: "14" });
    const saved = mockSaveRawConfigCalls[0]!;
    const cfg = saved.backup as Record<string, unknown>;
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalHours).toBe(12);
    expect(cfg.retention).toBe(14);
  });

  test("rejects non-numeric interval", () => {
    handleEnable({ interval: "abc" });
    expect(process.exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
    expect(mockLogError.some((m) => m.includes("--interval"))).toBe(true);
  });

  test("rejects zero retention", () => {
    handleEnable({ retention: "0" });
    expect(process.exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
  });

  test("--no-offsite sets offsite.enabled=false but leaves destinations untouched", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/tmp/x", encrypt: true }],
        },
      },
    };
    handleEnable({ offsite: false });
    const saved = mockSaveRawConfigCalls[0]!;
    const cfg = saved.backup as Record<string, unknown>;
    expect(cfg.enabled).toBe(true);
    expect(
      (cfg.offsite as Record<string, unknown>).enabled,
    ).toBe(false);
    // destinations preserved exactly as-is
    expect(
      (cfg.offsite as Record<string, unknown>).destinations,
    ).toEqual([{ path: "/tmp/x", encrypt: true }]);
  });
});

describe("handleDisable", () => {
  test("persists backup.enabled=false", () => {
    mockRawConfig = { backup: { enabled: true, intervalHours: 6 } };
    handleDisable();
    const saved = mockSaveRawConfigCalls[0]!;
    const cfg = saved.backup as Record<string, unknown>;
    expect(cfg.enabled).toBe(false);
    // other fields preserved
    expect(cfg.intervalHours).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// destinations add / remove / set-encrypt
// ---------------------------------------------------------------------------

describe("handleDestinationsAdd", () => {
  test("on null destinations: materializes iCloud default then appends", () => {
    // Start with completely empty config — destinations resolves to iCloud default.
    handleDestinationsAdd("/tmp/x", {});
    const saved = mockSaveRawConfigCalls[0]!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).toEqual({
      path: "/icloud/default",
      encrypt: true,
    });
    expect(destinations[1]).toEqual({ path: "/tmp/x", encrypt: true });
  });

  test("--plaintext stores encrypt: false", () => {
    handleDestinationsAdd("/tmp/x", { plaintext: true });
    const saved = mockSaveRawConfigCalls[0]!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    // 2 entries: iCloud default + new plaintext /tmp/x
    const tmpEntry = destinations.find((d) => d.path === "/tmp/x")!;
    expect(tmpEntry).toEqual({ path: "/tmp/x", encrypt: false });
  });

  test("appends to existing explicit array without re-materializing default", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/existing", encrypt: true }],
        },
      },
    };
    handleDestinationsAdd("/new", { plaintext: true });
    const saved = mockSaveRawConfigCalls[0]!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations).toEqual([
      { path: "/existing", encrypt: true },
      { path: "/new", encrypt: false },
    ]);
  });

  test("duplicate path errors", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/dup", encrypt: true }],
        },
      },
    };
    handleDestinationsAdd("/dup", {});
    expect(process.exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
  });
});

describe("handleDestinationsRemove", () => {
  test("removes matching entry", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [
            { path: "/a", encrypt: true },
            { path: "/b", encrypt: false },
          ],
        },
      },
    };
    handleDestinationsRemove("/a");
    const saved = mockSaveRawConfigCalls[0]!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations).toEqual([{ path: "/b", encrypt: false }]);
  });

  test("errors on nonexistent path", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/a", encrypt: true }],
        },
      },
    };
    handleDestinationsRemove("/nonexistent");
    expect(process.exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
    expect(mockLogError.some((m) => m.includes("not found"))).toBe(true);
  });
});

describe("handleDestinationsSetEncrypt", () => {
  test("flips encrypt flag to false", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/x", encrypt: true }],
        },
      },
    };
    handleDestinationsSetEncrypt("/x", "false");
    const saved = mockSaveRawConfigCalls[0]!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations).toEqual([{ path: "/x", encrypt: false }]);
  });

  test("flips encrypt flag to true", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/x", encrypt: false }],
        },
      },
    };
    handleDestinationsSetEncrypt("/x", "true");
    const saved = mockSaveRawConfigCalls[0]!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations[0]!.encrypt).toBe(true);
  });

  test("rejects non-boolean value", () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/x", encrypt: false }],
        },
      },
    };
    handleDestinationsSetEncrypt("/x", "yes");
    expect(process.exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
  });

  test("errors on nonexistent path", () => {
    handleDestinationsSetEncrypt("/missing", "true");
    expect(process.exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
  });
});

describe("handleDestinationsList", () => {
  test("empty state shows friendly message", async () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [],
        },
      },
    };
    await handleDestinationsList();
    expect(
      mockLogInfo.some((m) => m.includes("No offsite destinations")),
    ).toBe(true);
  });

  test("lists all destinations with encryption flag", async () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [
            { path: "/a", encrypt: true },
            { path: "/b", encrypt: false },
          ],
        },
      },
    };
    await handleDestinationsList();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("/a");
    expect(out).toContain("/b");
    expect(out).toContain("yes");
    expect(out).toContain("no");
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("handleStatus", () => {
  test("disabled state renders header", async () => {
    await handleStatus();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("Automatic backups: disabled");
    expect(out).toContain("Interval:");
    expect(out).toContain("Retention:");
    expect(out).toContain("Last run:");
  });

  test("enabled state with last-run checkpoint and mixed destinations", async () => {
    mockRawConfig = {
      backup: {
        enabled: true,
        intervalHours: 6,
        retention: 7,
        offsite: {
          enabled: true,
          destinations: [
            { path: "/reachable", encrypt: true },
            { path: "/unreachable/path", encrypt: false },
          ],
        },
      },
    };
    // Make the first destination reachable by putting a snapshot at its dir.
    // Our mocked list-snapshots returns whatever is in mockSnapshots — but
    // reachability is probed via fs/promises.stat(dirname(path)), which is
    // real. Instead, we rely on: both dirs won't exist → both "[unreachable]"
    // in production. For this test we just check the lines render.
    mockLastRunAt = String(Date.now() - 60 * 60 * 1000); // 1h ago
    await handleStatus();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("Automatic backups: enabled");
    expect(out).toContain("Last run:");
    expect(out).toContain("/reachable");
    expect(out).toContain("/unreachable/path");
  });

  test("offsite disabled shows (disabled) line", async () => {
    mockRawConfig = {
      backup: {
        enabled: true,
        offsite: { enabled: false },
      },
    };
    await handleStatus();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("(disabled)");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("handleList", () => {
  test("empty-state renders per-group '(none)'", async () => {
    await handleList();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("Local:");
    // iCloud default is included when offsite.enabled=true by default
    expect(out).toContain("(none)");
  });

  test("populated local pool renders table rows", async () => {
    mockSnapshots["/tmp/local"] = [
      {
        path: "/tmp/local/backup-20260411-093000.vbundle",
        filename: "backup-20260411-093000.vbundle",
        createdAt: new Date("2026-04-11T09:30:00Z"),
        sizeBytes: 1024,
        encrypted: false,
      },
    ];
    await handleList();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("backup-20260411-093000.vbundle");
    expect(out).toContain("Local:");
    expect(out).toContain("2026-04-11 09:30 UTC");
  });

  test("per-destination grouping with explicit offsite", async () => {
    mockRawConfig = {
      backup: {
        enabled: true,
        offsite: {
          enabled: true,
          destinations: [{ path: "/off1", encrypt: true }],
        },
      },
    };
    mockSnapshots["/off1"] = [
      {
        path: "/off1/backup.vbundle.enc",
        filename: "backup.vbundle.enc",
        createdAt: new Date("2026-04-11T09:30:00Z"),
        sizeBytes: 2048,
        encrypted: true,
      },
    ];
    await handleList();
    const out = mockLogInfo.join("\n");
    expect(out).toContain("Offsite: /off1");
    expect(out).toContain("encrypted");
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runProgram(
  args: string[],
): Promise<{ exitCode: number }> {
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerBackupCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  }
  const exitCode = process.exitCode ?? 0;
  return { exitCode };
}

describe("registerBackupCommand (end-to-end)", () => {
  test("vellum backup enable persists enabled=true via commander", async () => {
    const { exitCode } = await runProgram(["backup", "enable"]);
    expect(exitCode).toBe(0);
    expect(
      mockSaveRawConfigCalls.length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (mockSaveRawConfigCalls.at(-1)!.backup as Record<string, unknown>)
        .enabled,
    ).toBe(true);
  });

  test("vellum backup destinations add on null field materializes iCloud default", async () => {
    const { exitCode } = await runProgram([
      "backup",
      "destinations",
      "add",
      "/tmp/x",
    ]);
    expect(exitCode).toBe(0);
    const saved = mockSaveRawConfigCalls.at(-1)!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations).toHaveLength(2);
    expect(destinations[0]!.path).toBe("/icloud/default");
    expect(destinations[1]).toEqual({ path: "/tmp/x", encrypt: true });
  });

  test("vellum backup destinations add --plaintext stores encrypt=false", async () => {
    const { exitCode } = await runProgram([
      "backup",
      "destinations",
      "add",
      "/tmp/ssd",
      "--plaintext",
    ]);
    expect(exitCode).toBe(0);
    const saved = mockSaveRawConfigCalls.at(-1)!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    const added = destinations.find((d) => d.path === "/tmp/ssd");
    expect(added).toEqual({ path: "/tmp/ssd", encrypt: false });
  });

  test("vellum backup destinations remove /nonexistent exits with error", async () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/existing", encrypt: true }],
        },
      },
    };
    const { exitCode } = await runProgram([
      "backup",
      "destinations",
      "remove",
      "/nonexistent",
    ]);
    expect(exitCode).toBe(1);
    expect(mockSaveRawConfigCalls.length).toBe(0);
  });

  test("vellum backup destinations set-encrypt flips flag", async () => {
    mockRawConfig = {
      backup: {
        offsite: {
          destinations: [{ path: "/tmp/x", encrypt: true }],
        },
      },
    };
    const { exitCode } = await runProgram([
      "backup",
      "destinations",
      "set-encrypt",
      "/tmp/x",
      "false",
    ]);
    expect(exitCode).toBe(0);
    const saved = mockSaveRawConfigCalls.at(-1)!;
    const destinations = (
      (saved.backup as Record<string, unknown>).offsite as Record<
        string,
        unknown
      >
    ).destinations as BackupDestination[];
    expect(destinations[0]!.encrypt).toBe(false);
  });
});
