import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

describe("feature flag registry availability", () => {
  test("unified registry exists and contains assistant-scope flags", () => {
    const repoRoot = join(process.cwd(), "..");
    const registryPath = join(
      repoRoot,
      "meta",
      "feature-flags",
      "feature-flag-registry.json",
    );

    const raw = readFileSync(registryPath, "utf-8");
    const registry = JSON.parse(raw);

    expect(registry.version).toBe(1);
    expect(Array.isArray(registry.flags)).toBe(true);

    const assistantFlags = registry.flags.filter(
      (f: { scope: string }) => f.scope === "assistant",
    );
    expect(assistantFlags.length).toBeGreaterThan(0);

    // Every assistant-scope flag should have required fields
    for (const flag of assistantFlags) {
      expect(typeof flag.id).toBe("string");
      expect(typeof flag.key).toBe("string");
      expect(typeof flag.label).toBe("string");
      expect(typeof flag.description).toBe("string");
      expect(typeof flag.defaultEnabled).toBe("boolean");
      expect(flag.scope).toBe("assistant");
    }
  });
});
