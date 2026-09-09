/**
 * Tests for the sandboxed ACP adapter auto-installer.
 *
 * `execFile` is stubbed via the shared `installExecFileStub` helper: a
 * process-global `mock.module("node:child_process", ...)` driven by per-call
 * scripted responses keyed on `${command} ${args[0]}`. `Bun.which` is stubbed
 * via `installWhichStub` so each test controls whether `bun` is on PATH and
 * whether the adapter binary resolves after the install.
 *
 * The security-critical assertions live here: the installer must be `bun`
 * (never `npm`), run in a fresh temp dir (NOT the task cwd), with the ACP
 * secrets stripped from its env and the registry pinned to the public npm
 * registry.
 */

import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { installAcpConfigStub } from "./__tests__/helpers/acp-config-stub.js";
import { installExecFileStub } from "./__tests__/helpers/exec-file-stub.js";
import { installWhichStub } from "./__tests__/helpers/which-stub.js";

const { execScripts, execFileMock, reset } = installExecFileStub();
const config = await installAcpConfigStub();
const which = installWhichStub();

/** Fixed resolved `bun` path so script keys are predictable. */
const BUN_BIN = "/usr/local/bin/bun";
/** Key the exec stub uses for the global install. */
const BUN_ADD_KEY = `${BUN_BIN} add`;

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
  getInstalledAdapterVersion,
  resolveAgentWithAutoInstall,
  _resetAdapterInstallCacheForTests,
  _setAdapterVersionProbeDepsForTests,
} = await import("./auto-install.js");

/** Pinned specs under test, mirroring `DEFAULT_AGENT_NPM_PACKAGES`. */
const CLAUDE_SPEC = "@agentclientprotocol/claude-agent-acp@0.75.1";
const CODEX_SPEC = "@agentclientprotocol/codex-acp@1.10.0";
const GLOBAL_MODULES = "/home/tester/.bun/install/global/node_modules";

/**
 * Point the version probe at an in-memory bun global tree. Keys are package
 * names; values are the `version` their manifest reports.
 */
function stubGlobalTree(versions: Record<string, string>): void {
  _setAdapterVersionProbeDepsForTests({
    globalModulesDir: () => GLOBAL_MODULES,
    readFile: (path: string) => {
      const name = path.slice(
        `${GLOBAL_MODULES}/`.length,
        -"/package.json".length,
      );
      const version = versions[name];
      if (version === undefined) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.resolve(JSON.stringify({ name, version }));
    },
  });
}

/** Latest call's execFile options ({ cwd, env, ... }). */
function lastInstallOptions(): { cwd?: string; env?: NodeJS.ProcessEnv } {
  const call = execFileMock.mock.calls.at(-1)!;
  return call[2] as { cwd?: string; env?: NodeJS.ProcessEnv };
}

beforeEach(() => {
  reset();
  _resetAdapterInstallCacheForTests();
  config.setConfig({ agents: {} });
  // Default: bun on PATH, nothing else.
  which.setWhich({ bun: BUN_BIN });
});

