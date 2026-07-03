/**
 * Guard test: the injector registry materializes the exact same ordered
 * sequence the legacy hard-coded chain produced, now that the default injectors
 * are split across the memory plugin and the domain plugins (`turn-context`,
 * `workspace`, `documents`, `channel`, `session`).
 *
 * The per-turn injection chain is a registry union (see
 * `plugins/injector-registry.ts`) sorted by `order`, so this test locks the
 * produced order: the full ordered id sequence is asserted both against the
 * recomputed sort of every default plugin's contributed injectors and against a
 * hardcoded literal snapshot. Any reordering — a changed `order`, a new
 * injector, an injector moved between plugins, a regression in the registry's
 * sort — fails here loudly rather than silently shifting what the model sees
 * per turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { channelInjectors } from "../plugins/defaults/channel/injectors.js";
import { documentsInjectors } from "../plugins/defaults/documents/injectors.js";
import { registerDefaultPluginInjectors } from "../plugins/defaults/index.js";
import { memoryInjectors } from "../plugins/defaults/memory/injectors.js";
import {
  memoryV3Injector,
  memoryV3SpotlightInjector,
} from "../plugins/defaults/memory/v3/injector.js";
import { sessionInjectors } from "../plugins/defaults/session/injectors.js";
import { turnContextInjectors } from "../plugins/defaults/turn-context/injectors.js";
import { workspaceInjectors } from "../plugins/defaults/workspace/injectors.js";
import {
  clearInjectorRegistry,
  getRegisteredInjectors,
  registerPluginInjectors,
} from "../plugins/injector-registry.js";
import type { Injector } from "../plugins/types.js";

// Every injector every default plugin contributes — the registry-independent
// union, gathered straight from the plugins' exported arrays. Sorting this by
// `order` must reproduce what `getRegisteredInjectors()` returns once the
// defaults are registered.
const ALL_CONTRIBUTED = [
  ...turnContextInjectors,
  ...workspaceInjectors,
  ...documentsInjectors,
  ...channelInjectors,
  ...sessionInjectors,
  ...memoryInjectors,
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
    registerDefaultPluginInjectors();
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
    // (a) matches the recomputed stable sort of every contributed injector.
    expect(names).toEqual(
      [...ALL_CONTRIBUTED].sort((a, b) => a.order - b.order).map((i) => i.name),
    );
    // (b) matches the hardcoded snapshot — the deliberate lock.
    expect(names).toEqual(EXPECTED_ORDER);
  });
});

describe("injector registry duplicate-name rejection", () => {
  beforeEach(() => clearInjectorRegistry());
  afterEach(() => clearInjectorRegistry());

  const inj = (name: string, order: number): Injector => ({
    name,
    order,
    async produce() {
      return null;
    },
  });

  test("rejects two injectors with the same name within one contribution", () => {
    expect(() =>
      registerPluginInjectors("p", [inj("dup", 1), inj("dup", 2)]),
    ).toThrow(/duplicate injector name "dup"/);
  });

  test("rejects an injector name already registered by another plugin", () => {
    registerPluginInjectors("p1", [inj("shared", 1)]);
    expect(() => registerPluginInjectors("p2", [inj("shared", 2)])).toThrow(
      /already registered by plugin "p1"/,
    );
  });

  test("allows a plugin to re-register its own set (idempotent replace)", () => {
    registerPluginInjectors("p", [inj("a", 1)]);
    expect(() => registerPluginInjectors("p", [inj("a", 1)])).not.toThrow();
  });
});
