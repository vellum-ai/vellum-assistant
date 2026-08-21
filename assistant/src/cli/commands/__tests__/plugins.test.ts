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
 *   - upgrade's local fallback runs the same consent gate with upgrade
 *     wording, while a daemon-routed upgrade never reaches it
 *   - under --json the consent listing, the prompt, and the cancellation line
 *     all go to stderr, leaving stdout a pure JSON document
 *   - inspect renders the schedules surface block
 *   - install prints a setup-skill hint when `skills/setup` or
 *     `skills/<name>-setup` is present on the installed tree
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
import type { CliCommandRunResult } from "./cli-test-harness.js";
import { runCliCommand } from "./cli-test-harness.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let confirmCalls: Array<{
  question: string;
  refuseNonInteractiveMessage: string;
  /** Where the prompt line itself is written; undefined = readline's default. */
  stdout: NodeJS.WritableStream | undefined;
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

/** On-disk tree returned as the fake install `target` so post-install walks work. */
let installTarget: string | null = null;
const installTargetDirs: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../lib/confirm-prompt.js", () => ({
  confirmPrompt: async (opts: ConfirmPromptOptions) => {
    confirmCalls.push({
      question: opts.question,
      refuseNonInteractiveMessage: opts.refuseNonInteractiveMessage,
      stdout: opts.stdout,
    });
    return confirmResults.shift() ?? "confirmed";
  },
}));

const realGithub = await import("../../lib/install-from-github.js");
const realPlatform = await import("../../lib/install-from-platform.js");
const realInspect = await import("../../lib/inspect-plugin.js");
const realUpgrade = await import("../../lib/upgrade-plugin.js");
const realCliClient = await import("../../../ipc/cli-client.js");

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
    target: installTarget ?? `/plugins/${name}`,
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

/** Write a two-schedule fixture (one execute entrypoint, one script). */
function writeScheduleFixture(dir: string): void {
  stageSchedule("daily-report", "0 9 * * *")(dir);
  mkdirSync(join(dir, "schedules", "cleanup"), { recursive: true });
  writeFileSync(
    join(dir, "schedules", "cleanup", "config.json"),
    '{"expression": "0 0 * * 0"}',
  );
  writeFileSync(join(dir, "schedules", "cleanup", "index.sh"), "#!/bin/sh\n");
}

/** Stage a single declaration directory with the given raw expression. */
function stageSchedule(
  name: string,
  expression: string,
): (dir: string) => void {
  return (dir) => {
    const declarationDir = join(dir, "schedules", name);
    mkdirSync(declarationDir, { recursive: true });
    writeFileSync(
      join(declarationDir, "config.json"),
      JSON.stringify({ expression }),
    );
    writeFileSync(join(declarationDir, "index.md"), "Body.\n");
  };
}

function runCommand(args: string[]): Promise<CliCommandRunResult> {
  return runCliCommand(registerPluginsCommand, args);
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
  installTarget = null;
  // Platform features on by default, so a plain name install takes the
  // platform-tarball branch.
  delete process.env.VELLUM_DISABLE_PLATFORM;
  delete process.env.IS_PLATFORM;
});

