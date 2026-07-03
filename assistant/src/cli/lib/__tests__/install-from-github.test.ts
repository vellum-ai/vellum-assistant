/**
 * Tests for {@link installPlugin}.
 *
 * Whitelisted external plugins are shallow-cloned with `git` (replaced by a
 * fake {@link GitRunner} that materializes a tree into the clone dir) and,
 * when a curated adapter stub exists for the name, the stub is overlaid from
 * the GitHub Contents API (replaced by an in-memory fixture passed via the
 * `fetch` dependency). No globals are monkey-patched and no `--test-hook`
 * exports leak into production code.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type FetchLike,
  type GitRunner,
  installPlugin,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginPostinstallError,
  PluginSourceUnavailableError,
  type PostinstallRunner,
  readInstallMeta,
  sanitizePluginName,
} from "../install-from-github.js";

const CANON_REPO = "vellum-ai/vellum-assistant";
/** Synthetic host the fixtures use for Contents API `download_url`s. */
const DOWNLOAD_HOST = "https://files.test/";

/**
 * Build a `fetch` that serves the GitHub Contents API from an in-memory tree.
 *
 * `tree` is keyed by full canonical-repo path (e.g.
 * `plugins/caveman/package.json`) and maps each entry to a
 * file's content (`string`/`Uint8Array`) or `null` for an explicit directory.
 * Directory listings are derived from the key set; file `download_url`s point
 * at {@link DOWNLOAD_HOST} and are served with the stored bytes.
 *
 * The marketplace manifest lookup is answered with `manifest` (or a 404 when
 * omitted, so the name resolves to no installable source).
 */
function makeContentsFetch(opts: {
  tree: Record<string, Uint8Array | string | null>;
  manifest?: unknown;
  /**
   * HTTP status to answer the manifest fetch with. Defaults to 200 (when
   * `manifest` is provided) or 404 (when omitted). Set to a transient status
   * (e.g. 500) to simulate a marketplace lookup that fails rather than being
   * absent.
   */
  manifestStatus?: number;
}): FetchLike {
  const MANIFEST_URL = `https://api.github.com/repos/${CANON_REPO}/contents/plugins/marketplace.json`;
  const CONTENTS = `https://api.github.com/repos/${CANON_REPO}/contents/`;
  const { tree } = opts;

  function listing(apiPath: string):
    | {
        name: string;
        path: string;
        type: string;
        download_url: string | null;
      }[]
    | null {
    const prefix = apiPath ? `${apiPath}/` : "";
    const direct = new Map<string, boolean>();
    for (const key of Object.keys(tree)) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (!remainder) continue;
      const seg = remainder.split("/")[0]!;
      const isDir = remainder.includes("/") || tree[`${prefix}${seg}`] === null;
      direct.set(seg, (direct.get(seg) ?? false) || isDir);
    }
    if (direct.size === 0) return null;
    return Array.from(direct.entries()).map(([name, isDir]) => {
      const path = `${prefix}${name}`;
      return isDir
        ? { name, path, type: "dir", download_url: null }
        : { name, path, type: "file", download_url: `${DOWNLOAD_HOST}${path}` };
    });
  }

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

    if (url.startsWith(DOWNLOAD_HOST)) {
      const path = decodeURIComponent(url.slice(DOWNLOAD_HOST.length));
      const file = tree[path];
      if (file === null || file === undefined) {
        return new Response("not found", { status: 404 });
      }
      const bytes =
        typeof file === "string" ? new TextEncoder().encode(file) : file;
      return new Response(Buffer.from(bytes), { status: 200 });
    }

    if (url.startsWith(CONTENTS)) {
      const after = decodeURIComponent(
        url.slice(CONTENTS.length).split("?")[0]!,
      );
      const body = listing(after);
      if (body === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }

    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as FetchLike;
}

/**
 * Build a fake {@link GitRunner} that simulates a shallow clone.
 *
 * On `fetch`, the configured `tree` (repo-relative path → content, `null` =
 * directory) plus a token `.git/config` are written into the clone `cwd`, so
 * the subsequent copy can be asserted to include the tree and exclude `.git`.
 * `rev-parse HEAD` returns `commit`. Optional hooks let a test record the git
 * arguments or inject a fetch failure.
 */
