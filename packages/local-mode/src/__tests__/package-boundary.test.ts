/**
 * Package boundary tests for @vellumai/local-mode.
 *
 * This package is the shared local-assistant host surface. It sits one layer
 * above @vellumai/environments, @vellumai/service-contracts, and the
 * source-only @vellumai/avatar-manifest (its only allowed @vellumai
 * dependencies) and uses node builtins for filesystem, child-process, and
 * network work.
 *
 * Enforces that the package:
 * 1. Imports only node builtins, its own relative modules,
 *    `@vellumai/environments`, `@vellumai/service-contracts` (the pairing wire
 *    contracts), `@vellumai/avatar-manifest`, `zod` (the lockfile contract's
 *    schema library), and `nanoid` (pair's fallback local-id generator);
 *    nothing else.
 * 2. Declares exactly those runtime dependencies.
 * 3. Is marked `private`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

const ALLOWED_PACKAGES = new Set([
  "@vellumai/environments",
  "@vellumai/service-contracts",
  "@vellumai/avatar-manifest",
  "zod",
  "nanoid",
]);

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
 * Matches the module specifier of any `import ... from "<spec>"` /
 * `export ... from "<spec>"` / `require("<spec>")` statement.
 */
const IMPORT_SPEC = /(?:from\s+|require\s*\(\s*)["']([^"']+)["']/g;

/**
 * A specifier is forbidden when it is neither relative, a node builtin, nor
 * an entry point of one of the explicitly allowed packages.
 */
function isForbiddenSpecifier(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("node:")) return false;
  // A subpath export ("pkg/entry") is allowed exactly when its package is.
  const segments = spec.split("/");
  const packageName = spec.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0]!;
  return !ALLOWED_PACKAGES.has(packageName);
}

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("imports only node builtins, relative modules, and its allowed packages", () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i]!.matchAll(IMPORT_SPEC)) {
          const spec = match[1]!;
          if (isForbiddenSpecifier(spec)) {
            const relative = file.replace(PACKAGE_ROOT + "/", "");
            violations.push(`${relative}:${i + 1}: ${spec}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} forbidden import(s) in @vellumai/local-mode:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\n@vellumai/local-mode may import only node builtins, its own\n" +
          "relative modules, @vellumai/environments, and\n" +
          "@vellumai/service-contracts, and @vellumai/avatar-manifest. Any\n" +
          "other dependency would break bundler hosts that inline this\n" +
          "source-only package.",
      );
    }
  });

  test("package.json declares it as private with only its allowed dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies ?? {}).toEqual({
      "@vellumai/avatar-manifest": "workspace:*",
      "@vellumai/environments": "workspace:*",
      "@vellumai/service-contracts": "workspace:*",
      nanoid: "5.1.7",
      zod: "4.3.6",
    });
  });
});
