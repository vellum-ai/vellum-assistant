import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { getAllDefaultPlugins } from "../../index.js";

const PLUGIN_DIR = join(import.meta.dir, "..");

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") {
        continue;
      }
      files.push(...walkFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

describe("task-progress registration", () => {
  test("default-plugin registration includes both hooks after empty-response", () => {
    const plugins = getAllDefaultPlugins();
    const names = plugins.map((plugin) => plugin.manifest.name);
    const emptyIndex = names.indexOf("default-empty-response");
    const contextIndex = names.indexOf("default-task-progress");
    expect(contextIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBe(emptyIndex + 1);

    const plugin = plugins[contextIndex]!;
    expect(Object.keys(plugin.hooks ?? {}).sort()).toEqual([
      "post-compact",
      "user-prompt-submit",
    ]);
    expect(plugin.hooks?.["user-prompt-submit"]).toBeTypeOf("function");
    expect(plugin.hooks?.["post-compact"]).toBeTypeOf("function");
    expect(plugin.hooks?.["post-tool-use"]).toBeUndefined();
    expect(plugin.injectors).toBeUndefined();
  });

  test("owns no database, migration, lifecycle hook, or state store", () => {
    const productionFiles = walkFiles(PLUGIN_DIR);
    const forbidden =
      /sqlite|migration|pluginStorageDir|conversation-deleted|conversations-cleared|nudge-state-store|state-store|CREATE TABLE|bun:sqlite/i;
    for (const file of productionFiles) {
      const rel = file.slice(PLUGIN_DIR.length + 1);
      if (rel === "package.json") {
        continue;
      }
      const source = readFileSync(file, "utf8");
      expect(source, rel).not.toMatch(forbidden);
      expect(source, rel).not.toContain("hooks/init");
      expect(source, rel).not.toContain("hooks/shutdown");
    }

    const plugin = getAllDefaultPlugins().find(
      (entry) => entry.manifest.name === "default-task-progress",
    );
    expect(plugin?.hooks?.init).toBeUndefined();
    expect(plugin?.hooks?.shutdown).toBeUndefined();
    expect(plugin?.hooks?.["conversation-deleted"]).toBeUndefined();
  });
});
