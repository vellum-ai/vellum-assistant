import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { AssistantEvent } from "../../../../assistant/src/runtime/assistant-event.js";
import { assistantEventHub } from "../../../../assistant/src/runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../assistant/src/runtime/assistant-scope.js";
import type {
  ChatOpportunityDecision,
  ChatOpportunityDetectorStats,
} from "../chat-opportunity-detector.js";
import { meetEventDispatcher } from "../event-publisher.js";
import {
  __resetMeetSessionEventRouterForTests,
  getMeetSessionEventRouter,
} from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  BOT_LEAVE_HTTP_TIMEOUT_MS,
  MeetAvatarDeviceMissingError,
  type MeetChatOpportunityDetectorFactoryArgs,
  type MeetChatOpportunityDetectorLike,
  MEET_BOT_INTERNAL_PORT,
  MEET_JOIN_NAME_FALLBACK,
  type MeetAudioIngestLike,
  type MeetConversationBridgeLike,
  type MeetStorageWriterLike,
  type MeetTtsLipsyncFactoryArgs,
} from "../session-manager.js";
import type { TtsLipsyncHandle } from "../tts-lipsync.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface MockRunner {
  run: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  inspect: ReturnType<typeof mock>;
  logs: ReturnType<typeof mock>;
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
    logs: mock(async () => ""),
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
  subscribePcm: ReturnType<typeof mock>;
  /** Test helper: push a PCM chunk to every subscriber. */
  pushPcm: (bytes: Uint8Array) => void;
}

