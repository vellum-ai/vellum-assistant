import { describe, expect, test } from "bun:test";

import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import { getAllDefaultPluginNames } from "../plugins/defaults/main.js";

/**
 * Guard: the filesystem-backed default-plugin registry (`defaults/main.ts`)
 * and the import-backed barrel (`defaults/index.ts`) must agree on the
 * plugin set. `main.ts` is the barrel's eventual replacement; while both
 * exist, a plugin added to one but not the other would silently diverge the
 * consumers (e.g. per-chat plugin scoping reads names from `main.ts`, while
 * bootstrap registers plugins from the barrel).
 */
describe("default plugin names", () => {
  test("the filesystem registry matches the barrel's manifests exactly", () => {
    const fromFs = [...getAllDefaultPluginNames()].sort();
    const fromBarrel = getAllDefaultPlugins()
      .map((p) => p.manifest.name)
      .sort();
    expect(fromFs).toEqual(fromBarrel);
  });

  test("every name uses the default- prefix convention", () => {
    for (const name of getAllDefaultPluginNames()) {
      expect(name).toMatch(/^default-[a-z0-9-]+$/);
    }
  });
});
