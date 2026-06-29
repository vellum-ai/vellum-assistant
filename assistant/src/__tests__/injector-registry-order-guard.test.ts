/**
 * Guard test: the injector registry materializes the exact same ordered
 * sequence the legacy hard-coded chain produced.
 *
 * The per-turn injection chain is a registry union (see
 * `plugins/injector-registry.ts`) rather than a hard-coded import, so this test
 * locks the produced order: the full ordered id sequence is asserted both
 * against the recomputed sort of `defaultMemoryPlugin`'s contributed injectors
 * and against a hardcoded literal snapshot. Any reordering — a changed `order`,
 * a new injector, a regression in the registry's sort — fails here loudly
 * rather than silently shifting what the model sees per turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultInjectors } from "../plugins/defaults/memory/injectors.js";
import {
  memoryV3Injector,
  memoryV3SpotlightInjector,
} from "../plugins/defaults/memory/v3/injector.js";
import {
  clearInjectorRegistry,
  getRegisteredInjectors,
  registerPluginInjectors,
} from "../plugins/injector-registry.js";

const CONTRIBUTED = [
  ...defaultInjectors,
  memoryV3Injector,
  memoryV3SpotlightInjector,
];

// The ordered id sequence the chain must produce, by ascending `order`. This
// literal snapshot is the lock: update it deliberately, in lockstep with a real
// change to the injector set or its `order` values.
const EXPECTED_ORDER = [
  "disk-pressure-warning", // 5
  "workspace-context", // 10
  "background-turn", // 15
  "unified-turn-context", // 20
  "config-quarantine-notice", // 25
  "pkb-context", // 30
  "pkb-reminder", // 35
  "memory-v2-static", // 38
  "now-md", // 40
  "active-documents", // 45
  "document-comments", // 46
  "subagent-status", // 50
  "slack-messages", // 60
  "thread-focus", // 70
  "memory-v3-shadow", // 1000
  "memory-v3-spotlight", // 1001
];

describe("injector registry order guard", () => {
  beforeEach(() => {
    clearInjectorRegistry();
    registerPluginInjectors("default-memory", CONTRIBUTED);
  });

  afterEach(() => {
    clearInjectorRegistry();
  });

  test("getRegisteredInjectors returns a strictly ascending order sequence", () => {
    const orders = getRegisteredInjectors().map((i) => i.order);
    expect(orders.length).toBe(EXPECTED_ORDER.length);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]!).toBeGreaterThan(orders[i - 1]!);
    }
  });

  test("the materialized id sequence matches the recomputed sort and the snapshot", () => {
    const names = getRegisteredInjectors().map((i) => i.name);
    // (a) matches the recomputed stable sort of the contributed injectors.
    expect(names).toEqual(
      [...CONTRIBUTED].sort((a, b) => a.order - b.order).map((i) => i.name),
    );
    // (b) matches the hardcoded snapshot — the deliberate lock.
    expect(names).toEqual(EXPECTED_ORDER);
  });
});
