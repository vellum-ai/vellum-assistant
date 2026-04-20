/**
 * HTTP-layer tests for the avatar routes: `/avatar/viseme`,
 * `/avatar/enable`, `/avatar/disable`.
 *
 * Uses a stubbed device opener + the `FakeAvatarRenderer` fixture from
 * `avatar-interface.test.ts` so the routes can be exercised on macOS
 * developer machines with no real `/dev/video10`. The `resolveRenderer`
 * override lets each test swap in whatever factory semantics it needs
 * (successful renderer, renderer-throws-unavailable, renderer-returns-null)
 * without going through the global registry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AvatarRendererUnavailableError,
  type AvatarRenderer,
  type VisemeEvent,
} from "../src/media/avatar/index.js";
import {
  createHttpServer,
  type HttpServerAvatarOptions,
  type HttpServerHandle,
} from "../src/control/http-server.js";
import { BotState } from "../src/control/state.js";
import type { VideoDeviceHandle } from "../src/media/video-device.js";

import { FakeAvatarRenderer } from "./avatar-interface.test.js";

const API_TOKEN = "test-token-xyz";

function fakeDeviceHandle(): {
  writes: Uint8Array[];
  close: () => Promise<void>;
  closed: () => boolean;
  handle: VideoDeviceHandle;
} {
  const writes: Uint8Array[] = [];
  let closed = false;
  const handle: VideoDeviceHandle = {
    devicePath: "/dev/video10",
    width: 1280,
    height: 720,
    pixelFormat: "YU12",
    sink: {
      write(chunk: Uint8Array): boolean {
        writes.push(chunk);
        return true;
      },
      end(cb?: () => void): void {
        cb?.();
      },
      destroy(): void {
        /* noop */
      },
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
  return {
    writes,
    close: () => handle.close(),
    closed: () => closed,
    handle,
  };
}

function makeServer(avatar: HttpServerAvatarOptions | undefined): {
  server: HttpServerHandle;
} {
  const server = createHttpServer({
    apiToken: API_TOKEN,
    onLeave: () => {},
    onSendChat: () => {},
    onPlayAudio: () => {},
    avatar,
  });
  return { server };
}

async function startOnRandomPort(server: HttpServerHandle): Promise<string> {
  const { port } = await server.start(0);
  return `http://127.0.0.1:${port}`;
}

