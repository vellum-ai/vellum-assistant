/**
 * Package boundary tests for @vellumai/service-contracts.
 *
 * Ensures the package:
 * 1. Does NOT import from assistant, gateway, credential-executor, or other
 *    service runtime modules.
 * 2. Does NOT import from runtime shared packages that sit above it in the
 *    dependency hierarchy (@vellumai/credential-storage, @vellumai/egress-proxy,
 *    @vellumai/skill-host-contracts).
 * 3. Does NOT import from x-client packages (@vellumai/assistant-client,
 *    @vellumai/ces-client, @vellumai/gateway-client).
 * 4. Remains a pure schema/type package — no runtime dependencies beyond zod.
 *
 * @vellumai/service-contracts is the lowest layer of the shared packages
 * hierarchy and must not depend on any higher-layer package.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

/**
 * Recursively collect all .ts source files, excluding test and declaration files.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      files.push(...collectSourceFiles(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Patterns that must NOT appear in any import/require statement within
 * source files. These catch imports from higher-layer packages that would
 * create a forbidden upward dependency.
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  // Assistant runtime
  /from\s+["'](?:\.\.\/)*assistant(?:\/|["'])/,
  /require\s*\(\s*["'](?:\.\.\/)*assistant(?:\/|["'])/,
  /from\s+["']@vellumai\/assistant(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/assistant(?:\/|["'])/,

  // Gateway
  /from\s+["'](?:\.\.\/)*gateway(?:\/|["'])/,
  /require\s*\(\s*["'](?:\.\.\/)*gateway(?:\/|["'])/,
  /from\s+["']@vellumai\/(?:vellum-)?gateway(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/(?:vellum-)?gateway(?:\/|["'])/,

  // Credential executor
  /from\s+["'](?:\.\.\/)*credential-executor(?:\/|["'])/,
  /require\s*\(\s*["'](?:\.\.\/)*credential-executor(?:\/|["'])/,
  /from\s+["']@vellumai\/credential-executor(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/credential-executor(?:\/|["'])/,

  // Runtime shared packages (higher layer)
  /from\s+["']@vellumai\/credential-storage(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/credential-storage(?:\/|["'])/,
  /from\s+["']@vellumai\/egress-proxy(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/egress-proxy(?:\/|["'])/,
  /from\s+["']@vellumai\/skill-host-contracts(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/skill-host-contracts(?:\/|["'])/,

  // x-client packages (higher layer)
  /from\s+["']@vellumai\/assistant-client(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/assistant-client(?:\/|["'])/,
  /from\s+["']@vellumai\/ces-client(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/ces-client(?:\/|["'])/,
  /from\s+["']@vellumai\/gateway-client(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/gateway-client(?:\/|["'])/,
];

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("does not import from runtime or higher-layer packages", () => {
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
        `Found ${violations.length} forbidden import(s) in service-contracts package:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\n" +
          "@vellumai/service-contracts is a pure schema/type package and must not\n" +
          "import from runtime services or higher-layer packages.",
      );
    }
  });

  test("package.json declares it as private", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
  });

  test("package.json does not depend on runtime or higher-layer packages", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    const forbidden = Object.keys(allDeps).filter((dep) =>
      [
        "@vellumai/assistant",
        "@vellumai/credential-storage",
        "@vellumai/egress-proxy",
        "@vellumai/skill-host-contracts",
        "@vellumai/assistant-client",
        "@vellumai/ces-client",
        "@vellumai/gateway-client",
      ].includes(dep),
    );

    expect(forbidden).toEqual([]);
  });
});
