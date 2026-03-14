/**
 * Smoke test: verifies that the bundled feature-flag-registry.json exists
 * in the assistant source tree and is a valid, non-empty registry.
 *
 * The bundled copy is created by `meta/feature-flags/sync-bundled-copies.ts`
 * (run via postinstall or CI sync step). This test catches cases where the
 * sync was skipped — e.g. Docker builds that forget to copy the registry.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const BUNDLED_PATH = join(
  import.meta.dirname ?? __dirname,
  "..",
  "feature-flag-registry.json",
);

describe("bundled feature-flag-registry.json", () => {
  test("file exists", () => {
    expect(
      existsSync(BUNDLED_PATH),
      `Expected bundled registry at ${BUNDLED_PATH}. Run: bun run meta/feature-flags/sync-bundled-copies.ts`,
    ).toBe(true);
  });

  test("file is non-empty and valid JSON", () => {
    const stat = statSync(BUNDLED_PATH);
    expect(stat.size).toBeGreaterThan(0);

    const raw = readFileSync(BUNDLED_PATH, "utf-8");
    const registry = JSON.parse(raw);

    expect(registry.version).toBe(1);
    expect(Array.isArray(registry.flags)).toBe(true);
    expect(registry.flags.length).toBeGreaterThan(0);
  });
});
