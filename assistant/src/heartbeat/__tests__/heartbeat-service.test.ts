import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

// Seed the heartbeat config for real. Active hours are pinned null so the
// scheduling guard is time-of-day independent; maxConsecutiveRuns defaults to
// null (unlimited) here and individual tests re-seed it to exercise the cap.
function seedHeartbeat(
  overrides: {
    maxConsecutiveRuns?: number | null;
  } = {},
): void {
  setConfig("heartbeat", {
    enabled: true,
    intervalMs: 60_000,
    activeHoursStart: null,
    activeHoursEnd: null,
    maxConsecutiveRuns: null,
    maxDailyRuns: null,
    disposition: "Default disposition text.",
    ...overrides,
  });
}

let workspaceDir: string;

// Stub the in-process SSE hub so the writer's publish path is a
// no-op in these tests.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

// Capture broadcastMessage calls so tests can assert on the alerts and
// conversation-created events the heartbeat service emits directly.
type BroadcastedMessage = { type: string; [key: string]: unknown };
const broadcastedMessages: BroadcastedMessage[] = [];
let onBroadcast: ((msg: BroadcastedMessage) => void) | null = null;

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
  broadcastMessage: (msg: BroadcastedMessage) => {
    broadcastedMessages.push(msg);
    onBroadcast?.(msg);
  },
}));

// Stub workspace prompt reads so the heartbeat service doesn't try to
// read real workspace files. Use a fallback for early module-load calls
// (e.g. AuthSessionCache constructor) before beforeEach sets workspaceDir.
// The mock spreads the real module so exports it doesn't override (imported
// by transitive dependencies of the service under test) keep their real,
// preload-temp-dir-scoped implementations instead of vanishing — a missing
// export is an import-time SyntaxError for the whole test file.
const realPlatform = await import("../../util/platform.js");
const fallbackDir = join(tmpdir(), "vellum-hb-svc-fallback");
mock.module("../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () => workspaceDir ?? fallbackDir,
  getWorkspacePromptPath: (name: string) =>
    join(workspaceDir ?? fallbackDir, name),
  vellumRoot: () => workspaceDir ?? fallbackDir,
  getDataDir: () => join(workspaceDir ?? fallbackDir, "data"),
  getConversationsDir: () => join(workspaceDir ?? fallbackDir, "conversations"),
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPlatformName: () => "linux",
  normalizeAssistantId: (id: string) => id,
  getEmbeddingModelsDir: () => join(workspaceDir ?? fallbackDir, "models"),
  getSandboxRootDir: () => join(workspaceDir ?? fallbackDir, "sandbox"),
  getSandboxWorkingDir: () => join(workspaceDir ?? fallbackDir, "sandbox/work"),
  getSoundsDir: () => join(workspaceDir ?? fallbackDir, "sounds"),
  getAvatarDir: () => join(workspaceDir ?? fallbackDir, "avatar"),
  AVATAR_IMAGE_FILENAME: "avatar-image.png",
  getAvatarImagePath: () =>
    join(workspaceDir ?? fallbackDir, "avatar/avatar-image.png"),

  getXdgVellumConfigDirName: () => ".vellum",
  getPidPath: () => join(workspaceDir ?? fallbackDir, "assistant.pid"),
  getDbPath: () => join(workspaceDir ?? fallbackDir, "db/assistant.db"),
  getLogsDir: () => join(workspaceDir ?? fallbackDir, "logs"),
  getHistoryPath: () => join(workspaceDir ?? fallbackDir, "history.json"),
  getProtectedDir: () => join(workspaceDir ?? fallbackDir, "protected"),
  getSignalsDir: () => join(workspaceDir ?? fallbackDir, "signals"),
  getDaemonStderrLogPath: () =>
    join(workspaceDir ?? fallbackDir, "logs/assistant.err.log"),
  getDaemonStartupLockPath: () =>
    join(workspaceDir ?? fallbackDir, "assistant.lock"),
  getExternalDir: () => join(workspaceDir ?? fallbackDir, "external"),
  getBinDir: () => join(workspaceDir ?? fallbackDir, "bin"),
  getDotEnvPath: () => join(workspaceDir ?? fallbackDir, ".env"),
  getEmbedWorkerPidPath: () =>
    join(workspaceDir ?? fallbackDir, "embed-worker.pid"),
  getWorkspaceDirDisplay: () => workspaceDir ?? fallbackDir,
  getWorkspaceConfigPath: () =>
    join(workspaceDir ?? fallbackDir, "config.json"),
  getWorkspaceSkillsDir: () => join(workspaceDir ?? fallbackDir, "skills"),
  getWorkspaceHooksDir: () => join(workspaceDir ?? fallbackDir, ".githooks"),
  getWorkspacePluginsDir: () => join(workspaceDir ?? fallbackDir, "plugins"),
  getWorkspaceRoutesDir: () => join(workspaceDir ?? fallbackDir, "routes"),
  getDeprecatedDir: () => join(workspaceDir ?? fallbackDir, "deprecated"),
  getProfilerRootDir: () => join(workspaceDir ?? fallbackDir, "profiler"),
  getProfilerRunsDir: () => join(workspaceDir ?? fallbackDir, "profiler/runs"),
  getProfilerRunDir: (runId: string) =>
    join(workspaceDir ?? fallbackDir, "profiler/runs", runId),
  ensureDataDir: () => {},
}));

