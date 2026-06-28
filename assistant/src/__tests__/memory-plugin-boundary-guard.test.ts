import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for the plugin-sandbox boundary. The reference memory plugin
 * under `assistant/examples/plugins/memory-reference/` is the worked example
 * for the public plugin contract: it must wire into the daemon through
 * `@vellumai/plugin-api` ONLY, never by reaching into daemon internals
 * (`assistant/src/...`, `persistence/`, `memory/`, `getDb`,
 * `getConfiguredProvider`, etc.). The reverse direction is also enforced:
 * core daemon code must not import the example plugin's internals.
 *
 * If these invariants drift, the plugin would no longer prove that the
 * public contract is sufficient — and a real third-party plugin built to
 * the same contract would silently lose access to whatever internal the
 * example reached for.
 */

/** Resolve repo root (tests run from `assistant/`). */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

const PLUGIN_DIR = "assistant/examples/plugins/memory-reference";

/** The only bare (non-relative) module specifier the plugin may import. */
const ALLOWED_PACKAGE = "@vellumai/plugin-api";

/** Test-only bare imports permitted in `**\/__tests__\/**` files. */
const ALLOWED_TEST_PACKAGES = new Set(["bun:test"]);

// Genuine node stdlib only. Bun's `builtinModules` also reports `bun:*`
// runtime modules (`bun:sqlite`, `bun:test`, ...); those must NOT be blanket
// allowed — a plugin reaching for `bun:sqlite` directly would bypass the
// host's store. `bun:test` is permitted only in test files via
// ALLOWED_TEST_PACKAGES.
const NODE_STDLIB = builtinModules.filter((m) => !m.startsWith("bun"));
const NODE_BUILTINS = new Set([
  ...NODE_STDLIB,
  ...NODE_STDLIB.map((m) => `node:${m}`),
]);

/**
 * Match the module specifier of every static `import ... from "x"`,
 * `export ... from "x"`, bare `import "x"`, and dynamic `import("x")` /
 * `require("x")`. The `from` clause is anchored to the `import`/`export`
 * keyword so arbitrary string literals (tool descriptions, error messages)
 * are never mistaken for module specifiers, mirroring the skill guard's
 * keyword-anchored scan.
 */
const IMPORT_SPECIFIER = new RegExp(
  // `import ... from "x"` / `export ... from "x"`
  String.raw`\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']` +
    // bare `import "x"`
    String.raw`|\bimport\s+["']([^"']+)["']` +
    // dynamic `import("x")`
    String.raw`|\bimport\s*\(\s*["']([^"']+)["']` +
    // `require("x")`
    String.raw`|\brequire\s*\(\s*["']([^"']+)["']`,
  "g",
);

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Decide whether an import specifier breaches the sandbox boundary.
 * Allowed: `@vellumai/plugin-api`, node builtins, `bun:test` (tests only),
 * and relative paths that resolve to inside `pluginAbs`. Everything else —
 * daemon internals, third-party packages — is forbidden.
 */
function isForbiddenSpecifier(
  spec: string,
  fileAbs: string,
  pluginAbs: string,
  isTestFile: boolean,
): boolean {
  if (spec === ALLOWED_PACKAGE) return false;
  if (NODE_BUILTINS.has(spec)) return false;
  if (isTestFile && ALLOWED_TEST_PACKAGES.has(spec)) return false;
  if (isRelative(spec)) {
    const resolved = resolve(dirname(fileAbs), spec);
    return relative(pluginAbs, resolved).startsWith("..");
  }
  return true;
}

interface ForbiddenImport {
  file: string;
  specifier: string;
}

