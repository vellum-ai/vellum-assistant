import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { meetEventDispatcher } from "../event-publisher.js";
import {
  __resetMeetSessionEventRouterForTests,
  getMeetSessionEventRouter,
} from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  BOT_LEAVE_HTTP_TIMEOUT_MS,
  MEET_BOT_INTERNAL_PORT,
  type MeetAudioIngestLike,
} from "../session-manager.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface MockRunner {
  run: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  inspect: ReturnType<typeof mock>;
}

function makeMockRunner(
  overrides: {
    runResult?: {
      containerId: string;
      boundPorts: Array<{
        protocol: "tcp" | "udp";
        containerPort: number;
        hostIp: string;
        hostPort: number;
      }>;
    };
    runError?: unknown;
  } = {},
): MockRunner {
  const runResult = overrides.runResult ?? {
    containerId: "container-123",
    boundPorts: [
      {
        protocol: "tcp" as const,
        containerPort: MEET_BOT_INTERNAL_PORT,
        hostIp: "127.0.0.1",
        hostPort: 49200,
      },
    ],
  };

  return {
    run: mock(async () => {
      if (overrides.runError) throw overrides.runError;
      return runResult;
    }),
    stop: mock(async () => {}),
    remove: mock(async () => {}),
    inspect: mock(async () => ({ Id: runResult.containerId })),
  };
}

/**
 * Fake audio ingest that resolves `start()` immediately and tracks the
 * calls it received. Default for session-manager tests that don't care
 * about the ingest lifecycle — individual tests can spy on the returned
 * object by grabbing it from `lastIngest` on the factory.
 */
interface FakeAudioIngest extends MeetAudioIngestLike {
  start: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
}

function makeFakeAudioIngestFactory(): {
  factory: () => FakeAudioIngest;
  getLastIngest: () => FakeAudioIngest | null;
} {
  let lastIngest: FakeAudioIngest | null = null;
  return {
    factory: () => {
      const ingest: FakeAudioIngest = {
        start: mock(async () => {}),
        stop: mock(async () => {}),
      };
      lastIngest = ingest;
      return ingest;
    },
    getLastIngest: () => lastIngest,
  };
}

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "session-manager-test-"));
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// join()
// ---------------------------------------------------------------------------

