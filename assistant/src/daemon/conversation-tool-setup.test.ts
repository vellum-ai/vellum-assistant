import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { getEffectiveEnabledPluginSet } from "./conversation-tool-setup.js";

const DEFAULT_NAMES = getAllDefaultPlugins().map((p) => p.manifest.name);

/** Write a `.disabled` sentinel for `pluginName`; returns the created dir. */
function disablePlugin(pluginName: string): string {
  const dir = join(getWorkspacePluginsDir(), pluginName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".disabled"), "");
  return dir;
}

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

  describe("workspace-disabled plugins (precedence)", () => {
    const created: string[] = [];
    afterEach(() => {
      for (const dir of created.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("drops a workspace-disabled default the conversation did not select", () => {
      created.push(disablePlugin("default-memory"));
      const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["user-a"] });
      expect(set?.has("user-a")).toBe(true);
      // The workspace-disabled default is excluded (rule 2 beats rule 3)...
      expect(set?.has("default-memory")).toBe(false);
      // ...while the other defaults remain.
      expect(set?.has("default-turn-context")).toBe(true);
      expect(set?.size).toBe(DEFAULT_NAMES.length); // user-a + defaults - memory
    });

    test("keeps a conversation-enabled plugin even if workspace-disabled", () => {
      // Rule 1 (per-conversation explicit enable) beats rule 2 (workspace).
      created.push(disablePlugin("user-a"));
      const set = getEffectiveEnabledPluginSet({
        enabledPlugins: ["user-a", "user-b"],
      });
      expect(set?.has("user-a")).toBe(true);
      expect(set?.has("user-b")).toBe(true);
    });

    test("keeps a default the conversation explicitly enabled even if workspace-disabled", () => {
      // Rule 1 beats rule 2 for defaults too.
      created.push(disablePlugin("default-memory"));
      const set = getEffectiveEnabledPluginSet({
        enabledPlugins: ["default-memory"],
      });
      expect(set?.has("default-memory")).toBe(true);
    });
  });
});