function makeFakeAudioIngestFactory(): {
  factory: () => FakeAudioIngest;
  getLastIngest: () => FakeAudioIngest | null;
} {
  let lastIngest: FakeAudioIngest | null = null;
  return {
    factory: () => {
      const subscribers = new Set<(bytes: Uint8Array) => void>();
      const ingest: FakeAudioIngest = {
        start: mock(async () => {}),
        stop: mock(async () => {}),
        subscribePcm: mock((cb: (bytes: Uint8Array) => void) => {
          subscribers.add(cb);
          return () => subscribers.delete(cb);
        }),
        pushPcm: (bytes) => {
          for (const cb of subscribers) cb(bytes);
        },
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
      // Force the display-name resolver to return null so the JOIN_NAME
      // assertion below is deterministic — without this override the real
      // `getAssistantName()` reads `IDENTITY.md` from whatever workspace
      // happens to be on disk (the user's real `~/.vellum/workspace/` if
      // no preload is wired), which would leak into the assertion.
      resolveAssistantDisplayName: () => null,
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

    // TTS credential is still resolved via getProviderKey. STT credentials
    // are now owned by the audio-ingest's own provider resolver, so the
    // session manager no longer fetches a Deepgram key.
    expect(getProviderKey).toHaveBeenCalledWith("tts");
    expect(getProviderKey).not.toHaveBeenCalledWith("deepgram");

    // Runner invoked with the expected env/workspaceMounts/ports/name/network.
    // Session-manager passes mode-agnostic workspaceMounts — the runner is
    // responsible for translating them to binds (bare-metal) or named-volume
    // Mounts (Docker). See `docker-runner.test.ts` for that resolution.
    expect(runner.run).toHaveBeenCalledTimes(1);
    const runOpts = runner.run.mock.calls[0][0] as {
      image: string;
      env: Record<string, string>;
      workspaceMounts: Array<{
        target: string;
        subpath: string;
        readOnly?: boolean;
      }>;
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
    // `services.meet.joinName` is null by default → session manager falls
    // back to the assistant display name, then to MEET_JOIN_NAME_FALLBACK.
    // The test wires `resolveAssistantDisplayName: () => null` above, so
    // we land on the hard fallback regardless of what `IDENTITY.md` says.
    expect(runOpts.env.JOIN_NAME).toBe("Vellum");
    // `{assistantName}` is substituted in the session manager using the
    // same effective name that `JOIN_NAME` resolves to.
    expect(runOpts.env.CONSENT_MESSAGE).toContain("Vellum");
    expect(runOpts.env.CONSENT_MESSAGE).not.toContain("{assistantName}");
    expect(runOpts.env.DAEMON_URL).toBe("http://host.docker.internal:7821");
    expect(runOpts.env.BOT_API_TOKEN).toBe(session.botApiToken);
    expect(runOpts.env.TTS_API_KEY).toBe("tts-secret");
    expect(runOpts.env.SKIP_PULSE).toBe("0");

    expect(runOpts.workspaceMounts).toEqual([
      { target: "/sockets", subpath: "meets/m1/sockets" },
      { target: "/out", subpath: "meets/m1/out" },
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

  test("token resolver is populated during the container-spawn / audio-ingest window (regression: #26005-ish)", async () => {
    // Before the fix, the bot API token only became resolvable once the
    // `ActiveSession` record landed in `this.sessions`, which happens
    // AFTER `audioIngestPromise` resolves. The bot's `DaemonClient`
    // starts POSTing `lifecycle:joining` events well before that, so
    // every early event got a 401, tripped the bot's terminal-error
    // handler, and the bot shut itself down before it ever reached the
    // audio-socket connect or the "Ask to join" click. This test pins
    // the resolver in place from the moment the container starts.
    //
    // We stall the audio ingest's `start()` so the resolver is checked
    // during the exact window the bot's HTTP traffic hits.
    let resolveIngestStart: () => void = () => {};
    const ingestStartPromise = new Promise<void>((r) => {
      resolveIngestStart = r;
    });
    const factory = (): MeetAudioIngestLike => ({
      start: mock(async () => {
        await ingestStartPromise;
      }),
      stop: mock(async () => {}),
      subscribePcm: mock(() => () => {}),
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: factory,
    });

    const joinPromise = manager.join({
      url: "u",
      meetingId: "m-pending",
      conversationId: "c",
    });

    // Yield so `join()` gets past token generation + runner.run().
    // At this point `this.sessions` does NOT yet contain the session
    // (audio-ingest is stalled), but the resolver must still return the
    // token the bot is presenting on `Authorization: Bearer …`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const pendingToken =
      getMeetSessionEventRouter().resolveBotApiToken("m-pending");
    expect(pendingToken).toMatch(/^[0-9a-f]{64}$/);

    // Let the ingest finish; the session now lands in `this.sessions`
    // and the resolver keeps returning the same token.
    resolveIngestStart();
    const session = await joinPromise;
    // Cast away the `| null` from the resolver's return type — we
    // already asserted non-null above, but `toMatch` doesn't narrow.
    expect(session.botApiToken).toBe(pendingToken as string);
    expect(getMeetSessionEventRouter().resolveBotApiToken("m-pending")).toBe(
      pendingToken,
    );

    await manager.leave("m-pending", "cleanup");
    expect(
      getMeetSessionEventRouter().resolveBotApiToken("m-pending"),
    ).toBeNull();
  });

  test("token resolver is cleared when container spawn fails (no pending-token leak)", async () => {
    // If `runner.run()` throws, the rollback path must drop the
    // pre-registered pending token so a later retry with a fresh token
    // doesn't see a stale match.
    const runner = makeMockRunner({ runError: new Error("spawn boom") });
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      audioIngestFactory: makeFakeAudioIngestFactory().factory,
    });

    await expect(
      manager.join({
        url: "u",
        meetingId: "m-spawn-fail",
        conversationId: "c",
      }),
    ).rejects.toThrow(/spawn boom/);

    expect(
      getMeetSessionEventRouter().resolveBotApiToken("m-spawn-fail"),
    ).toBeNull();
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
  test("join starts the audio ingest with the meetingId and socket path (no API key threaded through)", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const getProviderKey = mock(async () => "");

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
    const call = ingest!.start.mock.calls[0] as unknown as [string, string];
    expect(call).toHaveLength(2);
    const [meetingId, socketPath] = call;
    expect(meetingId).toBe("m-audio");
    expect(socketPath).toBe(
      join(workspaceDir, "meets", "m-audio", "sockets", "audio.sock"),
    );
    // Session manager no longer fetches a Deepgram key — STT resolution
    // lives inside the audio ingest.
    expect(getProviderKey).not.toHaveBeenCalledWith("deepgram");

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

// ---------------------------------------------------------------------------
// JOIN_NAME fallback (Gap E)
// ---------------------------------------------------------------------------

describe("MeetSessionManager JOIN_NAME resolution", () => {
  function runOpts(runner: MockRunner) {
    return runner.run.mock.calls[0][0] as {
      env: Record<string, string>;
    };
  }

  test("falls back to resolveAssistantDisplayName when services.meet.joinName is null", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveAssistantDisplayName: () => "Atlas",
    });

    await manager.join({
      url: "u",
      meetingId: "m-joinname-1",
      conversationId: "c",
    });

    const env = runOpts(runner).env;
    expect(env.JOIN_NAME).toBe("Atlas");
    expect(env.CONSENT_MESSAGE).toContain("Atlas");
    expect(env.CONSENT_MESSAGE).not.toContain("{assistantName}");

    await manager.leave("m-joinname-1", "cleanup");
  });

  test("falls back to MEET_JOIN_NAME_FALLBACK when neither source resolves", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveAssistantDisplayName: () => null,
    });

    await manager.join({
      url: "u",
      meetingId: "m-joinname-2",
      conversationId: "c",
    });

    const env = runOpts(runner).env;
    expect(env.JOIN_NAME).toBe(MEET_JOIN_NAME_FALLBACK);
    expect(env.JOIN_NAME.length).toBeGreaterThan(0);
    // Substituted consent message uses the same effective name.
    expect(env.CONSENT_MESSAGE).toContain(MEET_JOIN_NAME_FALLBACK);

    await manager.leave("m-joinname-2", "cleanup");
  });

  test("caller-supplied consentMessage is still substituted in-manager", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveAssistantDisplayName: () => "Nova",
    });

    await manager.join({
      url: "u",
      meetingId: "m-joinname-3",
      conversationId: "c",
      // Caller passes a raw template — session manager substitutes it.
      consentMessage: "Hi, I'm {assistantName}!",
    });

    const env = runOpts(runner).env;
    expect(env.CONSENT_MESSAGE).toBe("Hi, I'm Nova!");

    await manager.leave("m-joinname-3", "cleanup");
  });
});

