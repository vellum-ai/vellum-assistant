import { describe, expect, test } from "bun:test";

import { getEffectiveEnabledPluginSet } from "./conversation-tool-setup.js";

describe("getEffectiveEnabledPluginSet", () => {
  test("returns null when enabledPlugins is null (no per-chat restriction)", () => {
    expect(getEffectiveEnabledPluginSet({ enabledPlugins: null })).toBeNull();
  });

  test("returns null when enabledPlugins is undefined", () => {
    expect(getEffectiveEnabledPluginSet({})).toBeNull();
  });

  test("returns a Set of the scoped plugin ids", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["a"] });
    expect(set).toEqual(new Set(["a"]));
  });

  test("preserves every scoped plugin id", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["a", "b"] });
    expect(set).toEqual(new Set(["a", "b"]));
  });

  test("returns an empty Set for an explicit empty scope", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: [] });
    expect(set).not.toBeNull();
    expect(set?.size).toBe(0);
  });
});
