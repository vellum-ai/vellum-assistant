import { describe, test, expect } from "bun:test";
import {
  ASSISTANT_INTERNAL_PORT,
  dockerResourceNames,
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
