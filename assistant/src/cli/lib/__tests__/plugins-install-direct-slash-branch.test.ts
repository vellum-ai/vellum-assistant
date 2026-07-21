/**
 * Direct (GitHub-URL) install from a branch whose name contains a slash.
 *
 * `assistant plugins install https://github.com/<owner>/<repo>/tree/feat/x`
 * used to misparse the slashed branch `feat/x` as ref `feat` + sub-path `x`,
 * because `/tree/<ref>/<path>` joins the ref and sub-path with a bare `/`. The
 * command now resolves the ambiguous boundary against the remote
 * (`resolveTreeRefPath`), so the whole branch reaches the installer as the ref.
 * These tests drive the real command with those two collaborators faked.
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

import type {
  InstallPluginOptions,
  PluginFetchSource,
} from "../install-from-github.js";

const installPluginCalls: InstallPluginOptions[] = [];
/** Ref short-names the faked remote reports as existing (heads + tags). */
let remoteRefs: Set<string>;

const realGithub = await import("../install-from-github.js");

mock.module("../install-from-github.js", () => ({
  ...realGithub,
  installPlugin: async (opts: InstallPluginOptions) => {
    installPluginCalls.push(opts);
    return {
      name: opts.name,
      target: `/plugins/${opts.name}`,
      fileCount: 3,
      ref: opts.directSource?.ref ?? "HEAD",
      commit: "abc1234def",
      committedAt: null,
    };
  },
  // Resolve against `remoteRefs` instead of the network: return the first
  // candidate (longest-ref-first) whose ref the fake remote reports.
  resolveTreeRefPath: async <T extends { readonly ref: string }>(
    _owner: string,
    _repo: string,
    candidates: readonly T[],
  ): Promise<T | null> => candidates.find((c) => remoteRefs.has(c.ref)) ?? null,
}));

const { registerPluginsCommand } = await import("../../commands/plugins.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerPluginsCommand(program);
  return program;
}

async function runInstall(url: string, ...extra: string[]): Promise<void> {
  await buildProgram().parseAsync([
    "node",
    "assistant",
    "plugins",
    "install",
    url,
    ...extra,
  ]);
}

describe("plugins install — direct GitHub URL with a slashed branch", () => {
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    installPluginCalls.length = 0;
    remoteRefs = new Set();
    process.exitCode = undefined;
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    mock.restore();
  });

  test("installs from the full slashed branch when it exists on the remote", async () => {
    remoteRefs = new Set(["main", "feat/results-viewer"]);

    await runInstall(
      "https://github.com/ZeebBoyBlue/virlo-integrations/tree/feat/results-viewer",
    );

    expect(installPluginCalls).toHaveLength(1);
    const source = installPluginCalls[0]!.directSource as PluginFetchSource;
    // The whole branch is the ref, and nothing is left over as a sub-path.
    expect(source.ref).toBe("feat/results-viewer");
    expect(source.rootPath).toBe("");
    // With an empty sub-path the install name falls back to the repo name.
    expect(installPluginCalls[0]!.name).toBe("virlo-integrations");
    expect(process.exitCode).not.toBe(1);
  });

  test("keeps ref and sub-path apart for a slashed branch plus a real sub-path", async () => {
    remoteRefs = new Set(["feat/results-viewer"]);

    await runInstall(
      "https://github.com/ZeebBoyBlue/virlo-integrations/tree/feat/results-viewer/integrations/vellum",
    );

    const source = installPluginCalls[0]!.directSource as PluginFetchSource;
    expect(source.ref).toBe("feat/results-viewer");
    expect(source.rootPath).toBe("integrations/vellum");
    // The name derives from the resolved sub-path leaf.
    expect(installPluginCalls[0]!.name).toBe("vellum");
  });

  test("resolves to the short branch + sub-path when only that branch exists", async () => {
    remoteRefs = new Set(["feat"]);

    await runInstall("https://github.com/owner/repo/tree/feat/results-viewer");

    const source = installPluginCalls[0]!.directSource as PluginFetchSource;
    expect(source.ref).toBe("feat");
    expect(source.rootPath).toBe("results-viewer");
  });

  test("falls back to the shortest-ref split when the remote confirms nothing", async () => {
    remoteRefs = new Set(); // unreachable / no matching ref

    await runInstall("https://github.com/owner/repo/tree/feat/results-viewer");

    // Same behavior as before this fix — the install still proceeds and the
    // clone surfaces any real not-found itself.
    const source = installPluginCalls[0]!.directSource as PluginFetchSource;
    expect(source.ref).toBe("feat");
    expect(source.rootPath).toBe("results-viewer");
  });
});
