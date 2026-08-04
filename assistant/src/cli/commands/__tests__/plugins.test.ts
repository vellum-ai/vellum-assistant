/**
 * Tests for the `assistant plugins` CLI command's declared-schedules consent
 * and surfacing.
 *
 * Validates:
 *   - install lists a staged plugin's declared schedules (name, cadence, mode)
 *     and prompts for consent before the install finalizes
 *   - declining cancels the install cleanly (exit 0, nothing installed)
 *   - a non-interactive refusal exits 1
 *   - --force skips the prompt but still lists the schedules
 *   - a plugin without schedules installs with zero consent UX
 *   - the direct-GitHub and bundled-catalog install branches are gated too,
 *     with the untrusted warning printed before the schedule listing
 *   - inspect renders the schedules surface block
 *
 * The installers are replaced by fakes that stage a fixture tree and run the
 * real `confirmStagedOrAbort` gate, so the command's consent callback is
 * exercised against a real on-disk staged tree via the real
 * `detectPluginSurfaces` walk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import type { ConfirmPromptOptions } from "../../lib/confirm-prompt.js";
import type { PluginInspection } from "../../lib/inspect-plugin.js";
import type {
  InstallPluginDeps,
  InstallPluginOptions,
  InstallPluginResult,
} from "../../lib/install-from-github.js";
import type {
  PluginUpgradeResult,
  UpgradePluginDeps,
  UpgradePluginOptions,
} from "../../lib/upgrade-plugin.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let confirmCalls: Array<{
  question: string;
  refuseNonInteractiveMessage: string;
}> = [];
let confirmResults: Array<"confirmed" | "denied" | "non-interactive"> = [];

/** Written into each fake install's staging dir before the consent gate runs. */
let stageFixture: ((stagingDir: string) => void) | null = null;

let installPluginCalls: InstallPluginOptions[] = [];
let platformInstallCalls: Array<{ name: string; force?: boolean }> = [];
let upgradePluginCalls: UpgradePluginOptions[] = [];

/**
 * Queued daemon IPC responses. The default (empty queue) is a transport
 * failure (`ok: false`, no `statusCode`), which routes upgrade to the local
 * lib fallback where the consent gate lives.
 */
let ipcResults: Array<{
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
}> = [];

let inspectResult: PluginInspection | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../lib/confirm-prompt.js", () => ({
  confirmPrompt: async (opts: ConfirmPromptOptions) => {
    confirmCalls.push({
      question: opts.question,
      refuseNonInteractiveMessage: opts.refuseNonInteractiveMessage,
    });
    return confirmResults.shift() ?? "confirmed";
  },
}));

const realGithub = await import("../../lib/install-from-github.js");
const realPlatform = await import("../../lib/install-from-platform.js");
const realInspect = await import("../../lib/inspect-plugin.js");

/**
 * Stage the fixture tree and run the real staged-install consent gate, so a
 * decline aborts exactly like production. Shared by the fake install and
 * fake upgrade.
 */
