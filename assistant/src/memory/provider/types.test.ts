import { describe, expect, test } from "bun:test";

import type { MemoryProvider } from "./types.js";

/**
 * Compile-time conformance fixture: a trivial stub proving the
 * `MemoryProvider` interface is implementable. The `satisfies` clause fails
 * the build if the interface drifts into something a provider can't satisfy.
 */
const _fixture = {
  id: "none",
  async retrieveForContext() {
    return [];
  },
  async retrieveForTurn() {
    return [];
  },
  async onTurnCommit() {},
  provideTools() {
    return [];
  },
  async init() {},
  async shutdown() {},
} satisfies MemoryProvider;

describe("MemoryProvider", () => {
  test("a null provider conforms to the interface", async () => {
    expect(_fixture.id).toBe("none");
    expect(await _fixture.retrieveForContext()).toEqual([]);
    expect(await _fixture.retrieveForTurn()).toEqual([]);
    expect(_fixture.provideTools()).toEqual([]);
  });
});
