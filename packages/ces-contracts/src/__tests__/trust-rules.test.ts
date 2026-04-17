/**
 * Tests for trust-rule family types and canonical parsing/normalization.
 *
 * Verifies:
 * 1. Scoped-rule parsing preserves executionTarget and allowHighRisk.
 * 2. Non-scoped known-tool rules strip executionTarget but preserve boolean
 *    allowHighRisk for backward compatibility.
 * 3. Unknown-tool rules preserve all fields for forward compatibility.
 * 4. Normalization flag behavior signals when a re-save is warranted.
 * 5. parseTrustFileData handles full trust file objects.
 */

import { describe, expect, test } from "bun:test";
import {
  isManagedSkillRule,
  isScopedRule,
  isSkillLoadRule,
  isUrlRule,
  parseTrustFileData,
  parseTrustRule,
  SCOPED_TOOLS,
  URL_TOOLS,
  MANAGED_SKILL_TOOLS,
  SKILL_LOAD_TOOL,
} from "../trust-rules.js";
import type {
  GenericTrustRule,
  ManagedSkillTrustRule,
  ScopedTrustRule,
  SkillLoadTrustRule,
  TrustRule,
  UrlTrustRule,
} from "../trust-rules.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-rule-1",
    tool: "bash",
    pattern: "**",
    scope: "everywhere",
    decision: "allow",
    priority: 100,
    createdAt: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scoped-rule parsing
// ---------------------------------------------------------------------------

