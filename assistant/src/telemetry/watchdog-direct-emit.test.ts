/**
 * Tests for the direct (unbuffered) watchdog telemetry emit.
 *
 * Unlike the batched reporter, this POSTs a single event straight to the
 * platform ingest. It must honor the `share_analytics` opt-out and the
 * platform-features gate, skip cleanly when credentials aren't resolved yet,
 * and otherwise send a well-formed single-event payload.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConsentState } from "../platform/consent-cache.js";

let shareAnalytics: ConsentState = true;
mock.module("../platform/consent-cache.js", () => ({
  getRawShareAnalytics: () => shareAnalytics,
}));

let platformEnabled = true;
mock.module("../platform/feature-gate.js", () => ({
  arePlatformFeaturesEnabled: () => platformEnabled,
}));

const fetchCalls: Array<{ path: string; body: string }> = [];
let clientAvailable = true;
mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () =>
      clientAvailable
        ? {
            fetch: async (path: string, init: { body: string }) => {
              fetchCalls.push({ path, body: init.body });
              return new Response("", { status: 200 });
            },
          }
        : null,
  },
}));

mock.module("../config/env.js", () => ({
  getPlatformOrganizationId: () => "org-1",
  getPlatformUserId: () => "user-1",
}));
mock.module("../util/device-id.js", () => ({
  getDeviceId: () => "device-xyz",
}));
mock.module("../version.js", () => ({ APP_VERSION: "9.9.9" }));

import { emitWatchdogEventDirect } from "./watchdog-direct-emit.js";

describe("emitWatchdogEventDirect", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    shareAnalytics = true;
    platformEnabled = true;
    clientAvailable = true;
  });

  test("POSTs a single well-formed watchdog event when opted in", async () => {
    await emitWatchdogEventDirect("sqlite_corrupted", {
      database: "main",
      error: "database disk image is malformed",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].path).toBe("/v1/telemetry/ingest/");
    const payload = JSON.parse(fetchCalls[0].body) as {
      device_id: string;
      assistant_version: string;
      organization_id?: string;
      user_id?: string;
      events: Array<Record<string, unknown>>;
    };
    expect(payload.device_id).toBe("device-xyz");
    expect(payload.assistant_version).toBe("9.9.9");
    expect(payload.organization_id).toBe("org-1");
    expect(payload.user_id).toBe("user-1");
    expect(payload.events).toHaveLength(1);
    const event = payload.events[0];
    expect(event.type).toBe("watchdog");
    expect(event.check_name).toBe("sqlite_corrupted");
    expect(event.value).toBeNull();
    expect(event.daemon_event_id).toBeString();
    expect(event.detail).toMatchObject({
      database: "main",
      error: "database disk image is malformed",
    });
  });

  test("sends nothing when share_analytics is a confirmed opt-out", async () => {
    shareAnalytics = false;
    await emitWatchdogEventDirect("sqlite_corrupted", { database: "main" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("emits while consent is unknown (no buffer to defer into)", async () => {
    shareAnalytics = "unknown";
    await emitWatchdogEventDirect("sqlite_corrupted", { database: "main" });
    expect(fetchCalls).toHaveLength(1);
  });

  test("sends nothing when platform features are disabled", async () => {
    platformEnabled = false;
    await emitWatchdogEventDirect("sqlite_corrupted", { database: "main" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("sends nothing (no throw) when credentials aren't resolved yet", async () => {
    clientAvailable = false;
    await emitWatchdogEventDirect("sqlite_corrupted", { database: "main" });
    expect(fetchCalls).toHaveLength(0);
  });
});