async function stageAndConfirm(
  name: string,
  confirmStaged: InstallPluginDeps["confirmStaged"],
): Promise<void> {
  const stagingDir = mkdtempSync(join(tmpdir(), "plugins-cmd-staging-"));
  try {
    stageFixture?.(stagingDir);
    await realGithub.confirmStagedOrAbort(name, stagingDir, confirmStaged);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Fake install: run the consent gate, then return a canned success result. */
async function runFakeInstall(
  name: string,
  deps: Pick<InstallPluginDeps, "confirmStaged"> | undefined,
): Promise<InstallPluginResult> {
  await stageAndConfirm(name, deps?.confirmStaged);
  return {
    name,
    target: `/plugins/${name}`,
    fileCount: 3,
    ref: "main",
    commit: "a".repeat(40),
    committedAt: null,
  };
}

mock.module("../../lib/install-from-github.js", () => ({
  ...realGithub,
  installPlugin: async (
    opts: InstallPluginOptions,
    deps: InstallPluginDeps,
  ) => {
    installPluginCalls.push(opts);
    return runFakeInstall(opts.name, deps);
  },
}));

mock.module("../../lib/install-from-platform.js", () => ({
  ...realPlatform,
  installPluginViaPlatform: async (
    opts: { name: string; force?: boolean },
    deps: Pick<InstallPluginDeps, "confirmStaged">,
  ) => {
    platformInstallCalls.push(opts);
    return runFakeInstall(opts.name, deps);
  },
}));

mock.module("../../lib/inspect-plugin.js", () => ({
  ...realInspect,
  inspectPlugin: async () => {
    if (!inspectResult) {
      throw new Error("inspectResult fixture not set");
    }
    return inspectResult;
  },
}));

const realUpgrade = await import("../../lib/upgrade-plugin.js");
const realCliClient = await import("../../../ipc/cli-client.js");

/** Fake upgrade: run the consent gate, then return a canned upgraded result. */
mock.module("../../lib/upgrade-plugin.js", () => ({
  ...realUpgrade,
  upgradePlugin: async (
    opts: UpgradePluginOptions,
    deps: UpgradePluginDeps,
  ): Promise<PluginUpgradeResult> => {
    upgradePluginCalls.push(opts);
    await stageAndConfirm(opts.name, deps.confirmStaged);
    return upgradedResult(opts.name);
  },
}));

mock.module("../../../ipc/cli-client.js", () => ({
  ...realCliClient,
  cliIpcCall: async () =>
    ipcResults.shift() ?? { ok: false, error: "daemon unreachable" },
}));

function upgradedResult(name: string): PluginUpgradeResult {
  return {
    name,
    outcome: "upgraded",
    fromCommit: "a".repeat(40),
    fromTimestamp: null,
    toCommit: "b".repeat(40),
    toTimestamp: null,
    target: `/plugins/${name}`,
    fileCount: 3,
    dryRun: false,
    strategy: "overwrite",
    conflicts: [],
    binaryConflicts: [],
    provenanceWasUnknown: false,
  };
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerPluginsCommand } = await import("../plugins.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Write a two-schedule fixture (one flat execute, one directory script). */
function writeScheduleFixture(dir: string): void {
  mkdirSync(join(dir, "schedules", "cleanup"), { recursive: true });
  writeFileSync(
    join(dir, "schedules", "daily-report.md"),
    '---\nexpression: "0 9 * * *"\n---\nSend the daily report.\n',
  );
  writeFileSync(
    join(dir, "schedules", "cleanup", "config.json"),
    '{"expression": "0 0 * * 0"}',
  );
  writeFileSync(join(dir, "schedules", "cleanup", "index.sh"), "#!/bin/sh\n");
}

async function runCommand(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  /** stdout + stderr lines in emission order, for cross-stream ordering. */
  events: string[];
  exitCode: number;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const events: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    stdoutChunks.push(text);
    events.push(text);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...logArgs: unknown[]) => {
    const text = logArgs.map(String).join(" ") + "\n";
    stdoutChunks.push(text);
    events.push(text);
  };
  console.error = (...logArgs: unknown[]) => {
    const text = logArgs.map(String).join(" ") + "\n";
    stderrChunks.push(text);
    events.push(text);
  };

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerPluginsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) {
      process.exitCode = 1;
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    events,
    exitCode,
  };
}

const savedDisablePlatform = process.env.VELLUM_DISABLE_PLATFORM;
const savedIsPlatform = process.env.IS_PLATFORM;

beforeEach(() => {
  confirmCalls = [];
  confirmResults = [];
  stageFixture = null;
  installPluginCalls = [];
  platformInstallCalls = [];
  upgradePluginCalls = [];
  ipcResults = [];
  inspectResult = null;
  // Platform features on by default, so a plain name install takes the
  // platform-tarball branch.
  delete process.env.VELLUM_DISABLE_PLATFORM;
  delete process.env.IS_PLATFORM;
});

afterEach(() => {
  if (savedDisablePlatform === undefined) {
    delete process.env.VELLUM_DISABLE_PLATFORM;
  } else {
    process.env.VELLUM_DISABLE_PLATFORM = savedDisablePlatform;
  }
  if (savedIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = savedIsPlatform;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugins install - declared-schedules consent", () => {
  test("lists declared schedules and prompts before finalizing", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["confirmed"];

    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).toContain('Plugin "example" declares 2 schedules:');
    expect(r.stdout).toContain("daily-report");
    expect(r.stdout).toContain("0 9 * * *");
    expect(r.stdout).toContain("(execute)");
    expect(r.stdout).toContain("cleanup");
    expect(r.stdout).toContain("0 0 * * 0");
    expect(r.stdout).toContain("(script)");

    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]!.question).toContain(
      'Install "example" and allow these schedules?',
    );

    // The listing precedes the install result, since consent gates finalize.
    expect(r.stdout.indexOf("declares 2 schedules")).toBeLessThan(
      r.stdout.indexOf('Installed plugin "example"'),
    );
    expect(r.exitCode).toBe(0);
    expect(platformInstallCalls.length).toBe(1);
  });

  test("declining cancels the install cleanly", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["denied"];

    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).toContain("Install cancelled.");
    expect(r.stdout).not.toContain("Installed plugin");
    expect(r.stderr).not.toContain("Plugin install failed");
    expect(r.exitCode).toBe(0);
  });

  test("a non-interactive refusal exits 1", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["non-interactive"];

    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).not.toContain("Installed plugin");
    expect(r.exitCode).toBe(1);
  });

  test("--force skips the prompt but still lists the schedules", async () => {
    stageFixture = writeScheduleFixture;

    const r = await runCommand(["plugins", "install", "example", "--force"]);

    expect(confirmCalls.length).toBe(0);
    expect(r.stdout).toContain('Plugin "example" declares 2 schedules:');
    expect(r.stdout).toContain('Installed plugin "example"');
    expect(r.exitCode).toBe(0);
  });

  test("a plugin without schedules installs with zero consent UX", async () => {
    stageFixture = null;

    const r = await runCommand(["plugins", "install", "example"]);

    expect(confirmCalls.length).toBe(0);
    expect(r.stdout).not.toContain("declares");
    expect(r.stdout).not.toContain("schedule");
    expect(r.stdout).toContain('Installed plugin "example"');
    expect(r.exitCode).toBe(0);
  });

  test("a direct GitHub install is gated too, after the untrusted warning", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["confirmed"];

    const r = await runCommand([
      "plugins",
      "install",
      "https://github.com/example-owner/example-repo",
    ]);

    expect(installPluginCalls.length).toBe(1);
    expect(installPluginCalls[0]!.directSource).toBeDefined();
    expect(confirmCalls.length).toBe(1);
    expect(r.stderr).toContain("unreviewed GitHub source");

    // The untrusted warning prints before the schedule listing.
    const warningIdx = r.events.findIndex((e) =>
      e.includes("unreviewed GitHub source"),
    );
    const listingIdx = r.events.findIndex((e) => e.includes("declares"));
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(listingIdx).toBeGreaterThan(warningIdx);

    expect(r.stdout).toContain('Installed untrusted plugin "example-repo"');
    expect(r.exitCode).toBe(0);
  });

  test("a bundled-catalog install (platform disabled) is gated too", async () => {
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    stageFixture = writeScheduleFixture;
    confirmResults = ["confirmed"];

    const r = await runCommand(["plugins", "install", "caveman"]);

    expect(platformInstallCalls.length).toBe(0);
    expect(installPluginCalls.length).toBe(1);
    expect(installPluginCalls[0]!.trustedSource).toBeDefined();
    expect(confirmCalls.length).toBe(1);
    expect(r.stdout).toContain('Plugin "caveman" declares 2 schedules:');
    expect(r.exitCode).toBe(0);
  });
});

