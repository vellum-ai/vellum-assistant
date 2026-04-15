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
  test("mounts the host Docker socket for Meet bot spawning", () => {
    const args = buildAssistantArgs();
    // The bind-mount is expressed as two adjacent args: "-v" then the spec.
    const mountIndex = args.indexOf(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
    expect(mountIndex).toBeGreaterThan(0);
    expect(args[mountIndex - 1]).toBe("-v");
  });

  test("passes VELLUM_WORKSPACE_VOLUME_NAME as a hint for the workspace-volume helper", () => {
    const args = buildAssistantArgs();
    const expected = `VELLUM_WORKSPACE_VOLUME_NAME=${instanceName}-workspace`;
    const envIndex = args.indexOf(expected);
    expect(envIndex).toBeGreaterThan(0);
    expect(args[envIndex - 1]).toBe("-e");
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

  test("publishes the assistant HTTP port on 127.0.0.1 so sibling bot containers can reach the daemon via host.docker.internal", () => {
    const args = buildAssistantArgs();
    // The port mapping is expressed as two adjacent args: "-p" then the spec.
    const portSpec = `127.0.0.1:${ASSISTANT_INTERNAL_PORT}:${ASSISTANT_INTERNAL_PORT}`;
    const portIndex = args.indexOf(portSpec);
    expect(portIndex).toBeGreaterThan(0);
    expect(args[portIndex - 1]).toBe("-p");
  });
});