// ---------------------------------------------------------------------------
// Dispatcher register-before-ingest race (Gap G) + leave synthesized
// lifecycle:left (Gap I)
// ---------------------------------------------------------------------------

describe("MeetSessionManager dispatcher sequencing", () => {
  test("registerMeetingDispatcher runs BEFORE audioIngest.start", async () => {
    const runner = makeMockRunner();
    const callOrder: string[] = [];

    const audioIngestFactory = {
      factory: () => {
        const subscribers = new Set<(bytes: Uint8Array) => void>();
        const ingest: MeetAudioIngestLike = {
          start: async (meetingId: string) => {
            // By the time audio ingest starts, the router handler must be
            // installed so transcripts fired during STT startup can reach
            // the dispatcher rather than falling through the unregistered
            // meeting drop path.
            callOrder.push(
              `ingest.start registeredCount=${getMeetSessionEventRouter().registeredCount()} meetingId=${meetingId}`,
            );
          },
          stop: async () => {
            callOrder.push("ingest.stop");
          },
          subscribePcm: (cb) => {
            subscribers.add(cb);
            return () => subscribers.delete(cb);
          },
        };
        return ingest;
      },
    };

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-race",
      conversationId: "c",
    });

    expect(callOrder).toHaveLength(1);
    expect(callOrder[0]).toBe(
      "ingest.start registeredCount=1 meetingId=m-race",
    );

    await manager.leave("m-race", "cleanup");
  });

  test("leave dispatches lifecycle:left BEFORE unregistering the dispatcher", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    // Storage writer stub that records lifecycle:left visibility during
    // stop(). The session manager's leave() should dispatch the synthesized
    // event before calling writer.stop(), so this stub's internal state
    // reflects the order.
    const writerEvents: string[] = [];
    const writerStart = mock(() => {});
    const writerStartAudio = mock(async (_source: unknown) => {});
    const writerStop = mock(async () => {
      writerEvents.push("stop");
    });
    const storageWriterFactory = (_args: {
      meetingId: string;
    }): MeetStorageWriterLike => ({
      start: writerStart,
      startAudio: writerStartAudio,
      stop: writerStop,
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      storageWriterFactory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-left",
      conversationId: "c",
    });

    // Subscribe a probe to the dispatcher so we can observe whether the
    // synthesized lifecycle:left fires while the subscription is still
    // live.
    const observed: string[] = [];
    meetEventDispatcher.subscribe("m-left", (event) => {
      if (event.type === "lifecycle") {
        observed.push(`lifecycle:${event.state}`);
      }
    });

    await manager.leave("m-left", "user-requested");

    expect(observed).toEqual(["lifecycle:left"]);
    // The writer was stopped after the synthesized event fired.
    expect(writerStop).toHaveBeenCalledTimes(1);
    expect(writerEvents).toEqual(["stop"]);
    // Dispatcher was fully torn down after leave.
    expect(getMeetSessionEventRouter().registeredCount()).toBe(0);
    expect(meetEventDispatcher.subscriberCount("m-left")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conversation bridge + storage writer wiring (Gaps A + B)
// ---------------------------------------------------------------------------

describe("MeetSessionManager bridge + writer wiring", () => {
  test("join() constructs and subscribes a MeetConversationBridge", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const bridgeSubscribe = mock(() => {});
    const bridgeUnsubscribe = mock(() => {});
    const factoryArgsSeen: Array<{
      meetingId: string;
      conversationId: string;
    }> = [];
    const conversationBridgeFactory = (args: {
      meetingId: string;
      conversationId: string;
    }): MeetConversationBridgeLike => {
      factoryArgsSeen.push(args);
      return {
        subscribe: bridgeSubscribe,
        unsubscribe: bridgeUnsubscribe,
      };
    };

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      conversationBridgeFactory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-bridge",
      conversationId: "conv-abc",
    });

    expect(factoryArgsSeen).toHaveLength(1);
    expect(factoryArgsSeen[0]).toEqual({
      meetingId: "m-bridge",
      conversationId: "conv-abc",
    });
    expect(bridgeSubscribe).toHaveBeenCalledTimes(1);

    await manager.leave("m-bridge", "cleanup");
    expect(bridgeUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test("join() constructs and starts a MeetStorageWriter and wires PCM tee", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const writerStart = mock(() => {});
    const writerStartAudio = mock(async (_source: unknown) => {});
    const writerStop = mock(async () => {});
    const factoryArgsSeen: Array<{ meetingId: string }> = [];
    const storageWriterFactory = (args: {
      meetingId: string;
    }): MeetStorageWriterLike => {
      factoryArgsSeen.push(args);
      return {
        start: writerStart,
        startAudio: writerStartAudio,
        stop: writerStop,
      };
    };

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      storageWriterFactory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-writer",
      conversationId: "c",
    });

    expect(factoryArgsSeen).toHaveLength(1);
    expect(factoryArgsSeen[0]).toEqual({ meetingId: "m-writer" });
    expect(writerStart).toHaveBeenCalledTimes(1);
    expect(writerStartAudio).toHaveBeenCalledTimes(1);

    // The PcmSource passed to startAudio should route to the audio-ingest
    // tee — verify that subscribing on the source calls subscribePcm.
    const ingest = audioIngestFactory.getLastIngest()!;
    const sourceArg = writerStartAudio.mock.calls[0][0] as {
      subscribe: (cb: (bytes: Uint8Array) => void) => () => void;
    };
    const received: Uint8Array[] = [];
    const unsubscribe = sourceArg.subscribe((b) => received.push(b));
    expect(ingest.subscribePcm).toHaveBeenCalledTimes(1);

    ingest.pushPcm(new Uint8Array([1, 2, 3]));
    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([1, 2, 3]);

    unsubscribe();
    ingest.pushPcm(new Uint8Array([9]));
    expect(received).toHaveLength(1);

    await manager.leave("m-writer", "cleanup");
    expect(writerStop).toHaveBeenCalledTimes(1);
  });

  test("storage writer startAudio failure does not fail the join", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const storageWriterFactory = (): MeetStorageWriterLike => ({
      start: () => {},
      startAudio: async () => {
        throw new Error("ffmpeg missing");
      },
      stop: async () => {},
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      storageWriterFactory,
    });

    // join must not throw even though startAudio rejects.
    await manager.join({
      url: "u",
      meetingId: "m-writer-fail",
      conversationId: "c",
    });
    expect(manager.getSession("m-writer-fail")).not.toBeNull();

    await manager.leave("m-writer-fail", "cleanup");
  });
});

