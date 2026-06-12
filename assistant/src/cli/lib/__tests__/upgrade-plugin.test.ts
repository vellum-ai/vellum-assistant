/**
 * Tests for {@link upgradePlugin}.
 *
 * An upgrade is drift detection (the same exact SHA comparison
 * {@link inspectPlugin} performs) followed by a forced re-install at the
 * marketplace pin. The marketplace + GitHub Contents API are replaced with an
 * in-memory fixture passed via `fetch`, the clone is replaced with a fake
 * {@link GitRunner} that materializes a tree, and the install target is a real
 * temp directory passed via `workspacePluginsDir` — no globals are patched.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike, GitRunner } from "../install-from-github.js";
import { PluginNotInstalledError } from "../uninstall-plugin.js";
import { PluginNotUpgradableError, upgradePlugin } from "../upgrade-plugin.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CANON_REPO = "vellum-ai/vellum-assistant";
const MANIFEST_URL = `https://api.github.com/repos/${CANON_REPO}/contents/plugins/marketplace.json`;
const CONTENTS = `https://api.github.com/repos/${CANON_REPO}/contents/`;

/** A marketplace manifest pinning `name` to `ref`. */
function manifestWith(name: string, ref: string): unknown {
  return {
    name: "vellum",
    plugins: [
      {
        name,
        source: { source: "github", repo: `example-org/${name}`, ref },
        description: "A test plugin.",
        category: "developer",
        license: "MIT",
      },
    ],
  };
}

/**
 * Build a `fetch` that serves the marketplace manifest and answers the GitHub
 * Contents API listing (used by the adapter-stub lookup) with a 404, so the
 * clone is treated as a raw external tree. `manifest: undefined` answers the
 * manifest with 404; `manifestStatus` overrides the manifest status to
 * simulate a transient marketplace failure.
 */
function makeFetch(opts: {
  manifest?: unknown;
  manifestStatus?: number;
}): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(MANIFEST_URL)) {
      if (opts.manifestStatus !== undefined && opts.manifestStatus !== 200) {
        return new Response("manifest unavailable", {
          status: opts.manifestStatus,
        });
      }
      if (opts.manifest === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(opts.manifest), { status: 200 });
    }
    // No adapter stub: the Contents API listing for plugins/<name> is empty.
    if (url.startsWith(CONTENTS)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as FetchLike;
}

/** A fake clone that materializes one file and reports `commit` at HEAD. */
function fakeGitRunner(commit: string, calls?: string[][]): GitRunner {
  return async (args, { cwd }) => {
    calls?.push([...args]);
    switch (args[0]) {
      case "fetch": {
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git", "config"), "[core]\n");
        writeFileSync(join(cwd, "package.json"), '{"name":"level-up"}');
        return { stdout: "" };
      }
      case "rev-parse":
        return { stdout: `${commit}\n` };
      default:
        return { stdout: "" };
    }
  };
}

/** A git runner that fails the test if any git command runs. */
const unusedGitRunner: GitRunner = async (args) => {
  throw new Error(`git should not run for this upgrade: ${args.join(" ")}`);
};

/** Materialize an installed plugin copy with an optional provenance sidecar. */
function installCopy(
  pluginsDir: string,
  name: string,
  sidecar: { commit: string } | null,
): void {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "0.1.0", description: "Installed copy." }),
  );
  if (sidecar !== null) {
    writeFileSync(
      join(dir, "install-meta.json"),
      JSON.stringify({
        origin: "vellum",
        name,
        source: {
          kind: "github",
          owner: "example-org",
          repo: name,
          ref: sidecar.commit,
        },
        commit: sidecar.commit,
        installedAt: "2026-06-10T12:00:00.000Z",
      }),
    );
  }
}

/** Read the commit recorded in a copy's provenance sidecar, if present. */
function sidecarCommit(pluginsDir: string, name: string): string | null {
  const path = join(pluginsDir, name, "install-meta.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")).commit ?? null;
}

