import { readFileSync } from "node:fs";
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

mock.module("./next-wake.js", () => ({
  computeNextBackgroundWakeIntent: () => computedIntent,
}));

mock.module("./platform-client.js", () => ({
  publishBackgroundWakeIntent: mockPublishBackgroundWakeIntent,
  clearBackgroundWakeIntent: mockClearBackgroundWakeIntent,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishSchedulesChanged: () => {},
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/vellum-wake-intent-hooks",
  getWorkspacePromptPath: (name: string) =>
    `/tmp/vellum-wake-intent-hooks/${name}`,
  vellumRoot: () => "/tmp/vellum-wake-intent-hooks",
  getDataDir: () => "/tmp/vellum-wake-intent-hooks/data",
  getConversationsDir: () => "/tmp/vellum-wake-intent-hooks/conversations",
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPlatformName: () => "linux",
  normalizeAssistantId: (id: string) => id,
  getEmbeddingModelsDir: () => "/tmp/vellum-wake-intent-hooks/models",
  getSandboxRootDir: () => "/tmp/vellum-wake-intent-hooks/sandbox",
  getSandboxWorkingDir: () => "/tmp/vellum-wake-intent-hooks/sandbox/work",
  getSoundsDir: () => "/tmp/vellum-wake-intent-hooks/sounds",
  getAvatarDir: () => "/tmp/vellum-wake-intent-hooks/avatar",
  AVATAR_IMAGE_FILENAME: "avatar-image.png",
  getAvatarImagePath: () =>
    "/tmp/vellum-wake-intent-hooks/avatar/avatar-image.png",
  getXdgVellumConfigDirName: () => ".vellum",
}));

const {
  flushBackgroundWakeIntentRefreshForTest,
  refreshBackgroundWakeIntent,
  resetBackgroundWakeIntentPublisherForTest,
} = await import("./publisher.js");
const { initializeDb } = await import("../memory/db-init.js");
const { getDb } = await import("../memory/db-connection.js");
const { createSchedule, deleteSchedule, updateSchedule } =
  await import("../schedule/schedule-store.js");

initializeDb();

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
    const job = createSchedule({
      name: "Wake hook",
      cronExpression: "* * * * *",
      message: "wake",
      syntax: "cron",
    });
    await flushQueuedWakeRefresh();
    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(1);

    updateSchedule(job.id, { name: "Wake hook updated" });
    await flushQueuedWakeRefresh();
    expect(mockPublishBackgroundWakeIntent).toHaveBeenCalledTimes(2);

    expect(deleteSchedule(job.id)).toBe(true);
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

  test("daemon lifecycle publishes once after heartbeat and scheduler startup", () => {
    const lifecycleSource = readFileSync(
      new URL("../daemon/lifecycle.ts", import.meta.url),
      "utf-8",
    );

    expect(lifecycleSource).toContain(
      [
        "heartbeat.start();",
        "registerBackgroundWakeRuntime({ scheduler, heartbeat });",
        'refreshBackgroundWakeIntent("daemon-startup");',
      ].join("\n    "),
    );
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
