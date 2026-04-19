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
});
