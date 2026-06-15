import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as cloudflareTunnel from "../lib/cloudflare-tunnel.js";
import * as ngrok from "../lib/ngrok.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

const realCloudflareTunnel = { ...cloudflareTunnel };
const realNgrok = { ...ngrok };

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

const { tunnel } = await import("../commands/tunnel.js");

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const tempDirs: string[] = [];

function makeLocalEntry(): AssistantEntry {
  const instanceDir = mkdtempSync(join(tmpdir(), "vellum-tunnel-test-"));
  tempDirs.push(instanceDir);
  return {
    assistantId: "assistant-1",
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

function writeLockfile(entry: AssistantEntry): void {
  const lockfileDir = mkdtempSync(join(tmpdir(), "vellum-tunnel-lockfile-"));
  tempDirs.push(lockfileDir);
  process.env.VELLUM_LOCKFILE_DIR = lockfileDir;
  mkdirSync(lockfileDir, { recursive: true });
  writeFileSync(
    join(lockfileDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        activeAssistant: entry.assistantId,
        assistants: [entry],
      },
      null,
      2,
    ),
  );
}

describe("tunnel nginx ingress feature flag", () => {
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
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    mock.module("../lib/cloudflare-tunnel.js", () => realCloudflareTunnel);
    mock.module("../lib/ngrok", () => realNgrok);
  });

  test("does not start ngrok when the flag lookup fails", async () => {
    process.argv = ["bun", "vellum", "tunnel", "--provider", "ngrok"];

    await expect(tunnel()).rejects.toThrow(
      "Could not verify the `web-remote-ingress` feature flag",
    );

    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("does not start cloudflared when the flag lookup fails", async () => {
    process.argv = ["bun", "vellum", "tunnel", "--provider", "cloudflare"];

    await expect(tunnel()).rejects.toThrow(
      "Could not verify the `web-remote-ingress` feature flag",
    );

    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });
});
