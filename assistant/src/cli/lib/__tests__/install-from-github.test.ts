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
  sanitizePluginName,
} from "../install-from-github.js";

/**
 * Build a GitHub Contents API fixture from an in-memory file tree.
 *
 * `tree` maps a path under the canonical prefix (e.g. `simple-memory`,
 * `simple-memory/hooks/init.ts`) to either:
 *   - a `Uint8Array`/`string` → a file with that content
 *   - `null` → a directory
 *
 * The fixture answers GET requests against
 *  - `https://api.github.com/repos/vellum-ai/vellum-assistant/contents/...`
 *  - any other URL we hand out as `download_url`
 */
function fixtureFetch(
  tree: Record<string, Uint8Array | string | null>,
): FetchLike {
  const PREFIX_API =
    "https://api.github.com/repos/vellum-ai/vellum-assistant/contents/experimental/plugins/";
  const PREFIX_RAW =
    "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/main/experimental/plugins/";

  function listing(apiPath: string): unknown {
    const rel = apiPath.startsWith("experimental/plugins/")
      ? apiPath.slice("experimental/plugins/".length)
      : apiPath;
    const prefix = rel ? rel + "/" : "";
    const direct = new Map<string, "file" | "dir">();
    for (const key of Object.keys(tree)) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (!remainder) continue;
      const [head, ...rest] = remainder.split("/");
      if (rest.length === 0) {
        const isDir = tree[key] === null;
        if (!direct.has(head!)) direct.set(head!, isDir ? "dir" : "file");
      } else {
        if (!direct.has(head!)) direct.set(head!, "dir");
      }
    }
    if (direct.size === 0) return null;
    return Array.from(direct.entries()).map(([name, type]) => ({
      name,
      // GitHub returns `path` rooted at the repo, not relative to the queried
      // directory — mirror that so the recursive copy hits the same fixture
      // handler on the way down.
      path: `experimental/plugins/${prefix}${name}`,
      type,
      size: type === "file" ? (tree[`${prefix}${name}`] as string).length : 0,
      download_url: type === "file" ? `${PREFIX_RAW}${prefix}${name}` : null,
    }));
  }

  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith(PREFIX_API)) {
      const after = url.slice(PREFIX_API.length).split("?")[0]!;
      const apiPath = `experimental/plugins/${decodeURIComponent(after)}`;
      const body = listing(apiPath);
      if (body === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith(PREFIX_RAW)) {
      const key =
        "experimental/plugins/" +
        decodeURIComponent(url.slice(PREFIX_RAW.length));
      const rel = key.slice("experimental/plugins/".length);
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

  test("respects ref by forwarding to GitHub", async () => {
    let seenRef: string | undefined;
    await installPlugin(
      { name: "demo", force: false, ref: "feat-branch" },
      {
        fetch: (async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("api.github.com")) {
            const m = /[?&]ref=([^&]+)/.exec(url);
            seenRef = m ? decodeURIComponent(m[1]!) : undefined;
            return new Response(
              JSON.stringify([
                {
                  name: "package.json",
                  path: "experimental/plugins/demo/package.json",
                  type: "file",
                  size: 2,
                  download_url:
                    "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/feat-branch/experimental/plugins/demo/package.json",
                },
              ]),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return new Response("{}", { status: 200 });
        }) as FetchLike,
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(seenRef).toBe("feat-branch");
    expect(existsSync(join(pluginsDir, "demo", "package.json"))).toBe(true);
  });

  test("rejects untrusted entry names from the GitHub response", async () => {
    // Devin P2 from PR-5 review: even though GitHub returns trustworthy data,
    // defense-in-depth requires us to validate `entry.name` before any
    // filesystem write. A malicious or buggy upstream that hands us
    // `../escape` must not be able to write outside the target.
    const badFetch: FetchLike = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.github.com")) {
        return new Response(
          JSON.stringify([
            {
              name: "../escape",
              path: "experimental/plugins/demo/../escape",
              type: "file",
              size: 1,
              download_url:
                "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/main/experimental/plugins/demo/escape",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
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

/**
 * Build a fixture that serves a marketplace manifest from the canonical repo
 * plus an external plugin repo's contents.
 *
 * `manifest` is served raw at the canonical marketplace URL. `externalTree`
 * maps repo-relative paths within `externalRepo` (e.g. `package.json`,
 * `hooks/init.ts`) to file contents or `null` for directories.
 */
function marketplaceFixtureFetch(
  manifest: unknown,
  externalRepo: string,
  externalTree: Record<string, string | null>,
  // First-party plugin trees keyed by their full repo path (e.g.
  // `experimental/plugins/caveman/package.json`). Anything not defined here
  // resolves to a 404 so the fallback path surfaces a clean not-found.
  firstPartyTree: Record<string, string | null> = {},
): FetchLike {
  const MANIFEST_URL =
    "https://api.github.com/repos/vellum-ai/vellum-assistant/contents/experimental/plugins/marketplace.json";
  const EXTERNAL_API = `https://api.github.com/repos/${externalRepo}/contents/`;
  const EXTERNAL_RAW = `https://raw.githubusercontent.com/${externalRepo}/`;
  const FIRST_PARTY_API =
    "https://api.github.com/repos/vellum-ai/vellum-assistant/contents/";
  const FIRST_PARTY_RAW =
    "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/";

  function listing(
    rel: string,
    tree: Record<string, string | null>,
    rawPrefix: string,
  ): unknown {
    const prefix = rel ? rel + "/" : "";
    const direct = new Map<string, "file" | "dir">();
    for (const key of Object.keys(tree)) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (!remainder) continue;
      const [head, ...rest] = remainder.split("/");
      if (!direct.has(head!)) {
        direct.set(
          head!,
          rest.length === 0 && tree[key] !== null ? "file" : "dir",
        );
      }
    }
    if (direct.size === 0) return null;
    return Array.from(direct.entries()).map(([name, type]) => ({
      name,
      path: `${prefix}${name}`,
      type,
      size: type === "file" ? (tree[`${prefix}${name}`] as string).length : 0,
      download_url:
        type === "file" ? `${rawPrefix}<ref>/${prefix}${name}` : null,
    }));
  }

  function rawFile(
    url: string,
    rawPrefix: string,
    tree: Record<string, string | null>,
  ): Response {
    // Strip the `<ref>/` segment we baked into download_url.
    const rel = decodeURIComponent(url.slice(rawPrefix.length)).replace(
      /^[^/]+\//,
      "",
    );
    const file = tree[rel];
    if (file === null || file === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Buffer.from(new TextEncoder().encode(file)), {
      status: 200,
    });
  }

  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith(MANIFEST_URL)) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }

    if (url.startsWith(EXTERNAL_API)) {
      const after = url.slice(EXTERNAL_API.length).split("?")[0]!;
      const body = listing(
        decodeURIComponent(after),
        externalTree,
        EXTERNAL_RAW,
      );
      if (body === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }

    if (url.startsWith(EXTERNAL_RAW)) {
      return rawFile(url, EXTERNAL_RAW, externalTree);
    }

    // First-party plugin directory listings, served from the canonical repo.
    if (url.startsWith(FIRST_PARTY_API)) {
      const after = url.slice(FIRST_PARTY_API.length).split("?")[0]!;
      const body = listing(
        decodeURIComponent(after),
        firstPartyTree,
        `${FIRST_PARTY_RAW}`,
      );
      if (body === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }

    if (url.startsWith(FIRST_PARTY_RAW)) {
      return rawFile(url, FIRST_PARTY_RAW, firstPartyTree);
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
