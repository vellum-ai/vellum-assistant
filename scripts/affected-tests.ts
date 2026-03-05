#!/usr/bin/env bun
/**
 * Dependency-graph-based affected test discovery.
 *
 * Builds a reverse transitive import dependency map and outputs test files
 * affected by a set of changed source files.
 *
 * Usage:
 *   bun scripts/affected-tests.ts --pkg <path> [changed files...]
 *   echo "src/foo.ts" | bun scripts/affected-tests.ts --pkg assistant
 */

import path from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    pkg: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
});

if (!values.pkg) {
  process.stderr.write("Error: --pkg <path> is required\n");
  process.exit(1);
}

const pkgRoot = path.resolve(values.pkg);

// Collect changed file paths — from positional args or stdin.
let changedFiles: string[];
if (positionals.length > 0) {
  changedFiles = positionals;
} else {
  const stdin = await Bun.stdin.text();
  changedFiles = stdin
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

if (changedFiles.length === 0) {
  // Nothing changed — nothing affected.
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Phase 1 — Scan source files and extract imports
// ---------------------------------------------------------------------------

const importRegex =
  /(?:from|mock\.module\()\s*["']([^"']+)["']/g;
const sideEffectImportRegex = /\bimport\s+["']([^"']+)["']/g;

const glob = new Bun.Glob("src/**/*.{ts,tsx}");

// adjacency: file -> set of files it imports
const adjacency = new Map<string, Set<string>>();

/**
 * Resolve a relative import specifier to an absolute file path on disk.
 * Handles .js -> .ts/.tsx remapping and directory index files.
 */
function resolveSpecifier(
  fromDir: string,
  specifier: string,
): string | null {
  // Strip .js extension for .ts/.tsx resolution
  let base = specifier;
  if (base.endsWith(".js")) {
    base = base.slice(0, -3);
  }

  const resolved = path.resolve(fromDir, base);

  // Try direct .ts / .tsx
  for (const ext of [".ts", ".tsx"]) {
    const candidate = resolved + ext;
    if (fileSet.has(candidate)) return candidate;
  }

  // Try directory index
  const indexCandidate = path.join(resolved, "index.ts");
  if (fileSet.has(indexCandidate)) return indexCandidate;

  return null;
}

// Collect all source file paths first so we can do fast set-membership checks
// instead of hitting the filesystem for every specifier resolution.
const allFiles: string[] = [];
for await (const relPath of glob.scan({ cwd: pkgRoot, absolute: false })) {
  allFiles.push(path.resolve(pkgRoot, relPath));
}

const fileSet = new Set(allFiles);

// Read all files in parallel and extract imports.
const entries = await Promise.all(
  allFiles.map(async (absPath) => {
    const text = await Bun.file(absPath).text();
    const imports = new Set<string>();
    const dir = path.dirname(absPath);

    let match: RegExpExecArray | null;
    // We need fresh regexes per file since we reuse the same regex objects
    const re = new RegExp(importRegex.source, importRegex.flags);
    const sideEffectRe = new RegExp(
      sideEffectImportRegex.source,
      sideEffectImportRegex.flags,
    );

    // Match standard imports (from "…") and mock.module("…")
    while ((match = re.exec(text)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        continue;
      }
      const resolved = resolveSpecifier(dir, specifier);
      if (resolved) {
        imports.add(resolved);
      }
    }

    // Match side-effect imports: import "./foo.js"
    while ((match = sideEffectRe.exec(text)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        continue;
      }
      const resolved = resolveSpecifier(dir, specifier);
      if (resolved) {
        imports.add(resolved);
      }
    }

    return [absPath, imports] as const;
  }),
);

for (const [absPath, imports] of entries) {
  adjacency.set(absPath, imports);
}

// ---------------------------------------------------------------------------
// Phase 2 — Compute reverse transitive dependency map for test files
// ---------------------------------------------------------------------------

const testFiles = allFiles.filter(
  (f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"),
);

// For each test file, BFS through adjacency to find all transitive deps.
// Then invert: source file -> set of test files that depend on it.
const reverseMap = new Map<string, Set<string>>();

for (const testFile of testFiles) {
  const visited = new Set<string>();
  const queue = [testFile];
  visited.add(testFile);

  while (queue.length > 0) {
    const current = queue.pop()!;
    const deps = adjacency.get(current);
    if (!deps) continue;
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  // Every file in `visited` (including the test itself) is a transitive dep.
  // Map each back to this test file.
  for (const dep of visited) {
    let tests = reverseMap.get(dep);
    if (!tests) {
      tests = new Set();
      reverseMap.set(dep, tests);
    }
    tests.add(testFile);
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Match changed files to affected tests
// ---------------------------------------------------------------------------

const affectedTests = new Set<string>();

for (const changedFile of changedFiles) {
  let absChanged = path.resolve(pkgRoot, changedFile);

  // Handle .js -> .ts mapping on the input side
  if (absChanged.endsWith(".js")) {
    const base = absChanged.slice(0, -3);
    if (fileSet.has(base + ".ts")) {
      absChanged = base + ".ts";
    } else if (fileSet.has(base + ".tsx")) {
      absChanged = base + ".tsx";
    }
  }

  const tests = reverseMap.get(absChanged);
  if (tests) {
    for (const t of tests) {
      affectedTests.add(t);
    }
  }
}

// ---------------------------------------------------------------------------
// Output — relative paths, sorted, one per line
// ---------------------------------------------------------------------------

const sorted = [...affectedTests]
  .map((abs) => path.relative(pkgRoot, abs))
  .sort();

if (sorted.length > 0) {
  process.stdout.write(sorted.join("\n") + "\n");
}
