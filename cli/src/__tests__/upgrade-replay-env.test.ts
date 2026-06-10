import { afterEach, describe, expect, test } from "bun:test";

import type { DockerStatefulSetSpec } from "../lib/statefulset.js";
import { buildReplayEnv } from "../lib/upgrade-lifecycle.js";

const SAVED_ENV_VARS = ["VELLUM_PLATFORM_URL", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of SAVED_ENV_VARS) {
  savedEnv[key] = process.env[key];
}

afterEach(() => {
  for (const key of SAVED_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
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
