/**
 * Tests for the post-boot registration path on the plugin registry.
 *
 * `registerPluginPostBoot()` is the trusted-host-only entry point used by
 * `assistant plugins install` to live-register a freshly-materialized plugin
 * after {@link closeRegistration} has flipped the per-boot latch. It must
 * keep every validation `registerPlugin()` performs while bypassing the
 * closed-registration latch — that asymmetry is the whole point of the
 * separate function.
 *
 * These tests live in their own file so the `closeRegistration()` calls
 * don't leak into the boot-time `plugin-registry.test.ts` cases.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  closeRegistration,
  getRegisteredPlugin,
  getRegisteredPlugins,
  registerPlugin,
  registerPluginPostBoot,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import { type Plugin, PluginExecutionError } from "../plugins/types.js";

function buildPlugin(name: string): Plugin {
  return { manifest: { name, version: "0.0.1" } };
}

describe("registerPluginPostBoot", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registers after closeRegistration (the whole point)", () => {
    closeRegistration();
    // `registerPlugin` would throw here.
    expect(() => registerPlugin(buildPlugin("alpha"))).toThrow(
      "registration is closed",
    );
    // `registerPluginPostBoot` succeeds.
    registerPluginPostBoot(buildPlugin("alpha"));
    expect(getRegisteredPlugins().map((p) => p.manifest.name)).toEqual([
      "alpha",
    ]);
  });

  test("rejects duplicate name even when registration is closed", () => {
    registerPlugin(buildPlugin("alpha"));
    closeRegistration();
    expect(() => registerPluginPostBoot(buildPlugin("alpha"))).toThrow(
      PluginExecutionError,
    );
    expect(() => registerPluginPostBoot(buildPlugin("alpha"))).toThrow(
      "already registered",
    );
  });

  test("rejects invalid (non-kebab-case) name", () => {
    closeRegistration();
    expect(() => registerPluginPostBoot(buildPlugin("Alpha_Plugin"))).toThrow(
      "must be kebab-case",
    );
  });

  test("rejects missing manifest", () => {
    closeRegistration();
    // Intentional shape violation — `as Plugin` casts past TS so we can
    // exercise the runtime guard.
    const bad = {} as Plugin;
    expect(() => registerPluginPostBoot(bad)).toThrow(
      "manifest is missing",
    );
  });

  test("rejects missing version", () => {
    closeRegistration();
    const bad = { manifest: { name: "missing-version" } } as Plugin;
    expect(() => registerPluginPostBoot(bad)).toThrow(
      "manifest.version is required",
    );
  });
});

describe("getRegisteredPlugin", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("returns the registered plugin", () => {
    const plugin = buildPlugin("alpha");
    registerPlugin(plugin);
    expect(getRegisteredPlugin("alpha")).toBe(plugin);
  });

  test("returns undefined for an unknown name", () => {
    expect(getRegisteredPlugin("nope")).toBeUndefined();
  });
});
