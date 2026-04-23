/**
 * Daemon-side avatar E2E test.
 *
 * Stands up the **real** meet-bot HTTP control surface (from
 * `bot/src/control/http-server.ts`) on a random loopback port, drives
 * {@link MeetSessionManager} through a full `join()` → `enableAvatar()` →
 * `disableAvatar()` → `leave()` cycle against it, and asserts both the HTTP
 * wire (path, method, auth header) and the bot-side lifecycle semantics
 * that the real `/avatar/enable` and `/avatar/disable` handlers establish:
 *
 *   - On `enableAvatar`: the renderer is started, the device is opened, the
 *     device writer is attached, and the camera is flipped ON — in that
 *     order. A shared {@link FakeAvatarRenderer} fixture is registered
 *     under the id `"fake"` so the test is independent of any concrete
 *     renderer shipping state (TalkingHead.js, Simli, HeyGen, Tavus,
 *     SadTalker, MuseTalk) while still exercising the real handler's
 *     camera-channel wiring.
 *
 *   - On `disableAvatar`: the camera is flipped OFF FIRST, then the writer is
 *     stopped, the device is closed, and the renderer is stopped — so
 *     participants stop seeing the video track before the frame source
 *     disappears (no black frame in the gap).
 *
 *   - Idempotent retries: a second `enableAvatar` while already running short-
 *     circuits with `alreadyRunning: true` without re-initializing the
 *     renderer (matching the http-server contract covered by
 *     `bot/__tests__/avatar-http-server.test.ts`).
 *
 * The test does not spin up real Docker, no real Meet, and does not touch the
 * daemon's long-running singletons — it uses `_createMeetSessionManagerForTests`
 * so each test gets an isolated manager with mock docker / audio-ingest deps.
 *
 * The daemon generates its own per-session `BOT_API_TOKEN` and passes it to
 * the container via env var at `runner.run()` time, so the bot server is
 * stood up lazily inside the mock runner's `run(opts)` callback using
 * `opts.env.BOT_API_TOKEN` as the bearer-token that the real auth
 * middleware will enforce. The bound port is threaded back through
 * `boundPorts` so the daemon's `session.botBaseUrl` points at the real
 * listener. This matches the production topology (daemon spawns bot
 * container, bot reads `BOT_API_TOKEN` from env) one step more faithfully
 * than a hand-rolled `Bun.serve` fake.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createHttpServer } from "../../bot/src/control/http-server.js";
import {
  __resetAvatarRegistryForTests,
  registerAvatarRenderer,
  type AvatarConfig,
} from "../../bot/src/media/avatar/index.js";
import type { VideoDeviceHandle } from "../../bot/src/media/video-device.js";
import { BotState } from "../../bot/src/control/state.js";
import { FakeAvatarRenderer } from "../../bot/__tests__/avatar-interface.test.js";

import {
  _resetEventPublisherForTests,
  createEventPublisher,
  meetEventDispatcher,
} from "../event-publisher.js";
import { __resetMeetSessionEventRouterForTests } from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  MEET_BOT_INTERNAL_PORT,
  type MeetAudioIngestLike,
} from "../session-manager.js";
import {
  buildTestHost,
  InMemoryEventHub,
} from "../../__tests__/build-test-host.js";

// ---------------------------------------------------------------------------
// Shared fixtures — the "fake bot" stands up a real `createHttpServer`
// from the bot source tree, backed by a {@link FakeAvatarRenderer}
// registered under the id `"fake"`, a stubbed {@link VideoDeviceHandle},
// and a fake camera channel. All the lifecycle calls the real HTTP
// handler makes (renderer.start → openDevice → camera.enableCamera on
// enable; camera.disableCamera → device.close → renderer.stop on disable)
// land on these fixtures, and each one pushes its label into a shared
// `trace` array so the test can assert the full handler-driven interleave
// with a single `toEqual` call.
// ---------------------------------------------------------------------------

interface RecordedAvatarRequest {
  method: string;
  path: string;
  authorization: string | null;
}

interface FakeCamera {
  enableCalls: number;
  disableCalls: number;
  enableCamera: () => Promise<{ changed: boolean }>;
  disableCamera: () => Promise<{ changed: boolean }>;
}

interface FakeDeviceFixture {
  /** Set to `true` the moment `close()` is awaited. */
  closed: boolean;
  /** How many times `openDevice` was invoked. */
  openCount: number;
  /** Factory used as `avatar.openDevice`. */
  openDevice: (devicePath: string) => Promise<VideoDeviceHandle>;
}

