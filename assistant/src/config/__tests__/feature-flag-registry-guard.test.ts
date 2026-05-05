/**
 * Validation guard tests for the unified feature flag registry.
 *
 * Ensures structural invariants hold so that both the TS and Swift loaders
 * can safely consume the registry without runtime surprises.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

function getRegistryPath(): string {
  return join(
    getRepoRoot(),
    "meta",
    "feature-flags",
    "feature-flag-registry.json",
  );
}

function loadRegistry(): Record<string, unknown> {
  const raw = readFileSync(getRegistryPath(), "utf-8");
  return JSON.parse(raw);
}

const VALID_SCOPES = new Set(["assistant", "client"]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unified feature flag registry guard", () => {
  const registry = loadRegistry();
  const flags = registry.flags as Record<string, unknown>[];

  // -----------------------------------------------------------------------
  // version
  // -----------------------------------------------------------------------

  test("version is a positive integer", () => {
    expect(typeof registry.version).toBe("number");
    expect(Number.isInteger(registry.version)).toBe(true);
    expect(registry.version as number).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // required fields and types
  // -----------------------------------------------------------------------

  test("all flags have required fields with correct types", () => {
    const violations: string[] = [];

    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      const prefix = `flags[${i}]`;

      if (typeof flag !== "object" || !flag || Array.isArray(flag)) {
        violations.push(`${prefix}: entry is not an object`);
        continue;
      }

      if (typeof flag.id !== "string" || flag.id.length === 0) {
        violations.push(`${prefix}: missing or non-string 'id'`);
      }
      if (typeof flag.scope !== "string" || flag.scope.length === 0) {
        violations.push(`${prefix}: missing or non-string 'scope'`);
      }
      if (typeof flag.key !== "string" || flag.key.length === 0) {
        violations.push(`${prefix}: missing or non-string 'key'`);
      }
      if (typeof flag.label !== "string" || flag.label.length === 0) {
        violations.push(`${prefix}: missing or non-string 'label'`);
      }
      if (
        typeof flag.description !== "string" ||
        flag.description.length === 0
      ) {
        violations.push(`${prefix}: missing or non-string 'description'`);
      }
      if (typeof flag.defaultEnabled !== "boolean") {
        violations.push(`${prefix}: missing or non-boolean 'defaultEnabled'`);
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found flags with missing or incorrectly-typed required fields.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // unique ids
  // -----------------------------------------------------------------------

  test("all id values are unique", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const flag of flags) {
      const id = flag.id as string;
      if (seen.has(id)) {
        duplicates.push(id);
      }
      seen.add(id);
    }

    if (duplicates.length > 0) {
      const message = [
        "Found duplicate flag id values in the registry.",
        "",
        "Duplicates:",
        ...duplicates.map((d) => `  - ${d}`),
      ].join("\n");

      expect(duplicates, message).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // unique keys
  // -----------------------------------------------------------------------

  test("all key values are unique", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const flag of flags) {
      const key = flag.key as string;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    if (duplicates.length > 0) {
      const message = [
        "Found duplicate flag key values in the registry.",
        "",
        "Duplicates:",
        ...duplicates.map((d) => `  - ${d}`),
      ].join("\n");

      expect(duplicates, message).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // valid scopes
  // -----------------------------------------------------------------------

  test("all scope values are valid", () => {
    const violations: string[] = [];

    for (const flag of flags) {
      const scope = flag.scope as string;
      if (!VALID_SCOPES.has(scope)) {
        violations.push(
          `flag '${flag.id}' has invalid scope '${scope}' (expected 'assistant' or 'client')`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found flags with invalid scope values.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
