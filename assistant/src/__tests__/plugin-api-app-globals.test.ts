import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * Guards the app-side ambient global (`window.vellum`) that
 * `@vellumai/plugin-api` ships so plugin apps don't hand-declare it.
 *
 * Two things must hold: the declaration must cover every method the host
 * injects into the app sandbox, and the publish build must actually ship it
 * (as `app.d.ts`, via the `./app` export, referenced from the main rollup).
 */

const APP_GLOBALS = new URL("../plugin-api/app-globals.d.ts", import.meta.url);
const BUILD_SCRIPT = new URL(
  "../../scripts/build-plugin-api.ts",
  import.meta.url,
);

/** The surface the runtime `sandbox-bridge` injects onto `window.vellum`. */
const INJECTED_MEMBERS = [
  "route",
  "sendAction",
  "fetch",
  "asset",
  "subscribe",
] as const;

describe("plugin-api app-side globals", () => {
  test("declares window.vellum with the full injected surface", () => {
    const src = readFileSync(APP_GLOBALS, "utf8");

    // Augments the DOM `Window` with the bridge.
    expect(src).toContain("interface Window");
    expect(src).toContain("vellum: VellumAppBridge");
    expect(src).toContain("declare global");

    for (const member of INJECTED_MEMBERS) {
      expect(src).toContain(member);
    }
  });

  test("publish build ships the app subpath types", () => {
    const src = readFileSync(BUILD_SCRIPT, "utf8");

    // Copied into the package as app.d.ts…
    expect(src).toContain("app-globals.d.ts");
    expect(src).toContain('"app.d.ts"');
    // …exposed via the ./app subpath…
    expect(src).toContain('"./app"');
    // …and pulled in transitively from the main rollup.
    expect(src).toContain('/// <reference path="./app.d.ts" />');
  });
});
