import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * Guards the app-side ambient global (`window.vellum`) that
 * `@vellumai/plugin-api` ships so plugin apps don't hand-declare it.
 *
 * Two things must hold: the declaration augments `Window` with the bridge
 * members an app may call (`fetch` and `getContext`), and the publish build
 * actually ships it (as `app.d.ts`, via the `./app` export, referenced from
 * the main rollup).
 */

const APP_GLOBALS = new URL("../plugin-api/app-globals.d.ts", import.meta.url);
const BUILD_SCRIPT = new URL(
  "../../scripts/build-plugin-api.ts",
  import.meta.url,
);

describe("plugin-api app-side globals", () => {
  test("augments Window with the window.vellum bridge fetch", () => {
    const src = readFileSync(APP_GLOBALS, "utf8");

    // Augments the DOM `Window` with the bridge.
    expect(src).toContain("declare global");
    expect(src).toContain("interface Window");
    expect(src).toContain("vellum: VellumAppBridge");

    // The exposed members: the authenticated proxy and the host context read.
    expect(src).toContain("fetch(");
    expect(src).toContain("getContext(");
  });

  test("types the host context an app reads as nullable on both axes", () => {
    const src = readFileSync(APP_GLOBALS, "utf8");

    // Both ids are nullable: a conversation can be closed, and an app can be
    // open with no conversation beside it. An app that assumes a string here
    // breaks in both cases, so the contract has to say so.
    expect(src).toContain("VellumAppContext");
    expect(src).toContain("activeConversationId: string | null");
    expect(src).toContain("editingConversationId: string | null");

    // Read-only by construction: the context type carries ids and nothing
    // that would let an app act on the host through this member.
    expect(src).toContain("getContext(): Promise<VellumAppContext>");
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
