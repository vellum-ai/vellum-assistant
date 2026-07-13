import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetHostDeviceIdCache } from "../lib/device-id.js";
import type { DockerStatefulSetSpec } from "../lib/statefulset.js";
import { buildReplayEnv, buildReplayState } from "../lib/upgrade-lifecycle.js";
import { snapshotEnv } from "./helpers/env.js";

const restoreEnv = snapshotEnv([
  "VELLUM_PLATFORM_URL",
  "ANTHROPIC_API_KEY",
  "VELLUM_DEVICE_ID",
  "VELAY_BASE_URL",
]);

beforeEach(() => {
  // A developer's pre-set relay override would make buildReplayEnv treat
  // VELAY_BASE_URL as host-managed and skew the replay assertions.
  delete process.env.VELAY_BASE_URL;
});

afterEach(() => {
  restoreEnv();
  resetHostDeviceIdCache();
});

describe("buildReplayEnv", () => {
  test("gateway: drops secrets, statics, and PATH; keeps flag overrides", () => {
    const captured = {
      GUARDIAN_BOOTSTRAP_SECRET: "s1",
      CES_SERVICE_TOKEN: "s2",
      ACTOR_TOKEN_SIGNING_KEY: "s3",
      PATH: "/usr/bin",
      GATEWAY_PORT: "18080",
      VELLUM_DISABLE_PLATFORM: "1",
      VELLUM_DEVICE_ID: "abc",
    };

    expect(buildReplayEnv(captured, "gateway")).toEqual({
      VELLUM_DISABLE_PLATFORM: "1",
      VELLUM_DEVICE_ID: "abc",
    });
  });

  test("gateway: captured VELLUM_PLATFORM_URL dropped when set on host", () => {
    process.env.VELLUM_PLATFORM_URL = "https://host.example.com";
    const replay = buildReplayEnv(
      { VELLUM_PLATFORM_URL: "https://stale.example.com" },
      "gateway",
    );
    expect(replay).toEqual({});
  });

  test("gateway: captured VELLUM_PLATFORM_URL kept when unset on host", () => {
    delete process.env.VELLUM_PLATFORM_URL;
    const replay = buildReplayEnv(
      { VELLUM_PLATFORM_URL: "https://stale.example.com" },
      "gateway",
    );
    expect(replay).toEqual({
      VELLUM_PLATFORM_URL: "https://stale.example.com",
    });
  });

  test("assistant: drops builder-computed extras, secrets, and PATH; keeps custom flags", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const captured = {
      VELLUM_ASSISTANT_NAME: "my-assistant",
      GATEWAY_INTERNAL_URL: "http://localhost:8080",
      GUARDIAN_BOOTSTRAP_SECRET: "s1",
      CES_SERVICE_TOKEN: "s2",
      ACTOR_TOKEN_SIGNING_KEY: "s3",
      PATH: "/usr/bin",
      MY_CUSTOM_FLAG: "yes",
      ANTHROPIC_API_KEY: "sk-captured",
    };

    expect(buildReplayEnv(captured, "assistant")).toEqual({
      MY_CUSTOM_FLAG: "yes",
      ANTHROPIC_API_KEY: "sk-captured",
    });
  });

  test("assistant: captured ANTHROPIC_API_KEY dropped when set on host", () => {
    process.env.ANTHROPIC_API_KEY = "sk-host";
    const replay = buildReplayEnv(
      { ANTHROPIC_API_KEY: "sk-captured", MY_CUSTOM_FLAG: "yes" },
      "assistant",
    );
    expect(replay).toEqual({ MY_CUSTOM_FLAG: "yes" });
  });

  test("a secret added to the spec is auto-excluded with no code change", () => {
    const spec: DockerStatefulSetSpec = {
      startOrder: ["gateway"],
      readiness: { endpoint: "/readyz", timeoutMs: 1, intervalMs: 1 },
      volumeClaimTemplates: [],
      containers: [
        {
          name: "gateway-sidecar",
          internalName: "gateway",
          network: "container",
          env: [
            { kind: "secret", name: "FUTURE_SECRET", secret: "signingKey" },
          ],
          volumeMounts: [],
        },
      ],
    };

    const replay = buildReplayEnv(
      { FUTURE_SECRET: "leaky", VELLUM_DEVICE_ID: "abc" },
      "gateway",
      spec,
    );
    expect(replay).toEqual({ VELLUM_DEVICE_ID: "abc" });
  });
});

