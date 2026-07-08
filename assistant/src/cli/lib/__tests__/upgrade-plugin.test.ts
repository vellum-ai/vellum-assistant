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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import {
  type GitRunner,
  PluginSourceUnavailableError,
} from "../install-from-github.js";
import { computeFingerprint } from "../plugin-fingerprint.js";
import { PluginNotInstalledError } from "../uninstall-plugin.js";
import {
  PluginMergeBaselineError,
  PluginNotUpgradableError,
  upgradePlugin,
} from "../upgrade-plugin.js";

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
  remoteCommitDate?: string;
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
    // The remote commit date `inspect` resolves to surface the human-readable
    // "to" timestamp; absent it 404s and the timestamp degrades to null.
    if (url.includes("api.github.com") && url.includes("/commits/")) {
      if (opts.remoteCommitDate === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          commit: { committer: { date: opts.remoteCommitDate } },
        }),
        { status: 200 },
      );
    }
    // No adapter stub: the Contents API listing for plugins/<name> is empty.
    if (url.startsWith(CONTENTS)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as FetchLike;
}

/**
 * A fake clone that materializes one file and reports `commit` at HEAD. When
 * `committedAtSeconds` is given, `git show -s --format=%ct HEAD` reports that
 * UNIX committer time, mirroring how install captures the commit timestamp.
 */
