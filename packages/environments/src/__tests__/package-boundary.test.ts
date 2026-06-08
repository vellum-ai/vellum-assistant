/**
 * Package boundary tests for @vellumai/environments.
 *
 * This package is the lowest layer of the shared-packages hierarchy: pure
 * environment types and constants with no runtime dependencies. It must
 * stay a leaf so any consumer (CLI, assistant, local-mode host) can depend
 * on it without dragging in a dependency tree.
 *
 * Enforces that the package:
 * 1. Imports only node builtins and its own relative modules — no `@vellumai/*`
 *    packages and no third-party runtime imports.
 * 2. Declares no runtime `dependencies` (devDependencies only).
 * 3. Is marked `private`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

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

/** A bare specifier is anything that is not a relative or node-builtin import. */
function isForbiddenSpecifier(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("node:")) return false;
  return true;
}

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("imports only node builtins and relative modules", () => {
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
        `Found ${violations.length} forbidden import(s) in @vellumai/environments:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\n@vellumai/environments is a pure types/constants leaf and must\n" +
          "import only node builtins and its own relative modules.",
      );
    }
  });

  test("package.json declares it as private with no runtime dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
