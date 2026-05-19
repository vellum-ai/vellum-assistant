/**
 * HTTP smoke test for the Phase 1 perception vertical slice.
 *
 * This exercises the same runtime routes the gateway proxies for the Tauri HUD:
 * POST one `app_focus_changed` event, then read it back from the in-memory
 * buffer via GET /v1/perception/recent.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  _setOverridesForTesting,
  clearFeatureFlagOverridesCache,
} from "../../config/assistant-feature-flags.js";
import { startPerception, stopPerception } from "../../perception/startup.js";
import { mintToken } from "../auth/token-service.js";
import { RuntimeHttpServer } from "../http-server.js";

const TEST_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "actor:self:test",
  scope_profile: "actor_client_v1",
  policy_epoch: 1,
  ttlSeconds: 3600,
});

const AUTH_HEADERS = {
  Authorization: `Bearer ${TEST_JWT}`,
  "Content-Type": "application/json",
};

const event = {
  eventId: "evt-http-smoke",
  ts: new Date("2026-01-01T00:00:00Z").toISOString(),
  source: { module: "test-http" },
  payload: {
    kind: "app_focus_changed",
    appId: "com.apple.Terminal",
    appName: "Terminal",
    windowTitle: "Eli - perception smoke",
    redacted: false,
  },
};

describe("perception HTTP smoke", () => {
  let server: RuntimeHttpServer | null = null;
  let port = 0;

  beforeEach(async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();
    server = new RuntimeHttpServer({ port: 0 });
    await server.start();
    port = server.actualPort;
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    stopPerception();
    clearFeatureFlagOverridesCache();
  });

  test("publishes and reads back recent perception context over HTTP", async () => {
    const publish = await fetch(
      `http://127.0.0.1:${port}/v1/perception/publish`,
      {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify(event),
      },
    );
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toEqual({ accepted: true });

    const recent = await fetch(
      `http://127.0.0.1:${port}/v1/perception/recent?limit=1`,
      {
        headers: { Authorization: `Bearer ${TEST_JWT}` },
      },
    );
    expect(recent.status).toBe(200);
    const body = (await recent.json()) as {
      enabled: boolean;
      entries: Array<{ event: typeof event }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.event).toMatchObject({
      eventId: "evt-http-smoke",
      payload: {
        kind: "app_focus_changed",
        appName: "Terminal",
        windowTitle: "Eli - perception smoke",
      },
    });
  });
});