describe("MeetSessionManager.join", () => {
  test("generates BOT_API_TOKEN, creates sockets dir, registers router, spawns container", async () => {
    const runner = makeMockRunner();
    const getProviderKey = mock(async (provider: string) => {
      if (provider === "deepgram") return "deepgram-secret";
      if (provider === "tts") return "tts-secret";
      return undefined;
    });

    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey,
      resolveDaemonUrl: () => "http://host.docker.internal:7821",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });

    const session = await manager.join({
      url: "https://meet.google.com/xyz-abc-def",
      meetingId: "m1",
      conversationId: "conv-1",
    });

    // Per-meeting token is 64 hex chars.
    expect(session.botApiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(session.containerId).toBe("container-123");
    expect(session.botBaseUrl).toBe("http://127.0.0.1:49200");
    expect(session.joinTimeoutMs).toBeGreaterThan(0);

    // Workspace directories created.
    expect(existsSync(join(workspaceDir, "meets", "m1", "sockets"))).toBe(true);
    expect(existsSync(join(workspaceDir, "meets", "m1", "out"))).toBe(true);

    // Event router registered a handler for this meeting.
    expect(getMeetSessionEventRouter().registeredCount()).toBe(1);
    expect(getMeetSessionEventRouter().resolveBotApiToken("m1")).toBe(
      session.botApiToken,
    );

    // Credentials resolved.
    expect(getProviderKey).toHaveBeenCalledWith("deepgram");
    expect(getProviderKey).toHaveBeenCalledWith("tts");

    // Runner invoked with the expected env/binds/ports/name/network.
    expect(runner.run).toHaveBeenCalledTimes(1);
    const runOpts = runner.run.mock.calls[0][0] as {
      image: string;
      env: Record<string, string>;
      binds: Array<{ hostPath: string; containerPath: string }>;
      ports: Array<{
        hostIp: string;
        hostPort: number;
        containerPort: number;
        protocol: string;
      }>;
      name: string;
      network: string;
    };
    expect(runOpts.image).toBe("vellum-meet-bot:dev");
    expect(runOpts.env.MEET_URL).toBe("https://meet.google.com/xyz-abc-def");
    expect(runOpts.env.MEETING_ID).toBe("m1");
    expect(runOpts.env.JOIN_NAME).toBe("");
    expect(runOpts.env.CONSENT_MESSAGE).toContain("{assistantName}");
    expect(runOpts.env.DAEMON_URL).toBe("http://host.docker.internal:7821");
    expect(runOpts.env.BOT_API_TOKEN).toBe(session.botApiToken);
    expect(runOpts.env.TTS_API_KEY).toBe("tts-secret");
    expect(runOpts.env.SKIP_PULSE).toBe("0");

    expect(runOpts.binds).toEqual([
      {
        hostPath: join(workspaceDir, "meets", "m1", "sockets"),
        containerPath: "/sockets",
      },
      {
        hostPath: join(workspaceDir, "meets", "m1", "out"),
        containerPath: "/out",
      },
    ]);

    expect(runOpts.ports).toEqual([
      {
        hostIp: "127.0.0.1",
        hostPort: 0,
        containerPort: MEET_BOT_INTERNAL_PORT,
        protocol: "tcp",
      },
    ]);

    expect(runOpts.name).toBe("vellum-meet-m1");
    expect(runOpts.network).toBe("bridge");

    // activeSessions and getSession both reflect the new record.
    expect(manager.activeSessions()).toHaveLength(1);
    expect(manager.getSession("m1")?.containerId).toBe("container-123");

    await manager.leave("m1", "test-cleanup");
  });

  test("token resolver returns null when the meeting is not active", async () => {
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });
    // Before any join, the resolver installed in ctor returns null.
    expect(getMeetSessionEventRouter().resolveBotApiToken("nope")).toBeNull();

    await manager.join({
      url: "u",
      meetingId: "m2",
      conversationId: "c2",
    });
    expect(getMeetSessionEventRouter().resolveBotApiToken("m2")).not.toBeNull();
    expect(getMeetSessionEventRouter().resolveBotApiToken("other")).toBeNull();

    await manager.leave("m2", "cleanup");
  });

  test("rejects a second join for the same meeting id", async () => {
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });
    await manager.join({ url: "u", meetingId: "dup", conversationId: "c" });
    await expect(
      manager.join({ url: "u", meetingId: "dup", conversationId: "c" }),
    ).rejects.toThrow(/already exists/);
    await manager.leave("dup", "cleanup");
  });

  test("rolls back the container when no host port is bound", async () => {
    const runner = makeMockRunner({
      runResult: { containerId: "c-unbound", boundPorts: [] },
    });
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      audioIngestFactory: audioIngestFactory.factory,
    });
    await expect(
      manager.join({
        url: "u",
        meetingId: "m-noport",
        conversationId: "c",
      }),
    ).rejects.toThrow(/did not publish a host port/);
    expect(runner.remove).toHaveBeenCalledTimes(1);
    expect(manager.activeSessions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// leave()
// ---------------------------------------------------------------------------

describe("MeetSessionManager.leave", () => {
  test("calls bot HTTP first, then removes — skips stop on graceful success", async () => {
    const runner = makeMockRunner();
    const botLeaveFetch = mock(async () => {});
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch,
      audioIngestFactory: audioIngestFactory.factory,
    });

    const session = await manager.join({
      url: "u",
      meetingId: "leave1",
      conversationId: "c",
    });
    await manager.leave("leave1", "user-requested");

    expect(botLeaveFetch).toHaveBeenCalledTimes(1);
    const [url, token] = botLeaveFetch.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(url).toBe(`${session.botBaseUrl}/leave`);
    expect(token).toBe(session.botApiToken);

    // Graceful path skips stop.
    expect(runner.stop).toHaveBeenCalledTimes(0);
    expect(runner.remove).toHaveBeenCalledTimes(1);

    // Session state cleared.
    expect(manager.getSession("leave1")).toBeNull();
    expect(getMeetSessionEventRouter().registeredCount()).toBe(0);
  });

  test("falls back to stop when bot HTTP fails", async () => {
    const runner = makeMockRunner();
    const botLeaveFetch = mock(async () => {
      throw new Error("bot unreachable");
    });
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch,
      audioIngestFactory: audioIngestFactory.factory,
    });

    await manager.join({
      url: "u",
      meetingId: "leave2",
      conversationId: "c",
    });
    await manager.leave("leave2", "timeout");

    expect(botLeaveFetch).toHaveBeenCalledTimes(1);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.remove).toHaveBeenCalledTimes(1);
  });

  test("falls back to stop when bot HTTP times out past 10s", async () => {
    const runner = makeMockRunner();

    // Simulate a hanging fetch that rejects with AbortError semantics, mirroring
    // what `AbortSignal.timeout(BOT_LEAVE_HTTP_TIMEOUT_MS)` would throw.
    const botLeaveFetch = mock(async () => {
      // The default fetch uses AbortSignal.timeout internally; simulate that
      // timeout by surfacing an abort-style error. The session manager only
      // cares that the promise rejects — it does not inspect the error type.
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch,
      audioIngestFactory: audioIngestFactory.factory,
    });

    await manager.join({
      url: "u",
      meetingId: "leave-timeout",
      conversationId: "c",
    });
    await manager.leave("leave-timeout", "operator");

    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.remove).toHaveBeenCalledTimes(1);
  });

  test("is a no-op for an unknown meeting id", async () => {
    const runner = makeMockRunner();
    const botLeaveFetch = mock(async () => {});
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch,
      audioIngestFactory: audioIngestFactory.factory,
    });
    await manager.leave("never-joined", "who-cares");
    expect(botLeaveFetch).toHaveBeenCalledTimes(0);
    expect(runner.stop).toHaveBeenCalledTimes(0);
    expect(runner.remove).toHaveBeenCalledTimes(0);
  });

  test("BOT_LEAVE_HTTP_TIMEOUT_MS is exported and sensible", () => {
    // Guard against accidental tightening that would cause flakes in CI.
    expect(BOT_LEAVE_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(BOT_LEAVE_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
// Max-meeting-minutes hard cap
// ---------------------------------------------------------------------------

describe("MeetSessionManager max-minutes timeout", () => {
  // We do not touch wall-clock sleep here — the max-minutes cap is exercised
  // by reaching into the timeout handle state directly through a stable
  // public surface (`joinTimeoutMs`), verifying that the manager registers a
  // timer that, when fired, triggers the leave flow.
  //
  // Bun's `setSystemTime` fake timer support is still evolving; rather than
  // depend on it we stub the manager's `setTimeout` behavior by triggering
  // `leave` directly after confirming `joinTimeoutMs` matches the
  // configuration value, then asserting the side-effects the timer would
  // have produced.

  test("joinTimeoutMs matches services.meet.maxMeetingMinutes * 60_000", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });

    const session = await manager.join({
      url: "u",
      meetingId: "t1",
      conversationId: "c",
    });

    // Default config is 240 minutes → 14_400_000 ms.
    expect(session.joinTimeoutMs).toBe(240 * 60_000);

    await manager.leave("t1", "cleanup");
  });

  test("timeout firing triggers leave(meetingId, 'timeout')", async () => {
    const runner = makeMockRunner();
    const botLeaveFetch = mock(async () => {});

    // Monkey-patch global setTimeout so we can capture and fire the scheduled
    // callback deterministically without leaning on fake-timer APIs.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let capturedCb: (() => void) | null = null;
    const fakeHandle = Symbol("fake-handle");
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      cb: () => void,
      _ms: number,
    ) => {
      capturedCb = cb;
      return fakeHandle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    (
      globalThis as unknown as { clearTimeout: typeof clearTimeout }
    ).clearTimeout = ((handle: unknown) => {
      if (handle === fakeHandle) capturedCb = null;
    }) as typeof clearTimeout;

    try {
      const audioIngestFactory = makeFakeAudioIngestFactory();
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "k",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch,
        audioIngestFactory: audioIngestFactory.factory,
      });

      await manager.join({
        url: "u",
        meetingId: "fire-timeout",
        conversationId: "c",
      });

      expect(capturedCb).not.toBeNull();

      // Fire the timer — this is what would happen after maxMeetingMinutes.
      capturedCb!();

      // Give the async leave() a microtask to settle.
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));

      expect(botLeaveFetch).toHaveBeenCalledTimes(1);
      expect(runner.remove).toHaveBeenCalledTimes(1);
      expect(manager.getSession("fire-timeout")).toBeNull();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// Audio ingest wiring
// ---------------------------------------------------------------------------

describe("MeetSessionManager audio ingest wiring", () => {
  test("join starts the audio ingest with the meetingId, socket path, and Deepgram key", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const getProviderKey = mock(async (provider: string) => {
      if (provider === "deepgram") return "deepgram-secret";
      return "";
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey,
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-audio",
      conversationId: "c",
    });

    const ingest = audioIngestFactory.getLastIngest();
    expect(ingest).not.toBeNull();
    expect(ingest!.start).toHaveBeenCalledTimes(1);
    const [meetingId, socketPath, apiKey] = ingest!.start.mock
      .calls[0] as unknown as [string, string, string];
    expect(meetingId).toBe("m-audio");
    expect(socketPath).toBe(
      join(workspaceDir, "meets", "m-audio", "sockets", "audio.sock"),
    );
    expect(apiKey).toBe("deepgram-secret");

    await manager.leave("m-audio", "cleanup");
  });

  test("leave stops the audio ingest after the container is removed", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    // Track call order by recording tags into a shared list.
    const callOrder: string[] = [];
    runner.remove = mock(async () => {
      callOrder.push("remove");
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: () => {
        const ingest = audioIngestFactory.factory();
        const origStop = ingest.stop;
        ingest.stop = mock(async () => {
          callOrder.push("ingest.stop");
          await (origStop as unknown as () => Promise<void>)();
        });
        return ingest;
      },
    });

    await manager.join({
      url: "u",
      meetingId: "m-order",
      conversationId: "c",
    });
    await manager.leave("m-order", "cleanup");

    const ingest = audioIngestFactory.getLastIngest();
    expect(ingest).not.toBeNull();
    expect(ingest!.stop).toHaveBeenCalledTimes(1);
    // Ingest stop runs after the container is removed.
    expect(callOrder).toEqual(["remove", "ingest.stop"]);
  });

  test("join rolls back the container when the audio ingest fails to start", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: () => {
        const ingest = audioIngestFactory.factory();
        ingest.start = mock(async () => {
          throw new Error("bot-connect timeout");
        });
        return ingest;
      },
    });

    await expect(
      manager.join({
        url: "u",
        meetingId: "m-timeout",
        conversationId: "c",
      }),
    ).rejects.toThrow(/bot-connect timeout/);

    // Container is torn down even though ingest was the failing step.
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.remove).toHaveBeenCalledTimes(1);

    // Ingest teardown happens too.
    const ingest = audioIngestFactory.getLastIngest();
    expect(ingest).not.toBeNull();
    expect(ingest!.stop).toHaveBeenCalledTimes(1);

    // No session lingers.
    expect(manager.activeSessions()).toHaveLength(0);
  });

  test("join tears down the audio ingest when the container fails to spawn", async () => {
    const runner = makeMockRunner({
      runError: new Error("docker unreachable"),
    });
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });

    await expect(
      manager.join({
        url: "u",
        meetingId: "m-nodocker",
        conversationId: "c",
      }),
    ).rejects.toThrow(/docker unreachable/);

    const ingest = audioIngestFactory.getLastIngest();
    expect(ingest).not.toBeNull();
    expect(ingest!.stop).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Event-hub lifecycle publication (PR 19)
