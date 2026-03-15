/**
 * Package boundary tests for @vellumai/credential-storage.
 *
 * Ensures the package:
 * 1. Does NOT import from the assistant daemon or CES modules.
 * 2. Exposes only local storage/runtime abstractions.
 * 3. Remains portable and self-contained.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

/**
 * Recursively collect all .ts files under a directory, excluding test files.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      files.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Patterns that must NOT appear in any import/require statement within
 * source files. These catch imports from the assistant daemon, CES,
 * or other modules this package should never depend on.
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  // Assistant daemon internals
  /from\s+["'](?:\.\.\/)*(?:assistant|@vellumai\/assistant)\//,
  /require\s*\(\s*["'](?:\.\.\/)*(?:assistant|@vellumai\/assistant)\//,

  // CES modules (credential execution service)
  /from\s+["'].*\/ces\//,
  /require\s*\(\s*["'].*\/ces\//,
  /from\s+["']@vellumai\/ces/,
  /require\s*\(\s*["']@vellumai\/ces/,

  // Direct runtime/daemon imports
  /from\s+["'].*\/runtime\//,
  /require\s*\(\s*["'].*\/runtime\//,
  /from\s+["'].*\/daemon\//,
  /require\s*\(\s*["'].*\/daemon\//,

  // Direct config/tools imports from assistant
  /from\s+["'].*\/config\/loader/,
  /from\s+["'].*\/tools\//,
  /from\s+["'].*\/oauth\/oauth-store/,
  /from\s+["'].*\/security\/secure-keys/,
];

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("does not import from assistant or CES modules", () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
          if (pattern.test(line)) {
            const relative = file.replace(PACKAGE_ROOT + "/", "");
            violations.push(`${relative}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} forbidden import(s) in credential-storage package:\n` +
          violations.map((v) => `  - ${v}`).join("\n"),
      );
    }
  });

  test("package.json declares it as private", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
  });

  test("package.json does not depend on assistant or CES packages", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    const forbidden = Object.keys(allDeps).filter(
      (dep) =>
        dep.includes("assistant") ||
        dep.includes("ces") ||
        dep.includes("daemon"),
    );
    expect(forbidden).toEqual([]);
  });
});

describe("public API surface", () => {
  test("exports credential record types", async () => {
    const mod = await import("../../src/index.js");

    // Verify credentialKey function is exported and works
    expect(typeof mod.credentialKey).toBe("function");
    expect(mod.credentialKey("github", "api_key")).toBe(
      "credential/github/api_key",
    );
  });

  test("exports only local storage/runtime abstractions", async () => {
    const mod = await import("../../src/index.js");
    const exportedNames = Object.keys(mod);

    // Should export the credentialKey utility
    expect(exportedNames).toContain("credentialKey");

    // Should NOT export anything CES-specific or assistant-specific
    const forbidden = exportedNames.filter(
      (name) =>
        name.toLowerCase().includes("daemon") ||
        name.toLowerCase().includes("ces") ||
        name.toLowerCase().includes("agentloop") ||
        name.toLowerCase().includes("toolexecutor"),
    );
    expect(forbidden).toEqual([]);
  });
});