afterEach(() => {
  for (const dir of installTargetDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  installTargetDirs.length = 0;
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
    // The cadence is humanized, with the raw expression as ground truth.
    expect(r.stdout).toContain("Every day at 9:00 AM (0 9 * * *)");
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
    expect(r.stdout).not.toContain("to help set up this plugin");
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

  test("strips terminal escape sequences from the listed declarations", async () => {
    // The cadence carries a clear-screen CSI plus an OSC title write, aimed at
    // rewriting the consent prompt.
    stageFixture = stageSchedule(
      "sneaky",
      "0 9 * * *\u001b[2J\u001b]0;pwned\u0007 SAFE",
    );
    confirmResults = ["confirmed"];

    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).toContain("sneaky");
    expect(r.stdout).toContain("SAFE");
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).not.toContain("\u0007");
    expect(r.stdout).not.toContain("pwned");
    expect(r.exitCode).toBe(0);
  });

  test("caps listing cell width so a long expression cannot flood the prompt", async () => {
    stageFixture = stageSchedule("wall", `0 9 * * * ${"x".repeat(200)}`);
    confirmResults = ["confirmed"];

    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).not.toContain("x".repeat(60));
    expect(r.stdout).toContain("...");
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

  test("--json --force leaves stdout as pure JSON and lists on stderr", async () => {
    stageFixture = writeScheduleFixture;

    const r = await runCommand([
      "plugins",
      "upgrade",
      "example",
      "--json",
      "--force",
    ]);

    expect(confirmCalls.length).toBe(0);
    expect(r.stderr).toContain('Plugin "example" declares 2 schedules:');
    expect(r.stderr).toContain("daily-report");
    expect(r.stdout).not.toContain("declares");
    expect(JSON.parse(r.stdout)).toMatchObject({
      name: "example",
      outcome: "upgraded",
    });
    expect(r.exitCode).toBe(0);
  });

  test("--json keeps the prompt and the cancellation off stdout", async () => {
    stageFixture = writeScheduleFixture;
    confirmResults = ["denied"];

    const r = await runCommand(["plugins", "upgrade", "example", "--json"]);

    // readline writes the question to whatever stream it is handed, so under
    // --json that has to be stderr.
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.stdout).toBe(process.stderr);
    expect(confirmCalls[0]!.question).toContain('Upgrade "example"');

    expect(r.stderr).toContain('Plugin "example" declares 2 schedules:');
    expect(r.stderr).toContain("Upgrade cancelled.");
    expect(r.stdout).toBe("");
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

  test("a daemon-routed upgrade prints the declared schedules, marking new ones", async () => {
    // Pre-upgrade install: one declared schedule under the workspace plugins
    // dir. Post-upgrade tree (the daemon result's target): the same schedule
    // plus a newly declared one.
    const workspaceDir = mkdtempSync(join(tmpdir(), "plugins-cmd-ws-"));
    const upgradedDir = mkdtempSync(join(tmpdir(), "plugins-cmd-upgraded-"));
    const savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    try {
      const installedDir = join(workspaceDir, "plugins", "example");
      stageSchedule("daily-report", "0 9 * * *")(installedDir);
      stageSchedule("daily-report", "0 9 * * *")(upgradedDir);
      stageSchedule("weekly-new", "0 8 * * 1")(upgradedDir);
      ipcResults = [
        {
          ok: true,
          result: { ...upgradedResult("example"), target: upgradedDir },
        },
      ];

      const r = await runCommand(["plugins", "upgrade", "example"]);

      expect(confirmCalls.length).toBe(0);
      expect(r.stdout).toContain('Upgraded "example"');
      expect(r.stdout).toContain('Plugin "example" declares 2 schedules:');
      const dailyLine = r.stdout
        .split("\n")
        .find((line) => line.includes("daily-report"));
      const weeklyLine = r.stdout
        .split("\n")
        .find((line) => line.includes("weekly-new"));
      expect(dailyLine).toBeDefined();
      expect(dailyLine).not.toContain("[new]");
      expect(weeklyLine).toContain("[new]");
      expect(r.stdout).toContain("New schedules run automatically");
      expect(r.exitCode).toBe(0);
    } finally {
      if (savedWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
      }
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  test("a daemon-routed dry run prints no schedule listing", async () => {
    const upgradedDir = mkdtempSync(join(tmpdir(), "plugins-cmd-dry-"));
    try {
      stageSchedule("daily-report", "0 9 * * *")(upgradedDir);
      ipcResults = [
        {
          ok: true,
          result: {
            ...upgradedResult("example"),
            outcome: "would-upgrade",
            dryRun: true,
            target: upgradedDir,
          },
        },
      ];

      const r = await runCommand([
        "plugins",
        "upgrade",
        "example",
        "--dry-run",
      ]);

      expect(r.stdout).toContain("would upgrade");
      expect(r.stdout).not.toContain("declares");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(upgradedDir, { recursive: true, force: true });
    }
  });
});

describe("plugins inspect - schedules surface", () => {
  /** Minimal installed-plugin inspection carrying the given surfaces block. */
  function inspectionWithSurfaces(
    surfaces: PluginInspection["surfaces"],
  ): PluginInspection {
    return {
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
      surfaces,
    };
  }

  test("renders declared schedules with cadence and mode", async () => {
    inspectResult = inspectionWithSurfaces({
      skills: [],
      hooks: [],
      tools: ["do_thing"],
      schedules: [
        { name: "daily-report", cadence: "0 9 * * *", mode: "execute" },
        { name: "cleanup", cadence: "0 0 * * 0", mode: "script" },
      ],
    });

    const r = await runCommand(["plugins", "inspect", "example"]);

    expect(r.stdout).toContain("schedules");
    // Cadences render humanized with the raw expression as ground truth.
    expect(r.stdout).toContain(
      "daily-report  Every day at 9:00 AM (0 9 * * *)",
    );
    expect(r.stdout).toContain("(execute)");
    expect(r.stdout).toContain(
      "cleanup       Every Sun at 12:00 AM (0 0 * * 0)",
    );
    expect(r.stdout).toContain("(script)");
    expect(r.exitCode).toBe(0);
  });

  test("renders an RRULE cadence as the raw expression", async () => {
    inspectResult = inspectionWithSurfaces({
      skills: [],
      hooks: [],
      tools: [],
      schedules: [
        {
          name: "weekly",
          cadence: "RRULE:FREQ=WEEKLY;BYDAY=MO",
          mode: "execute",
        },
      ],
    });

    const r = await runCommand(["plugins", "inspect", "example"]);

    expect(r.stdout).toContain("weekly  RRULE:FREQ=WEEKLY;BYDAY=MO  (execute)");
    expect(r.exitCode).toBe(0);
  });
});

describe("plugins install - setup skill hint", () => {
  function writeSetupSkill(skillId: string): void {
    const dir = mkdtempSync(join(tmpdir(), "plugins-cmd-target-"));
    installTargetDirs.push(dir);
    mkdirSync(join(dir, "skills", skillId), { recursive: true });
    writeFileSync(
      join(dir, "skills", skillId, "SKILL.md"),
      "---\nname: setup\ndescription: Set up the plugin.\n---\n",
    );
    installTarget = dir;
  }

  test("points at skills/setup after a successful install", async () => {
    writeSetupSkill("setup");

    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).toContain('Installed plugin "example"');
    expect(r.stdout).toContain(
      "Load the setup skill to help set up this plugin",
    );
    expect(r.exitCode).toBe(0);
  });

  test("points at skills/<name>-setup when that is the shipped id", async () => {
    writeSetupSkill("imessage-setup");

    const r = await runCommand(["plugins", "install", "imessage"]);

    expect(r.stdout).toContain(
      "Load the imessage-setup skill to help set up this plugin",
    );
    expect(r.exitCode).toBe(0);
  });

  test("prints no setup hint when the plugin ships no setup skill", async () => {
    const r = await runCommand(["plugins", "install", "example"]);

    expect(r.stdout).toContain('Installed plugin "example"');
    expect(r.stdout).not.toContain("to help set up this plugin");
    expect(r.exitCode).toBe(0);
  });
});