// ---------------------------------------------------------------------------
// Proactive chat-opportunity detector wiring (PR 7)
// ---------------------------------------------------------------------------

describe("MeetSessionManager proactive chat-opportunity detector wiring", () => {
  // When this file is run from `assistant/` the bun test preload
  // (`assistant/src/__tests__/test-preload.ts`, wired via
  // `assistant/bunfig.toml`) sets `VELLUM_WORKSPACE_DIR` to a tmp
  // workspace that `getConfig()` reads from. When the file is run
  // from `skills/meet-join/` there is no preload and the env var is
  // unset — fall back to a locally-managed tmp dir so the tests are
  // runnable from either directory (CLAUDE.md expects scoped tests
  // to work from their containing package).
  //
  // The fallback is wired via `beforeAll` (rather than describe-body
  // scope) so the env-var override is set only while this block is
  // executing — Bun evaluates describe bodies synchronously at module
  // load, so a body-scoped `process.env` mutation would leak into
  // every other describe in this file. `afterAll` tears it back down
  // so the next file (or a later block, if any are added below) sees
  // the original environment.
  let preloadWorkspace: string;
  let createdLocalWorkspace: boolean;

  beforeAll(() => {
    createdLocalWorkspace = !process.env.VELLUM_WORKSPACE_DIR;
    preloadWorkspace =
      process.env.VELLUM_WORKSPACE_DIR ??
      mkdtempSync(join(tmpdir(), "meet-session-manager-pchat-"));
    if (createdLocalWorkspace) {
      // `getConfig()` resolves its workspace from the env var, so point
      // it at the tmp dir we just created.
      process.env.VELLUM_WORKSPACE_DIR = preloadWorkspace;
    }
  });

  afterAll(() => {
    if (createdLocalWorkspace) {
      delete process.env.VELLUM_WORKSPACE_DIR;
      rmSync(preloadWorkspace, { recursive: true, force: true });
    }
  });

  /**
   * Make a fake detector and the factory that produced it so tests can
   * assert on construction arguments (assistantDisplayName, config,
   * callDetectorLLM, onOpportunity) and lifecycle (start, dispose) without
   * standing up the real regex + LLM stack.
   */
  interface FakeDetector extends MeetChatOpportunityDetectorLike {
    start: ReturnType<typeof mock>;
    dispose: ReturnType<typeof mock>;
    getStats: ReturnType<typeof mock>;
    /** Test helper — simulates a Tier 2 positive verdict firing the callback. */
    fireOpportunity: (hint: string) => void;
  }

  function makeFakeDetectorFactory(
    stats: ChatOpportunityDetectorStats = {
      tier1Hits: 2,
      tier2Calls: 1,
      tier2PositiveCount: 1,
      escalationsFired: 1,
      escalationsSuppressed: 0,
    },
  ): {
    factory: (args: MeetChatOpportunityDetectorFactoryArgs) => FakeDetector;
    lastDetector: () => FakeDetector | null;
    lastArgs: () => MeetChatOpportunityDetectorFactoryArgs | null;
  } {
    let detector: FakeDetector | null = null;
    let args: MeetChatOpportunityDetectorFactoryArgs | null = null;
    return {
      factory: (factoryArgs) => {
        args = factoryArgs;
        let capturedOnOpportunity = factoryArgs.onOpportunity;
        const fake: FakeDetector = {
          start: mock(() => {}),
          dispose: mock(() => {}),
          getStats: mock(() => ({ ...stats })),
          fireOpportunity: (hint: string) => capturedOnOpportunity(hint),
        };
        detector = fake;
        return fake;
      },
      lastDetector: () => detector,
      lastArgs: () => args,
    };
  }

  /**
   * Writes a `config/meet.json` to the test workspace so
   * `getMeetConfig()` picks up the override. Paired with an
   * `afterEach` that tears the file down — the rest of the file
   * relies on schema defaults, so leaving an override in place
   * would poison subsequent tests.
   */
  function overrideProactiveChatConfig(
    workspace: string,
    enabled: boolean,
  ): void {
    const configDir = join(workspace, "config");
    mkdirSync(configDir, { recursive: true });
    const meetConfigPath = join(configDir, "meet.json");
    writeFileSync(
      meetConfigPath,
      JSON.stringify(
        {
          proactiveChat: {
            enabled,
          },
        },
        null,
        2,
      ),
    );
  }

  afterEach(() => {
    // Remove any meet config override so other describe blocks see schema defaults.
    const meetConfigPath = join(preloadWorkspace, "config", "meet.json");
    if (existsSync(meetConfigPath)) {
      rmSync(meetConfigPath);
    }
  });

  test("join constructs detector with effectiveJoinName, proactiveChat config, and wake callback", async () => {
    // Point config writes at the preload workspace (which
    // `getMeetConfig()` reads via `VELLUM_WORKSPACE_DIR`) while the
    // manager uses `workspaceDir` for its per-meeting directory
    // staging. The two don't have to match — session manager reads
    // meet config via `getMeetConfig()` (preload dir) and uses
    // `deps.getWorkspaceDir` for disk layout (test-local override).
    overrideProactiveChatConfig(preloadWorkspace, true);

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const detectorFactory = makeFakeDetectorFactory();
    const wakeAgent = mock(async () => {});

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      chatOpportunityDetectorFactory: detectorFactory.factory,
      wakeAgent,
      resolveAssistantDisplayName: () => "Atlas",
    });

    await manager.join({
      url: "u",
      meetingId: "m-proactive-on",
      conversationId: "conv-pchat-1",
    });

    const args = detectorFactory.lastArgs();
    expect(args).not.toBeNull();
    // assistantDisplayName flows from the same effectiveJoinName source
    // as services.meet.joinName / JOIN_NAME — critical for the detector's
    // name-mention regex to match what the bot actually announces.
    expect(args!.assistantDisplayName).toBe("Atlas");
    expect(args!.meetingId).toBe("m-proactive-on");
    expect(args!.conversationId).toBe("conv-pchat-1");
    expect(args!.config.enabled).toBe(true);
    // detectorKeywords array is carried over unchanged (spreading to a
    // fresh array — verify by shape, not identity).
    expect(Array.isArray(args!.config.detectorKeywords)).toBe(true);
    expect(args!.config.detectorKeywords.length).toBeGreaterThan(0);

    const detector = detectorFactory.lastDetector()!;
    expect(detector.start).toHaveBeenCalledTimes(1);

    // Fire an opportunity — manager should invoke wakeAgent with the
    // configured source and the hint passed through verbatim.
    detector.fireOpportunity("question directed at assistant");
    // wakeAgent is called via `void this.deps.wakeAgent(...)` — allow
    // the microtask to settle before asserting.
    await Promise.resolve();

    expect(wakeAgent).toHaveBeenCalledTimes(1);
    const calls = wakeAgent.mock.calls as unknown as Array<
      [{ conversationId: string; hint: string; source: string }]
    >;
    expect(calls[0]![0]).toEqual({
      conversationId: "conv-pchat-1",
      hint: "question directed at assistant",
      source: "meet-chat-opportunity",
    });

    await manager.leave("m-proactive-on", "cleanup");
    // Detector disposed on leave.
    expect(detector.dispose).toHaveBeenCalledTimes(1);
  });

  test("proactiveChat.enabled=false skips detector construction entirely", async () => {
    overrideProactiveChatConfig(preloadWorkspace, false);

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const detectorFactory = makeFakeDetectorFactory();
    const wakeAgent = mock(async () => {});

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      chatOpportunityDetectorFactory: detectorFactory.factory,
      wakeAgent,
    });

    await manager.join({
      url: "u",
      meetingId: "m-proactive-off",
      conversationId: "c",
    });

    // Factory was never invoked.
    expect(detectorFactory.lastDetector()).toBeNull();
    expect(detectorFactory.lastArgs()).toBeNull();
    // No wakes possible when no detector exists.
    expect(wakeAgent).toHaveBeenCalledTimes(0);

    await manager.leave("m-proactive-off", "cleanup");
  });

  test("leave disposes the detector and leave still works when detector is null", async () => {
    // First case — detector present, dispose on leave.
    overrideProactiveChatConfig(preloadWorkspace, true);
    const detectorFactoryOn = makeFakeDetectorFactory();
    const managerOn = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngestFactory().factory,
      chatOpportunityDetectorFactory: detectorFactoryOn.factory,
      wakeAgent: async () => {},
    });
    await managerOn.join({
      url: "u",
      meetingId: "m-dispose-on",
      conversationId: "c",
    });
    await managerOn.leave("m-dispose-on", "cleanup");
    expect(detectorFactoryOn.lastDetector()!.dispose).toHaveBeenCalledTimes(1);

    // Second case — detector absent (enabled=false), leave must not throw
    // on the `detector?.dispose()` / `detector?.getStats()` paths.
    overrideProactiveChatConfig(preloadWorkspace, false);
    const detectorFactoryOff = makeFakeDetectorFactory();
    const managerOff = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngestFactory().factory,
      chatOpportunityDetectorFactory: detectorFactoryOff.factory,
      wakeAgent: async () => {},
    });
    await managerOff.join({
      url: "u",
      meetingId: "m-dispose-off",
      conversationId: "c",
    });
    await managerOff.leave("m-dispose-off", "cleanup");
    // Factory never called; no detector to dispose.
    expect(detectorFactoryOff.lastDetector()).toBeNull();
  });

  test("wakeAgent rejection is swallowed so the detector callback can't throw", async () => {
    overrideProactiveChatConfig(preloadWorkspace, true);

    const detectorFactory = makeFakeDetectorFactory();
    const wakeAgent = mock(async () => {
      throw new Error("wake exploded");
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngestFactory().factory,
      chatOpportunityDetectorFactory: detectorFactory.factory,
      wakeAgent,
    });

    await manager.join({
      url: "u",
      meetingId: "m-wake-throws",
      conversationId: "c",
    });

    const detector = detectorFactory.lastDetector()!;
    // Calling fireOpportunity synchronously must not raise — the manager
    // wraps the async wake in `.catch()` so the detector's callback
    // surface stays `void`.
    expect(() => detector.fireOpportunity("x")).not.toThrow();
    // Let the rejection propagate to its handler.
    await Promise.resolve();
    await Promise.resolve();

    expect(wakeAgent).toHaveBeenCalledTimes(1);

    await manager.leave("m-wake-throws", "cleanup");
  });

  test("leave logs a per-meeting chatOpportunity summary pulled from detector.getStats()", async () => {
    overrideProactiveChatConfig(preloadWorkspace, true);

    const detectorFactory = makeFakeDetectorFactory({
      tier1Hits: 7,
      tier2Calls: 3,
      tier2PositiveCount: 2,
      escalationsFired: 1,
      escalationsSuppressed: 1,
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngestFactory().factory,
      chatOpportunityDetectorFactory: detectorFactory.factory,
      wakeAgent: async () => {},
    });

    await manager.join({
      url: "u",
      meetingId: "m-summary",
      conversationId: "c",
    });
    await manager.leave("m-summary", "cleanup");

    const detector = detectorFactory.lastDetector()!;
    // `leave()` calls `getStats()` to materialize the summary log line
    // before emitting `meet.left`.
    expect(detector.getStats).toHaveBeenCalledTimes(1);
  });

  test("default detector LLM callback returns a ChatOpportunityDecision shape", async () => {
    // Smoke-test that the decision shape propagates unchanged through the
    // factory's `callDetectorLLM` hook. Constructing the real detector
    // here would pull in the provider stack, so we just verify the
    // factory receives a callable that can return the right shape.
    overrideProactiveChatConfig(preloadWorkspace, true);

    const detectorFactory = makeFakeDetectorFactory();
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => makeMockRunner(),
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngestFactory().factory,
      chatOpportunityDetectorFactory: detectorFactory.factory,
      wakeAgent: async () => {},
    });

    await manager.join({
      url: "u",
      meetingId: "m-llm-shape",
      conversationId: "c",
    });

    const args = detectorFactory.lastArgs()!;
    expect(typeof args.callDetectorLLM).toBe("function");
    // Confirm the declared return type is `Promise<ChatOpportunityDecision>`
    // by exercising the type — this asserts nothing at runtime but guards
    // against accidental drift in the injected callback's signature.
    const _typeGuard: (p: string) => Promise<ChatOpportunityDecision> =
      args.callDetectorLLM;
    expect(typeof _typeGuard).toBe("function");

    await manager.leave("m-llm-shape", "cleanup");
  });
});

