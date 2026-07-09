/**
 * Install-by-name in disable-platform (air-gapped / self-hosted) mode.
 *
 * With `VELLUM_DISABLE_PLATFORM=true` there is no platform to serve a verified
 * tarball, so `assistant plugins install <name>` resolves the pin from the
 * bundled marketplace catalog and installs through the GitHub path — with zero
 * platform calls. A name absent from the bundled catalog fails clearly. With
 * platform features enabled, the platform install endpoint is used unchanged.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { Command } from "commander";

import type { InstallPluginOptions } from "../install-from-github.js";

const installPluginCalls: InstallPluginOptions[] = [];
const platformInstallCalls: Array<{ name: string; force?: boolean }> = [];

const realGithub = await import("../install-from-github.js");
const realPlatform = await import("../install-from-platform.js");

mock.module("../install-from-github.js", () => ({
  ...realGithub,
  installPlugin: async (opts: InstallPluginOptions) => {
    installPluginCalls.push(opts);
    return {
      name: opts.name,
      target: `/plugins/${opts.name}`,
      fileCount: 3,
      ref: opts.directSource?.ref ?? "main",
      commit: "abc1234def",
      committedAt: null,
    };
  },
}));

mock.module("../install-from-platform.js", () => ({
  ...realPlatform,
  installPluginViaPlatform: async (opts: { name: string; force?: boolean }) => {
    platformInstallCalls.push(opts);
    return {
      name: opts.name,
      target: `/plugins/${opts.name}`,
      fileCount: 3,
      ref: "main",
      commit: "def5678abc",
      committedAt: null,
    };
  },
}));

const { registerPluginsCommand } = await import("../../commands/plugins.js");

/** A plugin known to live in the bundled marketplace manifest. */
const BUNDLED_PLUGIN = "caveman";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerPluginsCommand(program);
  return program;
}

async function runInstall(name: string): Promise<void> {
  await buildProgram().parseAsync(["node", "assistant", "plugins", "install", name]);
}

describe("plugins install by name — disable-platform mode", () => {
  const savedDisable = process.env.VELLUM_DISABLE_PLATFORM;
  const savedIsPlatform = process.env.IS_PLATFORM;
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    installPluginCalls.length = 0;
    platformInstallCalls.length = 0;
    process.exitCode = undefined;
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedDisable === undefined) {delete process.env.VELLUM_DISABLE_PLATFORM;}
    else {process.env.VELLUM_DISABLE_PLATFORM = savedDisable;}
    if (savedIsPlatform === undefined) {delete process.env.IS_PLATFORM;}
    else {process.env.IS_PLATFORM = savedIsPlatform;}
    process.exitCode = savedExitCode;
    mock.restore();
  });

  test("installs a bundled plugin via the GitHub path with no platform call", async () => {
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    delete process.env.IS_PLATFORM;

    await runInstall(BUNDLED_PLUGIN);

    expect(platformInstallCalls.length).toBe(0);
    expect(installPluginCalls.length).toBe(1);
    const opts = installPluginCalls[0]!;
    expect(opts.name).toBe(BUNDLED_PLUGIN);
    expect(opts.directSource).toEqual({
      owner: "JuliusBrussee",
      repo: "caveman",
      rootPath: "",
      ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });
    expect(process.exitCode).not.toBe(1);
  });

  test("errors clearly for a name absent from the bundled catalog", async () => {
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    delete process.env.IS_PLATFORM;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await runInstall("definitely-not-a-real-plugin");

    expect(installPluginCalls.length).toBe(0);
    expect(platformInstallCalls.length).toBe(0);
    expect(process.exitCode).toBe(1);
    const message = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("not in the bundled marketplace catalog");
  });

  test("uses the platform install endpoint when platform features are enabled", async () => {
    delete process.env.VELLUM_DISABLE_PLATFORM;
    delete process.env.IS_PLATFORM;

    await runInstall(BUNDLED_PLUGIN);

    expect(installPluginCalls.length).toBe(0);
    expect(platformInstallCalls.length).toBe(1);
    expect(platformInstallCalls[0]!.name).toBe(BUNDLED_PLUGIN);
    expect(process.exitCode).not.toBe(1);
  });
});
