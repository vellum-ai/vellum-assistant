import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PENDING_PLUGIN_INSTALL_KEY,
  PENDING_PLUGIN_INSTALL_MAX_AGE_MS,
  clearPendingPluginInstall,
  readPendingPluginInstall,
} from "@/domains/onboarding/pending-plugin-install";

function write(value: string) {
  localStorage.setItem(PENDING_PLUGIN_INSTALL_KEY, value);
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("readPendingPluginInstall", () => {
  test("returns null when nothing is stored", () => {
    expect(readPendingPluginInstall()).toBeNull();
  });

  test("returns the plugin id for a fresh, well-formed record", () => {
    write(JSON.stringify({ pluginId: "coffee-aficionado", ts: Date.now() }));
    expect(readPendingPluginInstall()).toBe("coffee-aficionado");
  });

  test("returns null for a malformed record", () => {
    write("{ not json");
    expect(readPendingPluginInstall()).toBeNull();
    write(JSON.stringify({ ts: Date.now() })); // missing pluginId
    expect(readPendingPluginInstall()).toBeNull();
    write(JSON.stringify({ pluginId: "x" })); // missing ts
    expect(readPendingPluginInstall()).toBeNull();
  });

  test("returns null for an expired record", () => {
    write(
      JSON.stringify({
        pluginId: "coffee-aficionado",
        ts: Date.now() - PENDING_PLUGIN_INSTALL_MAX_AGE_MS - 1,
      }),
    );
    expect(readPendingPluginInstall()).toBeNull();
  });

  test("reading does not clear; clear removes it", () => {
    write(JSON.stringify({ pluginId: "coffee-aficionado", ts: Date.now() }));
    expect(readPendingPluginInstall()).toBe("coffee-aficionado");
    expect(readPendingPluginInstall()).toBe("coffee-aficionado");
    clearPendingPluginInstall();
    expect(readPendingPluginInstall()).toBeNull();
  });
});
