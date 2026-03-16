/**
 * Guard tests for assistant feature flag conventions:
 *
 * 1. Key format: all feature flag keys used in production code must follow the
 *    canonical `feature_flags.<flag_id>.enabled` format. Any remaining
 *    `skills.<id>.enabled` usage outside of migration/backward-compat code is
 *    flagged — including template literal forms like `skills.${skillId}.enabled`.
 *
 * 2. Declaration coverage: all literal keys passed to
 *    `isAssistantFeatureFlagEnabled('<key>', ...)` in production code must be
 *    declared in the unified registry. This keeps flag usage declarative while
 *    allowing skills to exist without corresponding feature flags.
 *
 * 3. Indirect key coverage: all `feature_flags.<id>.enabled` string literals
 *    anywhere in production code (maps, constants, variables, etc.) must be
 *    declared in the unified registry. This catches indirect key patterns that
 *    Guard 2 would miss, such as flag keys stored in lookup maps or constants.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the repo root from the assistant/ package directory. */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

interface RegistryFlag {
  id: string;
  scope: string;
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

interface Registry {
  version: number;
  flags: RegistryFlag[];
}

function loadRegistry(): Registry {
  const registryPath = join(
    getRepoRoot(),
    "meta",
    "feature-flags",
    "feature-flag-registry.json",
  );
  return JSON.parse(readFileSync(registryPath, "utf-8"));
}

/**
 * Files allowed to contain `skills.<id>.enabled` string literals because they
 * are part of the backward-compat / migration layer or are test files
 * exercising legacy paths.
 */
const LEGACY_KEY_ALLOWLIST = new Set([
  // Type definitions documenting the legacy format
  "assistant/src/config/types.ts",
  // macOS client: fallback reads from legacy config section
  "clients/macos/vellum-assistant/Features/Settings/SettingsAccountTab.swift",
]);

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js")
  );
}

// ---------------------------------------------------------------------------
// Guard 1: Key format — no stale `skills.<id>.enabled` in production code
// ---------------------------------------------------------------------------

