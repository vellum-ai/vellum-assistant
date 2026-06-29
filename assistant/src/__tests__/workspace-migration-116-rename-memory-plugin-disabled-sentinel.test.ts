import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renameMemoryPluginDisabledSentinelMigration } from "../workspace/migrations/116-rename-memory-plugin-disabled-sentinel.js";

const OLD_RETRIEVAL = "default-memory-retrieval";
const OLD_V3_SHADOW = "default-memory-v3-shadow";
const NEW = "default-memory";

let workspaceDir: string;
let pluginsDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-116-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  pluginsDir = join(workspaceDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
}

function disable(pluginName: string, content = ""): void {
  const dir = join(pluginsDir, pluginName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".disabled"), content);
}

function isDisabled(pluginName: string): boolean {
  return existsSync(join(pluginsDir, pluginName, ".disabled"));
}

function pluginDirExists(pluginName: string): boolean {
  return existsSync(join(pluginsDir, pluginName));
}

beforeEach(freshWorkspace);

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("116-rename-memory-plugin-disabled-sentinel migration", () => {
  test("carries the disabled sentinel forward and removes the legacy stub", () => {
    disable(OLD_RETRIEVAL, "disabled-marker");

    renameMemoryPluginDisabledSentinelMigration.run(workspaceDir);

    expect(isDisabled(NEW)).toBe(true);
    // The sentinel content is preserved exactly.
    expect(readFileSync(join(pluginsDir, NEW, ".disabled"), "utf-8")).toBe(
      "disabled-marker",
    );
    // The legacy stub directory is gone (no bogus user-plugin entry).
    expect(pluginDirExists(OLD_RETRIEVAL)).toBe(false);
  });

  test("idempotent: running twice keeps the new sentinel and does not throw", () => {
    disable(OLD_RETRIEVAL);

    renameMemoryPluginDisabledSentinelMigration.run(workspaceDir);
    expect(() =>
      renameMemoryPluginDisabledSentinelMigration.run(workspaceDir),
    ).not.toThrow();

    expect(isDisabled(NEW)).toBe(true);
    expect(pluginDirExists(OLD_RETRIEVAL)).toBe(false);
  });

  test("no-op when no legacy sentinels exist — memory stays enabled", () => {
    renameMemoryPluginDisabledSentinelMigration.run(workspaceDir);

    expect(isDisabled(NEW)).toBe(false);
  });

  test("does not clobber an existing default-memory sentinel, still clears the stub", () => {
    disable(OLD_RETRIEVAL, "old");
    disable(NEW, "new");

    renameMemoryPluginDisabledSentinelMigration.run(workspaceDir);

    expect(readFileSync(join(pluginsDir, NEW, ".disabled"), "utf-8")).toBe(
      "new",
    );
    expect(pluginDirExists(OLD_RETRIEVAL)).toBe(false);
  });

  test("disabling only memory-v3-shadow keeps memory enabled but clears its stub", () => {
    // memory-v3-shadow's hooks were no-ops (v3 ran through the retrieval chain),
    // so disabling it never turned memory off; the combined plugin must stay on,
    // and its defunct stub must not linger as a bogus user plugin.
    disable(OLD_V3_SHADOW);

    renameMemoryPluginDisabledSentinelMigration.run(workspaceDir);

    expect(isDisabled(NEW)).toBe(false);
    expect(pluginDirExists(OLD_V3_SHADOW)).toBe(false);
  });

  test("both disabled: memory is disabled and both legacy stubs are removed", () => {
    disable(OLD_RETRIEVAL);
    disable(OLD_V3_SHADOW);

    renameMemoryPluginDisabledSentinelMigration.run(workspaceDir);

    expect(isDisabled(NEW)).toBe(true);
    expect(pluginDirExists(OLD_RETRIEVAL)).toBe(false);
    expect(pluginDirExists(OLD_V3_SHADOW)).toBe(false);
  });

  test("no-op (no throw) when the plugins directory does not exist", () => {
    rmSync(pluginsDir, { recursive: true, force: true });

    expect(() =>
      renameMemoryPluginDisabledSentinelMigration.run(workspaceDir),
    ).not.toThrow();
    expect(isDisabled(NEW)).toBe(false);
  });
});
