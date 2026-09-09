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
// resolve every named export. The recorded lines let the tests assert the
// warnings the auto-installer emits instead of only its return values.
const logRecords: { level: string; message: string }[] = [];
const realLogger = await import("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, level) => (fields: unknown, message?: unknown) => {
        logRecords.push({
          level: String(level),
          message: typeof message === "string" ? message : String(fields),
        });
      },
    }),
}));

function warnings(): string[] {
  return logRecords
    .filter((record) => record.level === "warn")
    .map((record) => record.message);
}

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
/** Stand-in for `BUN_INSTALL`: bun's global bin and module tree hang off it. */
const BUN_ROOT = "/home/tester/.bun";
const GLOBAL_MODULES = `${BUN_ROOT}/install/global/node_modules`;
/** Where `bun add --global` links an adapter binary. */
function bunLinked(command: string): string {
  return `${BUN_ROOT}/bin/${command}`;
}

/** A PATH entry that reaches bun's global bin dir through a symlinked dir. */
const BUN_ALIAS_ROOT = "/home/tester/bun-alias";

/** The same bun-linked binary, named through the aliased directory. */
function aliasLinked(command: string): string {
  return `${BUN_ALIAS_ROOT}/bin/${command}`;
}

/** Manifest reads the probe performed since the last reset. */
let manifestReads = 0;

/** An `fs` rejection meaning the path is not there: a real probe verdict. */
function enoent(path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `ENOENT: no such file or directory, ${path}`,
  );
  err.code = "ENOENT";
  return err;
}

/** An `fs` rejection meaning the call did not answer: no verdict at all. */
function emfile(path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `EMFILE: too many open files, ${path}`,
  );
  err.code = "EMFILE";
  return err;
}

/** Package the pin names for each adapter binary. */
const PINNED_PACKAGE: Record<string, string> = {
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
  "codex-acp": "@agentclientprotocol/codex-acp",
};

/** Default link owners: an installed pinned package owns its own bin. */
function ownersFromVersions(
  versions: Record<string, string>,
): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const [command, name] of Object.entries(PINNED_PACKAGE)) {
    if (versions[name] !== undefined) {
      owners[command] = name;
    }
  }
  return owners;
}

/**
 * `fs.realpath` over the fake bun tree: a `<bun>/bin/<name>` link resolves
 * into the package that owns it, every other path resolves to itself. The
 * alias bin dir is a symlink to the real one, so it resolves identically. A
 * binary missing from `owners` has a link that cannot be resolved.
 */
function fakeRealpath(
  owners: Record<string, string>,
): (path: string) => Promise<string> {
  const binPrefix = `${BUN_ROOT}/bin/`;
  const aliasPrefix = `${BUN_ALIAS_ROOT}/bin/`;
  return (rawPath: string) => {
    const path = rawPath.startsWith(aliasPrefix)
      ? `${binPrefix}${rawPath.slice(aliasPrefix.length)}`
      : rawPath;
    if (!path.startsWith(binPrefix)) {
      return Promise.resolve(path);
    }
    const owner = owners[path.slice(binPrefix.length)];
    if (owner === undefined) {
      return Promise.reject(enoent(path));
    }
    return Promise.resolve(`${GLOBAL_MODULES}/${owner}/dist/cli.js`);
  };
}

/** Attempts a pin scope gets, and the pause it earns, per the module. */
const MAX_INSTALL_ATTEMPTS = 3;
const INSTALL_COOLDOWN_MS = 30 * 60_000;

/** Test clock behind the install cooldown. */
let clockMs = 1_000_000;

function advanceClock(ms: number): void {
  clockMs += ms;
}

/**
 * Point the version probe at an in-memory bun global tree. `versions` maps a
 * package name to the `version` its manifest reports; `owners` maps a binary
 * name to the package its `<bun>/bin` link resolves into.
 */
