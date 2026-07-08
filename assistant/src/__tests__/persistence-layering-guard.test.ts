import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for the persistence-layering boundary.
 *
 * Persistence is a layer BELOW the memory feature. The intended dependency
 * direction is one-way: memory → persistence. `persistence/` provides the DB
 * core, conversation/message storage, job-queue mechanics, delivery/media
 * stores, LLM request-log/usage stores, and embeddings/Qdrant infra. The
 * memory *feature* (graph, v2, v3, retrospective, pkb) lives in the
 * `default-memory` plugin (`plugins/defaults/memory/`) and depends on
 * persistence, never the reverse.
 *
 * Two invariants are enforced:
 *  (a) Nothing under `assistant/src/**` imports a persistence module via a
 *      `memory/` re-export shim — the shims were removed, so any relative
 *      import that resolves to a deleted `memory/<name>.ts` is a violation.
 *  (b) `persistence/` does not import from `memory/`, except for an explicit,
 *      documented allowlist of residual feature back-imports that predate the
 *      layering split and could not be cleanly decoupled in the move PRs.
 */

/** Resolve repo root (tests run from `assistant/`). */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

const ASSISTANT_SRC = "assistant/src";
const PERSISTENCE_DIR = join(ASSISTANT_SRC, "persistence");
const MEMORY_DIR = join(ASSISTANT_SRC, "plugins", "defaults", "memory");

/**
 * TECH DEBT — residual `persistence/` → `memory/` feature back-imports.
 *
 * A genuine coupling to the memory *feature* that violates the one-way
 * memory → persistence direction is pinned here so the guard fails the moment
 * a NEW back-import is introduced. Do not add an entry without a decoupling
 * plan.
 *
 * Current entries, both on the conversation write paths:
 * - `fork-conversation-memory` — the memory plugin's fork-time state carry,
 *   invoked synchronously inside the fork transaction (see the module
 *   docstring for why it is a direct call rather than a first-class `hooks`
 *   dispatch like the other lifecycle events).
 * - `indexer` — the plain `addMessage` path invokes `indexMessageNow` to feed
 *   the persisted message into memory segment indexing, matching the other
 *   (non-persistence) write seams that already call it directly.
 *
 * Keyed by the importing persistence file (relative to repo root); the value
 * is the set of allowed `memory/<specifier>` module paths it may import.
 */
const PERSISTENCE_TO_MEMORY_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  "assistant/src/persistence/conversation-crud.ts": new Set([
    "fork-conversation-memory",
    "indexer",
  ]),
};

/**
 * PERMANENT exception — the migration registry, NOT tech debt.
 *
 * `steps.ts` is the ordered list of every migration step; it imports each
 * migration's forward/down function from the domain that owns it (memory's
 * `graph/bootstrap`, apps' `app-store`, …). Migrations are append-only and
 * checkpointed by stable function name, so they live in their owning feature by
 * design and are merely *referenced* here by the registry — this is the
 * registry's job, not a layering violation to ratchet to zero. Validated by the
 * no-stale-entries test like the allowlist, so a removed migration drops its
 * entry here.
 */
const MIGRATION_REGISTRY_MEMORY_IMPORTS: Record<string, ReadonlySet<string>> = {
  "assistant/src/persistence/steps.ts": new Set(["graph/bootstrap"]),
};

/** Match `from "x"`, `import "x"`, `import("x")`, and `mock.module("x", …)`. */
const IMPORT_PATTERN =
  /\b(?:from|import|mock\.module|require)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

/** All relative import specifiers in a source file, resolved to repo-root-relative paths. */
function* relativeImports(
  filePath: string,
  repoRoot: string,
): Generator<{ specifier: string; resolvedFromRoot: string }> {
  const content = readFileSync(filePath, "utf-8");
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1]!;
    const resolved = resolve(dirname(filePath), specifier);
    yield { specifier, resolvedFromRoot: relative(repoRoot, resolved) };
  }
}

/** Strip a trailing `.js` extension from a resolved import path. */
function stripJs(p: string): string {
  return p.endsWith(".js") ? p.slice(0, -3) : p;
}