function fakeGitRunner(
  commit: string,
  opts: { calls?: string[][]; committedAtSeconds?: number } = {},
): GitRunner {
  return async (args, { cwd }) => {
    opts.calls?.push([...args]);
    switch (args[0]) {
      case "fetch": {
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git", "config"), "[core]\n");
        writeFileSync(join(cwd, "package.json"), '{"name":"level-up"}');
        return { stdout: "" };
      }
      case "rev-parse":
        return { stdout: `${commit}\n` };
      case "show":
        return {
          stdout:
            opts.committedAtSeconds === undefined
              ? ""
              : `${opts.committedAtSeconds}\n`,
        };
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
  sidecar: { commit: string; committedAt?: string } | null,
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
        committedAt: sidecar.committedAt,
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

  test("threads commit timestamps through the move as the human-readable version", async () => {
    // GIVEN an installed copy with a recorded commit timestamp
    installCopy(pluginsDir, "level-up", {
      commit: SHA_A,
      committedAt: "2026-06-01T12:34:56.000Z",
    });
    // AND the marketplace pins a newer commit whose date the clone reports
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    // 2026-06-05T08:12:24Z expressed as UNIX seconds for `git show %ct`.
    const runGit = fakeGitRunner(SHA_B, {
      committedAtSeconds: Math.floor(
        Date.parse("2026-06-05T08:12:24.000Z") / 1000,
      ),
    });

    // WHEN the plugin is upgraded
    const result = await upgradePlugin(
      { name: "level-up" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN both ends of the move carry their commit timestamps
    expect(result.fromTimestamp).toBe("2026-06-01T12:34:56.000Z");
    expect(result.toTimestamp).toBe("2026-06-05T08:12:24.000Z");
  });

  test("a dry run resolves the target timestamp from the marketplace pin", async () => {
    // GIVEN an installed copy and a marketplace pin whose commit GitHub dates
    installCopy(pluginsDir, "level-up", {
      commit: SHA_A,
      committedAt: "2026-06-01T12:34:56.000Z",
    });
    const fetch = makeFetch({
      manifest: manifestWith("level-up", SHA_B),
      remoteCommitDate: "2026-06-05T08:12:24.000Z",
    });

    // WHEN a dry-run upgrade is performed (git must never run)
    const result = await upgradePlugin(
      { name: "level-up", dryRun: true },
      { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
    );

    // THEN the preview shows the timestamp move resolved without a clone
    expect(result.fromTimestamp).toBe("2026-06-01T12:34:56.000Z");
    expect(result.toTimestamp).toBe("2026-06-05T08:12:24.000Z");
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

  test("throws PluginSourceUnavailableError when the marketplace is unreachable", async () => {
    // GIVEN an installed copy and a marketplace fetch that fails transiently
    installCopy(pluginsDir, "level-up", { commit: SHA_A });
    const fetch = makeFetch({ manifestStatus: 500 });

    // WHEN an upgrade is attempted
    // THEN the outage is surfaced as a retryable source-unavailable error
    // (distinct from the permanent no-marketplace-entry conflict), since the
    // same request can succeed once the catalog recovers
    await expect(
      upgradePlugin(
        { name: "level-up" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginSourceUnavailableError);
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

/** A file tree keyed by POSIX-relative path. */
type Tree = Record<string, string>;

/**
 * A fake clone whose materialized tree depends on the fetched ref, so a merge
 * upgrade's base clone (`source.ref` = the recorded install commit) and pin
 * clone (`source.ref` = the marketplace pin) yield different trees. The ref is
 * the last `git fetch` argument; `rev-parse HEAD` echoes it back so the
 * checked-out commit matches the requested ref.
 */
function treeGitRunner(treesByRef: Record<string, Tree>): GitRunner {
  const refByCwd = new Map<string, string>();
  return async (args, { cwd }) => {
    switch (args[0]) {
      case "fetch": {
        const ref = args[args.length - 1];
        refByCwd.set(cwd, ref);
        const tree = treesByRef[ref] ?? {};
        for (const [rel, content] of Object.entries(tree)) {
          const abs = join(cwd, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
        // `.git` is stripped during materialization; create it so the strip
        // path is exercised, matching a real clone.
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git", "config"), "[core]\n");
        return { stdout: "" };
      }
      case "rev-parse":
        return { stdout: `${refByCwd.get(cwd) ?? ""}\n` };
      default:
        return { stdout: "" };
    }
  };
}

/**
 * Materialize an installed copy of `ours` on disk plus a provenance sidecar
 * recording `commit` and a fingerprint. By default the fingerprint is computed
 * over `base` (what install materialized); pass `fingerprintTree` to record a
 * mismatching baseline.
 */
function installMergeCopy(
  name: string,
  ours: Tree,
  commit: string,
  fingerprintTree: Tree | null,
): void {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(ours)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const sidecar: Record<string, unknown> = {
    origin: "vellum",
    name,
    source: { kind: "github", owner: "example-org", repo: name, ref: commit },
    commit,
    installedAt: "2026-06-10T12:00:00.000Z",
  };
  if (fingerprintTree !== null) {
    const refDir = mkdtempSync(join(tmpdir(), "merge-fingerprint-"));
    try {
      for (const [rel, content] of Object.entries(fingerprintTree)) {
        const abs = join(refDir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      sidecar.fingerprint = computeFingerprint(refDir, ["install-meta.json"]);
    } finally {
      rmSync(refDir, { recursive: true, force: true });
    }
  }
  writeFileSync(join(dir, "install-meta.json"), JSON.stringify(sidecar));
}

/** Read an installed file's contents, or null when absent. */
function installedFile(name: string, rel: string): string | null {
  const path = join(pluginsDir, name, rel);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

describe("upgradePlugin --strategy", () => {
  // base → ours / theirs trees shared by the three-way merge tests:
  // - common.txt: edited on disjoint lines by each side (a clean auto-merge)
  // - conflict.txt: edited differently on both sides (a true conflict)
  // - local-only.txt / remote-only.txt: added on one side only
  const BASE: Tree = {
    "common.txt": "a\nb\nc\n",
    "conflict.txt": "base\n",
  };
  const OURS: Tree = {
    "common.txt": "A\nb\nc\n",
    "conflict.txt": "ours\n",
    "local-only.txt": "added locally\n",
  };
  const THEIRS: Tree = {
    "common.txt": "a\nb\nC\n",
    "conflict.txt": "theirs\n",
    "remote-only.txt": "added upstream\n",
  };

  test("--strategy ours carries both sides' edits and resolves conflicts toward local", async () => {
    // GIVEN an install at SHA_A with local edits, and a pin at SHA_B
    installMergeCopy("level-up", OURS, SHA_A, BASE);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN the plugin is upgraded with the `ours` strategy
    const result = await upgradePlugin(
      { name: "level-up", strategy: "ours" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN it moves to the pin and records the strategy
    expect(result.outcome).toBe("upgraded");
    expect(result.toCommit).toBe(SHA_B);
    expect(result.strategy).toBe("ours");
    // AND non-conflicting edits from both sides survive
    expect(installedFile("level-up", "common.txt")).toBe("A\nb\nC\n");
    expect(installedFile("level-up", "local-only.txt")).toBe("added locally\n");
    expect(installedFile("level-up", "remote-only.txt")).toBe(
      "added upstream\n",
    );
    // AND the conflicting file resolves toward the local edit
    expect(installedFile("level-up", "conflict.txt")).toBe("ours\n");
  });

  test("--strategy theirs carries both sides' edits and resolves conflicts toward the pin", async () => {
    // GIVEN an install at SHA_A with local edits, and a pin at SHA_B
    installMergeCopy("level-up", OURS, SHA_A, BASE);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN the plugin is upgraded with the `theirs` strategy
    const result = await upgradePlugin(
      { name: "level-up", strategy: "theirs" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN non-conflicting edits from both sides still survive
    expect(result.strategy).toBe("theirs");
    expect(installedFile("level-up", "common.txt")).toBe("A\nb\nC\n");
    expect(installedFile("level-up", "local-only.txt")).toBe("added locally\n");
    expect(installedFile("level-up", "remote-only.txt")).toBe(
      "added upstream\n",
    );
    // AND the conflicting file resolves toward the pin
    expect(installedFile("level-up", "conflict.txt")).toBe("theirs\n");
  });

  test("--strategy overwrite discards local edits and re-installs the pin wholesale", async () => {
    // GIVEN an install at SHA_A with a local-only file, and a pin at SHA_B
    installMergeCopy("level-up", OURS, SHA_A, BASE);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN the plugin is upgraded with the `overwrite` strategy
    const result = await upgradePlugin(
      { name: "level-up", strategy: "overwrite" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the on-disk tree is exactly the pin — local edits are gone
    expect(result.strategy).toBe("overwrite");
    expect(installedFile("level-up", "common.txt")).toBe("a\nb\nC\n");
    expect(installedFile("level-up", "conflict.txt")).toBe("theirs\n");
    expect(installedFile("level-up", "remote-only.txt")).toBe(
      "added upstream\n",
    );
    expect(installedFile("level-up", "local-only.txt")).toBeNull();
  });

  test("defaults to overwrite when no strategy is given", async () => {
    // GIVEN an install with a local-only file and an advanced pin
    installMergeCopy("level-up", OURS, SHA_A, BASE);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN the plugin is upgraded without a strategy
    const result = await upgradePlugin(
      { name: "level-up" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN it overwrites: the local-only file is dropped
    expect(result.strategy).toBe("overwrite");
    expect(installedFile("level-up", "local-only.txt")).toBeNull();
  });

  test("--strategy assistant writes conflict markers and reports the conflicted path", async () => {
    // GIVEN an install at SHA_A with local edits, and a pin at SHA_B
    installMergeCopy("level-up", OURS, SHA_A, BASE);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN the plugin is upgraded with the `assistant` strategy
    const result = await upgradePlugin(
      { name: "level-up", strategy: "assistant" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN it moves to the pin and records the strategy
    expect(result.outcome).toBe("upgraded");
    expect(result.toCommit).toBe(SHA_B);
    expect(result.strategy).toBe("assistant");
    // AND non-conflicting edits from both sides still auto-merge
    expect(installedFile("level-up", "common.txt")).toBe("A\nb\nC\n");
    expect(installedFile("level-up", "local-only.txt")).toBe("added locally\n");
    expect(installedFile("level-up", "remote-only.txt")).toBe(
      "added upstream\n",
    );
    // AND the true conflict carries git markers naming both commits
    const conflict = installedFile("level-up", "conflict.txt") ?? "";
    expect(conflict).toContain("<<<<<<<");
    expect(conflict).toContain(SHA_A.slice(0, 7));
    expect(conflict).toContain(SHA_B.slice(0, 7));
    expect(conflict).toContain("ours\n");
    expect(conflict).toContain("theirs\n");
    // AND the conflicted path is surfaced for the assistant to resolve
    expect(result.conflicts).toEqual(["conflict.txt"]);
    expect(result.binaryConflicts).toEqual([]);
  });

  test("--strategy assistant reports no conflicts on a clean three-way merge", async () => {
    // GIVEN an install whose only divergence from the pin auto-merges cleanly
    const cleanOurs: Tree = { "common.txt": "A\nb\nc\n" };
    const cleanBase: Tree = { "common.txt": "a\nb\nc\n" };
    const cleanTheirs: Tree = { "common.txt": "a\nb\nC\n" };
    installMergeCopy("level-up", cleanOurs, SHA_A, cleanBase);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: cleanBase, [SHA_B]: cleanTheirs });

    // WHEN the plugin is upgraded with the `assistant` strategy
    const result = await upgradePlugin(
      { name: "level-up", strategy: "assistant" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN both edits merge with no markers and nothing needs resolution
    expect(result.strategy).toBe("assistant");
    expect(result.conflicts).toEqual([]);
    expect(result.binaryConflicts).toEqual([]);
    const merged = installedFile("level-up", "common.txt") ?? "";
    expect(merged).toBe("A\nb\nC\n");
    expect(merged).not.toContain("<<<<<<<");
  });

  test("throws PluginMergeBaselineError when no fingerprint was recorded", async () => {
    // GIVEN an install whose sidecar records no fingerprint (older install)
    installMergeCopy("level-up", OURS, SHA_A, null);
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN a merge strategy is requested
    // THEN the baseline cannot be trusted, so the merge is refused
    await expect(
      upgradePlugin(
        { name: "level-up", strategy: "ours" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginMergeBaselineError);
  });

  test("throws PluginMergeBaselineError when the re-materialized base drifts from the recorded fingerprint", async () => {
    // GIVEN an install whose recorded fingerprint describes a tree that differs
    // from what re-materializing the install commit produces (an adapter
    // overlay that moved since install)
    installMergeCopy("level-up", OURS, SHA_A, {
      "common.txt": "totally different baseline\n",
    });
    const fetch = makeFetch({ manifest: manifestWith("level-up", SHA_B) });
    const runGit = treeGitRunner({ [SHA_A]: BASE, [SHA_B]: THEIRS });

    // WHEN a merge strategy is requested
    // THEN the baseline is rejected rather than producing a corrupt merge
    await expect(
      upgradePlugin(
        { name: "level-up", strategy: "theirs" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginMergeBaselineError);
  });
});