function fakeGitRunner(opts: {
  tree: Record<string, string | null>;
  commit?: string;
  /** UNIX committer seconds reported by `git show -s --format=%ct HEAD`. */
  committedAtSeconds?: number;
  calls?: string[][];
  fetchError?: Error;
}): GitRunner {
  const commit = opts.commit ?? "abc123def4567890abc123def4567890abcdef12";
  return async (args, { cwd }) => {
    opts.calls?.push([...args]);
    switch (args[0]) {
      case "fetch": {
        if (opts.fetchError) throw opts.fetchError;
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git", "config"), "[core]\n");
        for (const [rel, content] of Object.entries(opts.tree)) {
          if (content === null) {
            mkdirSync(join(cwd, rel), { recursive: true });
            continue;
          }
          const dest = join(cwd, rel);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, content);
        }
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

/** A git runner that fails the test if any git command is invoked. */
const unusedGitRunner: GitRunner = async (args) => {
  throw new Error(`git should not run for this install: ${args.join(" ")}`);
};

/**
 * Read the real, committed caveman adapter stub from the repo so the
 * integration test exercises the adapter that ships rather than a fixture
 * copy that could drift from it. Returns every stub file keyed by its
 * Contents-API path (`plugins/caveman/<rel>`) so the fetch fake
 * serves the whole stub — package.json, the adapter, and its templates — to
 * the real postinstall runner. Resolves the stub relative to this test file.
 */
function readRealCavemanStub(): Record<string, string> {
  const repoRel = "plugins/caveman";
  const stubDir = join(import.meta.dir, "../../../../../", repoRel);
  const tree: Record<string, string> = {};
  const walk = (relDir: string): void => {
    const absDir = relDir ? join(stubDir, relDir) : stubDir;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      tree[`${repoRel}/${rel}`] = readFileSync(join(stubDir, rel), "utf-8");
    }
  };
  walk("");
  return tree;
}

const CAVEMAN_SHA = "63a91ecadbf4c4719a4602a5abb00883f9966034";

const CAVEMAN_MANIFEST = {
  name: "vellum-assistant",
  plugins: [
    {
      name: "caveman",
      source: {
        source: "github",
        repo: "JuliusBrussee/caveman",
        ref: CAVEMAN_SHA,
      },
      description: "Ultra-compressed communication mode.",
    },
  ],
};

describe("installPlugin — install lifecycle", () => {
  let ws: string;
  let pluginsDir: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "vellum-plugins-install-"));
    pluginsDir = join(ws, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("refuses to overwrite an existing install without --force", async () => {
    // GIVEN a plugin already installed at <pluginsDir>/caveman
    const target = join(pluginsDir, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"name":"caveman"}');

    // WHEN we install the same name without --force
    // THEN it refuses rather than clobbering the existing copy, and git is
    // never invoked (the guard trips before any clone)
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    await expect(
      installPlugin(
        { name: "caveman", force: false, ref: "main" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginAlreadyInstalledError);
  });

  test("--force replaces an existing install", async () => {
    // GIVEN a stale copy already on disk
    const target = join(pluginsDir, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.txt"), "old");

    // AND a clone that materializes the fresh upstream tree
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman"}', "README.md": "# caveman" },
      commit: CAVEMAN_SHA,
    });

    // WHEN we install with --force
    const result = await installPlugin(
      { name: "caveman", force: true, ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the fresh tree replaces the old copy entirely
    expect(result.target).toBe(target);
    expect(existsSync(join(target, "stale.txt"))).toBe(false);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  test("commitOverride materializes a specific commit, keeping repo from the manifest", async () => {
    // GIVEN a manifest pinning the current SHA, but an override to an older one
    const OLD_SHA = "1".repeat(40);
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const calls: string[][] = [];
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman"}' },
      commit: OLD_SHA,
      calls,
    });

    // WHEN we install with the commit override
    const result = await installPlugin(
      { name: "caveman", force: false, ref: "main", commitOverride: OLD_SHA },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the clone fetched the override commit, not the manifest's pin
    expect(calls.find((c) => c[0] === "fetch")?.at(-1)).toBe(OLD_SHA);
    expect(result.commit).toBe(OLD_SHA);
    expect(result.ref).toBe(OLD_SHA);

    // AND provenance records the override as the installed ref while still
    // resolving owner/repo from the manifest entry
    const meta = readInstallMeta(join(pluginsDir, "caveman"));
    expect(meta?.source.ref).toBe(OLD_SHA);
    expect(meta?.source.repo).toBe("caveman");
    expect(meta?.source.owner).toBe("JuliusBrussee");
    expect(meta?.author).toBe("user");
  });

  test("--force preserves the existing install when the clone fails", async () => {
    // GIVEN a working copy already on disk
    const target = join(pluginsDir, "caveman");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"name":"caveman-existing"}');

    // AND a clone that fails mid-fetch
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: {},
      fetchError: Object.assign(new Error("git fetch failed"), {
        stderr: "fatal: unable to access: Could not resolve host: github.com",
      }),
    });

    // WHEN we install with --force and the fetch fails
    // THEN the previous install is left untouched (staging never swapped in)
    await expect(
      installPlugin(
        { name: "caveman", force: true, ref: "main" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toThrow();
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"caveman-existing"}',
    );
  });
});

describe("installPlugin — marketplace resolution", () => {
  let ws: string;
  let pluginsDir: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "vellum-plugins-mkt-"));
    pluginsDir = join(ws, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("installs a whitelisted plugin by shallow-cloning its pinned repo + ref", async () => {
    // GIVEN a marketplace whitelisting caveman at its repo root, pinned to a commit SHA
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const calls: string[][] = [];
    const runGit = fakeGitRunner({
      tree: {
        "package.json": '{"name":"caveman"}',
        "README.md": "# caveman",
        ".claude-plugin": null,
        ".claude-plugin/plugin.json": "{}",
      },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
      // 2026-06-05T08:12:24Z as UNIX seconds, so the install captures it.
      committedAtSeconds: Math.floor(
        Date.parse("2026-06-05T08:12:24.000Z") / 1000,
      ),
      calls,
    });

    // WHEN we install by name (the install ref is ignored in favor of the
    // manifest's pinned ref)
    const result = await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the external tree is materialized under <pluginsDir>/caveman, the
    // result reports the pinned ref and resolved commit, and `.git` is dropped
    const target = join(pluginsDir, "caveman");
    expect(result.target).toBe(target);
    expect(result.ref).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");
    expect(result.commit).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");
    // AND the commit's committer date is captured as an ISO-8601 UTC string
    expect(result.committedAt).toBe("2026-06-05T08:12:24.000Z");
    expect(result.fileCount).toBe(3);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"caveman"}',
    );
    expect(existsSync(join(target, ".claude-plugin", "plugin.json"))).toBe(
      true,
    );
    expect(existsSync(join(target, ".git"))).toBe(false);

    // AND the clone fetched the pinned ref from the pinned repo URL.
    const fetchCall = calls.find((c) => c[0] === "fetch");
    expect(fetchCall).toContain("63a91ecadbf4c4719a4602a5abb00883f9966034");
    const remoteCall = calls.find((c) => c[0] === "remote");
    expect(remoteCall?.at(-1)).toBe(
      "https://github.com/JuliusBrussee/caveman.git",
    );

    // AND an install-meta sidecar records origin + github source + commit.
    const meta = JSON.parse(
      readFileSync(join(target, "install-meta.json"), "utf-8"),
    );
    expect(meta.origin).toBe("vellum");
    expect(meta.sourceRepo).toBe("JuliusBrussee/caveman");
    expect(meta.source.kind).toBe("github");
    expect(meta.source.owner).toBe("JuliusBrussee");
    expect(meta.source.ref).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");
    expect(meta.commit).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");

    // AND both content digests baseline the materialized tree (excluding the
    // sidecar) so later local edits are detectable.
    expect(meta.fingerprint.algorithm).toBe("sha256");
    expect(meta.fingerprint.files["package.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.fingerprint.files["install-meta.json"]).toBeUndefined();
    expect(meta.contentHash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("installs a plugin rooted at a sub-path, copying only that subtree", async () => {
    // GIVEN a marketplace entry whose source pins a directory *within* a repo
    // (a monorepo that ships several plugins) rather than the repo root.
    const NESTED_SHA = "0f".repeat(20);
    const NESTED_MANIFEST = {
      name: "vellum-assistant",
      plugins: [
        {
          name: "nested-plugin",
          source: {
            source: "github",
            repo: "example-org/monorepo",
            path: "packages/my-plugin",
            ref: NESTED_SHA,
          },
          description: "A plugin that lives in a monorepo sub-directory.",
        },
      ],
    };
    const fetch = makeContentsFetch({ tree: {}, manifest: NESTED_MANIFEST });
    // The clone carries files both at the repo root and under the pinned
    // sub-path; only the sub-path subtree should be materialized.
    const runGit = fakeGitRunner({
      tree: {
        "package.json": '{"name":"monorepo-root"}',
        "README.md": "# monorepo root",
        "packages/my-plugin/package.json": '{"name":"nested-plugin"}',
        "packages/my-plugin/README.md": "# nested plugin",
        "packages/my-plugin/hooks/init.ts": "export default async () => {};",
        "packages/other-plugin/package.json": '{"name":"other"}',
      },
      commit: NESTED_SHA,
    });

    // WHEN we install by name
    const result = await installPlugin(
      { name: "nested-plugin", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN only the sub-path subtree lands, rooted at <pluginsDir>/nested-plugin
    const target = join(pluginsDir, "nested-plugin");
    expect(result.target).toBe(target);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"nested-plugin"}',
    );
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "hooks", "init.ts"))).toBe(true);
    // AND the repo-root and sibling-package files are NOT copied in — the
    // install is scoped to the pinned directory.
    expect(result.fileCount).toBe(3);
    expect(readFileSync(join(target, "package.json"), "utf-8")).not.toContain(
      "monorepo-root",
    );
    expect(existsSync(join(target, "packages"))).toBe(false);

    // AND provenance records the sub-path so an upgrade/diff re-resolves the
    // same directory rather than the repo root.
    const meta = readInstallMeta(target);
    expect(meta?.source.owner).toBe("example-org");
    expect(meta?.source.repo).toBe("monorepo");
    expect(meta?.source.path).toBe("packages/my-plugin");
    expect(meta?.source.ref).toBe(NESTED_SHA);
  });

  test("a sub-path that does not exist in the clone surfaces a clean not-found", async () => {
    // GIVEN an entry pinning a directory the cloned ref doesn't contain
    const MISSING_SHA = "1a".repeat(20);
    const MISSING_PATH_MANIFEST = {
      name: "vellum-assistant",
      plugins: [
        {
          name: "nested-plugin",
          source: {
            source: "github",
            repo: "example-org/monorepo",
            path: "packages/does-not-exist",
            ref: MISSING_SHA,
          },
        },
      ],
    };
    const fetch = makeContentsFetch({
      tree: {},
      manifest: MISSING_PATH_MANIFEST,
    });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"monorepo-root"}' },
      commit: MISSING_SHA,
    });

    // WHEN we install
    // THEN the absent sub-path yields a hard not-found and nothing is staged
    await expect(
      installPlugin(
        { name: "nested-plugin", ref: "main" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginNotFoundError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("refuses to install when the checked-out commit differs from the pinned SHA", async () => {
    // GIVEN a clone whose resolved HEAD does not match the manifest's pinned
    // commit SHA — i.e. the upstream object served something unexpected
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman"}' },
      commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    // WHEN we install
    // THEN the integrity check fails closed rather than materializing and
    // later `import()`-ing code from an unexpected revision, and nothing lands
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginSourceUnavailableError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("a missing remote ref surfaces a clean not-found", async () => {
    // GIVEN a clone whose fetch fails because the ref doesn't exist
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: {},
      fetchError: Object.assign(new Error("git fetch failed"), {
        stderr:
          "fatal: couldn't find remote ref 63a91ecadbf4c4719a4602a5abb00883f9966034",
      }),
    });

    // WHEN we install
    // THEN it is a hard not-found, not a retryable error
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginNotFoundError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("a network failure during clone surfaces a retryable error", async () => {
    // GIVEN a clone whose fetch fails with a transient network error
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: {},
      fetchError: Object.assign(new Error("git fetch failed"), {
        stderr: "fatal: unable to access: Could not resolve host: github.com",
      }),
    });

    // WHEN we install
    // THEN it surfaces as the retryable variant so the route maps it to 503
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginSourceUnavailableError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("a name absent from the manifest is a not-found", async () => {
    // GIVEN a manifest that does NOT whitelist "simple-memory"
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });

    // WHEN we install an unlisted name
    // THEN it is a clean not-found pointing at the marketplace manifest, and
    // git is never invoked (there is no source to clone)
    await expect(
      installPlugin(
        { name: "simple-memory", ref: "main" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toMatchObject({
      constructor: PluginNotFoundError,
      message: expect.stringContaining("plugins/marketplace.json"),
    });
  });

  test("overlays a curated adapter stub and runs its postinstall transform", async () => {
    // GIVEN caveman is whitelisted externally
    // AND we curate an adapter stub for it at plugins/caveman —
    // the real, committed stub (package.json + postinstall.ts + templates), so
    // this test exercises the adapter that ships, not a fixture copy of it
    const fetch = makeContentsFetch({
      tree: readRealCavemanStub(),
      manifest: CAVEMAN_MANIFEST,
    });
    // AND the upstream clone is a Claude Code plugin: a name-mismatched
    // package.json, the `.claude-plugin/plugin.json` manifest, and the
    // terse-mode ruleset in skills/caveman/SKILL.md
    const runGit = fakeGitRunner({
      tree: {
        "package.json": JSON.stringify({
          name: "caveman-installer",
          version: "0.1.0",
          description: "Caveman installer.",
          license: "MIT",
        }),
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "caveman",
          description: "Ultra-compressed communication mode.",
        }),
        "skills/caveman/SKILL.md":
          "---\nname: caveman\ndescription: terse mode\n---\n\nCAVEMAN MODE. Drop filler words. Keep technical substance.",
      },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });

    // WHEN we install (real postinstall runner — no injected stub)
    const result = await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the materialized tree is a valid Vellum plugin: package.json `name`
    // matches the directory and declares the @vellumai/plugin-api peer dep
    // (fixing both loader warnings), and the upstream installer name is gone
    const target = join(pluginsDir, "caveman");
    expect(result.commit).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf-8"));
    expect(pkg.name).toBe("caveman");
    expect(pkg.peerDependencies["@vellumai/plugin-api"]).toBeString();
    expect(pkg.scripts?.postinstall).toBeUndefined();
    // AND every other upstream manifest field is preserved verbatim — only
    // `name` and the peer dep are touched, so the installed plugin reports the
    // upstream `version` (and description, license, …) rather than the stub's
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.description).toBe("Caveman installer.");
    expect(pkg.license).toBe("MIT");

    // AND a pre-model-call hook is synthesized carrying the upstream ruleset,
    // so caveman actually runs (terse mode injected on the user-facing call)
    const hook = readFileSync(
      join(target, "hooks", "pre-model-call.ts"),
      "utf-8",
    );
    expect(hook).toContain("PreModelCallContext");
    expect(hook).toContain('ctx.callSite !== "mainAgent"');
    expect(hook).toContain("CAVEMAN MODE. Drop filler words.");
    // AND the ruleset is sourced verbatim — the YAML frontmatter is stripped
    expect(hook).not.toContain("description: terse mode");
  });

  test("falls back to the stub manifest when the upstream ships no package.json", async () => {
    // GIVEN caveman is whitelisted with the real curated adapter stub
    const fetch = makeContentsFetch({
      tree: readRealCavemanStub(),
      manifest: CAVEMAN_MANIFEST,
    });
    // AND the upstream clone has NO package.json — only the Claude Code
    // manifest and the terse-mode ruleset the adapter reads
    const runGit = fakeGitRunner({
      tree: {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "caveman" }),
        "skills/caveman/SKILL.md":
          "---\nname: caveman\n---\n\nCAVEMAN MODE. Drop filler words.",
      },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });

    // WHEN we install (real postinstall runner)
    await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the overlaid stub is the only manifest available, so it becomes the
    // base: the loader still gets a matching `name` and the peer dep, and the
    // spent stub `postinstall` is dropped so no install machinery is shipped
    const pkg = JSON.parse(
      readFileSync(join(pluginsDir, "caveman", "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe("caveman");
    expect(pkg.peerDependencies["@vellumai/plugin-api"]).toBeString();
    expect(pkg.scripts?.postinstall).toBeUndefined();
  });

  test("strips a clone-supplied bunfig.toml so its preload can't run before the adapter", async () => {
    // GIVEN caveman is whitelisted with the real, committed adapter stub
    const fetch = makeContentsFetch({
      tree: readRealCavemanStub(),
      manifest: CAVEMAN_MANIFEST,
    });
    // AND the upstream clone is a valid Claude Code plugin that ALSO smuggles a
    // `bunfig.toml` whose `preload` points at attacker code in the clone. Bun
    // loads `$cwd/bunfig.toml` and runs `preload` before the entry point, so an
    // un-stripped config would execute `evil.ts` (writing a `pwned` sentinel)
    // ahead of the curated adapter — arbitrary code execution.
    const runGit = fakeGitRunner({
      tree: {
        "package.json": '{"name":"caveman-installer"}',
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "caveman",
          description: "Ultra-compressed communication mode.",
        }),
        "skills/caveman/SKILL.md":
          "---\nname: caveman\ndescription: terse mode\n---\n\nCAVEMAN MODE. Drop filler words. Keep technical substance.",
        "bunfig.toml": 'preload = ["./evil.ts"]\n',
        "evil.ts":
          'import { writeFileSync } from "node:fs";\nwriteFileSync("pwned", "pwned");\n',
      },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });

    // WHEN we install with the real postinstall runner (real `bun` subprocess)
    const result = await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the adapter still ran and produced a valid Vellum plugin
    const target = join(pluginsDir, "caveman");
    expect(result.commit).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");
    expect(
      readFileSync(join(target, "hooks", "pre-model-call.ts"), "utf-8"),
    ).toContain("CAVEMAN MODE. Drop filler words.");
    // AND the upstream bunfig.toml was dropped before `bun` ran, so its preload
    // never fired — no sentinel was written — and the config never persists in
    // the installed plugin
    expect(existsSync(join(target, "pwned"))).toBe(false);
    expect(existsSync(join(target, "bunfig.toml"))).toBe(false);
  });

  test("drops a clone-supplied bunfig.toml regardless of filename case", async () => {
    // GIVEN a raw external clone (no adapter stub) that smuggles a Bun config
    // under an uppercase name. The macOS install target is case-insensitive, so
    // Bun would still open a `BUNFIG.TOML`; a case-sensitive skip would miss it.
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: {
        "package.json": '{"name":"caveman"}',
        "BUNFIG.TOML": 'preload = ["./evil.ts"]\n',
      },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });

    // WHEN we install
    await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the uppercase Bun config was dropped while the plugin's own files
    // were materialized
    const target = join(pluginsDir, "caveman");
    expect(existsSync(join(target, "BUNFIG.TOML"))).toBe(false);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"caveman"}',
    );
  });

  test("stages the clone outside the served plugins/ directory", async () => {
    // GIVEN caveman is whitelisted externally (raw clone, no adapter stub)
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    // AND a git runner that records the working directory it clones into
    const cloneCwds: string[] = [];
    const runGit: GitRunner = async (args, { cwd }) => {
      if (args[0] === "fetch") {
        cloneCwds.push(cwd);
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, "package.json"), '{"name":"caveman"}');
        return { stdout: "" };
      }
      if (args[0] === "rev-parse") {
        return { stdout: "63a91ecadbf4c4719a4602a5abb00883f9966034\n" };
      }
      return { stdout: "" };
    };

    // WHEN we install
    const result = await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the half-built clone was staged in a sibling directory, never inside
    // the served plugins/ tree — so the daemon's source watcher and startup
    // loader can't observe the un-adapted clone (wrong name, no peer dep) and
    // log spurious name-mismatch / missing-peer-dependency warnings mid-install
    expect(cloneCwds).toHaveLength(1);
    expect(dirname(cloneCwds[0]!)).toBe(
      join(dirname(pluginsDir), ".plugins-staging"),
    );

    // AND the finished plugin still lands inside plugins/, with no staging
    // artifact left behind in the served directory
    expect(result.target).toBe(join(pluginsDir, "caveman"));
    expect(readdirSync(pluginsDir)).toEqual(["caveman"]);
  });

  test("does not run a postinstall for a raw clone without an adapter stub", async () => {
    // GIVEN caveman is whitelisted but we curate NO adapter stub for it
    // (the Contents API has no plugins/caveman directory)
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman"}', "hooks/init.ts": "//" },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });
    // AND a postinstall runner that fails the test if it is ever invoked
    const runPostinstall: PostinstallRunner = async () => {
      throw new Error("postinstall must not run for a stubless raw clone");
    };

    // WHEN we install
    await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, runGit, runPostinstall, workspacePluginsDir: pluginsDir },
    );

    // THEN the clone is installed verbatim — no transform ran
    const target = join(pluginsDir, "caveman");
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"caveman"}',
    );
  });

  test("aborts and rolls back when the adapter's postinstall fails", async () => {
    // GIVEN a whitelisted plugin with a curated stub declaring a postinstall
    const fetch = makeContentsFetch({
      tree: {
        "plugins/caveman/package.json": JSON.stringify({
          name: "caveman",
          scripts: { postinstall: "bun ./postinstall.ts" },
        }),
        "plugins/caveman/postinstall.ts": "// adapter",
      },
      manifest: CAVEMAN_MANIFEST,
    });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman-installer"}' },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });
    // AND its adapter exits non-zero
    const runPostinstall: PostinstallRunner = async () => {
      throw new Error("adapter blew up");
    };

    // WHEN we install
    // THEN it surfaces a PluginPostinstallError and nothing is materialized —
    // better to fail loudly than ship a half-transformed plugin
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit, runPostinstall, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginPostinstallError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("rejects a stub whose postinstall is not a single bun invocation", async () => {
    // GIVEN a curated stub whose postinstall is an arbitrary shell command
    // rather than the supported `bun <script>` adapter convention
    const fetch = makeContentsFetch({
      tree: {
        "plugins/caveman/package.json": JSON.stringify({
          name: "caveman",
          scripts: { postinstall: "rm -rf /" },
        }),
      },
      manifest: CAVEMAN_MANIFEST,
    });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman-installer"}' },
      commit: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });

    // WHEN we install (the default runner is never reached — resolution rejects
    // the command before anything executes)
    // THEN it surfaces a PluginPostinstallError and nothing is materialized
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginPostinstallError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("a transient marketplace failure surfaces a retryable error", async () => {
    // GIVEN the marketplace lookup fails transiently (e.g. rate-limit / 5xx)
    // rather than being absent, so the name can't be resolved to a source
    const fetch = makeContentsFetch({ tree: {}, manifestStatus: 500 });

    // WHEN we install the name (git never runs — there is no resolved source to
    // clone because the marketplace that would have named it was unreadable)
    // THEN it surfaces as the retryable variant so the route maps it to 503,
    // and nothing is left behind on disk
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginSourceUnavailableError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });
});

