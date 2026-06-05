/**
 * Tests for the silent ACP adapter auto-installer.
 *
 * `execFile` is stubbed via the shared `installExecFileStub` helper: a
 * process-global `mock.module("node:child_process", ...)` driven by per-call
 * scripted responses keyed on `${command} ${args[0]}`. The
 * `resolveAgentWithAutoInstall` ordering suite additionally stubs the ACP
 * config and `Bun.which` so it can flip bun / adapter-binary presence.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { installAcpConfigStub } from "./__tests__/helpers/acp-config-stub.js";
import { installExecFileStub } from "./__tests__/helpers/exec-file-stub.js";
import { installWhichStub } from "./__tests__/helpers/which-stub.js";

const { execScripts, execFileMock, reset } = installExecFileStub();
const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

// Spread the real module so other test files that load logger consumers
// (e.g. `truncateForLog` importers) after this process-global mock still
// resolve every named export.
const realLogger = await import("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const {
  ensureAdapterInstalled,
  resolveAgentWithAutoInstall,
  _resetAdapterInstallCacheForTests,
} = await import("./auto-install.js");

beforeEach(() => {
  reset();
  _resetAdapterInstallCacheForTests();
  config.setConfig({ agents: {} });
  which.setWhich({});
});

describe("ensureAdapterInstalled", () => {
  test("known command: runs `npm i -g <pkg>` and reports installed", async () => {
    execScripts.set("npm i", { stdout: "" });

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toEqual([
      "i",
      "-g",
      "@agentclientprotocol/claude-agent-acp",
    ]);
  });

  test("unknown command: never invokes npm (security allowlist)", async () => {
    const result = await ensureAdapterInstalled("some-arbitrary-binary");

    expect(result.installed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("npm failure: reports the error and does not install", async () => {
    execScripts.set("npm i", {
      error: new Error("EACCES: permission denied"),
    });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result.installed).toBe(false);
    expect(result.error).toContain("EACCES");
  });

  test("failed install is retried on the next call", async () => {
    execScripts.set("npm i", { error: new Error("network down") });
    const first = await ensureAdapterInstalled("claude-agent-acp");
    expect(first.installed).toBe(false);

    execScripts.set("npm i", { stdout: "" });
    const second = await ensureAdapterInstalled("claude-agent-acp");
    expect(second.installed).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test("successful install is cached for the process lifetime", async () => {
    execScripts.set("npm i", { stdout: "" });

    await ensureAdapterInstalled("claude-agent-acp");
    await ensureAdapterInstalled("claude-agent-acp");

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls dedupe to exactly one `npm i -g`", async () => {
    execScripts.set("npm i", { stdout: "" });

    const [a, b, c] = await Promise.all([
      ensureAdapterInstalled("claude-agent-acp"),
      ensureAdapterInstalled("claude-agent-acp"),
      ensureAdapterInstalled("claude-agent-acp"),
    ]);

    expect(a.installed).toBe(true);
    expect(b.installed).toBe(true);
    expect(c.installed).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("different commands install independently", async () => {
    execScripts.set("npm i", { stdout: "" });

    const [claude, codex] = await Promise.all([
      ensureAdapterInstalled("claude-agent-acp"),
      ensureAdapterInstalled("codex-acp"),
    ]);

    expect(claude.installed).toBe(true);
    expect(codex.installed).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const installedPackages = execFileMock.mock.calls.map(
      (call) => (call[1] as string[])[2],
    );
    expect(installedPackages.sort()).toEqual([
      "@agentclientprotocol/claude-agent-acp",
      "@zed-industries/codex-acp",
    ]);
  });
});

describe("resolveAgentWithAutoInstall - resolution order", () => {
  test("binary missing + bun present: resolves via bunx without invoking npm", async () => {
    which.setWhich({ bun: "/usr/local/bin/bun" });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) return;
    expect(result.resolved.agent.command).toBe("bun");
    expect(result.resolved.agent.adapterCommand).toBe("claude-agent-acp");
    expect(result.autoInstalledPackage).toBeUndefined();
    expect(result.failureMessage).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("binary + bun missing, npm install succeeds: falls back to the npm flow", async () => {
    let installed = false;
    which.setWhich((cmd) =>
      installed && cmd === "claude-agent-acp"
        ? "/usr/local/bin/claude-agent-acp"
        : null,
    );
    execScripts.set("npm i", {
      stdout: "",
      onCall: () => {
        installed = true;
      },
    });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) return;
    expect(result.resolved.agent.command).toBe("claude-agent-acp");
    expect(result.autoInstalledPackage).toBe(
      "@agentclientprotocol/claude-agent-acp",
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("binary, bun, and npm all missing: failure message carries the hint and install error", async () => {
    execScripts.set("npm i", { error: new Error("spawn npm ENOENT") });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(false);
    expect(result.failureMessage).toContain(
      "claude-agent-acp is not on PATH",
    );
    expect(result.failureMessage).toContain(
      "npm i -g @agentclientprotocol/claude-agent-acp",
    );
    expect(result.failureMessage).toContain("ENOENT");
  });
});
