import path from "node:path";

import { describe, expect, test } from "bun:test";

import { resolveRelativePath } from "./app-protocol";
import { mimeTypeForPath, resolveBundlePath } from "./vellumapp-protocol";

const BUNDLES_ROOT = "/data/bundles";
const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const BUNDLE_ROOT = path.join(BUNDLES_ROOT, VALID_UUID);

describe("resolveBundlePath — valid inputs", () => {
  test("resolves a top-level file inside the bundle", () => {
    expect(
      resolveBundlePath(
        BUNDLES_ROOT,
        `vellumapp://${VALID_UUID}/index.html`,
      ),
    ).toEqual({
      kind: "ok",
      uuid: VALID_UUID,
      resolved: path.join(BUNDLE_ROOT, "index.html"),
    });
  });

  test("resolves a nested asset path", () => {
    expect(
      resolveBundlePath(
        BUNDLES_ROOT,
        `vellumapp://${VALID_UUID}/assets/style.css`,
      ),
    ).toEqual({
      kind: "ok",
      uuid: VALID_UUID,
      resolved: path.join(BUNDLE_ROOT, "assets/style.css"),
    });
  });

  test("resolves the bare root to the bundle directory itself", () => {
    expect(
      resolveBundlePath(BUNDLES_ROOT, `vellumapp://${VALID_UUID}/`),
    ).toEqual({
      kind: "ok",
      uuid: VALID_UUID,
      resolved: BUNDLE_ROOT,
    });
  });
});

// The `URL` parser collapses `..` and `%2e%2e` segments during parsing
// (RFC 3986 path normalization), so most traversal-style inputs never
// reach `resolveRelativePath` with any `..` left to escape. This is the
// first line of defense; these tests document its behavior. The
// `resolveRelativePath` guard (tested below) is defense-in-depth.
describe("resolveBundlePath — URL parser collapses `..` segments", () => {
  test("literal `..` resolves to a safe in-bundle path", () => {
    expect(
      resolveBundlePath(
        BUNDLES_ROOT,
        `vellumapp://${VALID_UUID}/../etc/passwd`,
      ),
    ).toEqual({
      kind: "ok",
      uuid: VALID_UUID,
      resolved: path.join(BUNDLE_ROOT, "etc/passwd"),
    });
  });

  test("deeply nested `..` chains resolve to a safe in-bundle path", () => {
    expect(
      resolveBundlePath(
        BUNDLES_ROOT,
        `vellumapp://${VALID_UUID}/a/../../etc/passwd`,
      ),
    ).toEqual({
      kind: "ok",
      uuid: VALID_UUID,
      resolved: path.join(BUNDLE_ROOT, "etc/passwd"),
    });
  });

  test("percent-encoded `..` (`%2e%2e`) resolves to a safe in-bundle path", () => {
    expect(
      resolveBundlePath(
        BUNDLES_ROOT,
        `vellumapp://${VALID_UUID}/%2e%2e/etc/passwd`,
      ),
    ).toEqual({
      kind: "ok",
      uuid: VALID_UUID,
      resolved: path.join(BUNDLE_ROOT, "etc/passwd"),
    });
  });
});

// Direct probes of `resolveRelativePath` scoped to a bundle root —
// bypasses URL normalization to exercise the `startsWith` guard for real.
describe("resolveRelativePath — bundle-root guard (defense-in-depth)", () => {
  test("`..` segments surviving normalization are rejected", () => {
    expect(resolveRelativePath(BUNDLE_ROOT, "../etc/passwd")).toEqual({
      kind: "forbidden",
    });
  });

  test("deeply nested `..` that escape the bundle root are rejected", () => {
    expect(resolveRelativePath(BUNDLE_ROOT, "a/../../etc/passwd")).toEqual({
      kind: "forbidden",
    });
  });

  test("sibling bundle directories are rejected", () => {
    expect(
      resolveRelativePath(BUNDLE_ROOT, "../other-uuid/index.html"),
    ).toEqual({ kind: "forbidden" });
  });
});

describe("resolveBundlePath — invalid UUID", () => {
  test("malformed UUID returns forbidden", () => {
    expect(
      resolveBundlePath(BUNDLES_ROOT, "vellumapp://not-a-uuid/index.html"),
    ).toEqual({ kind: "forbidden" });
  });

  test("UUID with extra characters returns forbidden", () => {
    expect(
      resolveBundlePath(
        BUNDLES_ROOT,
        `vellumapp://${VALID_UUID}extra/index.html`,
      ),
    ).toEqual({ kind: "forbidden" });
  });

  test("empty hostname returns forbidden", () => {
    expect(
      resolveBundlePath(BUNDLES_ROOT, "vellumapp:///index.html"),
    ).toEqual({ kind: "forbidden" });
  });
});

describe("mimeTypeForPath", () => {
  test("returns text/html for .html files", () => {
    expect(mimeTypeForPath("index.html")).toBe("text/html");
  });

  test("returns application/javascript for .js files", () => {
    expect(mimeTypeForPath("bundle.js")).toBe("application/javascript");
  });

  test("returns text/css for .css files", () => {
    expect(mimeTypeForPath("styles.css")).toBe("text/css");
  });

  test("returns application/octet-stream for unknown extensions", () => {
    expect(mimeTypeForPath("data.xyz")).toBe("application/octet-stream");
  });

  test("is case-insensitive for file extensions", () => {
    expect(mimeTypeForPath("image.PNG")).toBe("image/png");
  });
});
