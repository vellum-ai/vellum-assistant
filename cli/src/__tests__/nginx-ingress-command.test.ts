import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as nginxIngressLib from "../lib/nginx-ingress.js";

const realNginxIngressLib = { ...nginxIngressLib };

const ensureTunnelEdgeMock = mock<typeof nginxIngressLib.ensureTunnelEdge>(
  async () => ({ port: 7840, started: true, includesWebApp: true }),
);

mock.module("../lib/nginx-ingress.js", () => ({
  ...nginxIngressLib,
  ensureTunnelEdge: ensureTunnelEdgeMock,
}));

// Restore the real module once this file finishes so the mock does not leak
// into sibling test files in the same `bun test` run.
afterAll(() => {
  mock.module("../lib/nginx-ingress.js", () => realNginxIngressLib);
});

import { resolveNginxIngressTarget, up } from "../commands/nginx-ingress.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-nginx-ingress-command-test-"));
const workspaceDir = join(testDir, "workspace");
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

function writeLockfile(
  entries: AssistantEntry[],
  activeAssistant?: string,
): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: entries,
        ...(activeAssistant ? { activeAssistant } : {}),
      },
      null,
      2,
    ),
  );
}

afterAll(() => {
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
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveNginxIngressTarget", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
  });

  test("derives the gateway port from runtimeUrl when resources are absent", () => {
    writeLockfile([
      {
        assistantId: "docker-assistant",
        name: "Docker Assistant",
        runtimeUrl: "http://localhost:9123",
        cloud: "docker",
      },
    ]);

    expect(resolveNginxIngressTarget("Docker Assistant")).toEqual({
      assistantId: "docker-assistant",
      workspaceDir,
      gatewayPort: 9123,
    });
  });
});

describe("up", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof spyOn<typeof console, "log">>;

  beforeEach(() => {
    ensureTunnelEdgeMock.mockClear();
    logs = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("starts the webhooks-only edge when the flag is off and states the mode", async () => {
    ensureTunnelEdgeMock.mockResolvedValue({
      port: 7845,
      started: true,
      includesWebApp: false,
    });

    await up({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });

    expect(ensureTunnelEdgeMock).toHaveBeenCalledTimes(1);
    expect(ensureTunnelEdgeMock.mock.calls[0]?.[0]).toMatchObject({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });
    const output = logs.join("\n");
    expect(output).toContain("http://127.0.0.1:7845 (webhooks only)");
    expect(output).toContain("web-remote-ingress");
    expect(output).toContain("vellum tunnel");
  });

  test("states the remote web mode when the flag is on", async () => {
    ensureTunnelEdgeMock.mockResolvedValue({
      port: 7840,
      started: true,
      includesWebApp: true,
    });

    await up({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });

    const output = logs.join("\n");
    expect(output).toContain("http://127.0.0.1:7840 (remote web + webhooks)");
    expect(output).not.toContain("Enable the web-remote-ingress feature flag");
  });
});
