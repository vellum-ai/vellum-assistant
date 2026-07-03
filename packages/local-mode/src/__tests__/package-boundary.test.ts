/**
 * Package boundary tests for @vellumai/local-mode.
 *
 * This package is the shared local-assistant host surface. It sits one layer
 * above @vellumai/environments (its only allowed @vellumai dependency) and
 * uses node builtins for filesystem, child-process, and network work.
 *
 * Enforces that the package:
 * 1. Imports only node builtins, its own relative modules, `@vellumai/environments`,
 *    and `zod` (the lockfile contract's schema library) — nothing else.
 * 2. Declares exactly those two runtime dependencies.
 * 3. Is marked `private`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

const ALLOWED_PACKAGES = new Set(["@vellumai/environments", "zod"]);

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
const IMPORT_SPEC = /(?:from|require\s*\(\s*)["']([^"']+)["']/g;

/**
 * A specifier is forbidden when it is neither relative, a node builtin, nor
 * one of the explicitly allowed `@vellumai/*` packages.
 */
function isForbiddenSpecifier(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("node:")) return false;
  if (ALLOWED_PACKAGES.has(spec)) return false;
  return true;
}

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("imports only node builtins, relative modules, and @vellumai/environments", () => {
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
          "relative modules, and @vellumai/environments. Any other dependency\n" +
          "would break bundler hosts that inline this source-only package.",
      );
    }
  });

  test("package.json declares it as private with only its environments and zod dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies ?? {}).toEqual({
      "@vellumai/environments": "file:../environments",
      zod: "4.3.6",
    });
  });
});