// Stub prompt helpers.
mock.module("../../prompts/persona-resolver.js", () => ({
  GUARDIAN_PERSONA_TEMPLATE: "",
  resolveGuardianPersona: () => null,
  resolveGuardianPersonaPath: () => null,
  resolveGuardianPersonaStrict: () => null,
  isGuardianPersonaCustomized: () => false,
  resolveUserSlug: () => null,
  resolveUserPersona: () => null,
  resolveChannelPersona: () => null,
  resolvePersonaContext: () => ({}),
  ensureGuardianPersonaFile: () => {},
}));
mock.module("../../prompts/system-prompt.js", () => ({
  isTemplateContent: () => false,
  buildCoreIdentityContext: () => "",
  buildSystemPrompt: () => "",
  ensurePromptFiles: () => {},
  stripCommentLines: (s: string) => s,
}));

// Mock runBackgroundJob — HeartbeatService now delegates the
// bootstrap/processMessage/timeout/failure-emit boundary to it.
const STUB_CONVERSATION_ID = "conv-heartbeat-test";

interface RunBackgroundJobCall {
  jobName: string;
  source: string;
  prompt: string;
  trustContext: { sourceChannel: string; trustClass: string };
  callSite: string;
  timeoutMs: number;
  origin: string;
  groupId?: string;
  onConversationCreated?: (id: string) => void;
}

const runBackgroundJobCalls: RunBackgroundJobCall[] = [];
let runBackgroundJobImpl: (opts: RunBackgroundJobCall) => Promise<{
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: string;
}> = async () => ({
  conversationId: STUB_CONVERSATION_ID,
  ok: true,
});

mock.module("../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: RunBackgroundJobCall) => {
    runBackgroundJobCalls.push(opts);
    // Mirror the real runner's contract: fire onConversationCreated with the
    // bootstrap-returned id BEFORE the job's processMessage finishes. Stub
    // it here so HeartbeatService tests can observe sidebar timing.
    opts.onConversationCreated?.(STUB_CONVERSATION_ID);
    return runBackgroundJobImpl(opts);
  },
}));

// Stub credential health service so the heartbeat doesn't spin up a
// real check during the test.
mock.module("../../credential-health/credential-health-service.js", () => ({
  checkAllCredentials: async () => ({ unhealthy: [] }),
}));

// Stub the heartbeat-run-store so the tests don't need a populated SQLite
// schema. Each function is a no-op that returns sensible defaults.
let heartbeatRunIdCounter = 0;
const skipHeartbeatRunCalls: Array<{ runId: string; reason: string }> = [];
mock.module("../heartbeat-run-store.js", () => ({
  insertPendingHeartbeatRun: () => `heartbeat-run-${++heartbeatRunIdCounter}`,
  startHeartbeatRun: () => true,
  completeHeartbeatRun: () => true,
  skipHeartbeatRun: (runId: string, reason: string) => {
    skipHeartbeatRunCalls.push({ runId, reason });
  },
  supersedePendingRun: () => {},
  markStaleRunsAsMissed: () => 0,
  markStaleRunningAsError: () => 0,
  countCompletedHeartbeatRuns: () => 10,
  countCompletedRunsToday: () => 0,
  countRecentConsecutiveRuns: () => 0,
}));

// Stub the pre-first-message gate so tests can flip it on/off without
// needing to seed the SQLite messages table. Defaults to OPEN so existing
// tests (which assume the user has interacted) keep passing.
let preFirstMessageGateOpen = true;
mock.module("../../runtime/pre-first-message-gate.js", () => ({
  hasReceivedUserMessage: () => preFirstMessageGateOpen,
}));

const { HeartbeatService } = await import("../heartbeat-service.js");

