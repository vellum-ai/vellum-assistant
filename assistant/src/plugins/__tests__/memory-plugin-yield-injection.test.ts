/**
 * FIX (Codex round 8): the built-in memory yield to an external `provides:
 * "memory"` plugin is MEMORY-SPECIFIC, not a wholesale suppression of runtime
 * assembly.
 *
 * When one external memory plugin is active (and the `memory-plugin-provider`
 * flag is on), the built-in memory layer must produce NO `<memory>` block —
 * neither v2 retrieval, the v3 cards/spotlight injectors, nor the v2 static
 * `<info>` block — exactly as `memory.provider: "none"` does. But the NON-memory
 * runtime injections that `memory-retrieval`'s hooks also drive (the unified
 * `<turn_context>` block, workspace/PKB/NOW/channel) must keep firing every
 * turn. Dropping `memory-retrieval`'s hooks wholesale (the prior behavior) would
 * have lost those non-memory blocks.
 *
 * This test drives the REAL injectors directly: the suppression is an early
 * return in each memory injector's `produce()`, ahead of any orchestration, so
 * no selector/provider mocking is needed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Control the discovery set the memory-capability arbiter reads. An active
// external memory plugin is simulated by returning one name here; the flag (set
// per-test) gates whether that name actually makes the built-in yield.
let discoveredMemoryPlugins: string[] = [];
const realMtimeCache = { ...(await import("../mtime-cache.js")) };
mock.module("../mtime-cache.js", () => ({
  ...realMtimeCache,
  getDiscoveredMemoryCapabilityPlugins: () => discoveredMemoryPlugins,
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

// A config that resolves the provider to v3-live, so the suppression is proven
// to win even when v3 would otherwise own the `<memory>` layer.
const V3_LIVE_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    v2: { ...DEFAULT_CONFIG.memory.v2, enabled: true },
    v3: { ...DEFAULT_CONFIG.memory.v3, live: true },
  },
};

mock.module("../../config/loader.js", () => ({
  getConfig: () => V3_LIVE_CONFIG,
  getConfigReadOnly: () => V3_LIVE_CONFIG,
  loadConfig: () => V3_LIVE_CONFIG,
  invalidateConfigCache: () => {},
}));

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";
import { defaultInjectors } from "../defaults/memory-retrieval/injectors.js";
import { memoryV3Injector } from "../defaults/memory-v3-shadow/injector.js";
import { isBuiltinMemoryInjectionSuppressed } from "../memory-capability.js";
import type { TurnContext } from "../types.js";

const unifiedTurnContextInjector = defaultInjectors.find(
  (i) => i.name === "unified-turn-context",
)!;
const memoryV2StaticInjector = defaultInjectors.find(
  (i) => i.name === "memory-v2-static",
)!;

// A guardian (owner) turn over the local channel, so the personal-memory trust
// gate the memory injectors apply would ADMIT it — proving the no-`<memory>`
// outcome comes from the external-plugin suppression, not the trust gate.
const TURN_CTX: TurnContext = {
  requestId: "req-1",
  conversationId: "conv-yield-1",
  turnIndex: 0,
  trust: { sourceChannel: "vellum", trustClass: "guardian" },
  timestamp: "2026-04-02T12:00:00Z",
};

function activateExternalMemoryPlugin(): void {
  discoveredMemoryPlugins = ["external-memory"];
  setOverridesForTesting({ "memory-plugin-provider": true });
}

beforeEach(() => {
  discoveredMemoryPlugins = [];
  clearFeatureFlagOverridesCache();
});

afterEach(() => {
  discoveredMemoryPlugins = [];
  clearFeatureFlagOverridesCache();
});

describe("memory-specific yield to an active external memory plugin", () => {
  test("isBuiltinMemoryInjectionSuppressed tracks the active external plugin", () => {
    // No external plugin (and provider is v3, not none) → not suppressed.
    expect(isBuiltinMemoryInjectionSuppressed(V3_LIVE_CONFIG)).toBe(false);

    // One active external memory plugin → suppressed, just like provider "none".
    activateExternalMemoryPlugin();
    expect(isBuiltinMemoryInjectionSuppressed(V3_LIVE_CONFIG)).toBe(true);
  });

  test("the built-in v3 <memory> injector yields (returns null) under an active external memory plugin", async () => {
    activateExternalMemoryPlugin();
    const block = await memoryV3Injector.produce(TURN_CTX);
    expect(block).toBeNull();
  });

  test("the built-in v2 static <info> injector yields under an active external memory plugin", async () => {
    activateExternalMemoryPlugin();
    // The injector suppresses the `<info>` block before reading any files, so
    // it returns null regardless of workspace memory contents.
    const block = await memoryV2StaticInjector.produce(TURN_CTX);
    expect(block).toBeNull();
  });

  test("the non-memory <turn_context> injection survives under an active external memory plugin", async () => {
    activateExternalMemoryPlugin();
    // The unified-turn-context injector does NOT gate on the memory suppression,
    // so the non-memory grounding block keeps firing every turn.
    const block = await unifiedTurnContextInjector.produce(TURN_CTX);
    expect(block).not.toBeNull();
    expect(block!.id).toBe("unified-turn-context");
    expect(block!.text).toContain("<turn_context>");
  });
});