interface FakeBotServer {
  url: string;
  port: number;
  /** The bearer-token the bot's auth middleware enforces on every route. */
  apiToken: string;
  /** One record per request that hit the server. */
  requests: RecordedAvatarRequest[];
  /** Every `FakeAvatarRenderer` instance the registry handed out, in order. */
  renderers: FakeAvatarRenderer[];
  camera: FakeCamera;
  device: FakeDeviceFixture;
  /**
   * Monotonic call trace — every lifecycle verb the real handler fires
   * appends to this. Drives the order-of-operations assertions
   * (renderer.start → device.open → camera.enableCamera on enable;
   * camera.disableCamera → device.close → renderer.stop on disable). Kept
   * as a single shared array (not per-component) so the test can assert
   * the full interleave with one `toEqual` call.
   */
  trace: string[];
  stop: () => Promise<void>;
}

/**
 * Build a {@link VideoDeviceHandle} stub whose `close()` flips a shared
 * `closed` flag and appends a `device.close` trace entry. The `sink`
 * accepts writes silently — the device-writer will subscribe to the
 * renderer's `onFrame` channel but the `FakeAvatarRenderer` never emits
 * frames, so no bytes actually land here.
 */
function makeFakeDeviceFixture(trace: string[]): FakeDeviceFixture {
  const fixture: FakeDeviceFixture = {
    closed: false,
    openCount: 0,
    openDevice: async (_devicePath: string) => {
      fixture.openCount += 1;
      trace.push("device.open");
      const handle: VideoDeviceHandle = {
        devicePath: "/dev/video10",
        width: 1280,
        height: 720,
        pixelFormat: "YU12",
        sink: {
          write: () => true,
          end: (cb?: () => void) => {
            cb?.();
          },
          destroy: () => {
            /* noop */
          },
        },
        close: async () => {
          fixture.closed = true;
          trace.push("device.close");
        },
      };
      return handle;
    },
  };
  return fixture;
}

function makeFakeCamera(trace: string[]): FakeCamera {
  const camera: FakeCamera = {
    enableCalls: 0,
    disableCalls: 0,
    enableCamera: async () => {
      camera.enableCalls += 1;
      trace.push("camera.enableCamera");
      return { changed: true };
    },
    disableCamera: async () => {
      camera.disableCalls += 1;
      trace.push("camera.disableCamera");
      return { changed: true };
    },
  };
  return camera;
}

/**
 * Stand up a real {@link createHttpServer} instance on a random loopback
 * port using the given bearer token. The registry's `"fake"` factory
 * (registered in `beforeEach`) hands out `FakeAvatarRenderer` instances;
 * each one is captured into `renderers` so the test can assert on start /
 * stop counts. The handler itself runs unmodified — `resolveAvatarRenderer`
 * looks up the factory, and the renderer's `start` + the fake camera's
 * `enableCamera` (etc.) fire in the exact order the production handler
 * enforces.
 *
 * Every request is recorded via a `Bun.serve` wrapper that captures
 * method/path/auth-header before delegating to `app.fetch`. The wrapper
 * (rather than a post-hoc `app.use("*", ...)`) exists because Hono's
 * middleware registration only takes effect for routes registered AFTER
 * the middleware, and all of the handler routes are registered inside
 * `createHttpServer` before we get a chance to `.use(...)` on the
 * returned app. A fetch-level wrapper catches every inbound request
 * uniformly — including 401s from the auth middleware — which matches
 * the wire observations the previous hand-rolled `Bun.serve` fake was
 * making.
 */
async function startRealBotServer(
  apiToken: string,
  camera: FakeCamera,
  device: FakeDeviceFixture,
): Promise<{
  stop: () => Promise<void>;
  url: string;
  port: number;
  requests: RecordedAvatarRequest[];
}> {
  const requests: RecordedAvatarRequest[] = [];

  const config: AvatarConfig = { enabled: true, renderer: "fake" };

  const handle = createHttpServer({
    apiToken,
    onLeave: () => {},
    onSendChat: () => {},
    onPlayAudio: () => {},
    avatar: {
      config,
      openDevice: device.openDevice,
      camera: {
        enableCamera: camera.enableCamera,
        disableCamera: camera.disableCamera,
      },
    },
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
      });
      return handle.app.fetch(req);
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("fake bot server failed to bind a port");
  }
  return {
    stop: async () => {
      await server.stop(true);
    },
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
  };
}

/**
 * Minimal stand-in for the audio ingest. The session manager doesn't
 * interact with it after `start()` resolves, so the fake is a no-op.
 */
