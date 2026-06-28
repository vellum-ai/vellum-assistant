/**
 * Tests for {@link reconcileBuiltinMemoryTools} — the runtime resync that keeps
 * the built-in `remember`/`recall` tools in the registry in lockstep with the
 * live yield decision (`shouldBuiltinMemoryYield`).
 *
 * The yield decision is the only mocked input; the registry and the real
 * provider tool definitions are exercised directly so the test pins the actual
 * register/unregister behavior:
 *
 * - yield true  → the built-in (core, unowned) memory tools are stripped, so an
 *   external memory plugin's same-named tools can register without colliding.
 * - yield false → the built-in memory tools are (re-)registered.
 * - a memory tool already owned by an external plugin is never stripped — the
 *   plugin owns its lifecycle.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import { AssistantConfigSchema } from "../../config/schema.js";
import { RiskLevel } from "../../permissions/types.js";
import * as memoryCapability from "../../plugins/memory-capability.js";
import {
  __clearRegistryForTesting,
  getTool,
  getToolOwner,
  registerPluginTools,
} from "../registry.js";
import {
  reconcileBuiltinMemoryTools,
  reconcileMemoryToolsForConfigChange,
} from "./builtin-memory-tool-sync.js";

// Pin the active provider to v2 so `provideTools()` returns the shared
// `remember`/`recall` definitions (graph/v2/v3 all resolve to the same pair).
function pinV2Config(): void {
  pinProvider("v2");
}

/** Pin the resolved memory provider that `getConfig()` reports. */
function pinProvider(provider: "v2" | "v3" | "graph" | "none"): void {
  spyOn(configLoader, "getConfig").mockReturnValue(
    AssistantConfigSchema.parse({ memory: { provider } }),
  );
}

function setYield(value: boolean): void {
  spyOn(memoryCapability, "shouldBuiltinMemoryYield").mockReturnValue(value);
}

afterEach(() => {
  spyOn(configLoader, "getConfig").mockRestore();
  spyOn(memoryCapability, "shouldBuiltinMemoryYield").mockRestore();
  __clearRegistryForTesting();
});

describe("reconcileBuiltinMemoryTools", () => {
  test("registers the built-in memory tools when the built-in should not yield", () => {
    __clearRegistryForTesting();
    pinV2Config();
    setYield(false);

    reconcileBuiltinMemoryTools();

    // Built-in remember/recall are present and core-owned (no extension owner).
    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();
    expect(getToolOwner("remember")).toBeUndefined();
    expect(getToolOwner("recall")).toBeUndefined();
  });

  test("strips the built-in memory tools when the built-in should yield", () => {
    __clearRegistryForTesting();
    pinV2Config();

    // Start with the built-in tools registered (the not-yielding state).
    setYield(false);
    reconcileBuiltinMemoryTools();
    expect(getTool("remember")).toBeDefined();

    // An external memory plugin becomes active → the built-in must yield.
    setYield(true);
    reconcileBuiltinMemoryTools();

    // The core memory tools are stripped so the plugin's same-named tools can
    // register without hitting the core-tool conflict skip.
    expect(getTool("remember")).toBeUndefined();
    expect(getTool("recall")).toBeUndefined();
  });

  test("restores the built-in memory tools when the external plugin goes away", () => {
    __clearRegistryForTesting();
    pinV2Config();

    setYield(true);
    reconcileBuiltinMemoryTools();
    expect(getTool("remember")).toBeUndefined();

    // The external memory plugin is removed → the built-in stops yielding.
    setYield(false);
    reconcileBuiltinMemoryTools();

    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();
  });

  test("never strips a memory tool owned by an external plugin", () => {
    __clearRegistryForTesting();
    pinV2Config();
    setYield(true);

    // The external memory plugin owns `remember`/`recall` (the steady state once
    // it has taken over). A resync while yielding must leave the plugin's tools
    // intact — `unregisterCoreTool` only evicts unowned core tools.
    registerPluginTools("external-memory", [
      {
        name: "remember",
        description: "plugin remember",
        category: "plugin",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox",
        input_schema: { type: "object", properties: {} },
        execute: async () => ({ content: "", isError: false }),
      },
      {
        name: "recall",
        description: "plugin recall",
        category: "plugin",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox",
        input_schema: { type: "object", properties: {} },
        execute: async () => ({ content: "", isError: false }),
      },
    ]);

    reconcileBuiltinMemoryTools();

    // The plugin's tools survive — ownership is unchanged.
    expect(getTool("remember")).toBeDefined();
    expect(getToolOwner("remember")).toEqual({
      kind: "plugin",
      id: "external-memory",
    });
    expect(getToolOwner("recall")).toEqual({
      kind: "plugin",
      id: "external-memory",
    });
  });
});

describe("reconcileMemoryToolsForConfigChange", () => {
  test("a runtime switch to provider:none unregisters remember/recall, and switching back re-registers them", () => {
    __clearRegistryForTesting();
    // No external memory plugin in play — ownership tracks the resolved provider.
    setYield(false);

    // A real provider is configured at boot: the memory tools are registered.
    pinProvider("v2");
    reconcileMemoryToolsForConfigChange();
    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();

    // A live config write flips the provider to "none" (no restart). The
    // provider now contributes no tools, so the resync strips the stale
    // model-visible memory tools.
    pinProvider("none");
    reconcileMemoryToolsForConfigChange();
    expect(getTool("remember")).toBeUndefined();
    expect(getTool("recall")).toBeUndefined();

    // Switching back to a real provider re-registers them — again without a
    // restart.
    pinProvider("v2");
    reconcileMemoryToolsForConfigChange();
    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();
    expect(getToolOwner("remember")).toBeUndefined();
    expect(getToolOwner("recall")).toBeUndefined();
  });

  test("never strips a plugin-owned memory tool when the provider resolves to none", () => {
    __clearRegistryForTesting();
    // An external memory plugin owns the names and the built-in yields to it.
    setYield(true);
    pinProvider("none");
    registerPluginTools("external-memory", [
      {
        name: "remember",
        description: "plugin remember",
        category: "plugin",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox",
        input_schema: { type: "object", properties: {} },
        execute: async () => ({ content: "", isError: false }),
      },
    ]);

    reconcileMemoryToolsForConfigChange();

    // The unregister direction only evicts unowned core tools, so the plugin's
    // tool is left intact.
    expect(getTool("remember")).toBeDefined();
    expect(getToolOwner("remember")).toEqual({
      kind: "plugin",
      id: "external-memory",
    });
  });
});
