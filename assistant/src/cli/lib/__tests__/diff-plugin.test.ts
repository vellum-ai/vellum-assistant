/**
 * Tests for {@link diffPlugin}.
 *
 * A diff re-materializes the recorded install commit through the same pipeline
 * install uses, then compares that baseline tree against the on-disk install.
 * The clone is replaced with a fake {@link GitRunner} that writes a known
 * baseline tree, the adapter-stub lookup is answered 404 by an in-memory
 * `fetch` (so the clone is treated as a raw external tree), and the install
 * target is a real temp directory passed via `workspacePluginsDir` — no globals
 * are patched. Fixtures vary the on-disk tree to exercise modified/added/
 * removed drift, binary content, and the clean case.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { diffPlugin, PluginDiffUnavailableError } from "../diff-plugin.js";
import type { FetchLike } from "../fetch-like.js";
import { type GitRunner, PluginNotFoundError } from "../install-from-github.js";
import { PluginNotInstalledError } from "../uninstall-plugin.js";

const SHA_A = "a".repeat(40);

/** Bytes for each baseline / on-disk file, keyed by repo-relative POSIX path. */
type Tree = Record<string, string | Buffer>;

/**
 * Build a `fetch` that answers the GitHub Contents API listing (the adapter
 * stub lookup) with a 404, so the clone is materialized as a raw external tree
 * with no overlay. Anything else surfaces a 500 so test bugs are loud.
 */
function makeFetch(): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.github.com")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as FetchLike;
}

/**
 * A fake clone that materializes `files` into the scratch clone dir at `fetch`
 * and reports `commit` at HEAD, mirroring how the real git pipeline stages a
 * tree before it is copied into the destination.
 */
function fakeGitRunner(commit: string, files: Tree): GitRunner {
  return async (args, { cwd }) => {
    switch (args[0]) {
      case "fetch": {
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git", "config"), "[core]\n");
        for (const [rel, content] of Object.entries(files)) {
          const abs = join(cwd, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
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
  throw new Error(`git should not run for this diff: ${args.join(" ")}`);
};

/**
 * Per-file SHA-256 digest of a tree, in the {@link Fingerprint} shape install
 * records in `install-meta.json`. Drift is classified against this recorded
 * baseline (as `inspect` does), so each fixture records the digest of its
 * install-time tree.
 */
function fingerprintOf(tree: Tree): {
  algorithm: "sha256";
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  for (const [rel, content] of Object.entries(tree)) {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    files[rel] = createHash("sha256").update(buf).digest("hex");
  }
  return { algorithm: "sha256", files };
}

/**
 * Materialize an installed plugin copy with `files` on disk and an optional
 * provenance sidecar. `sidecar: null` writes no `install-meta.json`; a sidecar
 * with `commit: null` records an install that captured no commit. `baseline`
 * is the install-time tree whose fingerprint is recorded — drift is classified
 * against it (as `inspect` does); omit it to record an install with no
 * fingerprint (an older or manually-copied install).
 */
function installCopy(
  pluginsDir: string,
  name: string,
  files: Tree,
  sidecar: {
    commit: string | null;
    committedAt?: string;
    baseline?: Tree;
  } | null,
): void {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
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
          ref: SHA_A,
        },
        commit: sidecar.commit,
        committedAt: sidecar.committedAt,
        installedAt: "2026-06-10T12:00:00.000Z",
        fingerprint:
          sidecar.baseline !== undefined
            ? fingerprintOf(sidecar.baseline)
            : null,
      }),
    );
  }
}