describe("ensureAdapterInstalled", () => {
  test("known command: runs `bun add --global <pkg>` and reports installed", async () => {
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0];
    expect(command).toBe(BUN_BIN);
    expect(args).toEqual(["add", "--global", CLAUDE_SPEC]);
  });

  test("installer never invokes npm", async () => {
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    await ensureAdapterInstalled("claude-agent-acp");

    for (const call of execFileMock.mock.calls) {
      expect(call[0]).not.toBe("npm");
    }
  });

  test("runs in a fresh temp dir (NOT the task cwd), token-free env, public registry", async () => {
    // Seed the secrets on the ambient env so we can assert they are stripped.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "should-not-leak";
    process.env.GEMINI_API_KEY = "should-not-leak-either";
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    try {
      await ensureAdapterInstalled("claude-agent-acp");
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.GEMINI_API_KEY;
    }

    const { cwd, env } = lastInstallOptions();
    // Sandboxed cwd: a temp dir under the OS temp root, never the process cwd.
    expect(cwd).toBeDefined();
    expect(cwd!.startsWith(tmpdir())).toBe(true);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toContain("vellum-acp-install-");

    // Secrets stripped, registry pinned.
    expect(env).toBeDefined();
    expect(env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env!.GEMINI_API_KEY).toBeUndefined();
    expect(env!.BUN_CONFIG_REGISTRY).toBe("https://registry.npmjs.org/");
  });

  test("unknown command: never invokes a package manager (security allowlist)", async () => {
    const result = await ensureAdapterInstalled("some-arbitrary-binary");

    expect(result.installed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("bun absent: no install attempted, reports not installed", async () => {
    which.setWhich({}); // bun not on PATH

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result.installed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("install failure: reports the error and does not install", async () => {
    execScripts.set(BUN_ADD_KEY, {
      error: new Error("EACCES: permission denied"),
    });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result.installed).toBe(false);
    expect(result.error).toContain("EACCES");
  });

  test("failed install is retried on the next call", async () => {
    execScripts.set(BUN_ADD_KEY, { error: new Error("network down") });
    const first = await ensureAdapterInstalled("claude-agent-acp");
    expect(first.installed).toBe(false);

    execScripts.set(BUN_ADD_KEY, { stdout: "" });
    const second = await ensureAdapterInstalled("claude-agent-acp");
    expect(second.installed).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test("successful install is cached for the process lifetime", async () => {
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    await ensureAdapterInstalled("claude-agent-acp");
    await ensureAdapterInstalled("claude-agent-acp");

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls dedupe to exactly one install", async () => {
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

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
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

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
    expect(installedPackages.sort()).toEqual([CLAUDE_SPEC, CODEX_SPEC]);
  });
});

describe("getInstalledAdapterVersion", () => {
  test("reads the version bun wrote into its global module tree", async () => {
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.47.0" });

    expect(await getInstalledAdapterVersion("claude-agent-acp")).toBe("0.47.0");
  });

  test("undefined when the package is absent from the global tree", async () => {
    stubGlobalTree({});

    expect(await getInstalledAdapterVersion("codex-acp")).toBeUndefined();
  });

  test("undefined for a command outside the adapter allowlist", async () => {
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });

    expect(
      await getInstalledAdapterVersion("some-arbitrary-binary"),
    ).toBeUndefined();
  });

  test("undefined when the manifest is not valid JSON", async () => {
    _setAdapterVersionProbeDepsForTests({
      readFile: () => Promise.resolve("not json"),
    });

    expect(await getInstalledAdapterVersion("codex-acp")).toBeUndefined();
  });
});

describe("ensureAdapterInstalled - version pinning", () => {
  test("binary on PATH at the pinned version: no install", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": "/usr/local/bin/claude-agent-acp",
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result).toEqual({ installed: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("binary on PATH at an older version: reinstalls the pinned spec", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": "/usr/local/bin/claude-agent-acp",
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.47.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CLAUDE_SPEC,
    ]);
  });

  test("binary on PATH from another package: reinstalls and takes the name over", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": "/usr/local/bin/codex-acp" });
    // An older `@zed-industries/codex-acp` owns the binary name and leaves
    // nothing under the pinned package's path.
    stubGlobalTree({ "@zed-industries/codex-acp": "0.4.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
  });

  test("binary missing from PATH: installs without consulting the probe", async () => {
    which.setWhich({ bun: BUN_BIN });
    _setAdapterVersionProbeDepsForTests({
      readFile: () => {
        throw new Error("probe must not run when the binary is missing");
      },
    });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAgentWithAutoInstall - resolution order", () => {
  test("binary missing + bun present: installs then resolves to the real binary", async () => {
    let installed = false;
    which.setWhich((cmd) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd === "claude-agent-acp" && installed) {
        return "/usr/local/bin/claude-agent-acp";
      }
      return null;
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installed = true;
      },
    });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    // The resolved command is the REAL binary, not a `bun x` wrapper.
    expect(result.resolved.agent.command).toBe("claude-agent-acp");
    expect(result.autoInstalledPackage).toBe(CLAUDE_SPEC);
    expect(result.failureMessage).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe(BUN_BIN);
  });

  test("missing codex installs the successor package and resolves the same command", async () => {
    let installed = false;
    which.setWhich((cmd) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd === "codex-acp" && installed) {
        return "/usr/local/bin/codex-acp";
      }
      return null;
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installed = true;
      },
    });

    const result = await resolveAgentWithAutoInstall("codex");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    expect(result.resolved.agent.command).toBe("codex-acp");
    expect(result.autoInstalledPackage).toBe(CODEX_SPEC);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
  });

  test("binary missing + bun absent: no install, plain failure with the hint", async () => {
    which.setWhich({}); // neither bun nor the adapter on PATH

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(false);
    expect(result.autoInstalledPackage).toBeUndefined();
    // No augmented failure message (the plain binary_not_found hint is
    // surfaced by the caller via formatResolveFailure).
    expect(result.failureMessage).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("install fails: failure message carries the hint and install error, never npm", async () => {
    which.setWhich({ bun: BUN_BIN });
    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(false);
    expect(result.failureMessage).toContain("claude-agent-acp is not on PATH");
    expect(result.failureMessage).toContain(`bun add -g ${CLAUDE_SPEC}`);
    expect(result.failureMessage).toContain("network is down");
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).not.toBe("npm");
    }
  });

  test("codex unaffected: already on PATH resolves with no install", async () => {
    which.setWhich((cmd) =>
      cmd === "codex-acp" ? "/usr/local/bin/codex-acp" : null,
    );

    const result = await resolveAgentWithAutoInstall("codex");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    expect(result.resolved.agent.command).toBe("codex-acp");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
