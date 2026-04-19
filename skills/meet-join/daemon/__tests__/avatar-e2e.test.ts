/**
 * Daemon-side avatar E2E test.
 *
 * Stands up a minimal bot HTTP server on a random loopback port that stands
 * in for a real meet-bot container, drives {@link MeetSessionManager} through
 * a full `join()` → `enableAvatar()` → `disableAvatar()` → `leave()` cycle
 * against that fake bot, and asserts both the HTTP wire (path, method, auth
 * header) and the bot-side lifecycle semantics the real `/avatar/enable` and
 * `/avatar/disable` handlers establish:
 *
 *   - On `enableAvatar`: the renderer is started, the device is opened, the
 *     device writer is attached, and the camera is flipped ON — in that
 *     order. The renderer is kept simple (a tracked {@link NoopAvatarRenderer})
 *     so the test is independent of any concrete renderer shipping state
 *     (TalkingHead.js, Simli, HeyGen, Tavus, SadTalker, MuseTalk).
 *
 *   - On `disableAvatar`: the camera is flipped OFF FIRST, then the writer is
 *     stopped, the device is closed, and the renderer is stopped — so
 *     participants stop seeing the video track before the frame source
 *     disappears (no black frame in the gap).
 *
 *   - Idempotent retries: a second `enableAvatar` while already running short-
 *     circuits with `alreadyRunning: true` without re-initializing the
 *     renderer (matching PR 5's http-server contract).
 *
 * The test does not spin up real Docker, no real Meet, and does not touch the
 * daemon's long-running singletons — it uses `_createMeetSessionManagerForTests`
 * so each test gets an isolated manager with mock docker / audio-ingest deps.
 * The fake bot skips the real bot's bearer-token auth middleware because the
 * daemon generates its own per-session token and the bot's real
 * `createHttpServer` would require that token at construction time — one
 * chicken-and-egg step ahead of `manager.join()` resolving. Instead, we
 * record the `Authorization` header the daemon sent and assert it matches
 * `Bearer ${session.botApiToken}` after the fact, which covers the same
 * wire-protocol invariant.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { meetEventDispatcher } from "../event-publisher.js";
import { __resetMeetSessionEventRouterForTests } from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  MEET_BOT_INTERNAL_PORT,
  type MeetAudioIngestLike,
} from "../session-manager.js";

// The fake bot's `/avatar/enable` handler talks to an in-test tracker
// that stands in for the real `NoopAvatarRenderer` on the bot side —
// we don't import the bot's NoopAvatarRenderer directly because the
// daemon tests must stay behind the skill's daemon/bot runtime boundary
// (bot code ships in a Docker container, daemon code runs on the host;
// the two processes only meet over the HTTP wire this test exercises).
// The counters below give the test the same observables
// (`startCount` / `stopCount`) the real NoopAvatarRenderer exposes for
// its own unit tests, so the assertions stay semantically aligned.
interface RendererTracker {
  startCount: number;
  stopCount: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function makeRendererTracker(): RendererTracker {
  const tracker: RendererTracker = {
    startCount: 0,
    stopCount: 0,
    start: async () => {
      tracker.startCount += 1;
    },
    stop: async () => {
      tracker.stopCount += 1;
    },
  };
  return tracker;
}

// ---------------------------------------------------------------------------
// Shared fixtures — the "fake bot" stands up a Bun.serve HTTP server that
// replays the semantically-interesting parts of the real meet-bot's
// `/avatar/enable` + `/avatar/disable` handlers against a tracked noop
// renderer + fake camera + fake device. This matches the pattern used by
// `chat-send-e2e.test.ts` (minimal bot server focused on the wire protocol
// + the specific lifecycle verbs we want to assert on).
// ---------------------------------------------------------------------------

interface RecordedAvatarRequest {
  method: string;
  path: string;
  authorization: string | null;
}

interface FakeCamera {
  enableCalls: number;
  disableCalls: number;
  /** Monotonic call trace — each call appends its label here. */
  trace: string[];
  enableCamera: () => Promise<{ changed: boolean }>;
  disableCamera: () => Promise<{ changed: boolean }>;
}

interface FakeDevice {
  /** Set to `true` the moment `close()` is awaited. */
  closed: boolean;
  /** Monotonic call trace — each call appends its label here. */
  trace: string[];
  open: () => Promise<void>;
  close: () => Promise<void>;
}

