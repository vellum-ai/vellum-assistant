/**
 * Tests for the `assistant plugins install` command.
 *
 * Network is replaced with a fixture filesystem via the `_testHooks.fetch`
 * seam exported from `commands/plugins.ts`. Each test points the install
 * at a tmpdir workspace by setting `VELLUM_WORKSPACE_DIR` before the
 * command runs.
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

import { _internals, _testHooks } from "../commands/plugins.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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
      // GitHub returns `path` rooted at the repo, not relative to the
      // queried directory — mirror that so the recursive copy hits the
      // same fixture handler on the way down.
      path: `experimental/plugins/${prefix}${name}`,
      type,
      size: type === "file" ? (tree[`${prefix}${name}`] as string).length : 0,
      download_url:
        type === "file"
          ? `${PREFIX_RAW}${prefix}${name}`
          : null,
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

interface Captured {
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}

function captureOutput(): { captured: Captured; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  console.log = ((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  }) as typeof console.log;
  console.error = ((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  }) as typeof console.error;
  process.exitCode = undefined;
  const captured: Captured = {
    stdout,
    stderr,
    get exitCode() {
      return process.exitCode;
    },
  } as unknown as Captured;
  return {
    captured,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = origExitCode;
    },
  };
}

describe("assistant plugins install", () => {
  let ws: string;
  let originalEnv: string | undefined;
  let originalFetch: FetchLike;
  let capture: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "vellum-plugins-install-"));
    originalEnv = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = ws;
    originalFetch = _testHooks.fetch;
    capture = captureOutput();
  });

  afterEach(() => {
    capture.restore();
    if (originalEnv === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
    else process.env.VELLUM_WORKSPACE_DIR = originalEnv;
    _testHooks.fetch = originalFetch;
    rmSync(ws, { recursive: true, force: true });
  });

  test("copies the GitHub tree into <workspaceDir>/plugins/<name>", async () => {
    _testHooks.fetch = fixtureFetch({
      "simple-memory": null,
      "simple-memory/package.json": '{"name":"simple-memory"}',
      "simple-memory/README.md": "# simple-memory",
      "simple-memory/hooks": null,
      "simple-memory/hooks/init.ts": "export default async () => {};\n",
      "simple-memory/tools": null,
      "simple-memory/tools/ping.ts": "export default {};\n",
    });

    await _internals.runInstall({ name: "simple-memory", force: false, ref: "main" });

    const target = join(ws, "plugins", "simple-memory");
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "hooks", "init.ts"))).toBe(true);
    expect(existsSync(join(target, "tools", "ping.ts"))).toBe(true);
    expect(readFileSync(join(target, "package.json"), "utf-8")).toBe(
      '{"name":"simple-memory"}',
    );
    expect(capture.captured.stdout.join("\n")).toContain('Installed plugin "simple-memory"');
    expect(process.exitCode).toBeFalsy();
  });

  test("refuses to overwrite an existing install without --force", async () => {
    const target = join(ws, "plugins", "simple-memory");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "pre-existing");

    _testHooks.fetch = fixtureFetch({
      "simple-memory": null,
      "simple-memory/package.json": "{}",
    });

    await _internals.runInstall({ name: "simple-memory", force: false, ref: "main" });

    expect(process.exitCode).toBe(1);
    expect(capture.captured.stderr.join("\n")).toContain("already installed");
    // The pre-existing marker is left untouched on refusal.
    expect(readFileSync(join(target, "marker"), "utf-8")).toBe("pre-existing");
  });

  test("--force replaces an existing install", async () => {
    const target = join(ws, "plugins", "simple-memory");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "pre-existing");

    _testHooks.fetch = fixtureFetch({
      "simple-memory": null,
      "simple-memory/package.json": '{"name":"simple-memory"}',
    });

    await _internals.runInstall({ name: "simple-memory", force: true, ref: "main" });

    expect(existsSync(join(target, "marker"))).toBe(false);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(process.exitCode).toBeFalsy();
  });

  test("404 on the canonical path is reported as not-found and rolls back", async () => {
    _testHooks.fetch = fixtureFetch({}); // empty tree → 404

    await _internals.runInstall({ name: "missing-plugin", force: false, ref: "main" });

    expect(process.exitCode).toBe(1);
    expect(capture.captured.stderr.join("\n")).toContain(
      "Plugin \"missing-plugin\" not found",
    );
    // No empty target directory left behind.
    expect(existsSync(join(ws, "plugins", "missing-plugin"))).toBe(false);
  });

  test("HTTP 5xx from GitHub rolls the install back and exits 1", async () => {
    _testHooks.fetch = (async () =>
      new Response("upstream broken", { status: 503 })) as FetchLike;

    await _internals.runInstall({ name: "demo", force: false, ref: "main" });

    expect(process.exitCode).toBe(1);
    expect(capture.captured.stderr.join("\n")).toContain("Plugin install failed");
    expect(existsSync(join(ws, "plugins", "demo"))).toBe(false);
  });

  test("respects --ref by forwarding to GitHub", async () => {
    let seenRef: string | undefined;
    _testHooks.fetch = (async (input: RequestInfo | URL) => {
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
    }) as FetchLike;

    await _internals.runInstall({ name: "demo", force: false, ref: "feat-branch" });

    expect(seenRef).toBe("feat-branch");
    expect(existsSync(join(ws, "plugins", "demo", "package.json"))).toBe(true);
  });

  test.each([
    ["../escape"],
    ["/abs/path"],
    [".hidden"],
    ["Name-WithCaps"],
    [""],
    ["space name"],
  ])("rejects invalid plugin name %p", async (bad) => {
    let thrown: unknown = null;
    try {
      _internals.sanitizeName(bad);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("accepts simple kebab-case + underscores + digits", () => {
    expect(_internals.sanitizeName("simple-memory")).toBe("simple-memory");
    expect(_internals.sanitizeName("plugin_2")).toBe("plugin_2");
    expect(_internals.sanitizeName("a")).toBe("a");
  });
});