/** Collect every plugin import specifier that breaches the boundary. */
function findForbiddenPluginImports(): ForbiddenImport[] {
  const repoRoot = getRepoRoot();
  const pluginAbs = join(repoRoot, PLUGIN_DIR);
  const forbidden: ForbiddenImport[] = [];

  for (const relPath of new Glob(`${PLUGIN_DIR}/**/*.ts`).scanSync({
    cwd: repoRoot,
  })) {
    const filePath = join(repoRoot, relPath);
    const isTestFile =
      relPath.includes("/__tests__/") || relPath.endsWith(".test.ts");
    const content = readFileSync(filePath, "utf-8");

    for (const match of content.matchAll(IMPORT_SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      if (isForbiddenSpecifier(spec, filePath, pluginAbs, isTestFile)) {
        forbidden.push({ file: relPath, specifier: spec });
      }
    }
  }

  return forbidden;
}

/**
 * Scan core daemon source for relative imports that resolve into the
 * reference plugin directory. The example must stay an island.
 */
function findCoreImportsOfPlugin(): string[] {
  const repoRoot = getRepoRoot();
  const pluginAbs = join(repoRoot, PLUGIN_DIR);
  const violations = new Set<string>();

  for (const relPath of new Glob("assistant/src/**/*.ts").scanSync({
    cwd: repoRoot,
  })) {
    const filePath = join(repoRoot, relPath);
    const content = readFileSync(filePath, "utf-8");

    for (const match of content.matchAll(IMPORT_SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec || !isRelative(spec)) continue;
      const resolved = resolve(dirname(filePath), spec);
      const fromPlugin = relative(pluginAbs, resolved);
      if (!fromPlugin.startsWith("..")) {
        violations.add(relPath);
        break;
      }
    }
  }

  return Array.from(violations).sort();
}

describe("memory-plugin-sandbox boundary", () => {
  test("reference memory plugin imports ONLY @vellumai/plugin-api, stdlib, and intra-plugin paths", () => {
    const forbidden = findForbiddenPluginImports();

    const message = [
      "The reference memory plugin reached outside the public plugin contract.",
      `Allowed imports: "${ALLOWED_PACKAGE}", node stdlib, "bun:test" (tests),`,
      "and relative paths that stay inside the plugin directory.",
      "",
      "Forbidden imports:",
      ...forbidden.map((v) => `  - ${v.file} -> ${v.specifier}`),
      "",
      "To fix: obtain the capability through the PluginHost contract in",
      `"${ALLOWED_PACKAGE}" instead of reaching into daemon internals.`,
    ].join("\n");

    expect(forbidden, message).toEqual([]);
  });

  test("core daemon code does not import the reference plugin's internals", () => {
    const violations = findCoreImportsOfPlugin();

    const message = [
      "Core daemon code imports the reference memory plugin's internals.",
      `The plugin under ${PLUGIN_DIR} is an example and must stay isolated.`,
      "",
      "Violations:",
      ...violations.map((f) => `  - ${f}`),
    ].join("\n");

    expect(violations, message).toEqual([]);
  });

  test("guard classifier accepts allowed and rejects forbidden specifiers (self-check)", () => {
    // Exercise the real predicate against synthetic specifiers so a future
    // refactor that weakens the rules fails loudly here.
    const pluginAbs = join(getRepoRoot(), PLUGIN_DIR);
    const sampleFile = join(pluginAbs, "tools", "remember.ts");
    const forbidden = (spec: string) =>
      isForbiddenSpecifier(spec, sampleFile, pluginAbs, false);

    expect(forbidden(ALLOWED_PACKAGE)).toBe(false);
    expect(forbidden("node:crypto")).toBe(false);
    expect(forbidden("../src/state.js")).toBe(false);
    expect(forbidden("../../../src/memory/getDb.js")).toBe(true);
    expect(
      forbidden("../../../../src/providers/provider-send-message.js"),
    ).toBe(true);
    expect(forbidden("drizzle-orm")).toBe(true);
    // `bun:test` is only allowed in test files.
    expect(isForbiddenSpecifier("bun:test", sampleFile, pluginAbs, false)).toBe(
      true,
    );
    expect(isForbiddenSpecifier("bun:test", sampleFile, pluginAbs, true)).toBe(
      false,
    );
  });
});
