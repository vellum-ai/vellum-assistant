import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as cloudflareTunnel from "../lib/cloudflare-tunnel.js";
import * as ngrok from "../lib/ngrok.js";
import * as nginxIngress from "../lib/nginx-ingress.js";
import * as tailscaleTunnel from "../lib/tailscale-tunnel.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

const realCloudflareTunnel = { ...cloudflareTunnel };
const realNgrok = { ...ngrok };
const realNginxIngress = { ...nginxIngress };
const realTailscaleTunnel = { ...tailscaleTunnel };
const realChildProcess = { ...childProcess };

const runCloudflareTunnelMock = mock<
  typeof cloudflareTunnel.runCloudflareTunnel
>(async () => {});
mock.module("../lib/cloudflare-tunnel.js", () => ({
  ...realCloudflareTunnel,
  runCloudflareTunnel: runCloudflareTunnelMock,
}));

const runNgrokTunnelMock = mock<typeof ngrok.runNgrokTunnel>(async () => {});
mock.module("../lib/ngrok", () => ({
  ...realNgrok,
  runNgrokTunnel: runNgrokTunnelMock,
}));

const runTailscaleTunnelMock = mock<typeof tailscaleTunnel.runTailscaleTunnel>(
  async () => {},
);
mock.module("../lib/tailscale-tunnel.js", () => ({
  ...realTailscaleTunnel,
  runTailscaleTunnel: runTailscaleTunnelMock,
}));

const EDGE_PORT = 18080;

const ensureTunnelEdgeMock = mock<typeof nginxIngress.ensureTunnelEdge>(
  async () => ({ port: EDGE_PORT, started: true, includesWebApp: true }),
);
mock.module("../lib/nginx-ingress.js", () => ({
  ...realNginxIngress,
  ensureTunnelEdge: ensureTunnelEdgeMock,
}));

const { tunnel } = await import("../commands/tunnel.js");

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const tempDirs: string[] = [];

function makeLocalEntry(assistantId = "assistant-1"): AssistantEntry {
  const instanceDir = mkdtempSync(join(tmpdir(), "vellum-tunnel-test-"));
  tempDirs.push(instanceDir);
  return {
    assistantId,
    runtimeUrl: "http://127.0.0.1:7830",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      qdrantPort: 6333,
      cesPort: 7822,
    },
  };
}

function makeCloudEntry(assistantId = "cloud-1"): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: `https://runtime.example.com/${assistantId}`,
    cloud: "vellum",
  };
}

/** A `hatch --remote docker` entry: local container gateway, no `resources`. */
function makeDockerEntry(assistantId = "docker-1"): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://localhost:7930",
    cloud: "docker",
  };
}

/** A macOS-app-managed entry: local container gateway, no `resources`. */
function makeAppleContainerEntry(assistantId = "apple-1"): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://localhost:8030",
    cloud: "apple-container",
  };
}

/** Point the default workspace dir at a temp dir; returns that dir. */
function useTempDefaultWorkspaceDir(): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), "vellum-tunnel-ws-"));
  tempDirs.push(workspaceDir);
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  return workspaceDir;
}

function writeLockfile(
  entryOrEntries: AssistantEntry | AssistantEntry[],
  activeAssistant?: string,
): void {
  const entries = Array.isArray(entryOrEntries)
    ? entryOrEntries
    : [entryOrEntries];
  const lockfileDir = mkdtempSync(join(tmpdir(), "vellum-tunnel-lockfile-"));
  tempDirs.push(lockfileDir);
  process.env.VELLUM_LOCKFILE_DIR = lockfileDir;
  mkdirSync(lockfileDir, { recursive: true });
  writeFileSync(
    join(lockfileDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        activeAssistant: activeAssistant ?? entries[0].assistantId,
        assistants: entries,
      },
      null,
      2,
    ),
  );
}

