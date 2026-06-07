/**
 * Tests for {@link installPlugin}.
 *
 * Network is replaced with an in-memory fixture passed via the `fetch`
 * dependency — no globals are monkey-patched and no `--test-hook` exports
 * leak into production code.
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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type FetchLike,
  installPlugin,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  sanitizePluginName,
} from "../install-from-github.js";

/**
 * Build a fixture for a first-party install from an in-memory file tree.
 *
 * `tree` maps a path under the canonical `experimental/plugins/` prefix (e.g.
 * `simple-memory`, `simple-memory/hooks/init.ts`) to either:
 *   - a `Uint8Array`/`string` → a file with that content
 *   - `null` → a directory
 *
 * Install fetches the whole repo tree in one `git/trees?recursive=1` request,
 * then pulls each file from `raw.githubusercontent.com`. The fixture answers:
 *  - the marketplace manifest lookup with a 404 (so resolution degrades to
 *    the first-party source — these tests don't exercise the marketplace)
 *  - `…/git/trees/<ref>?recursive=1` with the blob listing
 *  - `raw.githubusercontent.com/vellum-ai/vellum-assistant/<ref>/…` with bytes
 */
function fixtureFetch(
  tree: Record<string, Uint8Array | string | null>,
): FetchLike {
  const REPO = "vellum-ai/vellum-assistant";
  const MANIFEST_URL = `https://api.github.com/repos/${REPO}/contents/experimental/plugins/marketplace.json`;
  const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/`;
  const RAW = `https://raw.githubusercontent.com/${REPO}/`;
  const full = (key: string) => `experimental/plugins/${key}`;

  function treeBody(): unknown {
    const blobs = Object.keys(tree)
      .filter((key) => tree[key] !== null)
      .map((key) => ({ path: full(key), type: "blob", mode: "100644" }));
    return { tree: blobs, truncated: false };
  }

  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    // No marketplace manifest in these fixtures: degrade to first-party.
    if (url.startsWith(MANIFEST_URL)) {
      return new Response("not found", { status: 404 });
    }

    if (url.startsWith(TREE_API)) {
      return new Response(JSON.stringify(treeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith(RAW)) {
      // raw URL is `<RAW><ref>/experimental/plugins/<key>` — strip the ref.
      const afterRef = decodeURIComponent(url.slice(RAW.length)).replace(
        /^[^/]+\//,
        "",
      );
      const rel = afterRef.replace(/^experimental\/plugins\//, "");
      const file = tree[rel];
      if (file === null || file === undefined) {
        return new Response("not found", { status: 404 });
      }
      const bytes =
        typeof file === "string" ? new TextEncoder().encode(file) : file;
      return new Response(Buffer.from(bytes), { status: 200 });
    }

    return new Response("unexpected url: " + url, { status: 500 });
  }) as FetchLike;
}

describe("installPlugin", () => {
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

  test("copies the GitHub tree into <workspacePluginsDir>/<name>", async () => {
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
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "hooks", "init.ts"))).toBe(true);
    expect(existsSync(join(target, "tools", "ping.ts"))).toBe(true);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"simple-memory"}',
    );
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
            "simple-memory": null,
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
          "simple-memory": null,
          "simple-memory/package.json": '{"name":"simple-memory"}',
        }),
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(existsSync(join(target, "marker"))).toBe(false);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  });

  test("--force preserves the existing install when the fetch fails", async () => {
    // Codex P1 from PR-5 review: a transient 5xx during a forced re-install
    // must NOT delete the previously working plugin. The fetch error
    // surfaces, but the existing tree on disk is untouched.
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

    // Marker is still there because the failed install never touched the
    // target — the staging dir handles all writes until the swap.
    expect(readFileSync(join(target, "marker"), "utf-8")).toBe("pre-existing");
    // And no staging dir leaks into the plugins directory.
    const remaining = readdirSync(pluginsDir);
    expect(remaining).toEqual(["simple-memory"]);
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

  test("a rate-limited tree listing surfaces a retryable PluginSourceUnavailableError", async () => {
    // GIVEN GitHub's unauthenticated rate limit is exhausted: the tree
    // listing 403s with the remaining-quota header at zero
    const rateLimited: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/git\/trees\//.test(url)) {
        return new Response("rate limited", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        });
      }
      // Marketplace manifest lookup → 404 so resolution degrades to first-party.
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

  test("a forbidden tree listing with quota remaining stays a hard error", async () => {
    // GIVEN a 403 that is NOT a rate-limit (quota header present and nonzero):
    // a genuine authorization failure, not a transient one
    const forbidden: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/git\/trees\//.test(url)) {
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

  test("respects ref by forwarding to GitHub", async () => {
    // The requested ref must reach both the tree listing (in the URL path)
    // and the raw file download.
    let treeRef: string | undefined;
    let rawRef: string | undefined;
    await installPlugin(
      { name: "demo", force: false, ref: "feat-branch" },
      {
        fetch: (async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const treeMatch = /\/git\/trees\/([^?]+)\?recursive=1/.exec(url);
          if (treeMatch) {
            treeRef = decodeURIComponent(treeMatch[1]!);
            return new Response(
              JSON.stringify({
                tree: [
                  {
                    path: "experimental/plugins/demo/package.json",
                    type: "blob",
                    mode: "100644",
                  },
                ],
                truncated: false,
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          const rawMatch =
            /raw\.githubusercontent\.com\/vellum-ai\/vellum-assistant\/([^/]+)\//.exec(
              url,
            );
          if (rawMatch && url.endsWith("/package.json")) {
            rawRef = decodeURIComponent(rawMatch[1]!);
            return new Response("{}", { status: 200 });
          }
          // Marketplace manifest lookup → 404 so resolution degrades to
          // the first-party source.
          return new Response("not found", { status: 404 });
        }) as FetchLike,
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(treeRef).toBe("feat-branch");
    expect(rawRef).toBe("feat-branch");
    expect(existsSync(join(pluginsDir, "demo", "package.json"))).toBe(true);
  });

  test("rejects untrusted entry paths from the GitHub response", async () => {
    // Even though GitHub returns trustworthy data, defense-in-depth requires
    // us to validate every path segment before any filesystem write. A
    // malicious or buggy upstream that hands us `../escape` must not be able
    // to write outside the target.
    const badFetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/git\/trees\//.test(url)) {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: "experimental/plugins/demo/../escape",
                type: "blob",
                mode: "100644",
              },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("raw.githubusercontent.com")) {
        return new Response("x", { status: 200 });
      }
      // Marketplace manifest lookup → 404 so resolution degrades to
      // the first-party source.
      return new Response("not found", { status: 404 });
    }) as FetchLike;

    await expect(
      installPlugin(
        { name: "demo", force: false, ref: "main" },
        { fetch: badFetch, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toThrow(/Unsafe path segment/);

    // Nothing was written outside the target — in fact, the target itself
    // is gone because the failed install rolled back the staging dir.
    expect(existsSync(join(pluginsDir, "..", "escape"))).toBe(false);
    expect(readdirSync(pluginsDir)).toEqual([]);
  });
});

/**
 * Build a fixture that serves a marketplace manifest from the canonical repo
 * plus an external plugin repo's tree.
 *
 * `manifest` is served at the canonical marketplace contents URL.
 * `externalTree` maps repo-relative paths within `externalRepo` (e.g.
 * `package.json`, `.claude-plugin/plugin.json`) to file contents or `null`
 * for directories. `firstPartyTree` maps full canonical-repo paths (e.g.
 * `experimental/plugins/caveman/package.json`) for the first-party fallback
 * and collision cases.
 *
 * Install enumerates a repo's tree in one `git/trees?recursive=1` request
 * and downloads each file from `raw.githubusercontent.com`. The first-party
 * existence probe still uses the Contents API, so that surface is served too.
 */
function marketplaceFixtureFetch(
  manifest: unknown,
  externalRepo: string,
  externalTree: Record<string, string | null>,
  firstPartyTree: Record<string, string | null> = {},
): FetchLike {
  const CANON = "vellum-ai/vellum-assistant";
  const MANIFEST_URL = `https://api.github.com/repos/${CANON}/contents/experimental/plugins/marketplace.json`;
  const EXTERNAL_TREE = `https://api.github.com/repos/${externalRepo}/git/trees/`;
  const EXTERNAL_RAW = `https://raw.githubusercontent.com/${externalRepo}/`;
  const CANON_TREE = `https://api.github.com/repos/${CANON}/git/trees/`;
  const CANON_CONTENTS = `https://api.github.com/repos/${CANON}/contents/`;
  const CANON_RAW = `https://raw.githubusercontent.com/${CANON}/`;

  function treeBody(tree: Record<string, string | null>): unknown {
    const blobs = Object.keys(tree)
      .filter((key) => tree[key] !== null)
      .map((key) => ({ path: key, type: "blob", mode: "100644" }));
    return { tree: blobs, truncated: false };
  }

  function rawFile(
    url: string,
    rawPrefix: string,
    tree: Record<string, string | null>,
  ): Response {
    // raw URL is `<rawPrefix><ref>/<repoPath>` — strip the ref.
    const repoPath = decodeURIComponent(url.slice(rawPrefix.length)).replace(
      /^[^/]+\//,
      "",
    );
    const file = tree[repoPath];
    if (file === null || file === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Buffer.from(new TextEncoder().encode(file)), {
      status: 200,
    });
  }

  // Direct-children Contents listing, used only by the first-party probe.
  function contentsListing(
    apiPath: string,
    tree: Record<string, string | null>,
  ): unknown {
    const prefix = apiPath ? apiPath + "/" : "";
    const direct = new Set<string>();
    for (const key of Object.keys(tree)) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (!remainder) continue;
      direct.add(remainder.split("/")[0]!);
    }
    if (direct.size === 0) return null;
    return Array.from(direct).map((name) => ({
      name,
      path: `${prefix}${name}`,
      type: "dir",
    }));
  }

  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith(MANIFEST_URL)) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }

    if (url.startsWith(EXTERNAL_TREE)) {
      return new Response(JSON.stringify(treeBody(externalTree)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith(EXTERNAL_RAW)) {
      return rawFile(url, EXTERNAL_RAW, externalTree);
    }

    if (url.startsWith(CANON_TREE)) {
      return new Response(JSON.stringify(treeBody(firstPartyTree)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // First-party existence probe (Contents API), served from the canonical
    // repo. MANIFEST_URL is checked first above, so this only sees plugin dirs.
    if (url.startsWith(CANON_CONTENTS)) {
      const after = decodeURIComponent(
        url.slice(CANON_CONTENTS.length).split("?")[0]!,
      );
      const body = contentsListing(after, firstPartyTree);
      if (body === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }

    if (url.startsWith(CANON_RAW)) {
      return rawFile(url, CANON_RAW, firstPartyTree);
    }

    return new Response("unexpected url: " + url, { status: 500 });
  }) as FetchLike;
}

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
          ref: "v1.8.2",
        },
        description: "Ultra-compressed communication mode.",
      },
    ],
  };

  test("installs a whitelisted plugin from its pinned external repo + ref", async () => {
    // GIVEN a marketplace whitelisting caveman at its repo root, pinned to a tag
    const fetch = marketplaceFixtureFetch(
      CAVEMAN_MANIFEST,
      "JuliusBrussee/caveman",
      {
        "package.json": '{"name":"caveman"}',
        "README.md": "# caveman",
        ".claude-plugin": null,
        ".claude-plugin/plugin.json": "{}",
      },
    );

    // WHEN we install by name (the install ref is ignored in favor of the
    // manifest's pinned ref)
    const result = await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, workspacePluginsDir: pluginsDir },
    );

    // THEN the external tree is materialized under <pluginsDir>/caveman, and
    // the result reports the pinned ref
    const target = join(pluginsDir, "caveman");
    expect(result.target).toBe(target);
    expect(result.ref).toBe("v1.8.2");
    expect(result.fileCount).toBe(3);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"caveman"}',
    );
    expect(existsSync(join(target, ".claude-plugin", "plugin.json"))).toBe(
      true,
    );
  });

  test("a name absent from the manifest falls back to the first-party source", async () => {
    // GIVEN a manifest that does NOT whitelist "simple-memory", and an external
    // fixture that would 404 any external lookup
    const fetch = marketplaceFixtureFetch(
      CAVEMAN_MANIFEST,
      "JuliusBrussee/caveman",
      {},
    );

    // WHEN we install a first-party name, the canonical repo has no such tree
    // (the fixture only knows the manifest + caveman repo)
    // THEN resolution falls back to the first-party path and surfaces a clean
    // not-found pointing at the first-party source
    await expect(
      installPlugin(
        { name: "simple-memory", ref: "main" },
        { fetch, workspacePluginsDir: pluginsDir },
      ),
    ).rejects.toMatchObject({
      constructor: PluginNotFoundError,
      message: expect.stringContaining("vellum-ai/vellum-assistant"),
    });
  });

  test("first-party plugin wins a name collision with the marketplace", async () => {
    // GIVEN a manifest whitelisting "caveman" externally
    // AND an in-repo first-party plugin that also claims the name "caveman"
    const fetch = marketplaceFixtureFetch(
      CAVEMAN_MANIFEST,
      "JuliusBrussee/caveman",
      {
        "package.json": '{"name":"external-caveman"}',
        hooks: null,
        "hooks/init.ts": "// external",
      },
      {
        "experimental/plugins/caveman/package.json":
          '{"name":"@vellumai/caveman"}',
        "experimental/plugins/caveman/hooks": null,
        "experimental/plugins/caveman/hooks/init.ts": "// first-party",
      },
    );

    // WHEN we install by the colliding name
    const result = await installPlugin(
      { name: "caveman", ref: "main" },
      { fetch, workspacePluginsDir: pluginsDir },
    );

    // THEN the in-repo plugin is installed (matching what the search catalog
    // advertises for the name), not the external repo — the marketplace is
    // additive and never overrides a first-party plugin
    const target = join(pluginsDir, "caveman");
    expect(result.ref).toBe("main");
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"@vellumai/caveman"}',
    );
    expect(readFileSync(join(target, "hooks", "init.ts"), "utf-8")).toBe(
      "// first-party",
    );
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
