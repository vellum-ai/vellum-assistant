/**
 * Locks the memory plugin's file-based config resolution (`getMemoryConfig`)
 * to the host loader's memory slice (`getConfig().memory`): same schema
 * defaults, same per-field invalid fallback, same deployment-context fill.
 *
 * The plugin reads workspace/config.json's `memory` field itself; these
 * cases document that both resolutions agree on every file state. If the
 * loader's semantics change, this is the tripwire.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getConfig } from "../config/loader.js";
import { getMemoryConfig } from "../plugins/defaults/memory/config.js";
import { getWorkspaceConfigPath } from "../util/platform.js";

const configPath = getWorkspaceConfigPath();
const savedIsPlatform = process.env.IS_PLATFORM;

function writeConfig(value: unknown): void {
  writeFileSync(configPath, JSON.stringify(value, null, 2));
}

function resetState(): void {
  rmSync(configPath, { force: true });
  delete process.env.IS_PLATFORM;
}

/** Assert the plugin resolution deep-equals the host loader's slice. */
function expectParity(): ReturnType<typeof getMemoryConfig> {
  const plugin = getMemoryConfig();
  expect(plugin).toEqual(getConfig().memory);
  return plugin;
}

describe("memory config file parity", () => {
  beforeEach(resetState);
  afterEach(() => {
    resetState();
    if (savedIsPlatform !== undefined) {
      process.env.IS_PLATFORM = savedIsPlatform;
    }
  });

  test("absent config.json resolves to schema defaults, without creating the file", () => {
    const memory = getMemoryConfig();
    expect(existsSync(configPath)).toBe(false); // side-effect-free read
    expect(memory.enabled).not.toBeUndefined();
    expectParity(); // getConfig() may seed the file; values still agree
  });

  test("custom knobs are visible and identical", () => {
    writeConfig({ memory: { enabled: false, v2: { bm25_b: 0.9 } } });
    const memory = expectParity();
    expect(memory.enabled).toBe(false);
    expect(memory.v2.bm25_b).toBe(0.9);
  });

  test("an invalid leaf falls back per-field; valid siblings survive", () => {
    writeConfig({ memory: { enabled: false, v2: { bm25_b: "high" } } });
    const memory = expectParity();
    expect(memory.enabled).toBe(false); // sibling customization survives
    expect(typeof memory.v2.bm25_b).toBe("number"); // invalid leaf → default
  });

  test("unknown keys strip silently", () => {
    writeConfig({ memory: { retiredKnob: 123, enabled: false } });
    const memory = expectParity();
    expect(memory.enabled).toBe(false);
    expect("retiredKnob" in memory).toBe(false);
  });

  test("a non-object memory field resolves to defaults", () => {
    writeConfig({ memory: 5 });
    expectParity();
  });

  test("unparseable config.json resolves to defaults", () => {
    writeFileSync(configPath, "{ not json");
    const memory = getMemoryConfig();
    expect(memory.enabled).not.toBeUndefined();
    // getConfig() quarantines the corrupt file (a host-owned side effect);
    // after that both resolutions see the same absent-file state.
    expectParity();
  });

  test("platform deployment fill applies when the leaf is absent on disk", () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ memory: {} });
    const memory = expectParity();
    expect(memory.embeddings.provider).toBe("gemini");
  });

  test("an explicit on-disk provider beats the platform fill", () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ memory: { embeddings: { provider: "openai" } } });
    const memory = expectParity();
    expect(memory.embeddings.provider).toBe("openai");
  });

  test("the cache serves the same object until the file changes", () => {
    writeConfig({ memory: { enabled: false } });
    const first = getMemoryConfig();
    expect(getMemoryConfig()).toBe(first);
    writeConfig({ memory: { enabled: true } });
    const second = getMemoryConfig();
    expect(second).not.toBe(first);
    expect(second.enabled).toBe(true);
    expectParity();
  });
});