// ---------------------------------------------------------------------------
// TTS lip-sync forwarder wiring
// ---------------------------------------------------------------------------

describe("MeetSessionManager TTS lip-sync forwarder wiring", () => {
  /**
   * Fake lipsync factory — records every factory invocation and the
   * returned handle's `stop()` calls so tests can assert the forwarder
   * was constructed with the session's bridge + token and that its
   * handle was stopped on leave.
   */
  interface FakeLipsyncHandle extends TtsLipsyncHandle {
    stop: ReturnType<typeof mock>;
  }
  interface FakeLipsyncFactoryResult {
    factory: (args: MeetTtsLipsyncFactoryArgs) => FakeLipsyncHandle;
    lastArgs: () => MeetTtsLipsyncFactoryArgs | null;
    lastHandle: () => FakeLipsyncHandle | null;
    constructCount: () => number;
  }

  function makeFakeLipsyncFactory(): FakeLipsyncFactoryResult {
    let lastArgs: MeetTtsLipsyncFactoryArgs | null = null;
    let lastHandle: FakeLipsyncHandle | null = null;
    let constructCount = 0;
    return {
      factory: (args) => {
        lastArgs = args;
        constructCount += 1;
        const handle: FakeLipsyncHandle = {
          stop: mock(() => {}),
        };
        lastHandle = handle;
        return handle;
      },
      lastArgs: () => lastArgs,
      lastHandle: () => lastHandle,
      constructCount: () => constructCount,
    };
  }

  test("join() constructs lipsync forwarder with session bridge and bot token", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const lipsyncFactory = makeFakeLipsyncFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      ttsLipsyncFactory: lipsyncFactory.factory,
    });

    const session = await manager.join({
      url: "u",
      meetingId: "m-lipsync-wire",
      conversationId: "c",
    });

    // Factory must have been invoked exactly once with the session's
    // bridge, per-meeting bot token, and meeting id — these are the
    // inputs the forwarder needs to POST events to the right bot.
    expect(lipsyncFactory.constructCount()).toBe(1);
    const args = lipsyncFactory.lastArgs();
    expect(args).not.toBeNull();
    expect(args!.meetingId).toBe("m-lipsync-wire");
    expect(args!.botApiToken).toBe(session.botApiToken);
    // The bridge is the live object the session manager will use for
    // `speak` / `cancelSpeak` — not a separate construction — so object
    // identity must match what `getSession` would see on the happy path.
    expect(args!.bridge).toBeDefined();

    // Handle is alive (stop not yet called) until leave.
    const handle = lipsyncFactory.lastHandle()!;
    expect(handle.stop).toHaveBeenCalledTimes(0);

    await manager.leave("m-lipsync-wire", "cleanup");
  });

  test("leave() stops the lipsync forwarder handle", async () => {
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const lipsyncFactory = makeFakeLipsyncFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      ttsLipsyncFactory: lipsyncFactory.factory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-lipsync-leave",
      conversationId: "c",
    });
    await manager.leave("m-lipsync-leave", "cleanup");

    const handle = lipsyncFactory.lastHandle()!;
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  test("leave() stops the forwarder BEFORE tearing the ttsBridge down", async () => {
    // Teardown order matters: if `ttsBridge.cancelAll` ran before the
    // forwarder unsubscribed, any late viseme event emitted during a
    // cancelled stream's flush could fire a POST against a shutting-down
    // bridge. This test pins the ordering by capturing call timestamps on
    // both the lipsync stop and the bridge's `cancelAll`, then asserting
    // lipsync stop happened strictly earlier.
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const callOrder: string[] = [];

    const lipsyncFactory: (
      args: MeetTtsLipsyncFactoryArgs,
    ) => TtsLipsyncHandle = (_args) => ({
      stop: () => {
        callOrder.push("lipsync.stop");
      },
    });

    // Wrap the default bridge factory with a stub that only records the
    // cancelAll call. `speak`/`cancel`/`activeStreamCount` are not
    // exercised by this test — the session manager only calls cancelAll
    // during leave.
    const ttsBridgeFactory = () => ({
      meetingId: "m-lipsync-order",
      botBaseUrl: "http://unused",
      speak: async () => ({
        streamId: "unused",
        completion: Promise.resolve(),
      }),
      cancel: async () => {},
      cancelAll: async () => {
        callOrder.push("ttsBridge.cancelAll");
      },
      activeStreamCount: () => 0,
      onViseme: () => () => {},
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      ttsBridgeFactory,
      ttsLipsyncFactory: lipsyncFactory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-lipsync-order",
      conversationId: "c",
    });
    await manager.leave("m-lipsync-order", "cleanup");

    const lipsyncIdx = callOrder.indexOf("lipsync.stop");
    const cancelAllIdx = callOrder.indexOf("ttsBridge.cancelAll");
    expect(lipsyncIdx).toBeGreaterThanOrEqual(0);
    expect(cancelAllIdx).toBeGreaterThanOrEqual(0);
    expect(lipsyncIdx).toBeLessThan(cancelAllIdx);
  });

  test("leave continues cleanly when the lipsync handle's stop throws", async () => {
    // A misbehaving forwarder must not block meeting teardown — the bot
    // container still needs to be stopped/removed regardless.
    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const lipsyncFactory: (
      args: MeetTtsLipsyncFactoryArgs,
    ) => TtsLipsyncHandle = () => ({
      stop: () => {
        throw new Error("simulated lipsync stop failure");
      },
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      ttsLipsyncFactory: lipsyncFactory,
    });

    await manager.join({
      url: "u",
      meetingId: "m-lipsync-throw",
      conversationId: "c",
    });

    await expect(
      manager.leave("m-lipsync-throw", "cleanup"),
    ).resolves.toBeUndefined();

    // Container was still removed — teardown made it all the way through.
    expect(runner.remove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Docker-mode avatar-device preflight
// ---------------------------------------------------------------------------

/**
 * Covers the preflight introduced to cross-check the daemon's
 * `services.meet.avatar.enabled` config against the CLI's
 * `VELLUM_MEET_AVATAR=1` env-var opt-in. In Docker mode these two controls
 * are orthogonal: the CLI's env-var bind-mounts `/dev/video10` into the
 * assistant container on hatch/wake, and the daemon's config drives
 * `DockerRunner`'s `--device` pass-through. If config is on but the env-var
 * is off, the inner `dockerd` would reject container-create with a cryptic
 * "device not found" error. The preflight moves the failure to meet-join
 * time with a pointer at the env-var.
 *
 * The block writes `config/meet.json` overrides under its own tmp
 * workspace via `VELLUM_WORKSPACE_DIR` so `getMeetConfig()` picks up the
 * avatar-enabled fixture. It tears the override down in `afterEach` and
 * restores the original env in `afterAll` so other blocks see schema
 * defaults.
 */
describe("MeetSessionManager Docker-mode avatar-device preflight", () => {
  let preloadWorkspace: string;
  let createdLocalWorkspace: boolean;

  beforeAll(() => {
    createdLocalWorkspace = !process.env.VELLUM_WORKSPACE_DIR;
    preloadWorkspace =
      process.env.VELLUM_WORKSPACE_DIR ??
      mkdtempSync(join(tmpdir(), "meet-session-manager-avatar-"));
    if (createdLocalWorkspace) {
      process.env.VELLUM_WORKSPACE_DIR = preloadWorkspace;
    }
  });

  afterAll(() => {
    if (createdLocalWorkspace) {
      delete process.env.VELLUM_WORKSPACE_DIR;
      rmSync(preloadWorkspace, { recursive: true, force: true });
    }
  });

  function writeAvatarConfig(enabled: boolean, devicePath?: string): void {
    const configDir = join(preloadWorkspace, "config");
    mkdirSync(configDir, { recursive: true });
    const meetConfigPath = join(configDir, "meet.json");
    writeFileSync(
      meetConfigPath,
      JSON.stringify(
        {
          avatar: {
            enabled,
            ...(devicePath ? { devicePath } : {}),
          },
        },
        null,
        2,
      ),
    );
  }

  afterEach(() => {
    const meetConfigPath = join(preloadWorkspace, "config", "meet.json");
    if (existsSync(meetConfigPath)) rmSync(meetConfigPath);
  });

  test("throws MeetAvatarDeviceMissingError when avatar enabled + Docker mode + device missing", async () => {
    writeAvatarConfig(true);

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const avatarDeviceExists = mock((_path: string) => false);

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveRuntimeMode: () => "docker",
      avatarDeviceExists,
    });

    const joinPromise = manager.join({
      url: "u",
      meetingId: "m-avatar-missing",
      conversationId: "c",
    });

    await expect(joinPromise).rejects.toBeInstanceOf(
      MeetAvatarDeviceMissingError,
    );
    await expect(joinPromise).rejects.toThrow(/VELLUM_MEET_AVATAR=1/);
    await expect(joinPromise).rejects.toThrow(/\/dev\/video10/);

    // Preflight short-circuits before the Docker runner is ever touched.
    expect(runner.run).not.toHaveBeenCalled();
    expect(avatarDeviceExists).toHaveBeenCalledWith("/dev/video10");
    expect(manager.activeSessions()).toHaveLength(0);
  });

  test("error message references a custom devicePath override", async () => {
    writeAvatarConfig(true, "/dev/video11");

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveRuntimeMode: () => "docker",
      avatarDeviceExists: () => false,
    });

    await expect(
      manager.join({
        url: "u",
        meetingId: "m-avatar-custom-path",
        conversationId: "c",
      }),
    ).rejects.toThrow(/\/dev\/video11/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  test("skips preflight entirely in bare-metal mode", async () => {
    writeAvatarConfig(true);

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    // Would throw if consulted — proves the preflight short-circuits on
    // the runtime-mode gate before `avatarDeviceExists` is ever called.
    const avatarDeviceExists = mock((_path: string) => {
      throw new Error(
        "avatarDeviceExists should not be consulted in bare-metal mode",
      );
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveRuntimeMode: () => "bare-metal",
      avatarDeviceExists,
    });

    await manager.join({
      url: "u",
      meetingId: "m-avatar-baremetal",
      conversationId: "c",
    });

    expect(avatarDeviceExists).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledTimes(1);

    await manager.leave("m-avatar-baremetal", "cleanup");
  });

  test("skips preflight when avatar is disabled in config", async () => {
    writeAvatarConfig(false);

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const avatarDeviceExists = mock((_path: string) => {
      throw new Error(
        "avatarDeviceExists should not be consulted when avatar.enabled=false",
      );
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveRuntimeMode: () => "docker",
      avatarDeviceExists,
    });

    await manager.join({
      url: "u",
      meetingId: "m-avatar-disabled",
      conversationId: "c",
    });

    expect(avatarDeviceExists).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledTimes(1);

    await manager.leave("m-avatar-disabled", "cleanup");
  });

  test("passes preflight and caches the check when device is present", async () => {
    writeAvatarConfig(true);

    const runner = makeMockRunner();
    const audioIngestFactory = makeFakeAudioIngestFactory();
    const avatarDeviceExists = mock((_path: string) => true);

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: audioIngestFactory.factory,
      resolveRuntimeMode: () => "docker",
      avatarDeviceExists,
    });

    await manager.join({
      url: "u",
      meetingId: "m-avatar-ok-1",
      conversationId: "c1",
    });
    await manager.leave("m-avatar-ok-1", "cleanup");

    // Second join against the same device path does not re-stat the
    // filesystem — the preflight result is cached per device path.
    await manager.join({
      url: "u",
      meetingId: "m-avatar-ok-2",
      conversationId: "c2",
    });
    await manager.leave("m-avatar-ok-2", "cleanup");

    expect(avatarDeviceExists).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});