// ---------------------------------------------------------------------------

describe("MeetSessionManager event-hub lifecycle publication", () => {
  function captureHub() {
    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      (event) => {
        received.push(event);
      },
    );
    return { received, dispose: () => sub.dispose() };
  }

  test("join publishes meet.joining; leave publishes meet.left with reason", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "k",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: audioIngestFactory.factory,
      });

      await manager.join({
        url: "https://meet.google.com/aaa",
        meetingId: "m-ev-1",
        conversationId: "c",
      });
      await manager.leave("m-ev-1", "user-requested");

      const meetTypes = received
        .map((e) => e.message.type)
        .filter((t) => t.startsWith("meet."));
      expect(meetTypes).toContain("meet.joining");
      expect(meetTypes).toContain("meet.left");

      const joining = received.find((e) => e.message.type === "meet.joining")!;
      expect((joining.message as { url: string }).url).toBe(
        "https://meet.google.com/aaa",
      );

      const left = received.find((e) => e.message.type === "meet.left")!;
      expect((left.message as { reason: string }).reason).toBe(
        "user-requested",
      );
    } finally {
      dispose();
    }
  });

  test("lifecycle:joined bot event publishes meet.joined exactly once", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "k",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: audioIngestFactory.factory,
      });

      await manager.join({
        url: "u",
        meetingId: "m-ev-2",
        conversationId: "c",
      });

      // Simulate the bot delivering its lifecycle:joined event twice — the
      // session manager should only fire `meet.joined` on the first one.
      getMeetSessionEventRouter().dispatch("m-ev-2", {
        type: "lifecycle",
        meetingId: "m-ev-2",
        timestamp: new Date(0).toISOString(),
        state: "joined",
      });
      getMeetSessionEventRouter().dispatch("m-ev-2", {
        type: "lifecycle",
        meetingId: "m-ev-2",
        timestamp: new Date(0).toISOString(),
        state: "joined",
      });

      // Let the fire-and-forget publish calls settle.
      await Promise.resolve();
      await Promise.resolve();

      const joined = received.filter((e) => e.message.type === "meet.joined");
      expect(joined).toHaveLength(1);

      await manager.leave("m-ev-2", "cleanup");
    } finally {
      dispose();
    }
  });

  test("container spawn failure publishes meet.error", async () => {
    const runner = makeMockRunner({ runError: new Error("docker down") });
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "k",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: audioIngestFactory.factory,
      });

      await expect(
        manager.join({
          url: "u",
          meetingId: "m-ev-err",
          conversationId: "c",
        }),
      ).rejects.toThrow(/docker down/);

      await Promise.resolve();

      const errors = received.filter((e) => e.message.type === "meet.error");
      expect(errors).toHaveLength(1);
      expect((errors[0]!.message as { detail: string }).detail).toContain(
        "docker down",
      );
    } finally {
      dispose();
    }
  });

  test("lifecycle:error bot event publishes meet.error with detail", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const { received, dispose } = captureHub();
    try {
      const manager = _createMeetSessionManagerForTests({
        dockerRunnerFactory: () => runner,
        getProviderKey: async () => "k",
        getWorkspaceDir: () => workspaceDir,
        botLeaveFetch: async () => {},
        audioIngestFactory: audioIngestFactory.factory,
      });

      await manager.join({
        url: "u",
        meetingId: "m-ev-lerr",
        conversationId: "c",
      });

      getMeetSessionEventRouter().dispatch("m-ev-lerr", {
        type: "lifecycle",
        meetingId: "m-ev-lerr",
        timestamp: new Date(0).toISOString(),
        state: "error",
        detail: "join rejected by host",
      });

      await Promise.resolve();
      await Promise.resolve();

      const errors = received.filter((e) => e.message.type === "meet.error");
      expect(errors).toHaveLength(1);
      expect((errors[0]!.message as { detail: string }).detail).toBe(
        "join rejected by host",
      );

      await manager.leave("m-ev-lerr", "cleanup");
    } finally {
      dispose();
    }
  });
});
