/**
 * Tests for the memory-v2 skill seed gate invoked from the daemon startup
 * path (`assistant/src/daemon/memory-v2-startup.ts`).
 *
 * The gate is exercised in isolation rather than mounting the full lifecycle
 * import graph. Coverage matrix from PR 8 acceptance criteria:
 *   - Case 1: feature flag on + `config.memory.v2.enabled` on → seed runs.
 *   - Case 2: feature flag off → seed does not run.
 *   - Case 3: `config.memory.v2.enabled` off (flag on) → seed does not run.
 *   - Case 4: `seedV2SkillEntries` rejects → gate does not throw and the
 *     warning is logged.
 *
 * The seed call itself is fire-and-forget (`void` + `.catch`); the gate must
 * never block startup or surface an exception.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Programmable test state — drives every mocked dependency below.
// ---------------------------------------------------------------------------

interface TestState {
  flagOverrides: Record<string, boolean>;
  seedCallCount: number;
  seedShouldReject: Error | null;
  warnCalls: Array<{ obj: unknown; msg: unknown }>;
}

const state: TestState = {
  flagOverrides: {},
  seedCallCount: 0,
  seedShouldReject: null,
  warnCalls: [],
};

// ---------------------------------------------------------------------------
// Mocks — installed before the module under test is loaded.
// ---------------------------------------------------------------------------

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string, _config: unknown): boolean => {
    const explicit = state.flagOverrides[key];
    if (typeof explicit === "boolean") return explicit;
    return true; // undeclared flags default to enabled
  },
}));

mock.module("../memory/v2/skill-store.js", () => ({
  seedV2SkillEntries: async (): Promise<void> => {
    state.seedCallCount += 1;
    if (state.seedShouldReject) throw state.seedShouldReject;
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    warn: (obj: unknown, msg: unknown) => {
      state.warnCalls.push({ obj, msg });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { maybeSeedMemoryV2Skills } =
  await import("../daemon/memory-v2-startup.js");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal config shape the gate touches; cast to AssistantConfig at the boundary. */
function makeConfig(v2Enabled: boolean): AssistantConfig {
  return {
    memory: {
      v2: { enabled: v2Enabled },
    },
  } as unknown as AssistantConfig;
}

/**
 * Drain all microtasks so any `void`-prefixed promise inside
 * `maybeSeedMemoryV2Skills` settles before the test asserts. The fire-and-
 * forget chain involves: dynamic-import settle → `.then` callback →
 * inner `seedV2SkillEntries` resolution → `.catch` settle. We yield
 * generously to cover that whole chain regardless of the bundler's task
 * scheduling.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maybeSeedMemoryV2Skills (daemon startup gate)", () => {
  beforeEach(() => {
    state.flagOverrides = {};
    state.seedCallCount = 0;
    state.seedShouldReject = null;
    state.warnCalls = [];
  });

  test("invokes seedV2SkillEntries when flag and config are both enabled", async () => {
    state.flagOverrides = { "memory-v2-enabled": true };
    maybeSeedMemoryV2Skills(makeConfig(true));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(1);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("does not invoke seedV2SkillEntries when feature flag is off", async () => {
    state.flagOverrides = { "memory-v2-enabled": false };
    maybeSeedMemoryV2Skills(makeConfig(true));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(0);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("does not invoke seedV2SkillEntries when config.memory.v2.enabled is off", async () => {
    state.flagOverrides = { "memory-v2-enabled": true };
    maybeSeedMemoryV2Skills(makeConfig(false));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(0);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("does not invoke seedV2SkillEntries when both gates are off", async () => {
    state.flagOverrides = { "memory-v2-enabled": false };
    maybeSeedMemoryV2Skills(makeConfig(false));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(0);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("re-invocation seeds after flag flips on (deferred-init race recovery)", async () => {
    // Models the lifecycle-startup race: the synchronous seed call evaluates
    // the flag while the gateway IPC override fetch is still in flight, falls
    // through to the registry default (`false`), and skips. Once
    // `initFeatureFlagOverrides()` resolves, the chained `.then` re-invokes
    // the seed with the now-populated cache and the flag flips to `true`.
    state.flagOverrides = { "memory-v2-enabled": false };
    maybeSeedMemoryV2Skills(makeConfig(true));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(0);

    state.flagOverrides = { "memory-v2-enabled": true };
    maybeSeedMemoryV2Skills(makeConfig(true));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(1);
  });

  test("swallows seedV2SkillEntries rejections and logs a warning", async () => {
    state.flagOverrides = { "memory-v2-enabled": true };
    state.seedShouldReject = new Error("seed failed");

    // The gate must not throw — startup must not block on this.
    expect(() => maybeSeedMemoryV2Skills(makeConfig(true))).not.toThrow();

    await flushMicrotasks();

    expect(state.seedCallCount).toBe(1);
    expect(state.warnCalls).toHaveLength(1);
    const [{ obj, msg }] = state.warnCalls;
    expect((obj as { err: Error }).err.message).toBe("seed failed");
    expect(msg).toBe("Failed to seed v2 skill entries");
  });
});
