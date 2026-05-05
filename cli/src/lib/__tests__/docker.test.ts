import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import {
  ASSISTANT_INTERNAL_PORT,
  AVATAR_DEVICE_ENV_VAR,
  dockerResourceNames,
  resolveAvatarDevicePath,
  type ServiceName,
} from "../docker.js";
import { buildServiceRunArgs } from "../statefulset.js";

const instanceName = "test-instance";
const imageTags: Record<ServiceName, string> = {
  assistant: "vellumai/vellum-assistant:test",
  "credential-executor": "vellumai/vellum-credential-executor:test",
  gateway: "vellumai/vellum-gateway:test",
};

function buildAssistantArgs(
  overrides: Partial<Parameters<typeof buildServiceRunArgs>[0]> = {},
): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = buildServiceRunArgs({
    gatewayPort: 7830,
    imageTags,
    instanceName,
    res,
    ...overrides,
  });
  return builders.assistant();
}

function buildGatewayArgs(
  overrides: Partial<Parameters<typeof buildServiceRunArgs>[0]> = {},
): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = buildServiceRunArgs({
    gatewayPort: 7830,
    imageTags,
    instanceName,
    res,
    ...overrides,
  });
  return builders.gateway();
}

describe("buildServiceRunArgs — assistant", () => {
  test("does not grant elevated capabilities or disable security profiles", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("SYS_ADMIN");
    expect(args).not.toContain("NET_ADMIN");
    expect(args).not.toContain("seccomp=unconfined");
    expect(args).not.toContain("apparmor=unconfined");
  });

  test("does not mount a dockerd data volume", () => {
    const args = buildAssistantArgs();
    expect(args.some((a) => a.includes("/var/lib/docker"))).toBe(false);
  });

  test("does NOT bind-mount the host Docker socket", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  test("keeps existing workspace and socket volume mounts intact", () => {
    const args = buildAssistantArgs();
    expect(args).toContain(`${instanceName}-workspace:/workspace`);
    expect(args).toContain(`${instanceName}-socket:/run/ces-bootstrap`);
  });

  test("preserves existing required env vars", () => {
    const args = buildAssistantArgs();
    expect(args).toContain("IS_CONTAINERIZED=true");
    expect(args).toContain("VELLUM_WORKSPACE_DIR=/workspace");
    expect(args).toContain(`VELLUM_ASSISTANT_NAME=${instanceName}`);
  });

  test("publishes the assistant HTTP port on all host interfaces so sibling bot containers can reach the daemon via host.docker.internal on both Docker Desktop and Linux", () => {
    const args = buildAssistantArgs();
    // The port mapping is expressed as two adjacent args: "-p" then the spec.
    // Bound to all interfaces (no `127.0.0.1:` prefix) because on vanilla
    // Linux Docker, host.docker.internal:host-gateway resolves to the Docker
    // bridge gateway IP — packets arrive at the bridge interface, not
    // loopback, so a 127.0.0.1 DNAT rule would not match.
    const portSpec = `${ASSISTANT_INTERNAL_PORT}:${ASSISTANT_INTERNAL_PORT}`;
    const portIndex = args.indexOf(portSpec);
    expect(portIndex).toBeGreaterThan(0);
    expect(args[portIndex - 1]).toBe("-p");
  });

  test("forwards GUARDIAN_BOOTSTRAP_SECRET into the assistant container when provided, so the runtime can validate the gateway's x-bootstrap-secret header and close the published-port bypass", () => {
    const args = buildAssistantArgs({ bootstrapSecret: "super-secret-abc" });
    expect(args).toContain("GUARDIAN_BOOTSTRAP_SECRET=super-secret-abc");
  });

  test("omits GUARDIAN_BOOTSTRAP_SECRET when no bootstrapSecret is provided (bare-metal-style caller should not inherit a stale secret)", () => {
    const args = buildAssistantArgs();
    expect(args.some((a) => a.startsWith("GUARDIAN_BOOTSTRAP_SECRET="))).toBe(
      false,
    );
  });
});

describe("buildServiceRunArgs — gateway", () => {
  const savedVelayBaseUrl = process.env.VELAY_BASE_URL;

  beforeEach(() => {
    delete process.env.VELAY_BASE_URL;
  });

  afterEach(() => {
    if (savedVelayBaseUrl === undefined) delete process.env.VELAY_BASE_URL;
    else process.env.VELAY_BASE_URL = savedVelayBaseUrl;
  });

  test("passes VELAY_BASE_URL into the gateway container when set", () => {
    process.env.VELAY_BASE_URL = "http://host.docker.internal:8501";

    expect(buildGatewayArgs()).toContain(
      "VELAY_BASE_URL=http://host.docker.internal:8501",
    );
  });

  test("omits VELAY_BASE_URL from gateway args when unset", () => {
    expect(
      buildGatewayArgs().some((arg) => arg.startsWith("VELAY_BASE_URL=")),
    ).toBe(false);
  });
});

describe("VELLUM_AVATAR_DEVICE passthrough", () => {
  const savedValue = process.env[AVATAR_DEVICE_ENV_VAR];

  beforeEach(() => {
    delete process.env[AVATAR_DEVICE_ENV_VAR];
  });

  afterEach(() => {
    if (savedValue === undefined) delete process.env[AVATAR_DEVICE_ENV_VAR];
    else process.env[AVATAR_DEVICE_ENV_VAR] = savedValue;
  });

  test("resolveAvatarDevicePath returns default when env var is unset", () => {
    expect(resolveAvatarDevicePath({})).toBe("/dev/video10");
  });

  test("resolveAvatarDevicePath honors override", () => {
    expect(
      resolveAvatarDevicePath({ [AVATAR_DEVICE_ENV_VAR]: "/dev/video11" }),
    ).toBe("/dev/video11");
  });

  test("assistant args omit --device and env var when device node is absent", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--device");
    expect(args.some((a) => a.startsWith(`${AVATAR_DEVICE_ENV_VAR}=`))).toBe(
      false,
    );
  });
});
