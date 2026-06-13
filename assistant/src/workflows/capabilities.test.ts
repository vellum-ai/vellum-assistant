import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import {
  __clearRegistryForTesting,
  __resetRegistryForTesting,
  registerTool,
} from "../tools/registry.js";
import type {
  ExecutionTarget,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../tools/types.js";
import {
  CapabilityManifestSchema,
  CapabilityResolutionError,
  manifestGrantsSideEffects,
  resolveCapabilities,
  WORKFLOW_FORBIDDEN_TOOLS,
  WORKFLOW_READONLY_BASELINE,
} from "./capabilities.js";

function makeFakeTool(
  name: string,
  executionTarget: ExecutionTarget = "sandbox",
): Tool {
  return {
    name,
    description: `Fake ${name}`,
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget,
    input_schema: { type: "object", properties: {}, required: [] },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
  };
}

// A declarable side-effecting tool that is NOT part of the baseline — used to
// exercise the "baseline ∪ declared" union path.
const DECLARABLE_TOOL = "file_write";

beforeEach(() => {
  // Deterministic registry: only the baseline tools plus one declarable tool.
  __clearRegistryForTesting();
  for (const name of WORKFLOW_READONLY_BASELINE) {
    registerTool(makeFakeTool(name));
  }
  registerTool(makeFakeTool(DECLARABLE_TOOL));
});

afterAll(() => {
  // Restore the registry to its post-init baseline so other test files in a
  // combined run are not contaminated.
  __resetRegistryForTesting();
});

describe("CapabilityManifestSchema", () => {
  test("applies documented defaults for omitted fields", () => {
    const manifest = CapabilityManifestSchema.parse({});
    expect(manifest).toEqual({
      tools: [],
      hostFunctions: [],
      persona: false,
    });
  });

  test("preserves declared values", () => {
    const manifest = CapabilityManifestSchema.parse({
      tools: ["file_write"],
      hostFunctions: ["notify"],
      persona: true,
    });
    expect(manifest).toEqual({
      tools: ["file_write"],
      hostFunctions: ["notify"],
      persona: true,
    });
  });
});

describe("resolveCapabilities", () => {
  test("grants the read-only baseline without declaration", () => {
    const resolved = resolveCapabilities(CapabilityManifestSchema.parse({}));
    const names = resolved.tools.map((t) => t.name).sort();
    expect(names).toEqual([...WORKFLOW_READONLY_BASELINE].sort());
  });

  test("unions baseline with declared tools (no duplicates)", () => {
    const manifest = CapabilityManifestSchema.parse({
      // Declare one new tool plus a baseline tool that should not duplicate.
      tools: [DECLARABLE_TOOL, "file_read"],
    });
    const resolved = resolveCapabilities(manifest);
    const names = resolved.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [...WORKFLOW_READONLY_BASELINE, DECLARABLE_TOOL].sort(),
    );
    // No duplicate entries for the redeclared baseline tool.
    expect(names.filter((n) => n === "file_read")).toHaveLength(1);
  });

  test("passes through hostFunctions and persona", () => {
    const manifest = CapabilityManifestSchema.parse({
      hostFunctions: ["host_a", "host_b"],
      persona: true,
    });
    const resolved = resolveCapabilities(manifest);
    expect(resolved.hostFunctions).toEqual(["host_a", "host_b"]);
    expect(resolved.persona).toBe(true);
  });

  test("rejects a declared tool that does not exist in the registry", () => {
    const manifest = CapabilityManifestSchema.parse({
      tools: ["does_not_exist"],
    });
    expect(() => resolveCapabilities(manifest)).toThrow(
      CapabilityResolutionError,
    );
    try {
      resolveCapabilities(manifest);
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityResolutionError);
      expect((err as CapabilityResolutionError).reason).toBe("unknown_tool");
      expect((err as CapabilityResolutionError).toolName).toBe(
        "does_not_exist",
      );
    }
  });

  test("rejects a declared forbidden tool", () => {
    const forbidden = WORKFLOW_FORBIDDEN_TOOLS[0]!;
    // Even if it were registered, declaring a forbidden tool must throw.
    registerTool(makeFakeTool(forbidden));
    const manifest = CapabilityManifestSchema.parse({ tools: [forbidden] });
    try {
      resolveCapabilities(manifest);
      throw new Error("expected resolveCapabilities to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityResolutionError);
      expect((err as CapabilityResolutionError).reason).toBe("forbidden_tool");
      expect((err as CapabilityResolutionError).toolName).toBe(forbidden);
    }
  });

  test("rejects a declared host-proxy tool (executionTarget host)", () => {
    // A leaf builds a synthetic, anonymous ToolContext that carries none of the
    // originating turn's host-routing fields (transportInterface,
    // sourceActorPrincipalId, proxy resolver), so a host tool would mis-route
    // at run time. Rejection keys off the resolved executionTarget, NOT the
    // name — `send_to_host` has no `host_` prefix yet must still be rejected.
    // Every real host tool (host_bash, host_file_*, computer-use) declares
    // `executionTarget: "host"`, so this is the path that catches them.
    registerTool(makeFakeTool("send_to_host", "host"));
    const manifest = CapabilityManifestSchema.parse({
      tools: ["send_to_host"],
    });
    try {
      resolveCapabilities(manifest);
      throw new Error("expected resolveCapabilities to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityResolutionError);
      expect((err as CapabilityResolutionError).reason).toBe("host_tool");
      expect((err as CapabilityResolutionError).toolName).toBe("send_to_host");
    }
  });

  test("never includes a forbidden tool in the resolved set", () => {
    // Sanity: forbidden tools and baseline tools are disjoint.
    for (const name of WORKFLOW_FORBIDDEN_TOOLS) {
      expect(WORKFLOW_READONLY_BASELINE).not.toContain(name);
    }
    const resolved = resolveCapabilities(CapabilityManifestSchema.parse({}));
    const names = new Set(resolved.tools.map((t) => t.name));
    for (const forbidden of WORKFLOW_FORBIDDEN_TOOLS) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

describe("manifestGrantsSideEffects", () => {
  // The launch-time consent gate keys off this predicate: a run that grants
  // side-effecting tools/host functions must prompt; a read-only run must not.
  test("false for an absent or empty manifest (read-only baseline only)", () => {
    expect(manifestGrantsSideEffects(undefined)).toBe(false);
    expect(manifestGrantsSideEffects(null)).toBe(false);
    expect(manifestGrantsSideEffects({})).toBe(false);
    expect(manifestGrantsSideEffects({ tools: [], hostFunctions: [] })).toBe(
      false,
    );
  });

  test("true when the manifest declares side-effecting tools", () => {
    expect(manifestGrantsSideEffects({ tools: ["file_write"] })).toBe(true);
    expect(manifestGrantsSideEffects({ tools: ["bash", "send_email"] })).toBe(
      true,
    );
  });

  test("true when the manifest declares host functions", () => {
    expect(manifestGrantsSideEffects({ hostFunctions: ["notify"] })).toBe(true);
  });

  test("persona alone is NOT side-effecting (identity/memory, not tools)", () => {
    expect(manifestGrantsSideEffects({ persona: true })).toBe(false);
    expect(
      manifestGrantsSideEffects({
        tools: [],
        hostFunctions: [],
        persona: true,
      }),
    ).toBe(false);
  });

  test("false (never throws) for a malformed manifest — execute re-parses and rejects it", () => {
    expect(manifestGrantsSideEffects({ tools: "not-an-array" })).toBe(false);
    expect(manifestGrantsSideEffects(42)).toBe(false);
    expect(manifestGrantsSideEffects("nope")).toBe(false);
  });
});