interface FakeBotServer {
  url: string;
  port: number;
  /** One record per request the daemon sent. */
  requests: RecordedAvatarRequest[];
  /** The tracked "noop" renderer the `/avatar/enable` handler starts. */
  renderer: RendererTracker;
  camera: FakeCamera;
  device: FakeDevice;
  /**
   * Monotonic call trace — every callback the enable/disable handler
   * invokes appends to this. Drives the order-of-operations assertions
   * (renderer-start → device-open → camera-enable on enable; camera-disable
   * FIRST → device-close → renderer-stop on disable). Kept as a single
   * shared array (not per-component) so the test can assert the full
   * interleave with one `toEqual` call.
   */
  trace: string[];
  stop: () => Promise<void>;
}

/**
 * Boot a Bun.serve on a random loopback port whose `/avatar/enable` and
 * `/avatar/disable` handlers drive a tracked noop renderer + fake camera +
 * fake device writer, then respond with the same JSON body shape the real
 * bot's `createHttpServer` would return (see
 * `bot/src/control/http-server.ts`).
 */
function startFakeBot(): FakeBotServer {
  const requests: RecordedAvatarRequest[] = [];
  const renderer = makeRendererTracker();
  const trace: string[] = [];

  const camera: FakeCamera = {
    enableCalls: 0,
    disableCalls: 0,
    trace,
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

  const device: FakeDevice = {
    closed: false,
    trace,
    open: async () => {
      trace.push("device.open");
    },
    close: async () => {
      device.closed = true;
      trace.push("device.close");
    },
  };

  let rendererActive = false;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      requests.push({
        method: req.method,
        path,
        authorization: req.headers.get("authorization"),
      });

      if (req.method === "POST" && path === "/avatar/enable") {
        // Idempotent: a second enable while running short-circuits with
        // `alreadyRunning: true`, matching the real bot handler's
        // behavior (`bot/src/control/http-server.ts` — see the
        // `if (avatarRenderer) { ... alreadyRunning: true }` branch).
        if (rendererActive) {
          return new Response(
            JSON.stringify({
              enabled: true,
              renderer: "noop",
              alreadyRunning: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // Setup ordering must match the real bot: renderer.start() →
        // device open → camera.enableCamera(). The real handler also
        // calls attachDeviceWriter between open and camera toggle —
        // that's covered by the bot-side http-server tests and exercised
        // here by the device open + renderer.start sequence (the writer
        // is a pure-function bridge that has no observable effect at the
        // wire level this test targets).
        trace.push("renderer.start");
        await renderer.start();
        await device.open();
        await camera.enableCamera();
        rendererActive = true;

        return new Response(
          JSON.stringify({
            enabled: true,
            renderer: "noop",
            active: true,
            devicePath: "/dev/video10",
            cameraChanged: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (req.method === "POST" && path === "/avatar/disable") {
        // Teardown ordering: camera.disableCamera() FIRST, then device
        // close, then renderer.stop(). This matches the real handler's
        // deliberate ordering — drop the camera track before the frame
        // source disappears so other participants don't see a black
        // frame in the gap. See `bot/src/control/http-server.ts`'s
        // `/avatar/disable` handler for the canonical sequence.
        const wasActive = rendererActive;
        if (rendererActive) {
          await camera.disableCamera();
          await device.close();
          trace.push("renderer.stop");
          await renderer.stop();
        }
        rendererActive = false;

        return new Response(
          JSON.stringify({
            disabled: true,
            wasActive,
            cameraChanged: wasActive,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Unknown path — 404 so the daemon's fetch surfaces a clean error.
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("fake bot server failed to bind a port");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    renderer,
    camera,
    device,
    trace,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Minimal stand-in for the audio ingest. The session manager doesn't
 * interact with it after `start()` resolves, so the fake is a no-op.
 */
function makeFakeAudioIngest(): MeetAudioIngestLike {
  return {
    start: async () => {},
    stop: async () => {},
    subscribePcm: () => () => {},
  };
}

/**
 * Build a mock Docker runner whose `run()` returns a container record
 * pinned to the real fake-bot server's host port. This is how we stitch
 * the session's `botBaseUrl` to something a real `fetch()` can hit.
 */
function makeMockRunnerPointingAt(fakeBot: FakeBotServer) {
  const runResult = {
    containerId: "container-avatar-e2e",
    boundPorts: [
      {
        protocol: "tcp" as const,
        containerPort: MEET_BOT_INTERNAL_PORT,
        hostIp: "127.0.0.1",
        hostPort: fakeBot.port,
      },
    ],
  };
  return {
    run: mock(async () => runResult),
    stop: mock(async () => {}),
    remove: mock(async () => {}),
    inspect: mock(async () => ({ Id: runResult.containerId })),
    logs: mock(async () => ""),
  };
}

let workspaceDir: string;
let fakeBot: FakeBotServer;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "avatar-e2e-"));
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
  fakeBot = startFakeBot();
});

afterEach(async () => {
  await fakeBot.stop();
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// enableAvatar — full enable chain
// ---------------------------------------------------------------------------

describe("MeetSessionManager.enableAvatar end-to-end (real HTTP)", () => {
  test("drives renderer-start + device-open + camera-enable in that order via POST /avatar/enable", async () => {
    const runner = makeMockRunnerPointingAt(fakeBot);
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

    // Sanity: session is pointed at our fake bot.
    expect(session.botBaseUrl).toBe(fakeBot.url);

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
    //      renderer.start → device.open → camera.enableCamera.
    expect(fakeBot.trace).toEqual([
      "renderer.start",
      "device.open",
      "camera.enableCamera",
    ]);
    expect(fakeBot.renderer.startCount).toBe(1);
    expect(fakeBot.camera.enableCalls).toBe(1);
    expect(fakeBot.camera.disableCalls).toBe(0);
    expect(fakeBot.device.closed).toBe(false);

    // ---- Assert: the parsed JSON body the session-manager returned to
    //      the caller carries the bot's response fields so tools can
    //      relay them to the model.
    expect(body).toMatchObject({
      enabled: true,
      renderer: "noop",
      active: true,
      devicePath: "/dev/video10",
      cameraChanged: true,
    });

    await manager.leave("m-avatar-enable", "cleanup");
  });

  test("a second enableAvatar while already running returns alreadyRunning=true and does NOT re-start the renderer", async () => {
    // Matches the idempotent-retry contract established by PR 5: the bot
    // short-circuits a second /avatar/enable with `alreadyRunning: true`
    // so the daemon's retry path doesn't thrash the device.
    const runner = makeMockRunnerPointingAt(fakeBot);
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

    await manager.enableAvatar("m-avatar-idempotent");
    const second = await manager.enableAvatar("m-avatar-idempotent");

    expect(second.alreadyRunning).toBe(true);
    expect(fakeBot.renderer.startCount).toBe(1);
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
    const runner = makeMockRunnerPointingAt(fakeBot);
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
    expect(fakeBot.renderer.stopCount).toBe(1);
    expect(fakeBot.device.closed).toBe(true);

    expect(body).toMatchObject({
      disabled: true,
      wasActive: true,
      cameraChanged: true,
    });

    await manager.leave("m-avatar-disable", "cleanup");
  });

  test("disable when nothing is running returns wasActive=false and does not call the camera", async () => {
    const runner = makeMockRunnerPointingAt(fakeBot);
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

    const body = await manager.disableAvatar("m-avatar-noop-disable");
    expect(body).toMatchObject({ disabled: true, wasActive: false });
    // No lifecycle ops fired — nothing was running.
    expect(fakeBot.trace).toEqual([]);
    expect(fakeBot.camera.disableCalls).toBe(0);
    expect(fakeBot.renderer.stopCount).toBe(0);

    await manager.leave("m-avatar-noop-disable", "cleanup");
  });

  test("enable → disable → enable produces a clean second-cycle with the same lifecycle ops", async () => {
    // Ensures the daemon's enable/disable path doesn't leak state between
    // cycles. Matches the bot-side `disable then re-enable produces a
    // fresh renderer instance` invariant from avatar-http-server.test.ts
    // — here we mirror it one level up at the daemon boundary.
    const runner = makeMockRunnerPointingAt(fakeBot);
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
    expect(fakeBot.renderer.startCount).toBe(2);
    expect(fakeBot.renderer.stopCount).toBe(1);
    expect(fakeBot.camera.enableCalls).toBe(2);
    expect(fakeBot.camera.disableCalls).toBe(1);

    await manager.leave("m-avatar-cycle", "cleanup");
  });
});