function stubGlobalTree(
  versions: Record<string, string>,
  owners: Record<string, string> = ownersFromVersions(versions),
): void {
  _setAdapterVersionProbeDepsForTests({
    bunInstallDir: () => BUN_ROOT,
    realpath: fakeRealpath(owners),
    now: () => clockMs,
    readFile: (path: string) => {
      manifestReads += 1;
      const name = path.slice(
        `${GLOBAL_MODULES}/`.length,
        -"/package.json".length,
      );
      const version = versions[name];
      if (version === undefined) {
        return Promise.reject(enoent(path));
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
  logRecords.length = 0;
  manifestReads = 0;
  clockMs = 1_000_000;
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

  test("a settled install is not cached: the next call probes again", async () => {
    let installedVersion = "0.47.0";
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    _setAdapterVersionProbeDepsForTests({
      bunInstallDir: () => BUN_ROOT,
      realpath: fakeRealpath({
        "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
      }),
      readFile: () =>
        Promise.resolve(JSON.stringify({ version: installedVersion })),
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installedVersion = "0.75.1";
      },
    });

    await ensureAdapterInstalled("claude-agent-acp");
    // The adapter drifts off the pin again under the running daemon.
    installedVersion = "0.47.0";
    await ensureAdapterInstalled("claude-agent-acp");

    expect(execFileMock).toHaveBeenCalledTimes(2);
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

  test("concurrent calls on different PATHs each get their own decision", async () => {
    const BREW_BIN_DIR = "/opt/homebrew/bin";
    const BUN_BIN_DIR = `${BUN_ROOT}/bin`;
    which.setWhich((cmd, options) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd !== "codex-acp") {
        return null;
      }
      return options?.PATH === BREW_BIN_DIR
        ? `${BREW_BIN_DIR}/codex-acp`
        : bunLinked("codex-acp");
    });
    // Outdated in bun's tree: the bun-managed PATH must reinstall even though
    // the brew PATH resolves first and decides not to.
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "0.4.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const [external, bunManaged] = await Promise.all([
      ensureAdapterInstalled("codex-acp", BREW_BIN_DIR),
      ensureAdapterInstalled("codex-acp", BUN_BIN_DIR),
    ]);

    expect(external).toEqual({ installed: false });
    expect(bunManaged).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
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
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result).toEqual({ installed: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("binary on PATH at an older version: reinstalls the pinned spec", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
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
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
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

  test("binary PATH selects from outside bun: no install, pin not enforced", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "codex-acp": "/opt/homebrew/bin/codex-acp",
    });
    // The pinned package IS present in bun's tree at the pinned version, but
    // PATH selects the brew binary, so the manifest describes nothing that
    // will spawn and a reinstall would not change which binary wins.
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "1.10.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: false });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(manifestReads).toBe(0);
    expect(warnings().join(" ")).toContain("managed outside bun");
  });

  test("stale bun manifest never overrides the binary PATH selects", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": "/usr/local/bin/claude-agent-acp",
    });
    // Pinned version in bun's tree, older binary earlier on PATH: the probe
    // must not report the pin as satisfied for a binary it does not describe.
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });

    const result = await ensureAdapterInstalled("claude-agent-acp");

    expect(result).toEqual({ installed: false });
    expect(manifestReads).toBe(0);
    expect(warnings().join(" ")).toContain("managed outside bun");
  });

  test("bun link owned by the pinned package at the pinned version: no install", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    stubGlobalTree(
      { "@agentclientprotocol/codex-acp": "1.10.0" },
      { "codex-acp": "@agentclientprotocol/codex-acp" },
    );

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("bun link owned by another package: reinstalls even when the pinned manifest matches", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    // Both packages are installed and both keep a manifest, but the link
    // resolves into the other one, so the pinned manifest describes an
    // executable no spawn would run.
    stubGlobalTree(
      {
        "@agentclientprotocol/codex-acp": "1.10.0",
        "@zed-industries/codex-acp": "0.4.0",
      },
      { "codex-acp": "@zed-industries/codex-acp" },
    );
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
  });

  test("bun link that cannot be resolved: reinstalls the pin", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "1.10.0" }, {});
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
  });

  test("bun bin dir reached through a symlinked dir: still bun-managed", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": aliasLinked("codex-acp") });
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "0.4.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
    expect(warnings().join(" ")).not.toContain("managed outside bun");
  });

  test("aliased bun bin dir at the pinned version: no install", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": aliasLinked("codex-acp") });
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "1.10.0" });

    const result = await ensureAdapterInstalled("codex-acp");

    expect(result).toEqual({ installed: false });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(warnings().join(" ")).not.toContain("managed outside bun");
  });

  test("an install that leaves the pin unsatisfied is never retried", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    // `bun add` will exit 0 without moving the tree off 0.4.0, so no number of
    // reinstalls can satisfy the pin.
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "0.4.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const first = await ensureAdapterInstalled("codex-acp");
    const second = await ensureAdapterInstalled("codex-acp");
    const third = await ensureAdapterInstalled("codex-acp");

    expect(first).toEqual({ installed: true });
    expect(second).toEqual({ installed: false });
    expect(third).toEqual({ installed: false });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(
      warnings().filter((message) =>
        message.includes("does not select the pinned version"),
      ),
    ).toHaveLength(1);
  });

  test("two PATHs into the same bun tree run a single install", async () => {
    const BUN_BIN_DIR = `${BUN_ROOT}/bin`;
    const ALIAS_BIN_DIR = `${BUN_ALIAS_ROOT}/bin`;
    which.setWhich((cmd, options) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd !== "codex-acp") {
        return null;
      }
      return options?.PATH === ALIAS_BIN_DIR
        ? aliasLinked("codex-acp")
        : bunLinked("codex-acp");
    });
    stubGlobalTree({ "@agentclientprotocol/codex-acp": "0.4.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const [direct, aliased] = await Promise.all([
      ensureAdapterInstalled("codex-acp", BUN_BIN_DIR),
      ensureAdapterInstalled("codex-acp", ALIAS_BIN_DIR),
    ]);

    // Both probes want the pin, and both are served by one `bun add --global`.
    expect(direct).toEqual({ installed: true });
    expect(aliased).toEqual({ installed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
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

describe("ensureAdapterInstalled - bounded retries", () => {
  test("repeated install failures pause the pin instead of retrying forever", async () => {
    _setAdapterVersionProbeDepsForTests({ now: () => clockMs });
    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });

    for (let call = 0; call < MAX_INSTALL_ATTEMPTS; call += 1) {
      const result = await ensureAdapterInstalled("codex-acp");
      expect(result.installed).toBe(false);
      expect(result.error).toContain("network is down");
    }
    // Paused: the install is skipped outright, so there is no error to report.
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: false,
    });
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: false,
    });

    expect(execFileMock).toHaveBeenCalledTimes(MAX_INSTALL_ATTEMPTS);
    expect(
      warnings().filter((message) => message.includes("cooldown window")),
    ).toHaveLength(1);
  });

  test("the cooldown expires and the install is attempted again", async () => {
    _setAdapterVersionProbeDepsForTests({ now: () => clockMs });
    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });
    for (let call = 0; call < MAX_INSTALL_ATTEMPTS + 1; call += 1) {
      await ensureAdapterInstalled("codex-acp");
    }
    expect(execFileMock).toHaveBeenCalledTimes(MAX_INSTALL_ATTEMPTS);

    advanceClock(INSTALL_COOLDOWN_MS + 1);
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: true,
    });
    expect(execFileMock).toHaveBeenCalledTimes(MAX_INSTALL_ATTEMPTS + 1);
  });

  test("a verified install clears the attempt budget", async () => {
    let installedVersion = "0.4.0";
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    _setAdapterVersionProbeDepsForTests({
      bunInstallDir: () => BUN_ROOT,
      realpath: fakeRealpath({ "codex-acp": "@agentclientprotocol/codex-acp" }),
      readFile: () =>
        Promise.resolve(JSON.stringify({ version: installedVersion })),
      now: () => clockMs,
    });

    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });
    await ensureAdapterInstalled("codex-acp");
    await ensureAdapterInstalled("codex-acp");
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installedVersion = "1.10.0";
      },
    });
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: true,
    });

    // Off the pin again, offline again: a spent budget would have paused the
    // pin on the very first of these, so both still reach `bun add`.
    installedVersion = "0.4.0";
    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });
    await ensureAdapterInstalled("codex-acp");
    await ensureAdapterInstalled("codex-acp");

    expect(execFileMock).toHaveBeenCalledTimes(5);
  });

  test("a give-up on one PATH leaves another PATH still pinned", async () => {
    const AGENT_PATH = "/opt/agent/bin";
    const BUN_BIN_DIR = `${BUN_ROOT}/bin`;
    let installedVersion = "0.4.0";
    which.setWhich((cmd, options) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd !== "codex-acp") {
        return null;
      }
      // The agent's PATH cannot reach bun's global bin dir, so no install
      // ever shows up there; the daemon's PATH sees every one of them.
      return options?.PATH === AGENT_PATH ? null : bunLinked("codex-acp");
    });
    _setAdapterVersionProbeDepsForTests({
      bunInstallDir: () => BUN_ROOT,
      realpath: fakeRealpath({ "codex-acp": "@agentclientprotocol/codex-acp" }),
      readFile: () =>
        Promise.resolve(JSON.stringify({ version: installedVersion })),
      now: () => clockMs,
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installedVersion = "1.10.0";
      },
    });

    // The agent's PATH can never verify the pin, so it gives up after one
    // install.
    expect(await ensureAdapterInstalled("codex-acp", AGENT_PATH)).toEqual({
      installed: true,
    });
    expect(await ensureAdapterInstalled("codex-acp", AGENT_PATH)).toEqual({
      installed: false,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // A PATH that CAN see the install is still pinned when it drifts.
    installedVersion = "0.4.0";
    expect(await ensureAdapterInstalled("codex-acp", BUN_BIN_DIR)).toEqual({
      installed: true,
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("ensureAdapterInstalled - unreadable probes", () => {
  /**
   * A bun-linked adapter behind a `realpath` the test can make fail. The
   * binary is named through the alias dir so the probe has to resolve it
   * rather than matching the link path lexically.
   */
  function stubFlakyTree(state: {
    version: string;
    realpathFails: boolean;
  }): void {
    which.setWhich({ bun: BUN_BIN, "codex-acp": aliasLinked("codex-acp") });
    const resolveOwner = fakeRealpath({
      "codex-acp": "@agentclientprotocol/codex-acp",
    });
    _setAdapterVersionProbeDepsForTests({
      bunInstallDir: () => BUN_ROOT,
      realpath: (path: string) =>
        state.realpathFails ? Promise.reject(emfile(path)) : resolveOwner(path),
      readFile: () =>
        Promise.resolve(JSON.stringify({ version: state.version })),
      now: () => clockMs,
    });
  }

  test("a probe the filesystem refuses skips the install and re-probes", async () => {
    const state = { version: "0.4.0", realpathFails: true };
    stubFlakyTree(state);
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        state.version = "1.10.0";
      },
    });

    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: false,
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(warnings().join(" ")).toContain(
      "Could not read the installed ACP adapter",
    );

    state.realpathFails = false;
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: true,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("an unverifiable post-install probe does not abandon the pin", async () => {
    const state = { version: "0.4.0", realpathFails: false };
    stubFlakyTree(state);
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        // The install lands, but the verification cannot read the tree.
        state.version = "1.10.0";
        state.realpathFails = true;
      },
    });

    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: true,
    });
    expect(
      warnings().filter((message) =>
        message.includes("does not select the pinned version"),
      ),
    ).toEqual([]);

    // Once the filesystem answers again, the pin reads as satisfied.
    state.realpathFails = false;
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: false,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("unreadable probes spend the same budget and pause the pin", async () => {
    const state = { version: "0.4.0", realpathFails: true };
    stubFlakyTree(state);
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        state.version = "1.10.0";
      },
    });

    for (let call = 0; call < MAX_INSTALL_ATTEMPTS; call += 1) {
      await ensureAdapterInstalled("codex-acp");
    }

    // The filesystem recovers with the tree still off the pin, but the scope
    // is paused, so nothing installs until the cooldown elapses.
    state.realpathFails = false;
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: false,
    });
    expect(execFileMock).not.toHaveBeenCalled();

    advanceClock(INSTALL_COOLDOWN_MS + 1);
    expect(await ensureAdapterInstalled("codex-acp")).toEqual({
      installed: true,
    });
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

  test("recovery probes the agent's own PATH, not the daemon's", async () => {
    const AGENT_PATH = "/opt/agent/bin";
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { PATH: AGENT_PATH },
        },
      },
    });
    let installed = false;
    which.setWhich((cmd, options) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd !== "claude-agent-acp") {
        return null;
      }
      // The daemon's PATH already reaches a pinned adapter; the agent's does
      // not, which is the failure the resolver reported.
      if (options?.PATH !== AGENT_PATH) {
        return bunLinked("claude-agent-acp");
      }
      return installed ? `${AGENT_PATH}/claude-agent-acp` : null;
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installed = true;
      },
    });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    expect(result.autoInstalledPackage).toBe(CLAUDE_SPEC);
    expect(execFileMock).toHaveBeenCalledTimes(1);
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

