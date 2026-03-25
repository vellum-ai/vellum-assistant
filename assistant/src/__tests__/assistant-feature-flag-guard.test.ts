import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Guard tests for assistant feature flags.
 *
 * 1. Key format validation: ensure production code uses the canonical
 *    simple kebab-case format (e.g., "browser", "ces-tools"), not the
 *    legacy `skills.<id>.enabled` format.
 *
 * 2. Declaration coverage: ensure all assistant-scope flag keys in the
 *    unified registry conform to the simple kebab-case format.
 *
 * See AGENTS.md "Assistant Feature Flags" for the full convention.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/) */
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
  const raw = readFileSync(getRegistryPath(), "utf-8");
  return JSON.parse(raw);
}

const CANONICAL_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Files allowed to contain the legacy `skills.<id>.enabled` key format.
 * Keep this list minimal — only files that genuinely need to reference
 * the legacy format for backward compatibility.
 */
const LEGACY_KEY_ALLOWLIST = new Set([
  // macOS client: fallback reads from legacy config section
  "clients/macos/vellum-assistant/Features/Settings/SettingsAccountTab.swift",
]);

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.includes("/Tests/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js") ||
    filePath.endsWith("Tests.swift")
  );
}

// ---------------------------------------------------------------------------
// Test: key format validation
// ---------------------------------------------------------------------------

describe("assistant feature flag guard", () => {
  test("no production files use legacy skills.<id>.enabled key format outside allowlist", () => {
    // Search for the legacy key pattern in string literals across the codebase.
    // The pattern matches quoted strings like 'skills.browser.enabled',
    // "skills.browser.enabled", or `skills.browser.enabled`.
    const pattern = `['"\`]skills\\.[a-z][a-z0-9._-]*\\.enabled['"\`]`;

    let grepOutput = "";
    try {
      // Use execFileSync to avoid shell interpretation — the pattern contains
      // backtick characters that would trigger command substitution in /bin/sh
      // if passed through execSync's shell.
      grepOutput = execFileSync(
        "git",
        [
          "grep",
          "-lE",
          pattern,
          "--",
          "*.ts",
          "*.tsx",
          "*.js",
          "*.jsx",
          "*.swift",
        ],
        { encoding: "utf-8", cwd: getRepoRoot() },
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
        "Found production files using the legacy `skills.<id>.enabled` key format.",
        'New code must use the canonical simple kebab-case format (e.g., "browser", "ces-tools").',
        'See AGENTS.md "Assistant Feature Flags" for the convention.',
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: replace `skills.<id>.enabled` with the simple kebab-case format.",
        "If backward-compat access is genuinely needed, add to LEGACY_KEY_ALLOWLIST in assistant-feature-flag-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Test: unified registry key format (assistant-scope only)
  // ---------------------------------------------------------------------------

  test("all assistant-scope keys in the unified registry use the canonical simple kebab-case format", () => {
    const registry = loadRegistry();
    const assistantFlags = registry.flags.filter(
      (f) => f.scope === "assistant",
    );
    const keys = assistantFlags.map((f) => f.key);

    const violations = keys.filter((key) => !CANONICAL_KEY_RE.test(key));

    if (violations.length > 0) {
      const message = [
        "Found assistant-scope keys in the unified registry that do not match the canonical format.",
        'Expected format: simple kebab-case (e.g., "browser", "ces-tools")',
        "",
        "Violations:",
        ...violations.map((k) => `  - ${k}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Test: registry entries have required fields
  // ---------------------------------------------------------------------------

  test("all assistant-scope entries in the unified registry have required fields", () => {
    const registry = loadRegistry();
    const assistantFlags = registry.flags.filter(
      (f) => f.scope === "assistant",
    );
    const violations: string[] = [];

    for (const flag of assistantFlags) {
      if (typeof flag.defaultEnabled !== "boolean") {
        violations.push(`${flag.key}: missing or non-boolean 'defaultEnabled'`);
      }
      if (
        typeof flag.description !== "string" ||
        flag.description.length === 0
      ) {
        violations.push(`${flag.key}: missing or empty 'description'`);
      }
      if (typeof flag.label !== "string" || flag.label.length === 0) {
        violations.push(`${flag.key}: missing or empty 'label'`);
      }
      if (typeof flag.id !== "string" || flag.id.length === 0) {
        violations.push(`${flag.key}: missing or empty 'id'`);
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found entries in the unified registry with missing or invalid required fields.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