describe("plugins upgrade - declared-schedules consent (local fallback)", () => {
  test("lists declared schedules and prompts before finalizing", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["confirmed"];

    const r = await runCommand(["plugins", "upgrade", "example"]);

    expect(upgradePluginCalls.length).toBe(1);
    expect(r.stdout).toContain('Plugin "example" declares 2 schedules:');
    expect(r.stdout).toContain("daily-report");
    expect(r.stdout).toContain("cleanup");
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]!.question).toContain(
      'Upgrade "example" and allow these schedules?',
    );
    expect(r.stdout).toContain('Upgraded "example"');
    expect(r.exitCode).toBe(0);
  });

  test("declining cancels the upgrade cleanly", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["denied"];

    const r = await runCommand(["plugins", "upgrade", "example"]);

    expect(r.stdout).toContain("Upgrade cancelled.");
    expect(r.stdout).not.toContain('Upgraded "example"');
    expect(r.stderr).not.toContain("Plugin upgrade failed");
    expect(r.exitCode).toBe(0);
  });

  test("a non-interactive refusal exits 1", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["non-interactive"];

    const r = await runCommand(["plugins", "upgrade", "example"]);

    expect(r.stdout).not.toContain('Upgraded "example"');
    expect(r.exitCode).toBe(1);
  });

  test("--force skips the prompt but still lists the schedules", async () => {
    stageFixture = writeScheduleFixture;

    const r = await runCommand(["plugins", "upgrade", "example", "--force"]);

    expect(confirmCalls.length).toBe(0);
    expect(r.stdout).toContain('Plugin "example" declares 2 schedules:');
    expect(r.stdout).toContain('Upgraded "example"');
    expect(r.exitCode).toBe(0);
  });

  test("an upgrade without declared schedules has zero consent UX", async () => {
    stageFixture = null;

    const r = await runCommand(["plugins", "upgrade", "example"]);

    expect(confirmCalls.length).toBe(0);
    expect(r.stdout).toContain('Upgraded "example"');
    expect(r.exitCode).toBe(0);
  });

  test("a daemon-routed upgrade never reaches the local gate", async () => {
    // The daemon route is unattended by design; the reconciler's
    // schedule.declared notification is its consent surface.
    stageFixture = writeScheduleFixture;
    ipcResults = [{ ok: true, result: upgradedResult("example") }];

    const r = await runCommand(["plugins", "upgrade", "example"]);

    expect(upgradePluginCalls.length).toBe(0);
    expect(confirmCalls.length).toBe(0);
    expect(r.stdout).toContain('Upgraded "example"');
    expect(r.exitCode).toBe(0);
  });
});

describe("plugins inspect - schedules surface", () => {
  test("renders declared schedules with cadence and mode", async () => {
    inspectResult = {
      name: "example",
      installed: true,
      status: "not-in-marketplace",
      local: {
        target: "/plugins/example",
        commit: null,
        committedAt: null,
        version: null,
        description: null,
        installedAt: null,
        source: null,
        localChanges: null,
        issues: [],
      },
      remote: null,
      remoteError: null,
      surfaces: {
        skills: [],
        hooks: [],
        tools: ["do_thing"],
        schedules: [
          { name: "daily-report", cadence: "0 9 * * *", mode: "execute" },
          { name: "cleanup", cadence: "0 0 * * 0", mode: "script" },
        ],
      },
    };

    const r = await runCommand(["plugins", "inspect", "example"]);

    expect(r.stdout).toContain("schedules");
    expect(r.stdout).toContain("daily-report  0 9 * * *  (execute)");
    expect(r.stdout).toContain("cleanup       0 0 * * 0  (script)");
    expect(r.exitCode).toBe(0);
  });
});