/** Run tunnel() expecting exit(1); returns the joined console.error output. */
async function runTunnelExpectingExit1(): Promise<{
  exited: boolean;
  errors: string;
}> {
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code}`);
  }) as never);

  let exited = false;
  try {
    await tunnel();
  } catch (e) {
    exited = (e as Error).message === "exit:1";
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, errors: errors.join("\n") };
}

/** Run tunnel() capturing console.log output; returns the joined lines. */
async function runTunnelCapturingLogs(): Promise<string> {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  try {
    await tunnel();
  } finally {
    logSpy.mockRestore();
  }
  return logs.join("\n");
}

describe("tunnel edge targeting", () => {
  beforeEach(() => {
    process.argv = ["bun", "vellum", "tunnel"];
    writeLockfile(makeLocalEntry());
    globalThis.fetch = (async () => {
      throw new Error("gateway unavailable");
    }) as unknown as typeof globalThis.fetch;
    runCloudflareTunnelMock.mockReset();
    runCloudflareTunnelMock.mockResolvedValue(undefined);
    runNgrokTunnelMock.mockReset();
    runNgrokTunnelMock.mockResolvedValue(undefined);
    runTailscaleTunnelMock.mockReset();
    runTailscaleTunnelMock.mockResolvedValue(undefined);
    ensureTunnelEdgeMock.mockReset();
    ensureTunnelEdgeMock.mockResolvedValue({
      port: EDGE_PORT,
      started: true,
      includesWebApp: true,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    if (originalWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    mock.module("../lib/cloudflare-tunnel.js", () => realCloudflareTunnel);
    mock.module("../lib/ngrok", () => realNgrok);
    mock.module("../lib/tailscale-tunnel.js", () => realTailscaleTunnel);
    mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
  });

  test("does not start ngrok when the edge flag lookup fails", async () => {
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];
    ensureTunnelEdgeMock.mockImplementation(realNginxIngress.ensureTunnelEdge);

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Could not verify the `web-remote-ingress` feature flag",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("targets the edge port returned by ensureTunnelEdge for ngrok", async () => {
    const entry = makeLocalEntry();
    entry.runtimeUrl = "https://stale-tunnel.ngrok-free.dev";
    writeLockfile(entry);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();

    const workspaceDir = join(
      entry.resources!.instanceDir,
      ".vellum",
      "workspace",
    );
    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
    expect(logs).toContain(`Started the nginx edge on 127.0.0.1:${EDGE_PORT}`);
    expect(logs).toContain("serves remote web + webhooks");
  });

  test("an active cloud assistant falls back to the sole local entry with a note", async () => {
    const cloud = makeCloudEntry();
    const local = makeLocalEntry();
    writeLockfile([cloud, local], cloud.assistantId);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();

    const workspaceDir = join(
      local.resources!.instanceDir,
      ".vellum",
      "workspace",
    );
    expect(logs).toContain(
      "Assistant 'cloud-1' runs on Vellum Cloud and needs no tunnel. " +
        "Tunneling the local assistant 'assistant-1' instead.",
    );
    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("a positional docker assistant name tunnels via its runtimeUrl gateway port", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const local = makeLocalEntry();
    writeLockfile([local, makeDockerEntry()], local.assistantId);
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "docker-1",
      "--provider",
      "ngrok",
    ];

    await runTunnelCapturingLogs();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "docker-1",
      workspaceDir,
      gatewayPort: 7930,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "docker-1",
      workspaceDir,
    });
  });

  test("an active docker assistant tunnels on a bare invocation", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const docker = makeDockerEntry();
    writeLockfile(docker, docker.assistantId);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "docker-1",
      workspaceDir,
      gatewayPort: 7930,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "docker-1",
      workspaceDir,
    });
  });

  test("an active cloud assistant falls back to a sole docker entry with a note", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const cloud = makeCloudEntry();
    writeLockfile([cloud, makeDockerEntry()], cloud.assistantId);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain(
      "Assistant 'cloud-1' runs on Vellum Cloud and needs no tunnel. " +
        "Tunneling the local assistant 'docker-1' instead.",
    );
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "docker-1",
      workspaceDir,
    });
  });

  test("an active cloud assistant with no local entries exits with an error", async () => {
    writeLockfile(makeCloudEntry());
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Assistant 'cloud-1' runs on Vellum Cloud and needs no tunnel.",
    );
    expect(errors).toContain("No local assistant found to tunnel");
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an active cloud assistant with multiple local entries exits listing them", async () => {
    const cloud = makeCloudEntry();
    writeLockfile(
      [cloud, makeLocalEntry("assistant-a"), makeLocalEntry("assistant-b")],
      cloud.assistantId,
    );
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Assistant 'cloud-1' runs on Vellum Cloud and needs no tunnel.",
    );
    expect(errors).toContain(
      "Pass a local assistant as the name argument: assistant-a, assistant-b.",
    );
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("a positional cloud assistant name errors without auto-fallback", async () => {
    const local = makeLocalEntry();
    writeLockfile([makeCloudEntry(), local], local.assistantId);
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "cloud-1",
      "--provider",
      "ngrok",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Assistant 'cloud-1' runs on Vellum Cloud and needs no tunnel.",
    );
    expect(errors).toContain(
      "Pass a local assistant as the name argument: assistant-1.",
    );
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("a positional display name resolves the local assistant", async () => {
    const local = makeLocalEntry();
    local.name = "Ada";
    writeLockfile([makeCloudEntry(), local], "cloud-1");
    process.argv = ["bun", "vellum", "tunnel", "Ada", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    const workspaceDir = join(
      local.resources!.instanceDir,
      ".vellum",
      "workspace",
    );
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("an unquoted multi-word display name resolves the local assistant", async () => {
    const local = makeLocalEntry();
    local.name = "Ada Lovelace";
    writeLockfile([makeCloudEntry(), local], "cloud-1");
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "Ada",
      "Lovelace",
      "--provider",
      "ngrok",
    ];

    await runTunnelCapturingLogs();

    const workspaceDir = join(
      local.resources!.instanceDir,
      ".vellum",
      "workspace",
    );
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("a positional apple-container assistant name tunnels via its runtimeUrl gateway port", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const local = makeLocalEntry();
    writeLockfile([local, makeAppleContainerEntry()], local.assistantId);
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "apple-1",
      "--provider",
      "ngrok",
    ];

    await runTunnelCapturingLogs();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "apple-1",
      workspaceDir,
      gatewayPort: 8030,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "apple-1",
      workspaceDir,
    });
  });

  test("an active cloud assistant falls back to a sole apple-container entry with a note", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const cloud = makeCloudEntry();
    writeLockfile([cloud, makeAppleContainerEntry()], cloud.assistantId);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain(
      "Assistant 'cloud-1' runs on Vellum Cloud and needs no tunnel. " +
        "Tunneling the local assistant 'apple-1' instead.",
    );
    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "apple-1",
      workspaceDir,
      gatewayPort: 8030,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "apple-1",
      workspaceDir,
    });
  });

  test("an exact assistant ID wins over a colliding display name", async () => {
    const decoy = makeLocalEntry("assistant-a");
    decoy.name = "assistant-b";
    const target = makeLocalEntry("assistant-b");
    writeLockfile([decoy, target], "assistant-a");
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "assistant-b",
      "--provider",
      "ngrok",
    ];

    await runTunnelCapturingLogs();

    expect(runNgrokTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "assistant-b" }),
    );
  });

  test("a positional display name of a cloud assistant errors without auto-fallback", async () => {
    const cloud = makeCloudEntry();
    cloud.name = "Cloudy";
    const local = makeLocalEntry();
    writeLockfile([cloud, local], local.assistantId);
    process.argv = ["bun", "vellum", "tunnel", "Cloudy", "--provider", "ngrok"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Assistant 'Cloudy (cloud-1)' runs on Vellum Cloud and needs no tunnel.",
    );
    expect(errors).toContain(
      "Pass a local assistant as the name argument: assistant-1.",
    );
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an ambiguous positional display name errors listing the candidates", async () => {
    const first = makeLocalEntry("assistant-a");
    first.name = "Ada";
    const second = makeLocalEntry("assistant-b");
    second.name = "Ada";
    writeLockfile([first, second], "assistant-a");
    process.argv = ["bun", "vellum", "tunnel", "Ada", "--provider", "ngrok"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Multiple assistants match 'Ada': Ada (assistant-a), Ada (assistant-b).",
    );
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an unknown positional name errors", async () => {
    process.argv = ["bun", "vellum", "tunnel", "nope", "--provider", "ngrok"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("No assistant found with name or ID 'nope'.");
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("targets the edge port for cloudflare", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "cloudflare"];

    await runTunnelCapturingLogs();

    expect(runCloudflareTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(entry.resources!.instanceDir, ".vellum", "workspace"),
    });
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("targets the edge port for tailscale and notes a reused webhooks-only edge", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = ["bun", "vellum", "tunnel", "--provider", "tailscale"];
    ensureTunnelEdgeMock.mockResolvedValue({
      port: EDGE_PORT,
      started: false,
      includesWebApp: false,
    });

    const logs = await runTunnelCapturingLogs();

    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(entry.resources!.instanceDir, ".vellum", "workspace"),
    });
    expect(logs).toContain(`Reusing the nginx edge on 127.0.0.1:${EDGE_PORT}`);
    expect(logs).toContain("serves webhooks only");
  });

  test("missing nginx aborts before any provider spawn", async () => {
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];
    ensureTunnelEdgeMock.mockRejectedValue(
      new Error(
        "nginx is not installed, so the tunnel edge cannot start. " +
          "Install it (macOS: `brew install nginx`, Linux: `sudo apt install nginx`) " +
          "or point NGINX_BIN at an existing binary.",
      ),
    );

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("brew install nginx");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
  });

  test("does not start cloudflared when the edge flag lookup fails", async () => {
    process.argv = ["bun", "vellum", "tunnel", "--provider", "cloudflare"];
    ensureTunnelEdgeMock.mockImplementation(realNginxIngress.ensureTunnelEdge);

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Could not verify the `web-remote-ingress` feature flag",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("rejects an unknown --provider with a stale-CLI hint", async () => {
    process.argv = ["bun", "vellum", "tunnel", "--provider", "bogus"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("unknown tunnel provider 'bogus'");
    expect(errors).toContain("your CLI may be out of date");
    expect(errors).toContain("bun install -g vellum@latest");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("threads --domain through to runNgrokTunnel", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "--provider",
      "ngrok",
      "--domain",
      "foo.ngrok.app",
    ];

    await runTunnelCapturingLogs();

    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(entry.resources!.instanceDir, ".vellum", "workspace"),
      domain: "foo.ngrok.app",
    });
  });

  test("rejects --domain with a non-ngrok provider", async () => {
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "--provider",
      "cloudflare",
      "--domain",
      "foo.ngrok.app",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "--domain is only supported with --provider ngrok",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("--clear-domain drops the saved domain and runs domainless", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    const workspaceDir = join(
      entry.resources!.instanceDir,
      ".vellum",
      "workspace",
    );
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ ingress: { ngrok: { domain: "dead.ngrok.app" } } }),
    );
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "--provider",
      "ngrok",
      "--clear-domain",
    ];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain("Cleared the saved ngrok domain");
    const config = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    ) as { ingress?: { ngrok?: { domain?: string } } };
    expect(config.ingress?.ngrok).toBeUndefined();
    // The run proceeds domainless: no `domain` key reaches runNgrokTunnel.
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("rejects --clear-domain combined with --domain", async () => {
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "--provider",
      "ngrok",
      "--domain",
      "foo.ngrok.app",
      "--clear-domain",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("--clear-domain cannot be combined with --domain");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("rejects --clear-domain with a non-ngrok provider", async () => {
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "--provider",
      "cloudflare",
      "--clear-domain",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "--clear-domain is only supported with --provider ngrok",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("errors when --domain is missing its value", async () => {
    process.argv = [
      "bun",
      "vellum",
      "tunnel",
      "--provider",
      "ngrok",
      "--domain",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("--domain requires a value");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("a not-yet-implemented provider error carries the stale-CLI hint", async () => {
    // The default `vellum` provider has no runtime yet, so it exercises the
    // not-yet-implemented path without any network call.
    process.argv = ["bun", "vellum", "tunnel", "--provider", "vellum"];

    let err: Error | undefined;
    try {
      await tunnel();
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).toContain("is not yet implemented");
    expect(err?.message).toContain("your CLI may be out of date");
    expect(err?.message).toContain("bun install -g vellum@latest");
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });
});

describe("ngrok --domain spawn args", () => {
  const originalContainerized = process.env.IS_CONTAINERIZED;
  let lastChild: EventEmitter | null = null;

  const spawnMock = mock((..._args: unknown[]) => {
    const emitter = new EventEmitter();
    lastChild = Object.assign(emitter, {
      stdout: null,
      stderr: null,
      killed: false,
      kill: () => true,
      unref: () => {},
      pid: 4242,
    });
    return lastChild as unknown as ChildProcess;
  });
  const execFileSyncMock = mock(() => "ngrok version 3.9.0");

  beforeAll(() => {
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      spawn: spawnMock,
      execFileSync: execFileSyncMock,
    }));
  });

  afterAll(() => {
    mock.module("node:child_process", () => realChildProcess);
  });

  beforeEach(() => {
    spawnMock.mockClear();
    lastChild = null;
    delete process.env.IS_CONTAINERIZED;
    mockNgrokApiFetch([{ tunnels: [] }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = originalContainerized;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspace(config: Record<string, unknown>): string {
    const ws = mkdtempSync(join(tmpdir(), "vellum-ngrok-domain-test-"));
    tempDirs.push(ws);
    writeFileSync(join(ws, "config.json"), JSON.stringify(config, null, 2));
    return ws;
  }

  interface StubTunnel {
    public_url: string;
    config: { addr: string };
  }

  /** ngrok local API stub replaying one response per call, last one repeated. */
  function mockNgrokApiFetch(responses: { tunnels: StubTunnel[] }[]): void {
    let call = 0;
    globalThis.fetch = (async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call++;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  const unrelatedPortTunnel: StubTunnel = {
    public_url: "https://unrelated.ngrok.app",
    config: { addr: "localhost:65500" },
  };

  test("runNgrokTunnel spawns ngrok with --domain and persists the domain", async () => {
    const ws = makeWorkspace({});
    // The pre-spawn listing is empty (any running tunnel would abort the run);
    // post-spawn, only the tunnel matching the target port and domain may be
    // saved even with an unrelated-port tunnel listed first.
    mockNgrokApiFetch([
      { tunnels: [] },
      {
        tunnels: [
          unrelatedPortTunnel,
          {
            public_url: "https://foo.ngrok.app",
            config: { addr: "localhost:7831" },
          },
        ],
      },
    ]);

    const run = realNgrok.runNgrokTunnel({
      port: 7831,
      workspaceDir: ws,
      domain: "foo.ngrok.app",
    });
    // runNgrokTunnel blocks until the ngrok process exits; pump exit events
    // until its final exit listener is registered and the promise settles.
    const pump = setInterval(() => lastChild?.emit("exit", 0), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(cmd).toBe("ngrok");
    expect(args).toEqual([
      "http",
      "127.0.0.1:7831",
      "--log=stdout",
      "--domain=foo.ngrok.app",
    ]);

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress: { publicBaseUrl?: string; ngrok?: { domain?: string } } };
    expect(config.ingress.publicBaseUrl).toBe("https://foo.ngrok.app");
    expect(config.ingress.ngrok?.domain).toBe("foo.ngrok.app");
  });

  function mockTunnelListFetch(publicUrl: string, addr: string): void {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tunnels: [{ public_url: publicUrl, config: { addr } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
  }

  test("runNgrokTunnel rejects an existing tunnel that mismatches the requested domain", async () => {
    const ws = makeWorkspace({});
    mockTunnelListFetch("https://other.ngrok-free.app", "localhost:7831");

    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await expect(
        realNgrok.runNgrokTunnel({
          port: 7831,
          workspaceDir: ws,
          domain: "foo.ngrok.app",
        }),
      ).rejects.toThrow("exit:1");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const combined = errors.join("\n");
    expect(combined).toContain("https://other.ngrok-free.app");
    expect(combined).toContain(
      "does not match the requested domain 'foo.ngrok.app'",
    );
    expect(combined).toContain("Stop the existing ngrok agent");
    expect(spawnMock).not.toHaveBeenCalled();

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress?: { publicBaseUrl?: string; ngrok?: { domain?: string } } };
    expect(config.ingress?.publicBaseUrl).toBeUndefined();
    expect(config.ingress?.ngrok).toBeUndefined();
  });

  test("runNgrokTunnel adopts an existing tunnel that matches the requested domain", async () => {
    const ws = makeWorkspace({});
    mockTunnelListFetch("https://foo.ngrok.app", "localhost:7831");

    const run = realNgrok.runNgrokTunnel({
      port: 7831,
      workspaceDir: ws,
      domain: "foo.ngrok.app",
    });
    // The adopt path blocks until SIGINT/SIGTERM; pump SIGINT until the
    // listener is registered and the promise settles. Earlier tests leak
    // SIGINT handlers that call process.exit, so no-op it while pumping.
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (() => undefined) as never,
    );
    const pump = setInterval(() => process.emit("SIGINT"), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
      exitSpy.mockRestore();
    }

    expect(spawnMock).not.toHaveBeenCalled();
    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress: { publicBaseUrl?: string; ngrok?: { domain?: string } } };
    expect(config.ingress.publicBaseUrl).toBe("https://foo.ngrok.app");
    expect(config.ingress.ngrok?.domain).toBe("foo.ngrok.app");
  });

  test("maybeStartNgrokTunnel rejects a mismatched existing tunnel without adopting or spawning", async () => {
    const ws = makeWorkspace({
      telegram: { botUsername: "example_bot" },
      ingress: { ngrok: { domain: "foo.ngrok.app" } },
    });
    mockTunnelListFetch("https://other.ngrok-free.app", "localhost:7830");

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(
      (...a: unknown[]) => {
        warnings.push(a.join(" "));
      },
    );

    let child: unknown;
    try {
      child = await realNgrok.maybeStartNgrokTunnel(7830, ws);
    } finally {
      warnSpy.mockRestore();
    }

    expect(child).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
    const combined = warnings.join("\n");
    expect(combined).toContain("https://other.ngrok-free.app");
    expect(combined).toContain(
      "does not match the reserved domain 'foo.ngrok.app'",
    );
    expect(combined).toContain(
      "vellum tunnel --provider ngrok --domain foo.ngrok.app",
    );

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress: { publicBaseUrl?: string; ngrok?: { domain?: string } } };
    // The mismatched tunnel is not blessed in config…
    expect(config.ingress.publicBaseUrl).toBeUndefined();
    // …and the reserved domain stays saved as standing intent.
    expect(config.ingress.ngrok?.domain).toBe("foo.ngrok.app");
  });

  test("maybeStartNgrokTunnel skips when an existing agent tunnels a different port", async () => {
    const ws = makeWorkspace({
      telegram: { botUsername: "example_bot" },
    });
    // A stale pre-upgrade agent still tunnels the raw gateway port; the edge
    // port (18080) has no tunnel.
    mockTunnelListFetch("https://stale.ngrok-free.app", "localhost:7830");

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(
      (...a: unknown[]) => {
        warnings.push(a.join(" "));
      },
    );

    let child: unknown;
    try {
      child = await realNgrok.maybeStartNgrokTunnel(18080, ws);
    } finally {
      warnSpy.mockRestore();
    }

    expect(child).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
    const combined = warnings.join("\n");
    expect(combined).toContain("different local port");
    expect(combined).toContain(
      "https://stale.ngrok-free.app -> localhost:7830",
    );
    expect(combined).toContain("not 18080");
    expect(combined).toContain("vellum tunnel --provider ngrok");

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress?: { publicBaseUrl?: string } };
    expect(config.ingress?.publicBaseUrl).toBeUndefined();
  });

  test("runNgrokTunnel fails loudly when an existing agent tunnels a different port", async () => {
    const ws = makeWorkspace({});
    mockTunnelListFetch("https://stale.ngrok-free.app", "localhost:7830");

    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await expect(
        realNgrok.runNgrokTunnel({ port: 18080, workspaceDir: ws }),
      ).rejects.toThrow("exit:1");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const combined = errors.join("\n");
    expect(combined).toContain("different local port");
    expect(combined).toContain(
      "https://stale.ngrok-free.app -> localhost:7830",
    );
    expect(combined).toContain("not 18080");
    expect(combined).toContain("Stop the existing ngrok agent");
    expect(spawnMock).not.toHaveBeenCalled();

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress?: { publicBaseUrl?: string } };
    expect(config.ingress?.publicBaseUrl).toBeUndefined();
  });

  test("maybeStartNgrokTunnel passes the saved domain to the spawn args", async () => {
    const ws = makeWorkspace({
      telegram: { botUsername: "example_bot" },
      ingress: { ngrok: { domain: "foo.ngrok.app" } },
    });
    mockNgrokApiFetch([
      { tunnels: [] },
      {
        tunnels: [
          unrelatedPortTunnel,
          {
            public_url: "https://foo.ngrok.app",
            config: { addr: "localhost:7830" },
          },
        ],
      },
    ]);

    const child = await realNgrok.maybeStartNgrokTunnel(7830, ws);

    expect(child).not.toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(cmd).toBe("ngrok");
    expect(args).toEqual([
      "http",
      "127.0.0.1:7830",
      "--log=stdout",
      "--domain=foo.ngrok.app",
    ]);

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress: { publicBaseUrl?: string } };
    expect(config.ingress.publicBaseUrl).toBe("https://foo.ngrok.app");
  });

  test("runNgrokTunnel without --domain reuses the saved domain and does not delete it", async () => {
    const ws = makeWorkspace({
      ingress: { ngrok: { domain: "foo.ngrok.app" } },
    });
    mockNgrokApiFetch([
      { tunnels: [] },
      {
        tunnels: [
          {
            public_url: "https://foo.ngrok.app",
            config: { addr: "localhost:7831" },
          },
        ],
      },
    ]);

    const run = realNgrok.runNgrokTunnel({ port: 7831, workspaceDir: ws });
    const pump = setInterval(() => lastChild?.emit("exit", 0), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual([
      "http",
      "127.0.0.1:7831",
      "--log=stdout",
      "--domain=foo.ngrok.app",
    ]);

    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress: { publicBaseUrl?: string; ngrok?: { domain?: string } } };
    expect(config.ingress.publicBaseUrl).toBe("https://foo.ngrok.app");
    expect(config.ingress.ngrok?.domain).toBe("foo.ngrok.app");
  });
});
