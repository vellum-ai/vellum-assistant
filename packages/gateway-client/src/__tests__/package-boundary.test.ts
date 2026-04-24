/**
 * Package boundary tests for @vellumai/gateway-client.
 *
 * Ensures the package:
 * 1. Does NOT import from assistant, gateway, or credential-executor service
 *    runtime modules.
 * 2. Does NOT import from runtime shared packages (@vellumai/credential-storage,
 *    @vellumai/egress-proxy).
 * 3. Remains a lightweight client package with no runtime service dependencies.
 *
 * @vellumai/gateway-client is a typed HTTP client for assistant-to-gateway
 * calls (trust API, feature flags, log export, deliver). It may depend on
 * @vellumai/service-contracts for shared type definitions, but must not pull
 * in runtime service internals.
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
 * source files.
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  // Assistant runtime internals
  /from\s+["'](?:\.\.\/)+assistant\/src/,
  /require\s*\(\s*["'](?:\.\.\/)+assistant\/src/,
  /from\s+["']@vellumai\/assistant(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/assistant(?:\/|["'])/,

  // Gateway runtime internals (not the gateway-client package itself)
  /from\s+["'](?:\.\.\/)+gateway\/src/,
  /require\s*\(\s*["'](?:\.\.\/)+gateway\/src/,
  /from\s+["']@vellumai\/(?:vellum-)?gateway(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/(?:vellum-)?gateway(?:\/|["'])/,

  // Credential executor runtime internals
  /from\s+["'](?:\.\.\/)+credential-executor\/src/,
  /require\s*\(\s*["'](?:\.\.\/)+credential-executor\/src/,
  /from\s+["']@vellumai\/credential-executor(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/credential-executor(?:\/|["'])/,

  // Runtime shared packages
  /from\s+["']@vellumai\/credential-storage(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/credential-storage(?:\/|["'])/,
  /from\s+["']@vellumai\/egress-proxy(?:\/|["'])/,
  /require\s*\(\s*["']@vellumai\/egress-proxy(?:\/|["'])/,
];

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("does not import from service runtime modules or runtime shared packages", () => {
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
        `Found ${violations.length} forbidden import(s) in gateway-client package:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\n" +
          "@vellumai/gateway-client must not import from service runtime modules\n" +
          "or runtime shared packages (credential-storage, egress-proxy).",
      );
    }
  });

  test("package.json declares it as private", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
  });

  test("package.json does not depend on service runtime or runtime shared packages", () => {
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
        "@vellumai/vellum-gateway",
        "@vellumai/credential-storage",
        "@vellumai/egress-proxy",
      ].includes(dep),
    );

    expect(forbidden).toEqual([]);
  });
});
