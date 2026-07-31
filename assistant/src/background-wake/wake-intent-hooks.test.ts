import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BackgroundWakeIntent } from "./next-wake.js";
import type { BackgroundWakeIntentClientResult } from "./platform-client.js";

const mockPublishBackgroundWakeIntent = mock(
  async (): Promise<BackgroundWakeIntentClientResult> => ({
    status: "published",
  }),
);
const mockClearBackgroundWakeIntent = mock(
  async (): Promise<BackgroundWakeIntentClientResult> => ({
    status: "cleared",
  }),
);
let computedIntent: BackgroundWakeIntent | null = intentFixture();
const testWorkspaceDir =
  process.env.VELLUM_WORKSPACE_DIR ?? "/tmp/vellum-wake-intent-hooks";
const workspacePath = (...parts: string[]) => join(testWorkspaceDir, ...parts);

mock.module("./next-wake.js", () => ({
  computeNextBackgroundWakeIntent: () => computedIntent,
}));

mock.module("./platform-client.js", () => ({
  publishBackgroundWakeIntent: mockPublishBackgroundWakeIntent,
  clearBackgroundWakeIntent: mockClearBackgroundWakeIntent,
}));

// Replace `publishSchedulesChanged` while keeping the rest of the module REAL
// — a partial mock that drops the other exports breaks any transitively loaded
// module that imports them (the conversation write paths reach this module
// through the hook pipeline).
const actualSyncEvents =
  await import("../runtime/sync/resource-sync-events.js");
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  ...actualSyncEvents,
  publishSchedulesChanged: () => {},
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => testWorkspaceDir,
  getWorkspaceDirDisplay: () => testWorkspaceDir,
  getWorkspacePromptPath: (name: string) => workspacePath(name),
  getWorkspaceConfigPath: () => workspacePath("config.json"),
  getWorkspaceSkillsDir: () => workspacePath("skills"),
  getWorkspaceHooksDir: () => workspacePath("hooks"),
  getWorkspacePluginsDir: () => workspacePath("plugins"),
  getWorkspaceRoutesDir: () => workspacePath("routes"),
  vellumRoot: () => testWorkspaceDir,
  getDataDir: () => workspacePath("data"),
  getConfigQuarantineNoticePath: () =>
    workspacePath("data", "config-quarantine-notice.json"),
  getConfigValidationResetNoticePath: () =>
    workspacePath("data", "config-validation-reset-notice.json"),
  getDbPath: () => workspacePath("data", "db", "assistant.db"),
  ensureDataDir: () => {
    mkdirSync(workspacePath("data", "db"), { recursive: true });
  },
  getLogsDir: () => workspacePath("data", "logs"),
  getHistoryPath: () => workspacePath("data", "history"),
  getProtectedDir: () => workspacePath("protected"),
  getSignalsDir: () => workspacePath("signals"),
  getPidPath: () => workspacePath("vellum.pid"),
  getDaemonStderrLogPath: () => workspacePath("logs", "daemon-stderr.log"),
  getDaemonStartupLockPath: () => workspacePath("daemon-startup.lock"),
  getExternalDir: () => workspacePath("external"),
  getBinDir: () => workspacePath("bin"),
  getDotEnvPath: () => workspacePath(".env"),
  getEmbedWorkerPidPath: () => workspacePath("embed-worker.pid"),
  getDeprecatedDir: () => workspacePath("deprecated"),
  getConversationsDir: () => workspacePath("conversations"),
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPlatformName: () => "linux",
  normalizeAssistantId: (id: string) => id,
  getEmbeddingModelsDir: () => workspacePath("embedding-models"),
  getSandboxRootDir: () => workspacePath("data", "sandbox"),
  getSandboxWorkingDir: () => testWorkspaceDir,
  getSoundsDir: () => workspacePath("data", "sounds"),
  getAvatarDir: () => workspacePath("data", "avatar"),
  AVATAR_IMAGE_FILENAME: "avatar-image.png",
  getAvatarImagePath: () => workspacePath("data", "avatar", "avatar-image.png"),
  getXdgVellumConfigDirName: () => ".vellum",
  getProfilerRootDir: () => workspacePath("data", "profiler"),
  getProfilerRunsDir: () => workspacePath("data", "profiler", "runs"),
  getProfilerRunDir: (runId: string) =>
    workspacePath("data", "profiler", "runs", runId),
}));

const {
  flushBackgroundWakeIntentRefreshForTest,
  refreshBackgroundWakeIntent,
  resetBackgroundWakeIntentPublisherForTest,
} = await import("./publisher.js");
const { initializeDb } = await import("../persistence/db-init.js");
const { getDb } = await import("../persistence/db-connection.js");
const { createSchedule, deleteSchedule, updateSchedule } =
  await import("../schedule/schedule-store.js");

await initializeDb();