function makeFakeAudioIngest(): MeetAudioIngestLike {
  return {
    start: async () => ({ port: 42173, ready: Promise.resolve() }),
    stop: async () => {},
    subscribePcm: () => () => {},
  };
}

/**
 * Build a mock Docker runner whose `run(opts)` lazily boots the real bot
 * HTTP server using the `BOT_API_TOKEN` the daemon synthesized into the
 * env. The returned `boundPorts` entry points the daemon's resulting
 * `session.botBaseUrl` at the real listener, so subsequent
 * `manager.enableAvatar()` / `manager.disableAvatar()` calls hit the real
 * `/avatar/enable` and `/avatar/disable` handlers.
 */
function makeLazyRunner(fakeBotRef: { current: FakeBotServer | null }) {
  return {
    run: mock(async (opts: { env?: Record<string, string> }) => {
      const token = opts.env?.BOT_API_TOKEN;
      if (!token) {
        throw new Error(
          "mock runner expected BOT_API_TOKEN in opts.env — daemon should have set it",
        );
      }
      const renderers: FakeAvatarRenderer[] = [];
      const trace: string[] = [];
      const camera = makeFakeCamera(trace);
      const device = makeFakeDeviceFixture(trace);

      // Register a fresh factory that captures every instance it hands
      // out. The registry was reset in `beforeEach` so this is the only
      // factory the `/avatar/enable` handler's `resolveAvatarRenderer`
      // call can pick up.
      registerAvatarRenderer("fake", () => {
        const renderer = new FakeAvatarRenderer({
          id: "fake",
          // Match the real "noop-ish" capability profile the existing
          // assertions expect — the handler's camera-toggle wiring is
          // independent of these flags, but leaving them false keeps
          // the renderer cheap and side-effect-free.
          capabilities: { needsVisemes: false, needsAudio: false },
        });
        // Wrap start/stop so the handler-driven order lands in `trace`.
        const origStart = renderer.start.bind(renderer);
        renderer.start = async () => {
          trace.push("renderer.start");
          await origStart();
        };
        const origStop = renderer.stop.bind(renderer);
        renderer.stop = async () => {
          trace.push("renderer.stop");
          await origStop();
        };
        renderers.push(renderer);
        return renderer;
      });

      const server = await startRealBotServer(token, camera, device);

      const fakeBot: FakeBotServer = {
        url: server.url,
        port: server.port,
        apiToken: token,
        requests: server.requests,
        renderers,
        camera,
        device,
        trace,
        stop: server.stop,
      };
      fakeBotRef.current = fakeBot;

      return {
        containerId: "container-avatar-e2e",
        boundPorts: [
          {
            protocol: "tcp" as const,
            containerPort: MEET_BOT_INTERNAL_PORT,
            hostIp: "127.0.0.1",
            hostPort: server.port,
          },
        ],
      };
    }),
    stop: mock(async () => {}),
    remove: mock(async () => {}),
    inspect: mock(async () => ({ Id: "container-avatar-e2e" })),
    logs: mock(async () => ""),
  };
}

let workspaceDir: string;
const fakeBotRef: { current: FakeBotServer | null } = { current: null };
let testHub: InMemoryEventHub;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "avatar-e2e-"));
  __resetMeetSessionEventRouterForTests();
  _resetEventPublisherForTests();
  testHub = new InMemoryEventHub();
  createEventPublisher(buildTestHost({ events: testHub.facet() }));
  meetEventDispatcher._resetForTests();
  // Wipe the registry so tests can't leak factories across each other.
  // The `"fake"` id is re-registered inside the lazy runner below, once
  // per-test, so every test gets a clean factory whose closure captures
  // that test's trace array + fixture handles.
  __resetAvatarRegistryForTests();
  BotState.__resetForTests();
  fakeBotRef.current = null;
});

