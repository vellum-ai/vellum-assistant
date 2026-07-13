import { describe, expect, test } from "bun:test";

import {
  buildServiceRunArgs,
  getBuilderManagedEnvKeys,
  type BuildServiceRunArgsOpts,
  type DockerStatefulSetSpec,
  type ServiceName,
} from "../lib/statefulset.js";
import { PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";

const SECRET_KEYS = [
  "CES_SERVICE_TOKEN",
  "ACTOR_TOKEN_SIGNING_KEY",
  "GUARDIAN_BOOTSTRAP_SECRET",
];

describe("getBuilderManagedEnvKeys", () => {
  test("gateway always-set keys cover spec static + secret entries and PATH", () => {
    const { always } = getBuilderManagedEnvKeys("gateway");

    const expected = [
      "VELLUM_WORKSPACE_DIR",
      "GATEWAY_SECURITY_DIR",
      "ASSISTANT_HOST",
      "CES_CREDENTIAL_URL",
      "GATEWAY_IPC_SOCKET_DIR",
      "ASSISTANT_IPC_SOCKET_DIR",
      "GATEWAY_PORT",
      "RUNTIME_HTTP_PORT",
      ...SECRET_KEYS,
      "PATH",
    ];
    for (const key of expected) {
      expect(always.has(key)).toBe(true);
    }

    expect(always.has("VELLUM_DISABLE_PLATFORM")).toBe(false);
    expect(always.has("VELLUM_DEVICE_ID")).toBe(false);
  });

  test("assistant always-set keys include secrets and builder-computed extras", () => {
    const { always } = getBuilderManagedEnvKeys("assistant");

    const expected = [
      ...SECRET_KEYS,
      "VELLUM_ASSISTANT_NAME",
      "GATEWAY_INTERNAL_URL",
      "RUNTIME_HTTP_HOST",
      "PATH",
    ];
    for (const key of expected) {
      expect(always.has(key)).toBe(true);
    }
  });

  test("gateway hostForwarded equals the three spec host entries", () => {
    const { hostForwarded } = getBuilderManagedEnvKeys("gateway");
    const sorted = [...hostForwarded].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(sorted).toEqual([
      { name: "VELAY_BASE_URL", hostVar: "VELAY_BASE_URL" },
      { name: "VELLUM_ENVIRONMENT", hostVar: "VELLUM_ENVIRONMENT" },
      { name: "VELLUM_PLATFORM_URL", hostVar: "VELLUM_PLATFORM_URL" },
    ]);
  });

  test("assistant hostForwarded includes provider keys and platform URL", () => {
    const { hostForwarded } = getBuilderManagedEnvKeys("assistant");
    expect(hostForwarded).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      hostVar: "ANTHROPIC_API_KEY",
    });
    for (const envVar of Object.values(PROVIDER_ENV_VAR_NAMES)) {
      expect(hostForwarded).toContainEqual({ name: envVar, hostVar: envVar });
    }
    expect(hostForwarded).toContainEqual({
      name: "VELLUM_PLATFORM_URL",
      hostVar: "VELLUM_PLATFORM_URL",
    });
    // Managed speech dials velay from inside the assistant process, so the
    // relay override must reach this container, not just the gateway.
    expect(hostForwarded).toContainEqual({
      name: "VELAY_BASE_URL",
      hostVar: "VELAY_BASE_URL",
    });
  });

  test("hostForwarded keeps container name when hostVar differs", () => {
    const spec: DockerStatefulSetSpec = {
      startOrder: ["gateway"],
      readiness: { endpoint: "/readyz", timeoutMs: 1, intervalMs: 1 },
      volumeClaimTemplates: [],
      containers: [
        {
          name: "gateway-sidecar",
          internalName: "gateway",
          network: "container",
          env: [{ kind: "host", name: "CONTAINER_NAME", hostVar: "HOST_NAME" }],
          volumeMounts: [],
        },
      ],
    };

    const { hostForwarded } = getBuilderManagedEnvKeys("gateway", spec);
    expect(hostForwarded).toEqual([
      { name: "CONTAINER_NAME", hostVar: "HOST_NAME" },
    ]);
  });

  test("throws on unknown service name", () => {
    expect(() => getBuilderManagedEnvKeys("bogus" as ServiceName)).toThrow(
      'docker-statefulset: unknown service "bogus"',
    );
  });
});

describe("buildServiceRunArgs extra env routing", () => {
  const opts: BuildServiceRunArgsOpts = {
    gatewayPort: 18080,
    assistantPort: 18081,
    imageTags: {
      assistant: "assistant:test",
      gateway: "gateway:test",
      "credential-executor": "ces:test",
    },
    instanceName: "test-instance",
    res: {
      assistantContainer: "test-assistant",
      cesContainer: "test-ces",
      gatewayContainer: "test-gateway",
      network: "test-net",
    },
    extraGatewayEnv: { VELLUM_DISABLE_PLATFORM: "1" },
    extraAssistantEnv: { FOO: "bar" },
  };

  const runArgs = buildServiceRunArgs(opts);

  test("extraGatewayEnv lands only in gateway args", () => {
    const gatewayArgs = runArgs.gateway();
    expect(gatewayArgs).toContain("VELLUM_DISABLE_PLATFORM=1");
    expect(gatewayArgs).not.toContain("FOO=bar");
  });

  test("extraAssistantEnv lands only in assistant args", () => {
    const assistantArgs = runArgs.assistant();
    expect(assistantArgs).toContain("FOO=bar");
    expect(assistantArgs).not.toContain("VELLUM_DISABLE_PLATFORM=1");
  });

  test("credential-executor args get neither extra env map", () => {
    const cesArgs = runArgs["credential-executor"]();
    expect(cesArgs).not.toContain("VELLUM_DISABLE_PLATFORM=1");
    expect(cesArgs).not.toContain("FOO=bar");
  });
});
