/**
 * Tests for `tuning-profile.ts` — the corpus-size-adaptive profile selector.
 *
 * Below `MEMORY_V3_FULL_PROFILE_MIN_PAGES` real concept pages the resolver
 * returns the lean new-user profile (regardless of config); at or above it, it
 * maps the configured v3 values (the full schema defaults, or user overrides).
 */

import { describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/schema.js";
import { MemoryV3ConfigSchema } from "../../../../../config/schemas/memory-v3.js";
import {
  MEMORY_V3_FULL_PROFILE_MIN_PAGES,
  MEMORY_V3_NEW_USER_TUNING,
  resolveV3Tuning,
} from "../tuning-profile.js";

/** An AssistantConfig carrying just the parsed `memory.v3` subtree —
 *  `resolveV3Tuning` reads nothing else. */
function configWith(
  v3Overrides: Record<string, unknown> = {},
): AssistantConfig {
  return {
    memory: { v3: MemoryV3ConfigSchema.parse(v3Overrides) },
  } as unknown as AssistantConfig;
}

describe("resolveV3Tuning", () => {
  test("an empty corpus returns the lean new-user profile", () => {
    expect(resolveV3Tuning(configWith(), 0)).toEqual(MEMORY_V3_NEW_USER_TUNING);
  });

  test("just below the threshold returns the lean profile", () => {
    expect(
      resolveV3Tuning(configWith(), MEMORY_V3_FULL_PROFILE_MIN_PAGES - 1),
    ).toEqual(MEMORY_V3_NEW_USER_TUNING);
  });

  test("at the threshold returns the configured (full-default) profile", () => {
    const v3 = MemoryV3ConfigSchema.parse({});
    expect(
      resolveV3Tuning(configWith(), MEMORY_V3_FULL_PROFILE_MIN_PAGES),
    ).toEqual({
      hotSetK: v3.hotSet.k,
      freshSetK: v3.freshSet.k,
      needleK: v3.needleK,
      denseK: v3.denseK,
      replyQueryK: v3.replyQueryK,
      selectorEnabled: v3.selectorEnabled,
      learnedEdgesCap: v3.learnedEdges.cap,
      edgeSeedCount: v3.edge.seedCount,
      edgePerSeed: v3.edge.perSeed,
      edgeCap: v3.edge.cap,
    });
  });

  test("the full default profile is materially heavier than the lean one", () => {
    // Sanity: the established profile turns on the selector and dense lane the
    // lean profile leaves off, so the two profiles are genuinely distinct.
    const full = resolveV3Tuning(
      configWith(),
      MEMORY_V3_FULL_PROFILE_MIN_PAGES,
    );
    expect(full.selectorEnabled).toBe(true);
    expect(full.denseK).toBeGreaterThan(0);
    expect(MEMORY_V3_NEW_USER_TUNING.selectorEnabled).toBe(false);
    expect(MEMORY_V3_NEW_USER_TUNING.denseK).toBe(0);
  });

  test("above the threshold respects explicit config overrides", () => {
    const tuning = resolveV3Tuning(
      configWith({
        needleK: 50,
        denseK: 0,
        selectorEnabled: false,
        edge: { seedCount: 7 },
      }),
      100,
    );
    expect(tuning.needleK).toBe(50);
    expect(tuning.denseK).toBe(0);
    expect(tuning.selectorEnabled).toBe(false);
    expect(tuning.edgeSeedCount).toBe(7);
    // Unoverridden fields fall back to the full schema defaults.
    expect(tuning.freshSetK).toBe(100);
    expect(tuning.edgeCap).toBe(45);
  });

  test("below the threshold the lean profile wins over an override", () => {
    // A sparse corpus runs lean regardless of config — there is little to
    // retrieve, so the fast profile applies until the corpus grows.
    const tuning = resolveV3Tuning(configWith({ needleK: 50 }), 3);
    expect(tuning).toEqual(MEMORY_V3_NEW_USER_TUNING);
  });
});
