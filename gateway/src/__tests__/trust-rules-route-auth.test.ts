import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexSource = readFileSync(
  join(import.meta.dir, "..", "index.ts"),
  "utf8",
);

function extractTrustRuleRouteObjects(): string[] {
  const start = indexSource.indexOf("// ── Trust rules v3 ──");
  const end = indexSource.indexOf("  ];", start);
  const trustRuleRoutesSource = indexSource.slice(start, end);

  return trustRuleRoutesSource
    .split(/\n    \},\n/)
    .filter((routeObject) => routeObject.includes("handleTrustRules"));
}

describe("trust rule route authorization", () => {
  test("all trust rule routes use scoped settings authorization", () => {
    const routeObjects = extractTrustRuleRouteObjects();

    expect(routeObjects).toHaveLength(12);

    for (const routeObject of routeObjects) {
      expect(routeObject).toContain('auth: "edge-scoped"');
      expect(routeObject).not.toContain('auth: "edge"');

      const expectedScope = routeObject.includes("handleTrustRulesList")
        ? 'scope: "settings.read"'
        : 'scope: "settings.write"';
      expect(routeObject).toContain(expectedScope);
    }
  });
});