let ws: string;
let pluginsDir: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "upgrade-plugin-"));
  pluginsDir = join(ws, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("upgradePlugin", () => {
  test("upgrades to the marketplace pin when it has advanced", async () => {
    // GIVEN an installed copy pinned to SHA_A
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    // AND the marketplace now pins SHA_B
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = fakeGitRunner(SHA_B);

    // WHEN the plugin is upgraded
    const result = await upgradePlugin(
      { name: "level-up" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN it reports the move from the old commit to the pin
    expect(result.outcome).toBe("upgraded");
    expect(result.fromCommit).toBe(SHA_A);
    expect(result.toCommit).toBe(SHA_B);
    expect(result.fileCount).toBeGreaterThan(0);
    // AND the new pin is recorded in the provenance sidecar on disk
    expect(sidecarCommit(pluginsDir, "level-up")).toBe(SHA_B);
  });

  test("is a no-op when the installed commit already equals the pin", async () => {
    // GIVEN an installed copy already pinned to SHA_A
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    // AND the marketplace pins the same SHA_A
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_A) });

    // WHEN the plugin is upgraded (git must never run)
    const result = await upgradePlugin(
      { name: "level-up" },
      { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
    );

    // THEN it reports already-up-to-date and makes no changes
    expect(result.outcome).toBe("already-up-to-date");
    expect(result.fileCount).toBeNull();
    expect(result.toCommit).toBe(SHA_A);
  });

  test("a dry run reports the move without modifying the install", async () => {
    // GIVEN an installed copy pinned to SHA_A and a marketplace pin of SHA_B
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });

    // WHEN the plugin is upgraded with dryRun (git must never run)
    const result = await upgradePlugin(
      { name: "level-up", dryRun: true },
      { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
    );

    // THEN it reports what would change but leaves the install untouched
    expect(result.outcome).toBe("would-upgrade");
    expect(result.dryRun).toBe(true);
    expect(result.fileCount).toBeNull();
    expect(sidecarCommit(pluginsDir, "level-up")).toBe(SHA_A);
  });

  test("re-pins and records provenance for an install with none", async () => {
    // GIVEN an installed copy with no provenance sidecar
    installCopy(pluginsDir, "level-up", null);
    // AND the marketplace pins SHA_B
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = fakeGitRunner(SHA_B);

    // WHEN the plugin is upgraded
    const result = await upgradePlugin(
      { name: "level-up" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN it upgrades, flags the missing provenance, and records the new pin
    expect(result.outcome).toBe("upgraded");
    expect(result.fromCommit).toBeNull();
    expect(result.provenanceWasUnknown).toBe(true);
    expect(sidecarCommit(pluginsDir, "level-up")).toBe(SHA_B);
  });

  test("throws PluginNotInstalledError when nothing is installed", async () => {
    // GIVEN no installed copy, though the marketplace has an entry
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });

    // WHEN an upgrade is attempted
    // THEN it refuses because there is no install to advance
    await expect(
      upgradePlugin(
        { name: "level-up" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginNotInstalledError);
  });

  test("throws PluginNotUpgradableError when not in the marketplace", async () => {
    // GIVEN an installed copy but an empty marketplace catalog
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    const fetch = makeFetch({ manifest: undefined });

    // WHEN an upgrade is attempted
    // THEN there is no pin to advance to
    await expect(
      upgradePlugin(
        { name: "level-up" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginNotUpgradableError);
  });

  test("throws PluginNotUpgradableError when the marketplace is unreachable", async () => {
    // GIVEN an installed copy and a marketplace fetch that fails transiently
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    const fetch = makeFetch({ manifestStatus: 500 });

    // WHEN an upgrade is attempted
    // THEN the latest pin cannot be determined, so it refuses
    await expect(
      upgradePlugin(
        { name: "level-up" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginNotUpgradableError);
  });

  test("preserves the existing install when the re-install clone fails", async () => {
    // GIVEN an installed copy pinned to SHA_A and an advanced marketplace pin
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    // AND a clone that fails mid-fetch
    const failingGit: GitRunner = async (args) => {
      if (args[0] === "fetch") throw new Error("network down");
      return { stdout: "" };
    };

    // WHEN the upgrade is attempted
    // THEN it surfaces the clone failure
    await expect(
      upgradePlugin(
        { name: "level-up" },
        { fetch, runGit: failingGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toThrow("network down");
    // AND the previously installed copy is left intact at its old pin
    expect(sidecarCommit(pluginsDir, "level-up")).toBe(SHA_A);
  });
});
