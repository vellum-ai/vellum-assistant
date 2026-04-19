import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import {
  ASSISTANT_INTERNAL_PORT,
  DEFAULT_MEET_AVATAR_DEVICE_PATH,
  dockerResourceNames,
  MEET_AVATAR_DEVICE_ENV_VAR,
  MEET_AVATAR_ENV_VAR,
  resolveMeetAvatarDevicePath,
  serviceDockerRunArgs,
  type ServiceName,
} from "../docker.js";

const instanceName = "test-instance";
const imageTags: Record<ServiceName, string> = {
  assistant: "vellumai/vellum-assistant:test",
  "credential-executor": "vellumai/vellum-credential-executor:test",
  gateway: "vellumai/vellum-gateway:test",
};

function buildAssistantArgs(): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = serviceDockerRunArgs({
    gatewayPort: 7830,
    imageTags,
    instanceName,
    res,
  });
  return builders.assistant();
}

describe("serviceDockerRunArgs — assistant", () => {
  test("runs privileged so the inner dockerd can manage cgroups/iptables/overlayfs", () => {
    const args = buildAssistantArgs();
    expect(args).toContain("--privileged");
  });

  test("mounts a dedicated named volume at /var/lib/docker for the inner dockerd data store", () => {
    const args = buildAssistantArgs();
    const spec = `${instanceName}-dockerd-data:/var/lib/docker`;
    const mountIndex = args.indexOf(spec);
    expect(mountIndex).toBeGreaterThan(0);
    expect(args[mountIndex - 1]).toBe("-v");
  });

  test("does NOT bind-mount the host Docker socket (DinD replaces host-socket access)", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  test("does NOT set VELLUM_WORKSPACE_VOLUME_NAME (legacy Phase 1.8 hint, no longer needed in DinD)", () => {
    const args = buildAssistantArgs();
    expect(
      args.some((a) => a.startsWith("VELLUM_WORKSPACE_VOLUME_NAME=")),
    ).toBe(false);
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
});

describe("Meet avatar device passthrough (VELLUM_MEET_AVATAR opt-in)", () => {
  // Snapshot + restore the process env so tests can flip the env-var
  // without leaking state to later suites or other CLI tests.
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [MEET_AVATAR_ENV_VAR, MEET_AVATAR_DEVICE_ENV_VAR]) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("resolveMeetAvatarDevicePath returns null when the env var is unset", () => {
    expect(resolveMeetAvatarDevicePath({})).toBeNull();
  });

  test("resolveMeetAvatarDevicePath treats 0/false/no as disabled", () => {
    for (const value of ["", "0", "false", "FALSE", "no", " NO "]) {
      expect(resolveMeetAvatarDevicePath({ [MEET_AVATAR_ENV_VAR]: value })).toBe(
        null,
      );
    }
  });

  test("resolveMeetAvatarDevicePath returns the default device path when enabled with a truthy value", () => {
    for (const value of ["1", "true", "YES"]) {
      expect(resolveMeetAvatarDevicePath({ [MEET_AVATAR_ENV_VAR]: value })).toBe(
        DEFAULT_MEET_AVATAR_DEVICE_PATH,
      );
    }
  });

  test("resolveMeetAvatarDevicePath honors the VELLUM_MEET_AVATAR_DEVICE override", () => {
    expect(
      resolveMeetAvatarDevicePath({
        [MEET_AVATAR_ENV_VAR]: "1",
        [MEET_AVATAR_DEVICE_ENV_VAR]: "/dev/video11",
      }),
    ).toBe("/dev/video11");
  });

  test("assistant args omit --device and the avatar env vars when VELLUM_MEET_AVATAR is unset", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--device");
    expect(
      args.some((a) => a.startsWith(`${MEET_AVATAR_ENV_VAR}=`)),
    ).toBe(false);
    expect(
      args.some((a) => a.startsWith(`${MEET_AVATAR_DEVICE_ENV_VAR}=`)),
    ).toBe(false);
  });

  test("assistant args include --device=/dev/video10:/dev/video10 when VELLUM_MEET_AVATAR=1", () => {
    process.env[MEET_AVATAR_ENV_VAR] = "1";
    const args = buildAssistantArgs();
    const deviceIdx = args.indexOf("--device");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(args[deviceIdx + 1]).toBe(
      `${DEFAULT_MEET_AVATAR_DEVICE_PATH}:${DEFAULT_MEET_AVATAR_DEVICE_PATH}`,
    );
    // The env var must also be propagated into the container so the daemon
    // knows to turn on avatar passthrough when spawning the bot.
    expect(args).toContain(`${MEET_AVATAR_ENV_VAR}=1`);
    expect(args).toContain(
      `${MEET_AVATAR_DEVICE_ENV_VAR}=${DEFAULT_MEET_AVATAR_DEVICE_PATH}`,
    );
  });

  test("assistant args honor a custom device path from VELLUM_MEET_AVATAR_DEVICE", () => {
    process.env[MEET_AVATAR_ENV_VAR] = "1";
    process.env[MEET_AVATAR_DEVICE_ENV_VAR] = "/dev/video11";
    const args = buildAssistantArgs();
    const deviceIdx = args.indexOf("--device");
    expect(deviceIdx).toBeGreaterThan(0);
    expect(args[deviceIdx + 1]).toBe("/dev/video11:/dev/video11");
    expect(args).toContain(`${MEET_AVATAR_DEVICE_ENV_VAR}=/dev/video11`);
  });
});