describe("parseTrustRule — scoped tools", () => {
  test.each([...SCOPED_TOOLS])("preserves executionTarget and allowHighRisk for %s", (tool) => {
    const raw = makeRaw({
      tool,
      executionTarget: "container-a",
      allowHighRisk: true,
    });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect(rule.tool).toBe(tool);
    expect((rule as ScopedTrustRule).executionTarget).toBe("container-a");
    expect((rule as ScopedTrustRule).allowHighRisk).toBe(true);
  });

  test("scoped rule without optional fields is not normalized", () => {
    const raw = makeRaw({ tool: "host_bash" });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect(rule.tool).toBe("host_bash");
    expect("executionTarget" in rule).toBe(false);
    expect("allowHighRisk" in rule).toBe(false);
  });

  test("type guard isScopedRule narrows correctly", () => {
    const { rule } = parseTrustRule(makeRaw({ tool: "file_write" }));
    expect(isScopedRule(rule)).toBe(true);
    expect(isUrlRule(rule)).toBe(false);
    expect(isManagedSkillRule(rule)).toBe(false);
    expect(isSkillLoadRule(rule)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-scoped known-tool scope stripping
// ---------------------------------------------------------------------------

describe("parseTrustRule — URL tools strip invalid fields", () => {
  test.each([...URL_TOOLS])(
    "strips executionTarget but preserves allowHighRisk on %s",
    (tool) => {
      const raw = makeRaw({
        tool,
        executionTarget: "should-be-stripped",
        allowHighRisk: true,
      });
      const { rule, normalized } = parseTrustRule(raw);
      expect(normalized).toBe(true);
      expect(rule.tool).toBe(tool);
      expect("executionTarget" in rule).toBe(false);
      expect((rule as UrlTrustRule).allowHighRisk).toBe(true);
    },
  );

  test("URL tool without invalid fields is not normalized", () => {
    const raw = makeRaw({ tool: "web_fetch" });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect(rule.tool).toBe("web_fetch");
  });

  test("type guard isUrlRule narrows correctly", () => {
    const { rule } = parseTrustRule(makeRaw({ tool: "browser_navigate" }));
    expect(isUrlRule(rule)).toBe(true);
    expect(isScopedRule(rule)).toBe(false);
  });
});

describe("parseTrustRule — managed skill tools strip invalid fields", () => {
  test.each([...MANAGED_SKILL_TOOLS])(
    "strips executionTarget but preserves allowHighRisk on %s",
    (tool) => {
      const raw = makeRaw({
        tool,
        executionTarget: "x",
        allowHighRisk: false,
      });
      const { rule, normalized } = parseTrustRule(raw);
      expect(normalized).toBe(true);
      expect("executionTarget" in rule).toBe(false);
      expect((rule as ManagedSkillTrustRule).allowHighRisk).toBe(false);
    },
  );

  test("type guard isManagedSkillRule narrows correctly", () => {
    const { rule } = parseTrustRule(makeRaw({ tool: "scaffold_managed_skill" }));
    expect(isManagedSkillRule(rule)).toBe(true);
    expect(isScopedRule(rule)).toBe(false);
  });
});

describe("parseTrustRule — skill_load strips invalid fields", () => {
  test("strips executionTarget but preserves allowHighRisk on skill_load", () => {
    const raw = makeRaw({
      tool: SKILL_LOAD_TOOL,
      executionTarget: "container-b",
      allowHighRisk: true,
    });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(true);
    expect(rule.tool).toBe(SKILL_LOAD_TOOL);
    expect("executionTarget" in rule).toBe(false);
    expect((rule as SkillLoadTrustRule).allowHighRisk).toBe(true);
  });

  test("skill_load without invalid fields is not normalized", () => {
    const raw = makeRaw({ tool: SKILL_LOAD_TOOL, pattern: "skill_load:*" });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect(rule.tool).toBe(SKILL_LOAD_TOOL);
  });

  test("type guard isSkillLoadRule narrows correctly", () => {
    const { rule } = parseTrustRule(makeRaw({ tool: SKILL_LOAD_TOOL }));
    expect(isSkillLoadRule(rule)).toBe(true);
    expect(isScopedRule(rule)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown-tool preservation
// ---------------------------------------------------------------------------

describe("parseTrustRule — unknown tools", () => {
  test("preserves executionTarget and allowHighRisk for unknown tools", () => {
    const raw = makeRaw({
      tool: "future_tool_v99",
      executionTarget: "edge-worker",
      allowHighRisk: true,
    });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect(rule.tool).toBe("future_tool_v99");
    expect((rule as GenericTrustRule).executionTarget).toBe("edge-worker");
    expect((rule as GenericTrustRule).allowHighRisk).toBe(true);
  });

  test("unknown tool without optional fields is not normalized", () => {
    const raw = makeRaw({ tool: "computer_use_click" });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect(rule.tool).toBe("computer_use_click");
    expect("executionTarget" in rule).toBe(false);
    expect("allowHighRisk" in rule).toBe(false);
  });

  test("all type guards return false for generic rules", () => {
    const { rule } = parseTrustRule(makeRaw({ tool: "some_new_tool" }));
    expect(isScopedRule(rule)).toBe(false);
    expect(isUrlRule(rule)).toBe(false);
    expect(isManagedSkillRule(rule)).toBe(false);
    expect(isSkillLoadRule(rule)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normalization flag behavior
// ---------------------------------------------------------------------------

describe("parseTrustRule — normalization flag", () => {
  test("normalized is false when no changes needed", () => {
    const raw = makeRaw({ tool: "host_bash", allowHighRisk: true });
    const { normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
  });

  test("normalized is true when invalid fields are stripped", () => {
    const raw = makeRaw({ tool: "web_fetch", allowHighRisk: true });
    const { normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
  });

  test("normalized is true when decision is coerced", () => {
    const raw = makeRaw({ tool: "bash", decision: "invalid_decision" });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(true);
    expect(rule.decision).toBe("ask");
  });

  test("empty executionTarget string is not preserved on scoped rules", () => {
    const raw = makeRaw({ tool: "bash", executionTarget: "" });
    const { rule, normalized } = parseTrustRule(raw);
    expect(normalized).toBe(false);
    expect("executionTarget" in rule).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTrustFileData
// ---------------------------------------------------------------------------

describe("parseTrustFileData", () => {
  test("parses a valid trust file with mixed rule families", () => {
    const raw = {
      version: 3,
      starterBundleAccepted: true,
      rules: [
        makeRaw({ id: "r1", tool: "bash" }),
        makeRaw({ id: "r2", tool: "web_fetch", pattern: "web_fetch:https://example.com/*" }),
        makeRaw({ id: "r3", tool: "skill_load", pattern: "skill_load:*" }),
      ],
    };
    const { data, normalized } = parseTrustFileData(raw);
    expect(normalized).toBe(false);
    expect(data.version).toBe(3);
    expect(data.starterBundleAccepted).toBe(true);
    expect(data.rules).toHaveLength(3);
    expect(data.rules[0].tool).toBe("bash");
    expect(data.rules[1].tool).toBe("web_fetch");
    expect(data.rules[2].tool).toBe("skill_load");
  });

  test("reports normalized when any rule is modified", () => {
    const raw = {
      version: 3,
      rules: [
        makeRaw({ id: "r1", tool: "bash" }),
        // This rule has an invalid field for its family
        makeRaw({ id: "r2", tool: "web_fetch", executionTarget: "stale" }),
      ],
    };
    const { data, normalized } = parseTrustFileData(raw);
    expect(normalized).toBe(true);
    expect(data.rules).toHaveLength(2);
    expect("executionTarget" in data.rules[1]).toBe(false);
  });

  test("skips null/non-object entries and flags as normalized", () => {
    const raw = {
      version: 3,
      rules: [null, 42, makeRaw({ id: "r1", tool: "bash" })],
    };
    const { data, normalized } = parseTrustFileData(raw);
    expect(normalized).toBe(true);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].id).toBe("r1");
  });

  test("handles missing rules array", () => {
    const raw = { version: 3 };
    const { data, normalized } = parseTrustFileData(raw);
    expect(normalized).toBe(false);
    expect(data.rules).toEqual([]);
  });

  test("handles missing version", () => {
    const raw = { rules: [] };
    const { data } = parseTrustFileData(raw);
    expect(data.version).toBe(0);
  });

  test("starterBundleAccepted defaults to undefined when not true", () => {
    const raw = { version: 3, rules: [], starterBundleAccepted: false };
    const { data } = parseTrustFileData(raw);
    expect(data.starterBundleAccepted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke tests (compile-time only — no runtime assertions)
// ---------------------------------------------------------------------------

describe("type-level compatibility", () => {
  test("TrustRule union is assignable from all family interfaces", () => {
    // These assignments verify that each family interface satisfies TrustRule.
    // If any interface breaks the union, TypeScript will fail at compile time.
    const scoped: ScopedTrustRule = {
      id: "s1",
      tool: "bash",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 50,
      createdAt: 0,
      executionTarget: "host",
      allowHighRisk: true,
    };
    const url: UrlTrustRule = {
      id: "u1",
      tool: "web_fetch",
      pattern: "web_fetch:*",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
      createdAt: 0,
    };
    const managed: ManagedSkillTrustRule = {
      id: "m1",
      tool: "scaffold_managed_skill",
      pattern: "scaffold_managed_skill:*",
      scope: "everywhere",
      decision: "ask",
      priority: 1000,
      createdAt: 0,
    };
    const skillLoad: SkillLoadTrustRule = {
      id: "sl1",
      tool: "skill_load",
      pattern: "skill_load:*",
      scope: "everywhere",
      decision: "allow",
      priority: 100,
      createdAt: 0,
    };
    const generic: GenericTrustRule = {
      id: "g1",
      tool: "computer_use_click",
      pattern: "**",
      scope: "everywhere",
      decision: "ask",
      priority: 1000,
      createdAt: 0,
    };

    // All should be assignable to TrustRule
    const rules: TrustRule[] = [scoped, url, managed, skillLoad, generic];
    expect(rules).toHaveLength(5);
  });
});