afterEach(async () => {
  if (fakeBotRef.current !== null) {
    await fakeBotRef.current.stop();
    fakeBotRef.current = null;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

function expectFakeBot(): FakeBotServer {
  const bot = fakeBotRef.current;
  if (!bot) {
    throw new Error("fake bot was not booted — did manager.join() run?");
  }
  return bot;
}

// ---------------------------------------------------------------------------
// enableAvatar — full enable chain
// ---------------------------------------------------------------------------

describe("MeetSessionManager.enableAvatar end-to-end (real HTTP)", () => {
  test("drives renderer-start + device-open + camera-enable in that order via POST /avatar/enable", async () => {
    const runner = makeLazyRunner(fakeBotRef);
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "tts-key",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
    });

    const session = await manager.join({
      url: "https://meet.google.com/abc-def-ghi",
      meetingId: "m-avatar-enable",
      conversationId: "conv-avatar-enable",
    });

    const fakeBot = expectFakeBot();

    // Sanity: session is pointed at our real bot server.
    expect(session.botBaseUrl).toBe(fakeBot.url);
    // Token handed to the bot's auth middleware matches the one the
    // daemon minted — i.e. the auth gate is live and enforcing the same
    // token from both sides of the wire.
    expect(fakeBot.apiToken).toBe(session.botApiToken);

    const body = await manager.enableAvatar("m-avatar-enable");

    // ---- Assert: the bot received exactly one POST /avatar/enable with
    //      the daemon's per-session bearer token. This is the wire-level
    //      invariant the daemon's `defaultBotAvatarFetch` promises.
    expect(fakeBot.requests).toHaveLength(1);
    const req = fakeBot.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/avatar/enable");
    expect(req.authorization).toBe(`Bearer ${session.botApiToken}`);

    // ---- Assert: the bot-side lifecycle fired exactly the operations the
    //      real `/avatar/enable` handler promises, in the right order.
    //      renderer.start → device.open → camera.enableCamera. Every one
    //      of those trace entries is produced by the real handler's call
    //      into our fixture (renderer via the registry, device via
    //      `openDevice`, camera via the `camera.enableCamera` callback).
    expect(fakeBot.trace).toEqual([
      "renderer.start",
      "device.open",
      "camera.enableCamera",
    ]);
    expect(fakeBot.renderers).toHaveLength(1);
    expect(fakeBot.renderers[0]!.startCount).toBe(1);
    expect(fakeBot.camera.enableCalls).toBe(1);
    expect(fakeBot.camera.disableCalls).toBe(0);
    expect(fakeBot.device.openCount).toBe(1);
    expect(fakeBot.device.closed).toBe(false);

    // ---- Assert: the parsed JSON body the session-manager returned to
    //      the caller carries the bot's response fields so tools can
    //      relay them to the model.
    expect(body).toMatchObject({
      enabled: true,
      renderer: "fake",
      active: true,
      devicePath: "/dev/video10",
      cameraChanged: true,
    });

    await manager.leave("m-avatar-enable", "cleanup");
  });

  test("a second enableAvatar while already running returns alreadyRunning=true and does NOT re-start the renderer", async () => {
    // Idempotent-retry contract: the bot short-circuits a second
    // /avatar/enable with `alreadyRunning: true` so the daemon's retry
    // path doesn't thrash the device.
    const runner = makeLazyRunner(fakeBotRef);
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
    });

    await manager.join({
      url: "u",
      meetingId: "m-avatar-idempotent",
      conversationId: "c",
    });

    const fakeBot = expectFakeBot();

    await manager.enableAvatar("m-avatar-idempotent");
    const second = await manager.enableAvatar("m-avatar-idempotent");

    expect(second.alreadyRunning).toBe(true);
    // Exactly one renderer instance was constructed — the short-circuit
    // path must not reach the factory a second time.
    expect(fakeBot.renderers).toHaveLength(1);
    expect(fakeBot.renderers[0]!.startCount).toBe(1);
    // camera.enableCamera must not be called twice — the idempotent
    // short-circuit returns BEFORE touching the camera.
    expect(fakeBot.camera.enableCalls).toBe(1);
    expect(fakeBot.requests).toHaveLength(2);
    expect(fakeBot.requests.map((r) => r.path)).toEqual([
      "/avatar/enable",
      "/avatar/enable",
    ]);

    await manager.leave("m-avatar-idempotent", "cleanup");
  });
});

// ---------------------------------------------------------------------------
// disableAvatar — full disable chain, teardown ordering
// ---------------------------------------------------------------------------

