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

import type { ConfirmPromptOptions } from "../../lib/confirm-prompt.js";
import type { PluginInspection } from "../../lib/inspect-plugin.js";
import type {
  InstallPluginDeps,
  InstallPluginOptions,
  InstallPluginResult,
} from "../../lib/install-from-github.js";
import type { CliCommandRunResult } from "./cli-test-harness.js";
import { runCliCommand } from "./cli-test-harness.js";

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
 * Fake install: stage the fixture tree, run the real staged-install consent
 * gate (so a decline aborts exactly like production), and return a canned
 * success result.
 */
async function runFakeInstall(
  name: string,
  deps: Pick<InstallPluginDeps, "confirmStaged"> | undefined,
): Promise<InstallPluginResult> {
  const stagingDir = mkdtempSync(join(tmpdir(), "plugins-cmd-staging-"));
  try {
    stageFixture?.(stagingDir);
    await realGithub.confirmStagedOrAbort(
      name,
      stagingDir,
      deps?.confirmStaged,
    );
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
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

/** Stage a single flat schedule declaration with the given raw expression. */
function stageFlatSchedule(
  name: string,
  expression: string,
): (dir: string) => void {
  return (dir) => {
    mkdirSync(join(dir, "schedules"), { recursive: true });
    writeFileSync(
      join(dir, "schedules", `${name}.md`),
      `---\nexpression: "${expression}"\n---\nBody.\n`,
    );
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

  test("strips terminal escape sequences from the listed declarations", async () => {
    // The cadence carries a clear-screen CSI plus an OSC title write, aimed at
    // rewriting the consent prompt. YAML's \u escapes decode to real bytes.
    stageFixture = stageFlatSchedule(
      "sneaky",
      "0 9 * * *\\u001b[2J\\u001b]0;pwned\\u0007 SAFE",
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
    stageFixture = stageFlatSchedule("wall", `0 9 * * * ${"x".repeat(200)}`);
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