let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hb-svc-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
  broadcastedMessages.length = 0;
  onBroadcast = null;
  runBackgroundJobCalls.length = 0;
  skipHeartbeatRunCalls.length = 0;
  preFirstMessageGateOpen = true;
  seedHeartbeat();
  runBackgroundJobImpl = async () => ({
    conversationId: STUB_CONVERSATION_ID,
    ok: true,
  });
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("HeartbeatService", () => {
  test("invokes runBackgroundJob with expected options on each tick", async () => {
    const service = new HeartbeatService();

    await service.runOnce({ force: true });

    expect(runBackgroundJobCalls).toHaveLength(1);
    const call = runBackgroundJobCalls[0]!;
    expect(call.jobName).toBe("heartbeat");
    expect(call.source).toBe("heartbeat");
    expect(call.callSite).toBe("heartbeatAgent");
    expect(call.origin).toBe("heartbeat");
    // groupId is intentionally NOT passed — `system:background` is the
    // runner's default, so passing it explicitly was redundant.
    expect(call.groupId).toBeUndefined();
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(call.prompt).toContain("<heartbeat-checklist>");
    expect(call.prompt).toContain("<heartbeat-disposition>");
  });

  test("fires onConversationCreated synchronously via the runner BEFORE the runner returns", async () => {
    const created: Array<{ conversationId: string; title: string }> = [];
    let runnerHasResolved = false;
    let callbackFiredBeforeRunnerResolved = false;

    runBackgroundJobImpl = async () => {
      // Force the runner to take longer than the synchronous callback so
      // we can verify the SSE entry is created before the job finishes.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      runnerHasResolved = true;
      return { conversationId: STUB_CONVERSATION_ID, ok: true };
    };

    onBroadcast = (msg) => {
      if (msg.type === "heartbeat_conversation_created") {
        created.push({
          conversationId: msg.conversationId as string,
          title: msg.title as string,
        });
        callbackFiredBeforeRunnerResolved = !runnerHasResolved;
      }
    };

    const service = new HeartbeatService();

    await service.runOnce({ force: true });

    expect(created).toEqual([
      { conversationId: STUB_CONVERSATION_ID, title: "Heartbeat" },
    ]);
    expect(callbackFiredBeforeRunnerResolved).toBe(true);
  });

  test("does not race processMessage with an outer timeout — runner timeout is authoritative", async () => {
    // If the heartbeat were still running an outer Promise.race, a
    // long-running runner would surface as a 'Heartbeat execution timed out'
    // log entry. With the outer race removed, runOnce just awaits the
    // runner and returns whatever it produces.
    let runnerCompleted = false;
    runBackgroundJobImpl = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      runnerCompleted = true;
      return { conversationId: STUB_CONVERSATION_ID, ok: true };
    };

    const service = new HeartbeatService();

    await service.runOnce({ force: true });

    expect(runnerCompleted).toBe(true);
    // No heartbeat_alert broadcast because the runner returned ok=true and
    // there was no outer-timeout failure to surface.
    expect(
      broadcastedMessages.filter((m) => m.type === "heartbeat_alert"),
    ).toHaveLength(0);
  });

  test("calls alerter with the failure message when the runner reports ok=false", async () => {
    runBackgroundJobImpl = async () => ({
      conversationId: STUB_CONVERSATION_ID,
      ok: false,
      error: new Error("LLM call failed"),
      errorKind: "exception",
    });

    const service = new HeartbeatService();

    await service.runOnce({ force: true });

    const alerts = broadcastedMessages.filter(
      (m) => m.type === "heartbeat_alert",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "heartbeat_alert",
      title: "Heartbeat Failed",
      body: "LLM call failed",
    });
  });

  test("does not call alerter when the runner reports ok=true", async () => {
    const service = new HeartbeatService();

    await service.runOnce({ force: true });

    expect(
      broadcastedMessages.filter((m) => m.type === "heartbeat_alert"),
    ).toHaveLength(0);
  });

  test("scheduled run skips with reason 'pre_first_user_message' when the user has not yet interacted", async () => {
    preFirstMessageGateOpen = false;
    const service = new HeartbeatService();
    // start() seeds `_pendingRunId` via `scheduleNextRun` so the skip is
    // recorded with the pending run id. Without start() the test still
    // passes the no-LLM-call assertion but the skip record would be a
    // silent miss (the same `if (runId)` guard the existing "disabled"
    // branch uses).
    service.start();
    skipHeartbeatRunCalls.length = 0;

    try {
      // A non-forced runOnce simulates the interval timer firing.
      const result = await service.runOnce({ force: false });

      expect(result).toBe(false);
      expect(runBackgroundJobCalls).toHaveLength(0);
      expect(
        skipHeartbeatRunCalls.some(
          (c) => c.reason === "pre_first_user_message",
        ),
      ).toBe(true);
    } finally {
      await service.stop();
    }
  });

  test("forced run bypasses the pre-first-message gate (manual operator action)", async () => {
    preFirstMessageGateOpen = false;
    const service = new HeartbeatService();

    await service.runOnce({ force: true });

    expect(runBackgroundJobCalls).toHaveLength(1);
    expect(
      skipHeartbeatRunCalls.some((c) => c.reason === "pre_first_user_message"),
    ).toBe(false);
  });

  describe("max consecutive runs cap", () => {
    test("skips with reason 'max_consecutive_runs' after the cap is hit", async () => {
      seedHeartbeat({ maxConsecutiveRuns: 2 });
      const service = new HeartbeatService();

      expect(await service.runOnce({ force: false })).toBe(true);
      expect(await service.runOnce({ force: false })).toBe(true);
      expect(await service.runOnce({ force: false })).toBe(false);

      expect(runBackgroundJobCalls).toHaveLength(2);
      expect(
        skipHeartbeatRunCalls.some((c) => c.reason === "max_consecutive_runs"),
      ).toBe(true);
    });

    test("resetTimer() clears the counter so auto runs resume", async () => {
      seedHeartbeat({ maxConsecutiveRuns: 1 });
      const service = new HeartbeatService();
      service.start();
      try {
        await service.runOnce({ force: false });
        expect(await service.runOnce({ force: false })).toBe(false);

        service.resetTimer();
        expect(await service.runOnce({ force: false })).toBe(true);
        expect(runBackgroundJobCalls).toHaveLength(2);
      } finally {
        await service.stop();
      }
    });

    test("resetTimer() during an in-flight run is not undone by that run's increment", async () => {
      // Regression: if a guardian message arrives mid-run, `resetTimer()`
      // zeroes the counter but the in-flight run's `finally` block used to
      // unconditionally `_consecutiveRuns++`, leaving the counter at 1 and
      // tripping the cap-at-1 path one auto run too early.
      seedHeartbeat({ maxConsecutiveRuns: 1 });

      let releaseInflight: () => void = () => {};
      const inflight = new Promise<void>((resolve) => {
        releaseInflight = resolve;
      });
      runBackgroundJobImpl = async () => {
        await inflight;
        return { conversationId: STUB_CONVERSATION_ID, ok: true };
      };

      const service = new HeartbeatService();
      service.start();
      try {
        const runPromise = service.runOnce({ force: false });
        // Guardian message arrives while the run is still executing.
        service.resetTimer();
        releaseInflight();
        expect(await runPromise).toBe(true);

        // The reset during the in-flight run must survive: the next auto run
        // should proceed because the counter is still 0, not 1.
        runBackgroundJobImpl = async () => ({
          conversationId: STUB_CONVERSATION_ID,
          ok: true,
        });
        expect(await service.runOnce({ force: false })).toBe(true);
        expect(
          skipHeartbeatRunCalls.some(
            (c) => c.reason === "max_consecutive_runs",
          ),
        ).toBe(false);
      } finally {
        await service.stop();
      }
    });

    test("null disables the cap entirely", async () => {
      seedHeartbeat({ maxConsecutiveRuns: null });
      const service = new HeartbeatService();

      for (let i = 0; i < 5; i++) {
        expect(await service.runOnce({ force: false })).toBe(true);
      }
      expect(runBackgroundJobCalls).toHaveLength(5);
      expect(
        skipHeartbeatRunCalls.some((c) => c.reason === "max_consecutive_runs"),
      ).toBe(false);
    });

    test("force runs bypass the cap and do not increment the counter", async () => {
      seedHeartbeat({ maxConsecutiveRuns: 2 });
      const service = new HeartbeatService();

      // Five force runs would push us well past the cap if force counted.
      for (let i = 0; i < 5; i++) {
        expect(await service.runOnce({ force: true })).toBe(true);
      }
      // Two auto runs should still proceed because the counter is at zero.
      expect(await service.runOnce({ force: false })).toBe(true);
      expect(await service.runOnce({ force: false })).toBe(true);
      // The third auto run trips the cap.
      expect(await service.runOnce({ force: false })).toBe(false);
      expect(
        skipHeartbeatRunCalls.some((c) => c.reason === "max_consecutive_runs"),
      ).toBe(true);
    });

    test("reconfigure() resets the counter", async () => {
      seedHeartbeat({ maxConsecutiveRuns: 1 });
      const service = new HeartbeatService();
      service.start();
      try {
        await service.runOnce({ force: false });
        expect(await service.runOnce({ force: false })).toBe(false);

        service.reconfigure();
        expect(await service.runOnce({ force: false })).toBe(true);
      } finally {
        await service.stop();
      }
    });
  });
});
