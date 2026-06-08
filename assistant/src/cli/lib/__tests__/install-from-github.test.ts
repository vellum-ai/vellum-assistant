/**
 * Tests for {@link installPlugin}.
 *
 * Two materialization paths are exercised without touching the network or
 * spawning real subprocesses:
 *   - First-party plugins are fetched from the GitHub Contents API, replaced
 *     by an in-memory fixture passed via the `fetch` dependency.
 *   - External (whitelisted) plugins are shallow-cloned with `git`, replaced
 *     by a fake {@link GitRunner} that materializes a tree into the clone dir.
 * No globals are monkey-patched and no `--test-hook` exports leak into
 * production code.
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
  sanitizePluginName,
} from "../install-from-github.js";

const CANON_REPO = "vellum-ai/vellum-assistant";
/** Synthetic host the fixtures use for Contents API `download_url`s. */
const DOWNLOAD_HOST = "https://files.test/";

/**
 * Build a `fetch` that serves the GitHub Contents API from an in-memory tree.
 *
 * `tree` is keyed by full canonical-repo path (e.g.
 * `experimental/plugins/simple-memory/package.json`) and maps each entry to a
 * file's content (`string`/`Uint8Array`) or `null` for an explicit directory.
 * Directory listings are derived from the key set; file `download_url`s point
 * at {@link DOWNLOAD_HOST} and are served with the stored bytes.
 *
 * The marketplace manifest lookup is answered with `manifest` (or a 404 when
 * omitted, so resolution degrades to the first-party source).
 */
function makeContentsFetch(opts: {
  tree: Record<string, Uint8Array | string | null>;
  manifest?: unknown;
  /**
   * HTTP status to answer the manifest fetch with. Defaults to 200 (when
   * `manifest` is provided) or 404 (when omitted). Set to a transient status
   * (e.g. 500) to simulate a marketplace lookup that fails rather than being
   * absent — exercising the degrade-to-first-party path.
   */
  manifestStatus?: number;
}): FetchLike {
  const MANIFEST_URL = `https://api.github.com/repos/${CANON_REPO}/contents/experimental/plugins/marketplace.json`;
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

/** First-party fixture: keys are relative to `experimental/plugins/`. */
function fixtureFetch(
  tree: Record<string, Uint8Array | string | null>,
): FetchLike {
  const full: Record<string, Uint8Array | string | null> = {};
  for (const [key, value] of Object.entries(tree)) {
    full[`experimental/plugins/${key}`] = value;
  }
  return makeContentsFetch({ tree: full });
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
      default:
        return { stdout: "" };
    }
  };
}

/** A git runner that fails the test if any git command is invoked. */
const unusedGitRunner: GitRunner = async (args) => {
  throw new Error(
    `git should not run for a first-party install: ${args.join(" ")}`,
  );
};

/**
 * Read the real, committed caveman adapter stub from the repo so the
 * integration test exercises the adapter that ships rather than a fixture
 * copy that could drift from it. Returns every stub file keyed by its
 * Contents-API path (`experimental/plugins/caveman/<rel>`) so the fetch fake
 * serves the whole stub — package.json, the adapter, and its templates — to
 * the real postinstall runner. Resolves the stub relative to this test file.
 */
