import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PENDING_PLUGIN_INSTALL_KEY,
  PENDING_PLUGIN_INSTALL_MAX_AGE_MS,
  pluginsFromAttribution,
} from "@/domains/onboarding/plugin-attribution";

function write(value: string) {
  localStorage.setItem(PENDING_PLUGIN_INSTALL_KEY, value);
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("pluginsFromAttribution", () => {
  test("empty when nothing is stored", () => {
    expect(pluginsFromAttribution()).toEqual([]);
  });

  test("returns the attributed plugin for a fresh, well-formed record", () => {
    write(JSON.stringify({ pluginId: "coffee-aficionado", ts: Date.now() }));
    expect(pluginsFromAttribution()).toEqual(["coffee-aficionado"]);
  });

  test("empty for a malformed record", () => {
    write("{ not json");
    expect(pluginsFromAttribution()).toEqual([]);
    write(JSON.stringify({ ts: Date.now() })); // missing pluginId
    expect(pluginsFromAttribution()).toEqual([]);
    write(JSON.stringify({ pluginId: "x" })); // missing ts
    expect(pluginsFromAttribution()).toEqual([]);
  });

  test("empty for an expired record", () => {
    write(
      JSON.stringify({
        pluginId: "coffee-aficionado",
        ts: Date.now() - PENDING_PLUGIN_INSTALL_MAX_AGE_MS - 1,
      }),
    );
    expect(pluginsFromAttribution()).toEqual([]);
  });

  test("reading does not clear — it's a signal, not a one-shot", () => {
    write(JSON.stringify({ pluginId: "coffee-aficionado", ts: Date.now() }));
    expect(pluginsFromAttribution()).toEqual(["coffee-aficionado"]);
    expect(pluginsFromAttribution()).toEqual(["coffee-aficionado"]);
  });
});
