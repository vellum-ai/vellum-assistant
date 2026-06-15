/**
 * Tests for `syncFlagGatedTools()` — the follow-up registration that runs after
 * feature-flag overrides are fetched from the gateway. `initializeTools()` runs
 * during startup BEFORE that async fetch resolves, so a flag-enabled assistant
 * would otherwise never expose the gated tools until a restart (which can lose
 * the same race). These tests drive the gated-tool sets directly by mocking
 * `tool-manifest.js`, so they verify the registry behavior in isolation without
 * loading the full tool manifest.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Controllable gated-tool sets. `syncFlagGatedTools()` dynamically imports
// `./tool-manifest.js` and reads only these two helpers, so mocking them lets a
// test simulate "flag enabled" (non-empty) vs "flag off / not yet loaded" ([]).
let cesEnabled: Array<{ name: string }> = [];
let workflowEnabled: Array<{ name: string }> = [];
mock.module("./tool-manifest.js", () => ({
  getCesToolsIfEnabled: () => cesEnabled,
  getWorkflowToolsIfEnabled: () => workflowEnabled,
}));

import {
  __clearRegistryForTesting,
  getTool,
  syncFlagGatedTools,
} from "./registry.js";

function fakeTool(name: string) {
  return {
    name,
    description: `fake ${name}`,
    category: "test",
    defaultRiskLevel: "low" as never,
    executionTarget: "sandbox" as const,
    input_schema: { type: "object", properties: {}, required: [] },
    execute: async () => ({ content: "ok", isError: false }),
  };
}

describe("syncFlagGatedTools", () => {
  beforeEach(() => {
    __clearRegistryForTesting();
    cesEnabled = [];
    workflowEnabled = [];
  });

  test("registers a workflow tool that startup registration missed (the race)", async () => {
    workflowEnabled = [fakeTool("run_workflow"), fakeTool("manage_workflows")];
    // Simulates initializeTools() having run before the flag was known.
    expect(getTool("run_workflow")).toBeUndefined();

    await syncFlagGatedTools();

    expect(getTool("run_workflow")).toBeDefined();
    expect(getTool("manage_workflows")).toBeDefined();
  });

  test("registers enabled CES tools by the same path", async () => {
    cesEnabled = [fakeTool("make_authenticated_request")];

    await syncFlagGatedTools();

    expect(getTool("make_authenticated_request")).toBeDefined();
  });

  test("is idempotent — re-running does not throw or duplicate", async () => {
    workflowEnabled = [fakeTool("run_workflow")];

    await syncFlagGatedTools();
    await syncFlagGatedTools();

    expect(getTool("run_workflow")).toBeDefined();
  });

  test("registers nothing when no gated flag is enabled", async () => {
    await syncFlagGatedTools();

    expect(getTool("run_workflow")).toBeUndefined();
    expect(getTool("make_authenticated_request")).toBeUndefined();
  });
});