function readRealCavemanStub(): Record<string, string> {
  const repoRel = "experimental/plugins/caveman";
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

describe("installPlugin — first-party", () => {
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

  test("copies a first-party plugin into <workspacePluginsDir>/<name>", async () => {
    const result = await installPlugin(
      { name: "simple-memory", force: false, ref: "main" },
      {
        fetch: fixtureFetch({
          "simple-memory": null,
          "simple-memory/package.json": '{"name":"simple-memory"}',
          "simple-memory/README.md": "# simple-memory",
          "simple-memory/hooks": null,
          "simple-memory/hooks/init.ts": "export default async () => {};\n",
          "simple-memory/tools": null,
          "simple-memory/tools/ping.ts": "export default {};\n",
        }),
        workspacePluginsDir: pluginsDir,
      },
    );

    const target = join(pluginsDir, "simple-memory");
    expect(result.target).toBe(target);
    expect(result.fileCount).toBe(4);
    expect(result.ref).toBe("main");
    // First-party installs have no clone, so no commit is resolved.
    expect(result.commit).toBeNull();
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "hooks", "init.ts"))).toBe(true);
    expect(existsSync(join(target, "tools", "ping.ts"))).toBe(true);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"simple-memory"}',
    );
  });

  test("writes a provenance manifest recording the source and ref", async () => {
    // GIVEN a first-party install
    const target = join(pluginsDir, "simple-memory");

    // WHEN it completes
    await installPlugin(
      { name: "simple-memory", force: false, ref: "main" },
      {
        fetch: fixtureFetch({
          "simple-memory/package.json": '{"name":"simple-memory"}',
        }),
        workspacePluginsDir: pluginsDir,
      },
    );

    // THEN a hidden manifest records the resolved coordinates (no commit for
    // first-party) and is not counted as a plugin file
    const manifest = JSON.parse(
      readFileSync(join(target, ".vellum-plugin.json"), "utf-8"),
    );
    expect(manifest.name).toBe("simple-memory");
    expect(manifest.source.kind).toBe("first-party");
    expect(manifest.source.repo).toBe("vellum-assistant");
    expect(manifest.source.ref).toBe("main");
    expect(manifest.commit).toBeUndefined();
  });

  test("refuses to overwrite an existing install without --force", async () => {
    const target = join(pluginsDir, "simple-memory");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "pre-existing");

    await expect(
      installPlugin(
        { name: "simple-memory", force: false, ref: "main" },
        {
          fetch: fixtureFetch({
            "simple-memory/package.json": "{}",
          }),
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginAlreadyInstalledError);

    // The pre-existing marker is left untouched on refusal.
    expect(readFileSync(join(target, "marker"), "utf-8")).toBe("pre-existing");
  });

  test("--force replaces an existing install", async () => {
    const target = join(pluginsDir, "simple-memory");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "pre-existing");

    await installPlugin(
      { name: "simple-memory", force: true, ref: "main" },
      {
        fetch: fixtureFetch({
          "simple-memory/package.json": '{"name":"simple-memory"}',
        }),
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(existsSync(join(target, "marker"))).toBe(false);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  });

  test("--force preserves the existing install when the fetch fails", async () => {
    // A transient 5xx during a forced re-install must NOT delete the
    // previously working plugin. The fetch error surfaces, but the existing
    // tree on disk is untouched (all writes go through the staging dir).
    const target = join(pluginsDir, "simple-memory");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "pre-existing");

    await expect(
      installPlugin(
        { name: "simple-memory", force: true, ref: "main" },
        {
          fetch: (async () =>
            new Response("upstream broken", { status: 503 })) as FetchLike,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toThrow(/HTTP 503/);

    expect(readFileSync(join(target, "marker"), "utf-8")).toBe("pre-existing");
    // And no staging dir leaks into the plugins directory.
    expect(readdirSync(pluginsDir)).toEqual(["simple-memory"]);
  });

  test("404 on the canonical path is reported as not-found", async () => {
    await expect(
      installPlugin(
        { name: "missing-plugin", force: false, ref: "main" },
        {
          fetch: fixtureFetch({}),
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotFoundError);

    expect(existsSync(join(pluginsDir, "missing-plugin"))).toBe(false);
    // And no staging dir leaks either.
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("HTTP 5xx from GitHub propagates and leaves no staging behind", async () => {
    await expect(
      installPlugin(
        { name: "demo", force: false, ref: "main" },
        {
          fetch: (async () =>
            new Response("upstream broken", { status: 503 })) as FetchLike,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toThrow(/HTTP 503/);

    expect(existsSync(join(pluginsDir, "demo"))).toBe(false);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("a rate-limited contents listing surfaces a retryable PluginSourceUnavailableError", async () => {
    // GIVEN GitHub's unauthenticated rate limit is exhausted: the contents
    // listing 403s with the remaining-quota header at zero
    const rateLimited: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/contents/")) {
        return new Response("rate limited", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as FetchLike;

    // WHEN we install
    // THEN the failure is classified as transient (retryable), not a hard
    // error, so the route can surface a 503 instead of a 500
    await expect(
      installPlugin(
        { name: "demo", force: false, ref: "main" },
        { fetch: rateLimited, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginSourceUnavailableError);

    // AND no staging dir leaks behind on the transient failure.
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("a forbidden contents listing with quota remaining stays a hard error", async () => {
    // GIVEN a 403 that is NOT a rate-limit (quota header present and nonzero):
    // a genuine authorization failure, not a transient one
    const forbidden: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/contents/")) {
        return new Response("forbidden", {
          status: 403,
          headers: { "x-ratelimit-remaining": "57" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as FetchLike;

    // WHEN we install
    // THEN it surfaces as a hard error — NOT the retryable variant — so the
    // route maps it to 500 rather than inviting an endless retry loop
    await expect(
      installPlugin(
        { name: "demo", force: false, ref: "main" },
        { fetch: forbidden, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.not.toBeInstanceOf(PluginSourceUnavailableError);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  test("respects ref by forwarding it to the contents listing", async () => {
    // The requested ref must reach the first-party contents listing request.
    let listRef: string | undefined;
    const base = fixtureFetch({ "demo/package.json": "{}" });
    const fetch: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const match = /\/contents\/experimental\/plugins\/demo\?ref=([^&]+)/.exec(
        url,
      );
      if (match) listRef = decodeURIComponent(match[1]!);
      return base(url, init);
    };

    await installPlugin(
      { name: "demo", force: false, ref: "feat-branch" },
      { fetch, workspacePluginsDir: pluginsDir },
    );

    expect(listRef).toBe("feat-branch");
    expect(existsSync(join(pluginsDir, "demo", "package.json"))).toBe(true);
  });

  test("rejects untrusted entry names from the GitHub response", async () => {
    // Even though GitHub returns trustworthy data, defense-in-depth requires
    // us to validate every entry name before any filesystem write. A malicious
    // or buggy upstream that hands us `../escape` must not write outside the
    // target.
    const badFetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("marketplace.json")) {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/contents/")) {
        return new Response(
          JSON.stringify([
            {
              name: "../escape",
              path: "experimental/plugins/demo/../escape",
              type: "file",
              download_url: `${DOWNLOAD_HOST}escape`,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("x", { status: 200 });
    }) as FetchLike;

    await expect(
      installPlugin(
        { name: "demo", force: false, ref: "main" },
        { fetch: badFetch, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toThrow(/Unsafe entry name/);

    // Nothing was written outside the target — in fact, the target itself
    // is gone because the failed install rolled back the staging dir.
    expect(existsSync(join(pluginsDir, "..", "escape"))).toBe(false);
    expect(readdirSync(pluginsDir)).toEqual([]);
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

  const CAVEMAN_MANIFEST = {
    name: "vellum-assistant",
    plugins: [
      {
        name: "caveman",
        source: {
          source: "github",
          repo: "JuliusBrussee/caveman",
          ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
        },
        description: "Ultra-compressed communication mode.",
      },
    ],
  };

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

    // AND a provenance manifest records the external source + commit.
    const manifest = JSON.parse(
      readFileSync(join(target, ".vellum-plugin.json"), "utf-8"),
    );
    expect(manifest.source.kind).toBe("external");
    expect(manifest.source.owner).toBe("JuliusBrussee");
    expect(manifest.source.ref).toBe(
      "63a91ecadbf4c4719a4602a5abb00883f9966034",
    );
    expect(manifest.commit).toBe("63a91ecadbf4c4719a4602a5abb00883f9966034");
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

  test("a name absent from the manifest falls back to the first-party source", async () => {
    // GIVEN a manifest that does NOT whitelist "simple-memory", and no such
    // first-party tree in the canonical repo
    const fetch = makeContentsFetch({ tree: {}, manifest: CAVEMAN_MANIFEST });

    // WHEN we install a first-party name
    // THEN resolution falls back to the first-party path and surfaces a clean
    // not-found pointing at the first-party source (git is never invoked)
    await expect(
      installPlugin(
        { name: "simple-memory", ref: "main" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toMatchObject({
      constructor: PluginNotFoundError,
      message: expect.stringContaining("vellum-ai/vellum-assistant"),
    });
  });

  test("overlays a curated adapter stub and runs its postinstall transform", async () => {
    // GIVEN caveman is whitelisted externally
    // AND we curate an adapter stub for it at experimental/plugins/caveman —
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
        "package.json": '{"name":"caveman-installer"}',
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

  test("does not run a postinstall for a raw clone without an adapter stub", async () => {
    // GIVEN caveman is whitelisted but we curate NO adapter stub for it
    // (the Contents API has no experimental/plugins/caveman directory)
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
        "experimental/plugins/caveman/package.json": JSON.stringify({
          name: "caveman",
          scripts: { postinstall: "bun ./postinstall.ts" },
        }),
        "experimental/plugins/caveman/postinstall.ts": "// adapter",
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
        "experimental/plugins/caveman/package.json": JSON.stringify({
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

  test("refuses to install an adapter stub as first-party when the marketplace lookup fails", async () => {
    // GIVEN the marketplace lookup fails transiently (e.g. rate-limit / 5xx)
    // rather than being absent, so resolution degrades to the first-party path
    // AND the same-named in-repo directory is an adapter stub (a package.json
    // with a postinstall + adapter script, but no hooks/tools of its own)
    const fetch = makeContentsFetch({
      tree: {
        "experimental/plugins/caveman/package.json": JSON.stringify({
          name: "caveman",
          scripts: { postinstall: "bun ./postinstall.ts" },
        }),
        "experimental/plugins/caveman/postinstall.ts": "// adapter",
      },
      manifestStatus: 500,
    });

    // WHEN we install the name (git never runs — there is no external source to
    // clone because the marketplace that would have named it was unreadable)
    // THEN it fails loudly with a PluginPostinstallError instead of
    // materializing the bare stub as a non-functional standalone plugin, and
    // nothing is left behind on disk
    await expect(
      installPlugin(
        { name: "caveman", ref: "main" },
        { fetch, runGit: unusedGitRunner, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toBeInstanceOf(PluginPostinstallError);
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
});