describe("assistant feature flag key format guard", () => {
  test("no production TypeScript files use skills.<id>.enabled outside allowlist", () => {
    const repoRoot = getRepoRoot();

    // Search for string literals and template literals containing
    // `skills.<id>.enabled` or `skills.${...}.enabled` in .ts files
    // under assistant/src/ and gateway/src/ (excluding test files and
    // allowlisted paths). The pattern catches both literal keys
    // (e.g., `skills.foo.enabled`) and template literal forms
    // (e.g., `skills.${skillId}.enabled`).
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -lE "skills\\.[a-z0-9_-]+\\.enabled|skills\\.\\$\\{" -- 'assistant/src/**/*.ts' 'gateway/src/**/*.ts'`,
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (LEGACY_KEY_ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found production TypeScript files using legacy `skills.<id>.enabled` key format.",
        "Use the canonical `feature_flags.<id>.enabled` format instead.",
        "Call `isAssistantFeatureFlagEnabled(`feature_flags.${skillId}.enabled`, config)` to check skill flags.",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "If this is a legitimate backward-compat path, add it to LEGACY_KEY_ALLOWLIST in",
        "assistant-feature-flag-guardrails.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard 2: Declaration coverage for literal key usage
// ---------------------------------------------------------------------------

describe("assistant feature flag declaration coverage guard", () => {
  test("all literal flag keys in isAssistantFeatureFlagEnabled calls are declared in the unified registry", () => {
    const repoRoot = getRepoRoot();

    // Load the unified registry and extract assistant-scope keys
    const registry = loadRegistry();
    const declaredKeys = new Set(
      registry.flags.filter((f) => f.scope === "assistant").map((f) => f.key),
    );

    // Extract full keys from isAssistantFeatureFlagEnabled('<key>', ...) calls
    // in non-test production files. We read each matching file and apply a
    // multiline regex so that calls split across lines are still caught:
    //
    //   isAssistantFeatureFlagEnabled(
    //     'feature_flags.foo.enabled',
    //     config,
    //   )
    //
    const usedKeys = new Set<string>();
    let matchingFiles = "";
    try {
      matchingFiles = execSync(
        `git grep -l "isAssistantFeatureFlagEnabled" -- 'assistant/src/**/*.ts' ':!assistant/src/__tests__/**'`,
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }

    if (matchingFiles) {
      // Multiline regex: match the function name, optional whitespace/newlines,
      // opening paren, optional whitespace/newlines, then a quoted string key.
      const multilinePattern =
        /isAssistantFeatureFlagEnabled\(\s*['"]([^'"]+)['"]/g;
      for (const relPath of matchingFiles.split("\n")) {
        if (!relPath) continue;
        const absPath = join(repoRoot, relPath);
        const content = readFileSync(absPath, "utf-8");
        for (const match of content.matchAll(multilinePattern)) {
          usedKeys.add(match[1]);
        }
      }
    }

    // Check that all used keys are declared in the registry
    const undeclared: string[] = [];
    for (const key of usedKeys) {
      if (!declaredKeys.has(key)) {
        undeclared.push(key);
      }
    }

    if (undeclared.length > 0) {
      const message = [
        "Found feature flag keys used in production code that are NOT declared in the unified registry.",
        `Registry: meta/feature-flags/feature-flag-registry.json`,
        "",
        "Undeclared keys:",
        ...undeclared.map((k) => `  - ${k}`),
        "",
        'To fix: add the missing key(s) to the unified registry with scope "assistant".',
      ].join("\n");

      expect(undeclared, message).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard 3: Indirect key coverage — flag key literals anywhere in production code
// ---------------------------------------------------------------------------

describe("assistant feature flag indirect key coverage guard", () => {
  test("all feature_flags.<id>.enabled string literals in production code are declared in the unified registry", () => {
    const repoRoot = getRepoRoot();

    // Load the unified registry and extract all declared keys (any scope)
    const registry = loadRegistry();
    const declaredKeys = new Set(registry.flags.map((f) => f.key));

    // Search for any string literal matching the canonical key pattern
    // in production .ts files under assistant/src/ and gateway/src/.
    // This catches keys in maps, constants, variables, or any other
    // indirect patterns that Guard 2 would miss.
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -nE "feature_flags\\.[a-z0-9_-]+\\.enabled\\b" -- 'assistant/src/**/*.ts' 'gateway/src/**/*.ts'`,
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const keyPattern = /feature_flags\.[a-z0-9_-]+\.enabled\b/g;
    const undeclared: string[] = [];

    for (const line of grepOutput.split("\n")) {
      if (!line) continue;

      // Format: "file:line:content"
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const filePath = line.slice(0, colonIdx);

      // Skip test files and persisted-data migration files (they reference retired flag keys by design)
      if (isTestFile(filePath)) continue;
      if (
        filePath.includes("/workspace/migrations/") ||
        filePath.includes("/memory/migrations/")
      )
        continue;

      // Extract all key occurrences from this line
      const content = line.slice(colonIdx + 1);
      for (const match of content.matchAll(keyPattern)) {
        const key = match[0];
        if (!declaredKeys.has(key)) {
          undeclared.push(`${filePath}: ${key}`);
        }
      }
    }

    if (undeclared.length > 0) {
      const message = [
        "Found feature_flags.<id>.enabled string literals in production code that are NOT declared in the unified registry.",
        "This catches indirect flag key usage (maps, constants, variables) that the direct-call guard misses.",
        `Registry: meta/feature-flags/feature-flag-registry.json`,
        "",
        "Undeclared keys:",
        ...undeclared.map((k) => `  - ${k}`),
        "",
        "To fix: add the missing key(s) to the unified registry, or remove the stale reference.",
      ].join("\n");

      expect(undeclared, message).toEqual([]);
    }
  });
});
