import { describe, expect, it } from "bun:test";

import {
  getFlagDefinition,
  scopeIncludes,
} from "@/lib/feature-flags/feature-flag-catalog";
import { routes } from "@/utils/routes";
import { TIPS_CATALOG } from "@/utils/tips-catalog";

/** Every string leaf of the routes registry (route constants, not builders). */
function collectRoutePaths(node: unknown, into: Set<string>): Set<string> {
  if (typeof node === "string") {
    into.add(node);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) {
      collectRoutePaths(value, into);
    }
  }
  return into;
}

describe("TIPS_CATALOG", () => {
  it("has a unique id per tip", () => {
    const ids = TIPS_CATALOG.map((tip) => tip.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains only info tips from the curated source", () => {
    for (const tip of TIPS_CATALOG) {
      expect(tip.kind).toBe("info");
      expect(tip.source).toBe("curated");
    }
  });

  it("points every learnMore link at a real route constant", () => {
    const routePaths = collectRoutePaths(routes, new Set<string>());
    for (const tip of TIPS_CATALOG) {
      if (!tip.learnMore) {
        continue;
      }
      expect(routePaths.has(tip.learnMore.to)).toBe(true);
      expect(tip.learnMore.label.length).toBeGreaterThan(0);
    }
  });

  it("keeps tip copy short enough for the sidebar", () => {
    for (const tip of TIPS_CATALOG) {
      expect(tip.body.length).toBeGreaterThan(0);
      expect(tip.body.length).toBeLessThanOrEqual(90);
    }
  });

  it("gives every tip a short title and eyebrow", () => {
    for (const tip of TIPS_CATALOG) {
      expect(tip.title.length).toBeGreaterThan(0);
      expect(tip.title.length).toBeLessThanOrEqual(30);
      expect(tip.eyebrow.length).toBeGreaterThan(0);
      expect(tip.eyebrow.length).toBeLessThanOrEqual(14);
    }
  });

  it("gates flag-gated tips on a registry flag with the matching scope", () => {
    for (const tip of TIPS_CATALOG) {
      const checks = [
        { storeKey: tip.gates?.requiresClientFlag, scope: "client" as const },
        {
          storeKey: tip.gates?.requiresAssistantFlag,
          scope: "assistant" as const,
        },
      ];
      for (const { storeKey, scope } of checks) {
        if (!storeKey) {
          continue;
        }
        const definition = getFlagDefinition(storeKey);
        expect(definition).toBeDefined();
        expect(scopeIncludes(definition!.scope, scope)).toBe(true);
      }
    }
  });
});
