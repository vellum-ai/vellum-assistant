import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  resolveAppProtocolPath,
  resolveRelativePath,
} from "./app-protocol";

// Use posix-style absolute roots in tests so assertions are
// platform-stable; `app-protocol.ts` uses `node:path` which respects
// `path.sep` at runtime. On Linux CI / dev macOS that's `/`.
const ROOT = "/app/renderer";

describe("resolveAppProtocolPath — allowed paths", () => {
  test("resolves the empty pathname to the root itself", () => {
    expect(resolveAppProtocolPath(ROOT, "app://vellum.ai/")).toEqual({
      kind: "ok",
      resolved: ROOT,
    });
  });

  test("resolves a top-level file inside the root", () => {
    expect(resolveAppProtocolPath(ROOT, "app://vellum.ai/index.html")).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "index.html"),
    });
  });

  test("resolves nested asset paths inside the root", () => {
    expect(
      resolveAppProtocolPath(ROOT, "app://vellum.ai/assets/app.css"),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "assets/app.css") });
  });

  test("strips leading slashes so the join doesn't escape the root", () => {
    expect(
      resolveAppProtocolPath(ROOT, "app://vellum.ai///index.html"),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "index.html") });
  });
});

// The `URL` parser collapses `..` and `%2e%2e` segments while parsing
// the pathname (RFC 3986 path normalization), so most "traversal-style"
// inputs never reach `path.normalize` with any `..` left to escape.
// That's the first line of defense; these tests document its behavior.
// The `startsWith(rendererRoot + sep)` check inside `resolveRelativePath`
// is defense-in-depth — exercised directly below — that catches any
// pathname that did slip past URL normalization.
describe("resolveAppProtocolPath — URL parser collapses `..` segments", () => {
  test("literal `..` resolves to a safe in-root path", () => {
    expect(
      resolveAppProtocolPath(ROOT, "app://vellum.ai/../etc/passwd"),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "etc/passwd") });
  });

  test("deeply nested `..` chains resolve to a safe in-root path", () => {
    expect(
      resolveAppProtocolPath(
        ROOT,
        "app://vellum.ai/a/b/../../../etc/passwd",
      ),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "etc/passwd") });
  });

  test("percent-encoded `..` (`%2e%2e`) resolves to a safe in-root path", () => {
    expect(
      resolveAppProtocolPath(ROOT, "app://vellum.ai/%2e%2e/etc/passwd"),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "etc/passwd") });
  });
});

describe("resolveAppProtocolPath — malformed input handling", () => {
  test("invalid percent-encoding returns `forbidden` instead of throwing", () => {
    // `decodeURIComponent("/%ZZ")` throws `URIError`. The wrapper
    // converts that to a clean 403 so the protocol handler doesn't
    // surface a 500 to the renderer.
    expect(resolveAppProtocolPath(ROOT, "app://vellum.ai/%ZZ")).toEqual({
      kind: "forbidden",
    });
  });
});

// Direct probes of `resolveRelativePath` — the pure guard the URL
// wrapper delegates to. These bypass URL normalization to exercise the
// `startsWith(rendererRoot + sep)` invariant for real, so a future
// regression in either the guard or URL normalization is caught here.
describe("resolveRelativePath — startsWith guard", () => {
  test("the empty path resolves to the root itself", () => {
    expect(resolveRelativePath(ROOT, "")).toEqual({
      kind: "ok",
      resolved: ROOT,
    });
  });

  test("nested in-root paths pass", () => {
    expect(resolveRelativePath(ROOT, "assets/app.css")).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "assets/app.css"),
    });
  });

  test("`..` segments surviving normalization are rejected", () => {
    expect(resolveRelativePath(ROOT, "../etc/passwd")).toEqual({
      kind: "forbidden",
    });
  });

  test("deeply nested `..` that escape the root are rejected", () => {
    expect(resolveRelativePath(ROOT, "a/../../etc/passwd")).toEqual({
      kind: "forbidden",
    });
  });

  test("ROOT-prefixed siblings are rejected (the `+ sep` is what protects)", () => {
    // `path.join("/app/renderer", "../renderer-evil/x")` →
    // `/app/renderer-evil/x`. That string starts with the literal
    // `/app/renderer` prefix but is a sibling, not a child. Adding
    // `+ path.sep` to the prefix is what keeps this out.
    expect(resolveRelativePath(ROOT, "../renderer-evil/x")).toEqual({
      kind: "forbidden",
    });
  });
});

// `apps/web/vite.config.ts` sets `base: "/assistant/"`, so the
// built HTML emits asset URLs like `/assistant/assets/index.js`.
// The renderer files on disk live directly under `rendererRoot`,
// NOT under a `/assistant/` subdirectory. The protocol handler
// passes `mountPrefix: "/assistant"` so these tests pin the
// stripping behavior.
describe("resolveAppProtocolPath — mount-prefix stripping", () => {
  test("maps `/assistant` to the root itself", () => {
    expect(
      resolveAppProtocolPath(ROOT, "app://vellum.ai/assistant", "/assistant"),
    ).toEqual({ kind: "ok", resolved: ROOT });
  });

  test("maps `/assistant/<rest>` to `rendererRoot/<rest>`", () => {
    expect(
      resolveAppProtocolPath(
        ROOT,
        "app://vellum.ai/assistant/assets/index.js",
        "/assistant",
      ),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "assets/index.js") });
  });

  test("a nested deep path under the mount maps cleanly", () => {
    expect(
      resolveAppProtocolPath(
        ROOT,
        "app://vellum.ai/assistant/assets/css/app.css",
        "/assistant",
      ),
    ).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "assets/css/app.css"),
    });
  });

  test("a path that doesn't start with the mount is passed through (and 404s as usual)", () => {
    // `/favicon.ico` lives at the bare protocol root. Stays under
    // `rendererRoot/favicon.ico` (where Vite emits favicon).
    expect(
      resolveAppProtocolPath(
        ROOT,
        "app://vellum.ai/favicon.ico",
        "/assistant",
      ),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "favicon.ico") });
  });

  test("a sibling that shares the mount prefix as a string is NOT stripped", () => {
    // `/assistantfoo` shares `/assistant` as a string prefix but
    // isn't under the mount. The strip only fires for exact match or
    // `/assistant/` prefix.
    expect(
      resolveAppProtocolPath(
        ROOT,
        "app://vellum.ai/assistantfoo/bar",
        "/assistant",
      ),
    ).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "assistantfoo/bar"),
    });
  });

  test("path-traversal guard still fires for stripped paths", () => {
    // `/assistant/../etc/passwd` — URL normalization collapses to
    // `/etc/passwd`, which doesn't start with the mount, so no strip.
    // The result lands at `rendererRoot/etc/passwd` (in-root, ok).
    expect(
      resolveAppProtocolPath(
        ROOT,
        "app://vellum.ai/assistant/../etc/passwd",
        "/assistant",
      ),
    ).toEqual({ kind: "ok", resolved: path.join(ROOT, "etc/passwd") });
  });
});