describe("MeetSessionManager.disableAvatar end-to-end (real HTTP)", () => {
  test("drives camera-disable FIRST, then device-close, then renderer-stop via POST /avatar/disable", async () => {
    const runner = makeLazyRunner(fakeBotRef);
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
    });

    const session = await manager.join({
      url: "u",
      meetingId: "m-avatar-disable",
      conversationId: "c",
    });

    const fakeBot = expectFakeBot();

    // Prime the avatar so disable has something to tear down.
    await manager.enableAvatar("m-avatar-disable");
    // Clear the trace between enable + disable so we assert only the
    // disable-path ordering (otherwise the enable ops at the head of the
    // array would dominate the toEqual).
    fakeBot.trace.length = 0;

    const body = await manager.disableAvatar("m-avatar-disable");

    // ---- Wire assertions.
    const disableReqs = fakeBot.requests.filter(
      (r) => r.path === "/avatar/disable",
    );
    expect(disableReqs).toHaveLength(1);
    const req = disableReqs[0]!;
    expect(req.method).toBe("POST");
    expect(req.authorization).toBe(`Bearer ${session.botApiToken}`);

    // ---- Teardown ordering: camera first, then device/renderer. The
    //      camera must be flipped OFF before the frame source disappears
    //      so other participants don't see a black frame while the
    //      renderer tears down.
    expect(fakeBot.trace).toEqual([
      "camera.disableCamera",
      "device.close",
      "renderer.stop",
    ]);
    expect(fakeBot.camera.disableCalls).toBe(1);
    expect(fakeBot.renderers[0]!.stopCount).toBe(1);
    expect(fakeBot.device.closed).toBe(true);

    expect(body).toMatchObject({
      disabled: true,
      wasActive: true,
      cameraChanged: true,
    });

    await manager.leave("m-avatar-disable", "cleanup");
  });

  test("disable when nothing is running returns wasActive=false; camera OFF fires but no renderer/device teardown", async () => {
    // The real `/avatar/disable` handler (unlike the old hand-rolled
    // fake) unconditionally flips the camera OFF whenever a camera
    // channel is wired — even when no renderer was ever started.
    // Rationale in the handler: a disable request means "ensure Meet
    // isn't emitting a video track"; if the extension's camera toggle
    // was somehow left ON by a prior boot / crash, the unconditional
    // disableCamera call gets us back to a known-safe state. The
    // renderer.stop and device.close branches remain gated on the
    // presence of active handles, so no spurious teardown fires.
    const runner = makeLazyRunner(fakeBotRef);
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
    });

    await manager.join({
      url: "u",
      meetingId: "m-avatar-noop-disable",
      conversationId: "c",
    });

    const fakeBot = expectFakeBot();

    const body = await manager.disableAvatar("m-avatar-noop-disable");
    expect(body).toMatchObject({ disabled: true, wasActive: false });
    // Camera OFF always fires — see handler contract above.
    expect(fakeBot.trace).toEqual(["camera.disableCamera"]);
    expect(fakeBot.camera.disableCalls).toBe(1);
    // But no renderer was ever constructed and no device was ever opened.
    expect(fakeBot.renderers).toHaveLength(0);
    expect(fakeBot.device.openCount).toBe(0);
    expect(fakeBot.device.closed).toBe(false);

    await manager.leave("m-avatar-noop-disable", "cleanup");
  });

  test("enable → disable → enable produces a clean second-cycle with the same lifecycle ops", async () => {
    // Ensures the daemon's enable/disable path doesn't leak state between
    // cycles. Matches the bot-side `disable then re-enable produces a
    // fresh renderer instance` invariant from avatar-http-server.test.ts
    // — here we mirror it one level up at the daemon boundary, and
    // because the real handler now drives the trace the observation is
    // end-to-end through the HTTP wire.
    const runner = makeLazyRunner(fakeBotRef);
    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
    });

    await manager.join({
      url: "u",
      meetingId: "m-avatar-cycle",
      conversationId: "c",
    });

    const fakeBot = expectFakeBot();

    await manager.enableAvatar("m-avatar-cycle");
    await manager.disableAvatar("m-avatar-cycle");
    await manager.enableAvatar("m-avatar-cycle");

    // Trace for the whole cycle: enable → disable → enable.
    expect(fakeBot.trace).toEqual([
      "renderer.start",
      "device.open",
      "camera.enableCamera",
      "camera.disableCamera",
      "device.close",
      "renderer.stop",
      "renderer.start",
      "device.open",
      "camera.enableCamera",
    ]);
    // Two distinct renderer instances were constructed — the second
    // enable must not reuse the first's torn-down instance.
    expect(fakeBot.renderers).toHaveLength(2);
    expect(fakeBot.renderers[0]!.startCount).toBe(1);
    expect(fakeBot.renderers[0]!.stopCount).toBe(1);
    expect(fakeBot.renderers[1]!.startCount).toBe(1);
    expect(fakeBot.renderers[1]!.stopCount).toBe(0);
    expect(fakeBot.camera.enableCalls).toBe(2);
    expect(fakeBot.camera.disableCalls).toBe(1);

    await manager.leave("m-avatar-cycle", "cleanup");
  });
});