describe("background wake intent publisher hooks", () => {
  beforeEach(() => {
    computedIntent = intentFixture();
    mockPublishBackgroundWakeIntent.mockClear();
    mockClearBackgroundWakeIntent.mockClear();
    mockPublishBackgroundWakeIntent.mockImplementation(async () => ({
      status: "published" as const,
    }));
    mockClearBackgroundWakeIntent.mockImplementation(async () => ({
      status: "cleared" as const,
    }));
    resetBackgroundWakeIntentPublisherForTest();
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  test("debounces repeated refreshes into one publish", async () => {
    refreshBackgroundWakeIntent("first");
    refreshBackgroundWakeIntent("second");
    refreshBackgroundWakeIntent("third");

    await flushBackgroundWakeIntentRefreshForTest();

    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(1);
    expect(mockClearBackgroundWakeIntent).not.toHaveBeenCalled();
  });

  test("clears without throwing when no local intent exists", async () => {
    computedIntent = null;

    refreshBackgroundWakeIntent("no-intent");
    await flushBackgroundWakeIntentRefreshForTest();

    expect(mockClearBackgroundWakeIntent).toHaveBeenCalledTimes(1);
    expect(mockClearBackgroundWakeIntent).toHaveBeenCalledWith(null);
  });

  test("keeps last intent snapshot when clear is skipped so it can retry", async () => {
    const publishedIntent = intentFixture({
      computedAt: 1_800_000_000_000,
      sourceGeneration: "bw1:stable-source",
    });
    computedIntent = publishedIntent;

    refreshBackgroundWakeIntent("publish");
    await flushBackgroundWakeIntentRefreshForTest();

    computedIntent = null;
    mockClearBackgroundWakeIntent.mockImplementationOnce(async () => ({
      status: "skipped" as const,
      reason: "missing_platform_client" as const,
    }));

    refreshBackgroundWakeIntent("clear-skipped");
    await flushBackgroundWakeIntentRefreshForTest();
    refreshBackgroundWakeIntent("clear-retry");
    await flushBackgroundWakeIntentRefreshForTest();

    expect(mockClearBackgroundWakeIntent).toHaveBeenCalledTimes(2);
    expect(mockClearBackgroundWakeIntent).toHaveBeenNthCalledWith(
      1,
      publishedIntent,
    );
    expect(mockClearBackgroundWakeIntent).toHaveBeenNthCalledWith(
      2,
      publishedIntent,
    );
  });

  test("does not throw into callers when platform publish fails", async () => {
    mockPublishBackgroundWakeIntent.mockImplementation(async () => {
      throw new Error("network down");
    });

    refreshBackgroundWakeIntent("publish-failure");
    await expect(
      flushBackgroundWakeIntentRefreshForTest(),
    ).resolves.toBeUndefined();

    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(1);
  });

  test("schedule create, update, and delete mutations refresh the wake intent", async () => {
    const job = await createSchedule({
      name: "Wake hook",
      cronExpression: "* * * * *",
      message: "wake",
      syntax: "cron",
    });
    await flushQueuedWakeRefresh();
    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(1);

    await updateSchedule(job.id, { name: "Wake hook updated" });
    await flushQueuedWakeRefresh();
    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(2);

    expect(await deleteSchedule(job.id)).toBe(true);
    await flushQueuedWakeRefresh();
    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(3);
  });

  test("heartbeat scheduling and run-completion paths queue wake intent refreshes", () => {
    const heartbeatSource = readFileSync(
      new URL("../heartbeat/heartbeat-service.ts", import.meta.url),
      "utf-8",
    );

    expect(heartbeatSource).toContain(
      'refreshBackgroundWakeIntentSoon("heartbeat-disabled")',
    );
    expect(heartbeatSource).toContain(
      'refreshBackgroundWakeIntentSoon("heartbeat-cron-scheduled")',
    );
    expect(heartbeatSource).toContain(
      'refreshBackgroundWakeIntentSoon("heartbeat-interval-scheduled")',
    );
    expect(heartbeatSource).toContain(
      'refreshBackgroundWakeIntentSoon("heartbeat-reconfigured")',
    );
    expect(heartbeatSource).toContain(
      'refreshBackgroundWakeIntentSoon("heartbeat-run-complete")',
    );
  });

  test("scheduler startup publishes the daemon-startup wake intent", () => {
    const schedulerSource = readFileSync(
      new URL("../schedule/scheduler.ts", import.meta.url),
      "utf-8",
    );
    const lifecycleSource = readFileSync(
      new URL("../daemon/lifecycle.ts", import.meta.url),
      "utf-8",
    );

    // The daemon-startup intent is published from the end of startScheduler(),
    // so it lands once the scheduler is live and its schedules are visible to
    // computeNextBackgroundWakeIntent. Heartbeat startup republishes with the
    // live heartbeat timing via its own "heartbeat-*" refreshes.
    expect(schedulerSource).toContain(
      'refreshBackgroundWakeIntent("daemon-startup")',
    );
    // Lifecycle no longer publishes the intent directly.
    expect(lifecycleSource).not.toContain("refreshBackgroundWakeIntent");
  });

  test("shutdown paths do not clear background wake intents", () => {
    const lifecycleSource = readFileSync(
      new URL("../daemon/lifecycle.ts", import.meta.url),
      "utf-8",
    );
    const shutdownSource = readFileSync(
      new URL("../daemon/shutdown-handlers.ts", import.meta.url),
      "utf-8",
    );

    expect(lifecycleSource).not.toContain("clearBackgroundWakeIntent");
    expect(shutdownSource).not.toContain("clearBackgroundWakeIntent");
    expect(shutdownSource).not.toContain("background-wake/platform-client");
  });
});

async function flushQueuedWakeRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushBackgroundWakeIntentRefreshForTest();
}

function intentFixture(
  overrides: Partial<BackgroundWakeIntent> = {},
): BackgroundWakeIntent {
  const nextWakeAt = 1_800_000_060_000;
  return {
    nextWakeAt,
    actualNextDueAt: nextWakeAt,
    reason: "schedule",
    sourceGeneration: "bw1:source",
    computedAt: nextWakeAt - 60_000,
    sourcePayload: {
      heartbeat: null,
      schedules: [],
    },
    ...overrides,
  };
}
