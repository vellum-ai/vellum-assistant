import { describe, expect, test } from "bun:test";

import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import { getEffectiveEnabledPluginSet } from "./conversation-tool-setup.js";

const DEFAULT_NAMES = getAllDefaultPlugins().map((p) => p.manifest.name);

describe("getEffectiveEnabledPluginSet", () => {
  test("returns null when enabledPlugins is null (no per-chat restriction)", () => {
    expect(getEffectiveEnabledPluginSet({ enabledPlugins: null })).toBeNull();
  });

  test("returns null when enabledPlugins is undefined", () => {
    expect(getEffectiveEnabledPluginSet({})).toBeNull();
  });

  test("unions first-party defaults with the selected user plugins", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["user-a"] });
    expect(set).not.toBeNull();
    // The explicitly selected user plugin is present...
    expect(set?.has("user-a")).toBe(true);
    // ...alongside core default-plugin infrastructure, which the new-chat pills
    // never list and so must never be filtered out.
    expect(set?.has("default-memory")).toBe(true);
    expect(set?.has("default-turn-context")).toBe(true);
    expect(set?.has("default-workspace")).toBe(true);
    expect(set?.has("default-session")).toBe(true);
    expect(set?.has("default-title-generate")).toBe(true);
    for (const name of DEFAULT_NAMES) {
      expect(set?.has(name)).toBe(true);
    }
  });

  test("still excludes a non-selected user plugin", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["user-a"] });
    expect(set?.has("user-b")).toBe(false);
  });

  test("an explicit empty scope still includes the defaults", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: [] });
    expect(set).not.toBeNull();
    expect(set?.has("default-memory")).toBe(true);
    expect(set?.size).toBe(DEFAULT_NAMES.length);
  });
});