describe("persistence-layering boundary", () => {
  test("nothing under assistant/src imports a persistence module via a memory/ shim", () => {
    const repoRoot = getRepoRoot();
    // Persistence-module basenames (top-level + embeddings) whose old memory/
    // shims were deleted. An import that resolves to memory/<basename>.ts now
    // targets a non-existent file — a leftover shim reference.
    const persistenceModules = new Set<string>();
    for (const subdir of ["persistence", "persistence/embeddings"]) {
      for (const rel of new Glob(`${subdir}/*.ts`).scanSync({
        cwd: join(repoRoot, ASSISTANT_SRC),
      })) {
        if (rel.endsWith(".test.ts")) {
          continue;
        }
        persistenceModules.add(rel.split("/").pop()!.replace(/\.ts$/, ""));
      }
    }
    // `schema` resolves through persistence/schema/index, also formerly shimmed.
    persistenceModules.add("schema");

    const memoryPrefix = `${MEMORY_DIR}/`;
    const violations: string[] = [];
    for (const rel of new Glob(`${ASSISTANT_SRC}/**/*.ts`).scanSync({
      cwd: repoRoot,
    })) {
      const filePath = join(repoRoot, rel);
      for (const { specifier, resolvedFromRoot } of relativeImports(
        filePath,
        repoRoot,
      )) {
        const target = stripJs(resolvedFromRoot);
        if (!target.startsWith(memoryPrefix)) {
          continue;
        }
        const rest = target.slice(memoryPrefix.length);
        // Only flag top-level memory/<basename> that shadows a persistence module.
        if (!rest.includes("/") && persistenceModules.has(rest)) {
          violations.push(`${rel}: ${specifier}`);
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found imports of a persistence module via a memory/ shim path.",
        "The persistence shims were removed — import persistence/ modules directly.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  test("persistence/ does not import from memory/ outside the documented allowlist", () => {
    const repoRoot = getRepoRoot();
    const memoryFromRoot = relative(repoRoot, join(repoRoot, MEMORY_DIR));
    const violations: string[] = [];

    for (const rel of new Glob(`${PERSISTENCE_DIR}/**/*.ts`).scanSync({
      cwd: repoRoot,
    })) {
      const filePath = join(repoRoot, rel);
      const allowed = new Set<string>([
        ...(PERSISTENCE_TO_MEMORY_ALLOWLIST[rel] ?? []),
        ...(MIGRATION_REGISTRY_MEMORY_IMPORTS[rel] ?? []),
      ]);
      for (const { resolvedFromRoot } of relativeImports(filePath, repoRoot)) {
        const target = stripJs(resolvedFromRoot);
        if (
          target !== memoryFromRoot &&
          !target.startsWith(`${memoryFromRoot}/`)
        ) {
          continue;
        }
        const specifier = target.slice(`${memoryFromRoot}/`.length);
        if (!allowed.has(specifier)) {
          violations.push(`${rel} -> memory/${specifier}`);
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found a persistence/ -> memory/ import outside the allowlist.",
        "Persistence is a layer below memory: the dependency must be one-way",
        "(memory -> persistence). If this is genuinely unavoidable feature",
        "coupling, add it to PERSISTENCE_TO_MEMORY_ALLOWLIST with a decoupling",
        "plan; otherwise move the depended-on infra into persistence/.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  test("the allowlist is honored exactly (no stale entries)", () => {
    // Each allowlisted import must still exist, so the list ratchets down as
    // back-imports are removed rather than silently rotting.
    const repoRoot = getRepoRoot();
    const memoryFromRoot = relative(repoRoot, join(repoRoot, MEMORY_DIR));
    const stale: string[] = [];

    for (const [file, allowed] of [
      ...Object.entries(PERSISTENCE_TO_MEMORY_ALLOWLIST),
      ...Object.entries(MIGRATION_REGISTRY_MEMORY_IMPORTS),
    ]) {
      const filePath = join(repoRoot, file);
      const actual = new Set<string>();
      for (const { resolvedFromRoot } of relativeImports(filePath, repoRoot)) {
        const target = stripJs(resolvedFromRoot);
        if (target.startsWith(`${memoryFromRoot}/`)) {
          actual.add(target.slice(`${memoryFromRoot}/`.length));
        }
      }
      for (const spec of allowed) {
        if (!actual.has(spec)) {
          stale.push(`${file} -> memory/${spec}`);
        }
      }
    }

    if (stale.length > 0) {
      const message = [
        "Stale PERSISTENCE_TO_MEMORY_ALLOWLIST entries (import removed but",
        "still allowlisted). Delete these entries to keep the ratchet tight:",
        "",
        ...stale.map((v) => `  - ${v}`),
      ].join("\n");
      expect(stale, message).toEqual([]);
    }
  });
});
