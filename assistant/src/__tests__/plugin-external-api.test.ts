/**
 * Tests for the `globalThis.__vellumPluginRuntime` bridge.
 *
 * The bridge exists so workspace-local plugins (`<workspaceDir>/plugins/*`)
 * can register with the daemon's bundled module instances even when the
 * daemon is a `bun --compile` binary. Absolute-path imports against a
 * compiled binary load fresh disk copies into a disjoint module graph; the
 * bridge sidesteps that by attaching a stable handle to globalThis.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getPluginRuntime,
  installPluginRuntime,
  uninstallPluginRuntimeForTests,
} from "../plugins/external-api.js";
import { registerPlugin } from "../plugins/registry.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";

describe("plugin external-api bridge", () => {
  beforeEach(() => {
    uninstallPluginRuntimeForTests();
  });

  afterEach(() => {
    uninstallPluginRuntimeForTests();
  });

  test("installs a runtime handle on globalThis", () => {
    expect(getPluginRuntime()).toBeUndefined();
    installPluginRuntime();
    const runtime = getPluginRuntime();
    expect(runtime).toBeDefined();
    expect(runtime?.version).toBe(1);
  });

  test("exposes the canonical registerPlugin / hub / secrets references", () => {
    installPluginRuntime();
    const runtime = getPluginRuntime();
    expect(runtime?.registerPlugin).toBe(registerPlugin);
    expect(runtime?.assistantEventHub).toBe(assistantEventHub);
    expect(runtime?.getSecureKeyAsync).toBe(getSecureKeyAsync);
  });

  test("plugins can read the runtime via the documented globalThis key", () => {
    installPluginRuntime();
    // Mirror the access pattern documented for plugin authors.
    const runtime = (
      globalThis as { __vellumPluginRuntime?: { version: number } }
    ).__vellumPluginRuntime;
    expect(runtime).toBeDefined();
    expect(runtime?.version).toBe(1);
  });

  test("install is idempotent — repeat calls preserve the same handle", () => {
    installPluginRuntime();
    const first = getPluginRuntime();
    installPluginRuntime();
    installPluginRuntime();
    expect(getPluginRuntime()).toBe(first);
  });

  test("getPluginRuntime returns undefined when the bridge is not installed", () => {
    expect(getPluginRuntime()).toBeUndefined();
  });
});