let ws: string;
let pluginsDir: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "diff-plugin-"));
  pluginsDir = join(ws, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("diffPlugin", () => {
  test("reports a unified diff for a file edited since install", async () => {
    // GIVEN a plugin whose install baseline declares a two-line file
    const baseline: Tree = {
      "package.json": '{"name":"level-up"}',
      "src/skill.ts": "export const a = 1;\nexport const b = 2;\n",
    };
    // AND the on-disk copy edited the second line of that file
    installCopy(
      pluginsDir,
      "level-up",
      {
        "package.json": '{"name":"level-up"}',
        "src/skill.ts": "export const a = 1;\nexport const b = 99;\n",
      },
      { commit: SHA_A, baseline },
    );

    // WHEN the plugin is diffed against its install commit
    const result = await diffPlugin(
      { name: "level-up" },
      {
        fetch: makeFetch(),
        runGit: fakeGitRunner(SHA_A, baseline),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN the recorded baseline commit is reported as drifted
    expect(result.commit).toBe(SHA_A);
    expect(result.clean).toBe(false);
    // AND exactly the edited file is surfaced as modified
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file.path).toBe("src/skill.ts");
    expect(file.status).toBe("modified");
    expect(file.binary).toBe(false);
    expect(file.reconstructed).toBe(true);
    // AND the unified diff shows the old and new line
    expect(file.diff).toContain("-export const b = 2;");
    expect(file.diff).toContain("+export const b = 99;");
    expect(file.diff).toContain("a/src/skill.ts");
    expect(file.diff).toContain("b/src/skill.ts");
  });

  test("classifies added and removed files against the baseline", async () => {
    // GIVEN a baseline with a single source file besides the manifest
    const baseline: Tree = {
      "package.json": '{"name":"level-up"}',
      "src/old.ts": "export const gone = true;\n",
    };
    // AND an on-disk copy that dropped that file and added a new one
    installCopy(
      pluginsDir,
      "level-up",
      {
        "package.json": '{"name":"level-up"}',
        "src/new.ts": "export const added = true;\n",
      },
      { commit: SHA_A, baseline },
    );

    // WHEN the plugin is diffed
    const result = await diffPlugin(
      { name: "level-up" },
      {
        fetch: makeFetch(),
        runGit: fakeGitRunner(SHA_A, baseline),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN both the addition and the removal are reported, sorted by path
    expect(result.clean).toBe(false);
    expect(result.files.map((f) => [f.path, f.status])).toEqual([
      ["src/new.ts", "added"],
      ["src/old.ts", "removed"],
    ]);
    // AND each side diffs against /dev/null like git
    const added = result.files[0];
    const removed = result.files[1];
    expect(added.diff).toContain("+export const added = true;");
    expect(added.diff).toContain("/dev/null");
    expect(removed.diff).toContain("-export const gone = true;");
    expect(removed.diff).toContain("/dev/null");
  });

  test("reports clean when the on-disk tree matches the baseline", async () => {
    // GIVEN a baseline and an identical on-disk copy
    const tree: Tree = {
      "package.json": '{"name":"level-up"}',
      "src/skill.ts": "export const a = 1;\n",
    };
    installCopy(pluginsDir, "level-up", tree, {
      commit: SHA_A,
      baseline: tree,
    });

    // WHEN the plugin is diffed
    const result = await diffPlugin(
      { name: "level-up" },
      {
        fetch: makeFetch(),
        runGit: fakeGitRunner(SHA_A, tree),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN no drift is reported and the file list is empty
    expect(result.clean).toBe(true);
    expect(result.files).toHaveLength(0);
  });

  test("excludes the provenance sidecar from the diff", async () => {
    // GIVEN a baseline (which never contains install-meta.json) and an on-disk
    // copy identical to it apart from the sidecar install always writes
    const tree: Tree = { "package.json": '{"name":"level-up"}' };
    installCopy(pluginsDir, "level-up", tree, {
      commit: SHA_A,
      baseline: tree,
    });

    // WHEN the plugin is diffed
    const result = await diffPlugin(
      { name: "level-up" },
      {
        fetch: makeFetch(),
        runGit: fakeGitRunner(SHA_A, tree),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN the sidecar is not surfaced as a local addition
    expect(result.clean).toBe(true);
    expect(result.files.map((f) => f.path)).not.toContain("install-meta.json");
  });

  test("marks a drifted binary file instead of emitting a line diff", async () => {
    // GIVEN a baseline binary blob and an on-disk copy with different bytes
    const baseline: Tree = {
      "package.json": '{"name":"level-up"}',
      "assets/icon.bin": Buffer.from([0x00, 0x01, 0x02, 0x03]),
    };
    installCopy(
      pluginsDir,
      "level-up",
      {
        "package.json": '{"name":"level-up"}',
        "assets/icon.bin": Buffer.from([0x00, 0xff, 0xfe, 0xfd]),
      },
      { commit: SHA_A, baseline },
    );

    // WHEN the plugin is diffed
    const result = await diffPlugin(
      { name: "level-up" },
      {
        fetch: makeFetch(),
        runGit: fakeGitRunner(SHA_A, baseline),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN the binary file is flagged rather than line-diffed
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file.path).toBe("assets/icon.bin");
    expect(file.binary).toBe(true);
    expect(file.reconstructed).toBe(true);
    expect(file.diff).toContain("Binary files differ");
  });

  test("flags a file whose install-time baseline cannot be reconstructed", async () => {
    // GIVEN an install whose recorded fingerprint captured one version of a file
    const recorded: Tree = {
      "package.json": '{"name":"level-up"}',
      "src/skill.ts": "export const v = 1;\n",
    };
    // AND an on-disk copy the user edited (drift vs the recorded baseline)
    installCopy(
      pluginsDir,
      "level-up",
      {
        "package.json": '{"name":"level-up"}',
        "src/skill.ts": "export const v = 2;\n",
      },
      { commit: SHA_A, baseline: recorded },
    );
    // AND a re-materialization that yields DIFFERENT bytes than were recorded
    // (e.g. the curated adapter overlay moved since install), so the baseline
    // bytes cannot be faithfully reconstructed for this file
    const driftedClone: Tree = {
      "package.json": '{"name":"level-up"}',
      "src/skill.ts": "export const v = 3;\n",
    };

    // WHEN the plugin is diffed
    const result = await diffPlugin(
      { name: "level-up" },
      {
        fetch: makeFetch(),
        runGit: fakeGitRunner(SHA_A, driftedClone),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN the file is still reported as drifted (classified vs the recorded
    // fingerprint, like inspect), but flagged rather than diffed against the
    // fabricated baseline bytes
    expect(result.clean).toBe(false);
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file.path).toBe("src/skill.ts");
    expect(file.status).toBe("modified");
    expect(file.reconstructed).toBe(false);
    expect(file.diff).toContain("Baseline unavailable");
    // AND the re-materialized (wrong) bytes are never presented as the baseline
    expect(file.diff).not.toContain("export const v = 3;");
  });

  test("throws PluginNotInstalledError when no copy is installed", async () => {
    // GIVEN an empty plugins directory
    // WHEN a plugin that was never installed is diffed
    // THEN it reports the install is missing (git is never reached)
    await expect(
      diffPlugin(
        { name: "level-up" },
        {
          fetch: makeFetch(),
          runGit: unusedGitRunner,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotInstalledError);
  });

  test("throws PluginDiffUnavailableError when the install recorded no commit", async () => {
    // GIVEN an installed copy whose sidecar captured no commit
    installCopy(
      pluginsDir,
      "level-up",
      { "package.json": '{"name":"level-up"}' },
      { commit: null },
    );

    // WHEN the plugin is diffed
    // THEN there is no immutable baseline to re-materialize (git is never run)
    await expect(
      diffPlugin(
        { name: "level-up" },
        {
          fetch: makeFetch(),
          runGit: unusedGitRunner,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginDiffUnavailableError);
  });

  test("throws PluginNotFoundError when the recorded commit yields no tree", async () => {
    // GIVEN an installed copy with a recorded commit and fingerprint (so the
    // baseline-classification guard passes and execution reaches the clone)
    installCopy(
      pluginsDir,
      "level-up",
      { "package.json": '{"name":"level-up"}' },
      { commit: SHA_A, baseline: { "package.json": '{"name":"level-up"}' } },
    );
    // AND a clone that materializes no files (the commit/sub-path is gone)
    const emptyClone = fakeGitRunner(SHA_A, {});

    // WHEN the plugin is diffed
    // THEN the missing baseline is surfaced as not-found
    await expect(
      diffPlugin(
        { name: "level-up" },
        {
          fetch: makeFetch(),
          runGit: emptyClone,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotFoundError);
  });
});