describe("avatar HTTP routes", () => {
  let server: HttpServerHandle | null = null;

  beforeEach(() => {
    BotState.__resetForTests();
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
  });

  // ---------------------------------------------------------------------
  // POST /avatar/viseme
  // ---------------------------------------------------------------------

  describe("POST /avatar/viseme", () => {
    test("without an active renderer, returns 200 + dispatched=false", async () => {
      const { server: s } = makeServer({
        config: { enabled: false, renderer: "noop" },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/viseme`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ phoneme: "ah", weight: 0.5, timestamp: 10 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ dispatched: false });
    });

    test("rejects a malformed viseme body with 400", async () => {
      const { server: s } = makeServer({
        config: { enabled: false, renderer: "noop" },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/viseme`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ phoneme: 42, weight: "zero" }),
      });
      expect(res.status).toBe(400);
    });

    test("with an active viseme-consuming renderer, forwards to pushViseme", async () => {
      const fake = new FakeAvatarRenderer({
        id: "fake",
        capabilities: { needsVisemes: true, needsAudio: false },
      });
      const device = fakeDeviceHandle();
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
      });
      server = s;
      const base = await startOnRandomPort(server);

      // Flip the renderer on first.
      const enable = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(enable.status).toBe(200);

      const viseme: VisemeEvent = {
        phoneme: "ah",
        weight: 0.9,
        timestamp: 123,
      };
      const res = await fetch(`${base}/avatar/viseme`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(viseme),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ dispatched: true });
      expect(fake.visemes).toHaveLength(1);
      expect(fake.visemes[0]).toEqual(viseme);
    });

    test("with a renderer that advertises needsVisemes=false, drops the event", async () => {
      const fake = new FakeAvatarRenderer({
        id: "fake",
        capabilities: { needsVisemes: false, needsAudio: true },
      });
      const device = fakeDeviceHandle();
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
      });
      server = s;
      const base = await startOnRandomPort(server);

      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });

      const res = await fetch(`${base}/avatar/viseme`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ phoneme: "ah", weight: 0.5, timestamp: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ dispatched: false });
      expect(fake.visemes).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // POST /avatar/enable
  // ---------------------------------------------------------------------

  describe("POST /avatar/enable", () => {
    test("returns 503 when the avatar subsystem is not wired up", async () => {
      const { server: s } = makeServer(undefined);
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(503);
    });

    test("returns 200 active=false when resolver returns null (noop / disabled)", async () => {
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "noop" },
        resolveRenderer: () => null,
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.active).toBe(false);
      expect(body.renderer).toBe("noop");
    });

    test("returns 503 with rendererId + reason when resolver throws AvatarRendererUnavailableError", async () => {
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "simli" },
        resolveRenderer: () => {
          throw new AvatarRendererUnavailableError(
            "simli",
            "missing SIMLI_API_KEY credential",
          );
        },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.renderer).toBe("simli");
      expect(body.error).toBe("missing SIMLI_API_KEY credential");
    });

    test("starts the renderer, opens the device, returns 200 active=true", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      let openCalls = 0;
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async (path) => {
          openCalls += 1;
          expect(path).toBe("/dev/video10");
          return device.handle;
        },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.active).toBe(true);
      expect(body.renderer).toBe("fake");
      expect(body.devicePath).toBe("/dev/video10");
      expect(fake.startCount).toBe(1);
      expect(openCalls).toBe(1);
    });

    test("a second /avatar/enable call is idempotent (alreadyRunning=true)", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      let openCalls = 0;
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => {
          openCalls += 1;
          return device.handle;
        },
      });
      server = s;
      const base = await startOnRandomPort(server);

      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      const second = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.alreadyRunning).toBe(true);
      expect(fake.startCount).toBe(1);
      expect(openCalls).toBe(1);
    });

    test("when renderer.start() throws a non-Unavailable error, renderer.stop() runs before rethrow", async () => {
      // Renderer partially initializes (GPU session, WebRTC tab) then
      // crashes. The handler must call stop() so those resources don't
      // linger — avatarRenderer is still null so no /avatar/disable
      // retry could clean them up.
      class ExplodingStartRenderer extends FakeAvatarRenderer {
        override async start(): Promise<void> {
          this.startCount += 1;
          throw new TypeError("gpu context lost mid-init");
        }
      }
      const fake = new ExplodingStartRenderer({ id: "fake" });
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      // Non-Unavailable error bubbles as a 500 from hono's default
      // error boundary. The assertion that matters here is the cleanup
      // below.
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(fake.startCount).toBe(1);
      expect(fake.stopCount).toBe(1);
    });

    test("when the renderer starts but the device open fails, returns 503 and tears the renderer down", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => {
          throw new Error("ENOENT /dev/video10 not present");
        },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.renderer).toBe("fake");
      expect(body.error).toContain("failed to open avatar device");
      // Renderer was started, then stopped on the failure path.
      expect(fake.startCount).toBe(1);
      expect(fake.stopCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // POST /avatar/disable
  // ---------------------------------------------------------------------

  describe("POST /avatar/disable", () => {
    test("returns 200 when avatar subsystem is not configured", async () => {
      const { server: s } = makeServer(undefined);
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disabled).toBe(true);
    });

    test("returns 200 wasActive=false when nothing is running", async () => {
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "noop" },
        resolveRenderer: () => null,
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disabled).toBe(true);
      expect(body.wasActive).toBe(false);
    });

    test("tears down the active renderer and device", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
      });
      server = s;
      const base = await startOnRandomPort(server);

      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(fake.startCount).toBe(1);

      const res = await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disabled).toBe(true);
      expect(body.wasActive).toBe(true);
      expect(fake.stopCount).toBe(1);
      expect(device.closed()).toBe(true);
    });

    test("disable then re-enable produces a fresh renderer instance", async () => {
      const first = new FakeAvatarRenderer({ id: "fake" });
      const second = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const rendererQueue: AvatarRenderer[] = [first, second];
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => {
          const next = rendererQueue.shift();
          if (!next) throw new Error("rendererQueue exhausted");
          return next;
        },
        openDevice: async () => device.handle,
      });
      server = s;
      const base = await startOnRandomPort(server);

      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(first.startCount).toBe(1);
      expect(first.stopCount).toBe(1);
      expect(second.startCount).toBe(1);
      expect(second.stopCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // Camera-toggle wiring
  //
  // `/avatar/enable` and `/avatar/disable` call into the optional `camera`
  // field on `HttpServerAvatarOptions` AFTER starting the renderer (enable)
  // and BEFORE tearing it down (disable) — so Meet's camera reflects the
  // renderer's liveness without a black frame between the two transitions.
  // ---------------------------------------------------------------------

  describe("camera-toggle integration", () => {
    test("/avatar/enable calls camera.enableCamera after the renderer starts", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const callOrder: string[] = [];

      // Tag the renderer start + device open so the order against the
      // camera enable is asserted directly.
      const openDevice = async (): Promise<VideoDeviceHandle> => {
        callOrder.push("open-device");
        return device.handle;
      };
      const enableCamera = async (): Promise<{ changed: boolean }> => {
        callOrder.push("camera-enable");
        return { changed: true };
      };
      let disableCalls = 0;
      const disableCamera = async (): Promise<{ changed: boolean }> => {
        disableCalls += 1;
        return { changed: false };
      };

      // Wrap the renderer's `start` so we can log the order too.
      const origStart = fake.start.bind(fake);
      fake.start = async () => {
        callOrder.push("renderer-start");
        await origStart();
      };

      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice,
        camera: { enableCamera, disableCamera },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.active).toBe(true);
      expect(body.cameraChanged).toBe(true);

      // Order: renderer starts BEFORE the device opens BEFORE the camera
      // is flipped on. The device must be attached before Meet reads
      // frames (the camera-on flip is what prompts Meet to start reading),
      // and the renderer must be running before the device is attached
      // so the writer has something to pump. disableCamera must NOT be
      // called on the enable path.
      expect(callOrder).toEqual([
        "renderer-start",
        "open-device",
        "camera-enable",
      ]);
      expect(disableCalls).toBe(0);
    });

    test("/avatar/enable surfaces camera errors in the response body without failing the renderer", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const enableCamera = async (): Promise<{ changed: boolean }> => {
        throw new Error("aria-state did not transition to on within 5000ms");
      };
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
        camera: {
          enableCamera,
          disableCamera: async () => ({ changed: false }),
        },
      });
      server = s;
      const base = await startOnRandomPort(server);

      const res = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      // Renderer stayed up — the response is still 200 — but the camera
      // error is surfaced in the body so the daemon can log it.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.active).toBe(true);
      expect(body.cameraError).toMatch(/did not transition/);
      expect(fake.startCount).toBe(1);
      // No spurious teardown on camera failure.
      expect(fake.stopCount).toBe(0);
    });

    test("/avatar/disable calls camera.disableCamera BEFORE tearing down the renderer", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const callOrder: string[] = [];
      let closedBefore: string[] = [];

      const enableCamera = async (): Promise<{ changed: boolean }> => {
        callOrder.push("camera-enable");
        return { changed: true };
      };
      const disableCamera = async (): Promise<{ changed: boolean }> => {
        callOrder.push("camera-disable");
        closedBefore = [...callOrder];
        return { changed: true };
      };

      const origStop = fake.stop.bind(fake);
      fake.stop = async () => {
        callOrder.push("renderer-stop");
        await origStop();
      };
      const origClose = device.handle.close.bind(device.handle);
      device.handle.close = async () => {
        callOrder.push("device-close");
        await origClose();
      };

      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
        camera: { enableCamera, disableCamera },
      });
      server = s;
      const base = await startOnRandomPort(server);

      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      const res = await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disabled).toBe(true);
      expect(body.wasActive).toBe(true);
      expect(body.cameraChanged).toBe(true);

      // camera-disable must come before renderer-stop and device-close.
      // closedBefore snapshots the call order as of when the camera was
      // disabled — it must only contain the enable-path entries, not the
      // stop/close entries.
      expect(closedBefore).not.toContain("renderer-stop");
      expect(closedBefore).not.toContain("device-close");
      // Final order sanity-check.
      expect(callOrder).toEqual([
        "camera-enable",
        "camera-disable",
        "device-close",
        "renderer-stop",
      ]);
    });

    test("/avatar/disable still tears down the renderer when camera.disableCamera throws", async () => {
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const enableCamera = async (): Promise<{ changed: boolean }> => ({
        changed: true,
      });
      const disableCamera = async (): Promise<{ changed: boolean }> => {
        throw new Error("extension disconnected");
      };
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
        camera: { enableCamera, disableCamera },
      });
      server = s;
      const base = await startOnRandomPort(server);

      await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });

      const res = await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disabled).toBe(true);
      expect(body.wasActive).toBe(true);
      expect(body.cameraError).toContain("extension disconnected");
      // Renderer + device still torn down — camera failure must not leak
      // resources.
      expect(fake.stopCount).toBe(1);
      expect(device.closed()).toBe(true);
    });

    test("when `camera` is absent, /avatar/enable + /avatar/disable still work without a toggle call", async () => {
      // Boot-smoke-test shape: no extension is attached, so no camera
      // channel is wired. The avatar routes must still run the renderer
      // + device lifecycle without throwing.
      const fake = new FakeAvatarRenderer({ id: "fake" });
      const device = fakeDeviceHandle();
      const { server: s } = makeServer({
        config: { enabled: true, renderer: "fake" },
        resolveRenderer: () => fake,
        openDevice: async () => device.handle,
        // `camera` intentionally omitted.
      });
      server = s;
      const base = await startOnRandomPort(server);

      const enable = await fetch(`${base}/avatar/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(enable.status).toBe(200);
      const enableBody = await enable.json();
      // No cameraChanged / cameraError in the body when camera is absent.
      expect(enableBody.cameraChanged).toBeUndefined();
      expect(enableBody.cameraError).toBeUndefined();

      const disable = await fetch(`${base}/avatar/disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(disable.status).toBe(200);
      const disableBody = await disable.json();
      expect(disableBody.cameraChanged).toBeUndefined();
      expect(disableBody.cameraError).toBeUndefined();
    });
  });
});