describe("resolveAgentWithAutoInstall - pin enforcement on a resolved binary", () => {
  test("bun-managed adapter at the pinned version: resolves with no install", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    expect(result.resolved.agent.command).toBe("claude-agent-acp");
    expect(result.failureMessage).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("bun-managed adapter at an older version: reinstalls the pin and returns the re-resolved agent", async () => {
    let installedVersion = "0.47.0";
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    _setAdapterVersionProbeDepsForTests({
      bunInstallDir: () => BUN_ROOT,
      realpath: fakeRealpath({
        "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
      }),
      readFile: () =>
        Promise.resolve(JSON.stringify({ version: installedVersion })),
    });
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        installedVersion = "0.75.1";
      },
    });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    expect(result.resolved.agent.command).toBe("claude-agent-acp");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CLAUDE_SPEC,
    ]);
    expect(installedVersion).toBe("0.75.1");
  });

  test("bun-managed adapter with an unreadable manifest: reinstalls the pin", async () => {
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    // The link resolves into the pinned package, but nothing is installed
    // under its path, so the manifest read finds no version to trust.
    stubGlobalTree(
      { "@zed-industries/codex-acp": "0.4.0" },
      { "codex-acp": "@agentclientprotocol/codex-acp" },
    );
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const result = await resolveAgentWithAutoInstall("codex");

    expect(result.resolved.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
  });

  test("adapter managed outside bun: warns once, never installs, resolves as-is", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": "/usr/local/bin/claude-agent-acp",
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.47.0" });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const first = await resolveAgentWithAutoInstall("claude");
    const second = await resolveAgentWithAutoInstall("claude");

    expect(first.resolved.ok).toBe(true);
    if (!first.resolved.ok) {
      return;
    }
    expect(first.resolved.agent.command).toBe("claude-agent-acp");
    expect(second.resolved.ok).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(
      warnings().filter((message) => message.includes("managed outside bun")),
    ).toHaveLength(1);
  });

  test("a no-install decision is not cached: the pin is re-checked per spawn", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.75.1" });

    await resolveAgentWithAutoInstall("claude");
    await resolveAgentWithAutoInstall("claude");

    expect(manifestReads).toBe(2);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("an adapter replaced under a running daemon is caught on the next spawn", async () => {
    let installedVersion = "1.10.0";
    which.setWhich({ bun: BUN_BIN, "codex-acp": bunLinked("codex-acp") });
    _setAdapterVersionProbeDepsForTests({
      bunInstallDir: () => BUN_ROOT,
      realpath: fakeRealpath({
        "codex-acp": "@agentclientprotocol/codex-acp",
      }),
      readFile: () => {
        manifestReads += 1;
        return Promise.resolve(JSON.stringify({ version: installedVersion }));
      },
    });
    execScripts.set(BUN_ADD_KEY, { stdout: "" });

    const first = await resolveAgentWithAutoInstall("codex");

    expect(first.resolved.ok).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();

    // `bun add -g ...@latest` outside the daemon replaces the executable.
    installedVersion = "1.11.0";
    const second = await resolveAgentWithAutoInstall("codex");

    expect(second.resolved.ok).toBe(true);
    // One probe per spawn, plus the second spawn's post-install verification.
    expect(manifestReads).toBe(3);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "add",
      "--global",
      CODEX_SPEC,
    ]);
  });

  test("reinstall fails: keeps the resolved adapter and surfaces no failure message", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.47.0" });
    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    expect(result.resolved.agent.command).toBe("claude-agent-acp");
    expect(result.failureMessage).toBeUndefined();
    expect(warnings().join(" ")).toContain(
      "Could not reinstall the ACP adapter",
    );
  });

  test("post-install resolution failure keeps the agent resolved before it", async () => {
    let onPath = true;
    which.setWhich((cmd) => {
      if (cmd === "bun") {
        return BUN_BIN;
      }
      if (cmd === "claude-agent-acp" && onPath) {
        return bunLinked("claude-agent-acp");
      }
      return null;
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.47.0" });
    // The reinstall unlinks the bin instead of repointing it, so the
    // re-resolve fails on an agent the caller already had in hand.
    execScripts.set(BUN_ADD_KEY, {
      stdout: "",
      onCall: () => {
        onPath = false;
      },
    });

    const result = await resolveAgentWithAutoInstall("claude");

    expect(result.resolved.ok).toBe(true);
    if (!result.resolved.ok) {
      return;
    }
    expect(result.resolved.agent.command).toBe("claude-agent-acp");
    expect(result.autoInstalledPackage).toBeUndefined();
    expect(result.failureMessage).toBeUndefined();
    expect(warnings().join(" ")).toContain("no longer resolves");
  });

  test("a reinstall that keeps failing warns once, not once per spawn", async () => {
    which.setWhich({
      bun: BUN_BIN,
      "claude-agent-acp": bunLinked("claude-agent-acp"),
    });
    stubGlobalTree({ "@agentclientprotocol/claude-agent-acp": "0.47.0" });
    execScripts.set(BUN_ADD_KEY, { error: new Error("network is down") });

    await resolveAgentWithAutoInstall("claude");
    await resolveAgentWithAutoInstall("claude");

    expect(
      warnings().filter((message) =>
        message.includes("Could not reinstall the ACP adapter"),
      ),
    ).toHaveLength(1);
  });

  test("agent whose command maps to no package: never touches the installer", async () => {
    config.setConfig({
      agents: { custom: { command: "some-other-binary", args: [] } },
    });
    which.setWhich({
      bun: BUN_BIN,
      "some-other-binary": "/usr/local/bin/some-other-binary",
    });

    const result = await resolveAgentWithAutoInstall("custom");

    expect(result.resolved.ok).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });
});