describe("installPlugin — direct (untrusted) install", () => {
  let ws: string;
  let pluginsDir: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "vellum-plugins-direct-"));
    pluginsDir = join(ws, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("installs from a caller-supplied source, bypassing the marketplace", async () => {
    // GIVEN no marketplace manifest at all (a direct install must not consult it)
    const fetch = makeContentsFetch({ tree: {} });
    const calls: string[][] = [];
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"dev-plugin"}', "hooks/init.ts": "//" },
      commit: "a".repeat(40),
      calls,
    });

    // WHEN we install directly from owner/repo on its default branch (HEAD)
    const result = await installPlugin(
      {
        name: "dev-plugin",
        directSource: {
          owner: "owner",
          repo: "dev-plugin",
          rootPath: "",
          ref: "HEAD",
        },
      },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    // THEN the tree is materialized and provenance records the direct source.
    const target = join(pluginsDir, "dev-plugin");
    expect(result.target).toBe(target);
    expect(result.fileCount).toBe(2);
    // A non-SHA ref (HEAD/branch) does NOT trip the pinned-commit integrity
    // check — the resolved commit is recorded as-is.
    expect(result.ref).toBe("HEAD");
    expect(result.commit).toBe("a".repeat(40));

    const fetchCall = calls.find((c) => c[0] === "fetch");
    expect(fetchCall?.at(-1)).toBe("HEAD");
    const remoteCall = calls.find((c) => c[0] === "remote");
    expect(remoteCall?.at(-1)).toBe("https://github.com/owner/dev-plugin.git");

    const meta = readInstallMeta(target);
    expect(meta?.source.owner).toBe("owner");
    expect(meta?.source.repo).toBe("dev-plugin");
    expect(meta?.source.ref).toBe("HEAD");
    expect(meta?.commit).toBe("a".repeat(40));
  });

  test("never overlays a curated adapter stub, even if one matches the name", async () => {
    // GIVEN a fetch that WOULD serve an adapter stub for the name, and a
    // postinstall runner that fails the test if it is ever invoked
    const fetch = makeContentsFetch({
      tree: {
        "plugins/caveman/package.json": JSON.stringify({
          name: "caveman",
          scripts: { postinstall: "bun ./postinstall.ts" },
        }),
        "plugins/caveman/postinstall.ts": "// adapter",
      },
    });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"caveman-fork"}' },
      commit: "b".repeat(40),
    });
    const runPostinstall: PostinstallRunner = async () => {
      throw new Error("adapter stub must not run for a direct install");
    };

    // WHEN we install directly
    await installPlugin(
      {
        name: "caveman",
        directSource: {
          owner: "someone",
          repo: "caveman-fork",
          rootPath: "",
          ref: "HEAD",
        },
      },
      { fetch, runGit, runPostinstall, workspacePluginsDir: pluginsDir },
    );

    // THEN the upstream manifest is installed verbatim — no stub transform ran
    const pkg = readFileSync(
      join(pluginsDir, "caveman", "package.json"),
      "utf-8",
    );
    expect(pkg).toBe('{"name":"caveman-fork"}');
  });

  test("a direct install from a sub-path copies only that subtree", async () => {
    const fetch = makeContentsFetch({ tree: {} });
    const runGit = fakeGitRunner({
      tree: {
        "package.json": '{"name":"monorepo"}',
        "packages/leaf/package.json": '{"name":"leaf"}',
      },
      commit: "c".repeat(40),
    });

    const result = await installPlugin(
      {
        name: "leaf",
        directSource: {
          owner: "owner",
          repo: "monorepo",
          rootPath: "packages/leaf",
          ref: "main",
        },
      },
      { fetch, runGit, workspacePluginsDir: pluginsDir },
    );

    const target = join(pluginsDir, "leaf");
    expect(result.fileCount).toBe(1);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"leaf"}',
    );
    expect(existsSync(join(target, "packages"))).toBe(false);
  });

  test("a direct install pinned to a full SHA still enforces the integrity check", async () => {
    // GIVEN a pinned SHA whose checked-out commit diverges
    const fetch = makeContentsFetch({ tree: {} });
    const runGit = fakeGitRunner({
      tree: { "package.json": '{"name":"x"}' },
      commit: "d".repeat(40),
    });

    // WHEN the direct ref is a full SHA, the resolved commit must match it
    await expect(
      installPlugin(
        {
          name: "x",
          directSource: {
            owner: "owner",
            repo: "x",
            rootPath: "",
            ref: "e".repeat(40),
          },
        },
        { fetch, runGit, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginSourceUnavailableError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });
});

describe("sanitizePluginName", () => {
  test.each([
    ["../escape"],
    ["/abs/path"],
    [".hidden"],
    ["Name-WithCaps"],
    [""],
    ["space name"],
  ])("rejects invalid plugin name %p", (bad) => {
    expect(() => sanitizePluginName(bad)).toThrow(InvalidPluginNameError);
  });

  test("accepts simple kebab-case + underscores + digits", () => {
    expect(sanitizePluginName("simple-memory")).toBe("simple-memory");
    expect(sanitizePluginName("plugin_2")).toBe("plugin_2");
    expect(sanitizePluginName("a")).toBe("a");
  });

  test.each(["default-advisor", "default-memory", "default-", "default-x"])(
    "rejects reserved prefix name %p",
    (reserved) => {
      expect(() => sanitizePluginName(reserved)).toThrow(
        InvalidPluginNameError,
      );
    },
  );
});