describe("buildReplayState", () => {
  beforeEach(() => {
    // VELLUM_DEVICE_ID env precedence keeps getOrCreateHostDeviceId off the
    // filesystem in tests.
    process.env.VELLUM_DEVICE_ID = "host-device-id";
    resetHostDeviceIdCache();
  });

  test("backfills VELLUM_DEVICE_ID on gateway replay env when absent", () => {
    const state = buildReplayState({}, { VELLUM_DISABLE_PLATFORM: "1" });
    expect(state.extraGatewayEnv).toEqual({
      VELLUM_DISABLE_PLATFORM: "1",
      VELLUM_DEVICE_ID: "host-device-id",
    });
  });

  test("captured VELLUM_DEVICE_ID wins over host-derived id", () => {
    const state = buildReplayState({}, { VELLUM_DEVICE_ID: "existing" });
    expect(state.extraGatewayEnv.VELLUM_DEVICE_ID).toBe("existing");
  });

  test("backfills VELLUM_DEVICE_ID on assistant replay env when absent", () => {
    const state = buildReplayState({}, {});
    expect(state.extraAssistantEnv.VELLUM_DEVICE_ID).toBe("host-device-id");
  });

  test("assistant backfill inherits captured gateway VELLUM_DEVICE_ID", () => {
    const state = buildReplayState({}, { VELLUM_DEVICE_ID: "gw-captured" });
    expect(state.extraGatewayEnv.VELLUM_DEVICE_ID).toBe("gw-captured");
    expect(state.extraAssistantEnv.VELLUM_DEVICE_ID).toBe("gw-captured");
  });

  test("captured assistant VELLUM_DEVICE_ID wins over host-derived id", () => {
    const state = buildReplayState({ VELLUM_DEVICE_ID: "existing" }, {});
    expect(state.extraAssistantEnv.VELLUM_DEVICE_ID).toBe("existing");
  });

  test("assistant inherits the gateway's captured VELAY_BASE_URL", () => {
    // Instances created before VELAY_BASE_URL was forwarded to the assistant
    // stored the relay override only on the gateway; managed speech dials
    // from the assistant process and must reach the same relay.
    const state = buildReplayState(
      {},
      { VELAY_BASE_URL: "http://velay.internal:8484" },
    );
    expect(state.extraAssistantEnv.VELAY_BASE_URL).toBe(
      "http://velay.internal:8484",
    );
  });

  test("captured assistant VELAY_BASE_URL wins over the gateway's", () => {
    const state = buildReplayState(
      { VELAY_BASE_URL: "http://assistant-override" },
      { VELAY_BASE_URL: "http://gateway-value" },
    );
    expect(state.extraAssistantEnv.VELAY_BASE_URL).toBe(
      "http://assistant-override",
    );
  });

  test("host-set VELAY_BASE_URL defers to host forwarding (no replay copy)", () => {
    process.env.VELAY_BASE_URL = "http://host-managed";
    const state = buildReplayState(
      {},
      { VELAY_BASE_URL: "http://gateway-value" },
    );
    // Filtered from the gateway replay env, so nothing to inherit — the
    // builder re-forwards the host value to both containers instead.
    expect(state.extraGatewayEnv.VELAY_BASE_URL).toBeUndefined();
    expect(state.extraAssistantEnv.VELAY_BASE_URL).toBeUndefined();
  });

  test("plucks secrets from the captured envs", () => {
    const state = buildReplayState(
      { CES_SERVICE_TOKEN: "ces-token", ACTOR_TOKEN_SIGNING_KEY: "sign-key" },
      { GUARDIAN_BOOTSTRAP_SECRET: "bootstrap" },
    );
    expect(state.bootstrapSecret).toBe("bootstrap");
    expect(state.cesServiceToken).toBe("ces-token");
    expect(state.signingKey).toBe("sign-key");
  });

  test("generates fresh secrets when missing from captured env", () => {
    const state = buildReplayState({}, {});
    expect(state.bootstrapSecret).toBeUndefined();
    expect(state.cesServiceToken).toMatch(/^[0-9a-f]{64}$/);
    expect(state.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
