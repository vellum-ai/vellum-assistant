import { describe, expect, it } from "bun:test";

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
      expect(tip.body.length).toBeLessThanOrEqual(120);
    }
  });
});
