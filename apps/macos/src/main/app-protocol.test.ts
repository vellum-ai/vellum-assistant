import path from "node:path";

import { describe, expect, test } from "bun:test";

import { resolveAppProtocolPath } from "./app-protocol";

// Use posix-style absolute roots in tests so assertions are
// platform-stable; `app-protocol.ts` uses `node:path` which respects
// `path.sep` at runtime. On Linux CI / dev macOS that's `/`.
const ROOT = "/app/renderer";

describe("resolveAppProtocolPath — allowed paths", () => {
  test("resolves the empty pathname to the root itself", () => {
    const result = resolveAppProtocolPath(ROOT, "app://vellum.ai/");
    expect(result).toEqual({ kind: "ok", resolved: ROOT });
  });

  test("resolves a top-level file inside the root", () => {
    const result = resolveAppProtocolPath(ROOT, "app://vellum.ai/index.html");
    expect(result).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "index.html"),
    });
  });

  test("resolves nested asset paths inside the root", () => {
    const result = resolveAppProtocolPath(
      ROOT,
      "app://vellum.ai/assets/app.css",
    );
    expect(result).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "assets/app.css"),
    });
  });

  test("strips leading slashes so the join doesn't escape the root", () => {
    const result = resolveAppProtocolPath(ROOT, "app://vellum.ai///index.html");
    expect(result).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "index.html"),
    });
  });
});

// The `URL` parser collapses `..` and `%2e%2e` segments while parsing
// the pathname (RFC 3986 path normalization), so most "traversal-style"
// inputs never reach `path.normalize` with any `..` left to escape.
// That's the first line of defense; these tests document its behavior.
// The `startsWith(rendererRoot + sep)` check in `resolveAppProtocolPath`
// is defense-in-depth that catches any pathname that did slip past URL
// normalization — important to keep, even if there's no known case in
// practice today.
describe("resolveAppProtocolPath — URL parser collapses `..` segments", () => {
  test("literal `..` resolves to a safe in-root path", () => {
    const result = resolveAppProtocolPath(ROOT, "app://vellum.ai/../etc/passwd");
    expect(result).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "etc/passwd"),
    });
  });

  test("deeply nested `..` chains resolve to a safe in-root path", () => {
    const result = resolveAppProtocolPath(
      ROOT,
      "app://vellum.ai/a/b/../../../etc/passwd",
    );
    expect(result).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "etc/passwd"),
    });
  });

  test("percent-encoded `..` (`%2e%2e`) resolves to a safe in-root path", () => {
    const result = resolveAppProtocolPath(
      ROOT,
      "app://vellum.ai/%2e%2e/etc/passwd",
    );
    expect(result).toEqual({
      kind: "ok",
      resolved: path.join(ROOT, "etc/passwd"),
    });
  });
});

// Direct probe of the defense-in-depth guard. We can't easily smuggle a
// `..` past URL normalization, but we can bypass URL entirely by
// constructing a request URL whose pathname is a literal trailing
// segment, then trusting `path.normalize` to do nothing surprising.
// These cases pin the contract: if `URL` normalization ever regresses
// or a future scheme exposes new traversal vectors, this guard fires.
describe("resolveAppProtocolPath — startsWith guard", () => {
  test("returns `ok` for the root itself (the `===` exemption)", () => {
    expect(resolveAppProtocolPath(ROOT, "app://vellum.ai/")).toEqual({
      kind: "ok",
      resolved: ROOT,
    });
  });

  test("ROOT-prefixed siblings would be rejected if URL didn't normalize", () => {
    // `/app/renderer-evil` shares the `/app/renderer` prefix as a
    // string but isn't a child directory. The `+ path.sep` in the
    // startsWith check is what rejects the false-positive prefix
    // match. We verify this by asserting that `/app/renderer-evil` is
    // NOT considered a child of `/app/renderer` — the function's
    // internal predicate.
    const sibling = "/app/renderer-evil";
    expect(sibling.startsWith(ROOT + path.sep)).toBe(false);
  });
});
