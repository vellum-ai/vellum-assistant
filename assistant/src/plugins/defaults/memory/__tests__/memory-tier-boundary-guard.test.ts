import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for the memory plugin's tier boundaries. See
 * `assistant/docs/architecture/memory.md` for the full tier map.
 *
 * The memory plugin is layered into tier directories: `substrate/` is the
 * shared concept-page substrate used by both v2 and v3, `v1/` is the legacy
 * PKB/graph engine, `v2/` is the activation-spreading engine, and `v3/` (plus
 * its `v3-eval/` sibling) is the lane/orchestrator engine. Everything else
 * under the plugin root — including `graph/` (the all-tier legacy store and
 * dispatcher) — is spine code that composes tiers.
 *
 * Guard 1 — tier import edges (production files only):
 *   - `substrate/` imports no tier directory (it is the bottom layer).
 *   - `v1/` imports no other tier directory (shared `graph/` modules and
 *     plugin-root infra are fine — they are spine, not tiers).
 *   - `v2/` may import `substrate/` but not `v1/`, `v3/`, or `v3-eval/`.
 *   - `v3/` and `v3-eval/` may import `substrate/` (and each other) but not
 *     `v1/` or `v2/`.
 *   - A spine file importing from two or more tier directories is a
 *     composition point and must be on the frozen {@link SPINE_ALLOWLIST}.
 *
 * Guard 2 — tier-key config reads (`memory.v2.*` / `memory.v3.*`) across all
 * of `assistant/src/`. Tier selection flows through the predicates in
 * `src/config/memory-v3-gate.ts` (from which `src/config/memory-tier.ts`
 * derives) and substrate tunables resolve via `substrate/tuning.ts`, so raw
 * tier-key reads outside the frozen {@link TIER_KEY_READ_ALLOWLIST} are a
 * layering leak. Each finding carries WHICH key it read, and every exemption
 * is a (path, keys) pair — so the `v2/` engine stays exempt for `memory.v2`
 * only and `v3/` for `memory.v3` only, matching the documented boundary that
 * an engine reads its own tuning namespace and no other.
 *
 * Detection strips comments and string/template literals first (so job names
 * like "memory.v2.sweep" and schema error strings do not false-positive),
 * then matches three read forms: dot chains (`config.memory?.v3?.live`),
 * computed literal access (`config.memory["v3"]`), and destructuring off a
 * `memory` object (`const { v2 } = config.memory`, `const { memory: { v3 } }
 * = config`). Bare `"v2"` / `"v3"` string literals survive stripping so
 * computed access stays visible; every other literal is blanked.
 *
 * Both allowlists carry a reverse "stale exemption" test — per (path, keys)
 * pair for tier keys — so an entry whose multi-tier import or tier-key read
 * disappears fails loudly and gets removed instead of lingering.
 *
 * Tests run from `assistant/`, so paths resolve against `process.cwd()`.
 * Both `.ts` and `.tsx` production files are scanned (the assistant tsconfig
 * ships both); test files (`*.test.ts`, `*.test.tsx`, `__tests__/`) are out
 * of scope — the boundary guarded is the shipped runtime.
 */

/** `assistant/src/plugins/defaults/memory`, relative to the `assistant/` cwd. */
const MEM_REL = join("src", "plugins", "defaults", "memory");
const MEM_ABS = join(process.cwd(), MEM_REL);

const TIER_DIRS = ["substrate", "v1", "v2", "v3", "v3-eval"] as const;
type Tier = (typeof TIER_DIRS)[number];

/** Tier directories each tier must not import from. */
const FORBIDDEN_TIER_IMPORTS: Record<Tier, ReadonlySet<Tier>> = {
  substrate: new Set(["v1", "v2", "v3", "v3-eval"]),
  v1: new Set(["substrate", "v2", "v3", "v3-eval"]),
  v2: new Set(["v1", "v3", "v3-eval"]),
  v3: new Set(["v1", "v2"]),
  "v3-eval": new Set(["v1", "v2"]),
};

/**
 * Spine files allowed to import from two or more tier directories — the
 * composition points where the plugin wires tiers together. Paths are
 * relative to the plugin root, posix-separated. Frozen — do not add: new
 * multi-tier composition belongs in an existing spine file, and shrinking
 * this list is how the tier deletion runbooks retire an engine.
 */
const SPINE_ALLOWLIST: ReadonlySet<string> = new Set([
  "fork-conversation-memory.ts",
  "graph-topology/build-memory-graph.ts",
  "graph/conversation-graph-memory.ts",
  "injectors.ts",
  "job-handlers.ts",
  "jobs-worker.ts",
  "src/memory-v2-routes.ts",
  "startup.ts",
]);

/** The two tier config namespaces this guard tracks. */
type TierKey = "v2" | "v3";

interface TierKeyExemption {
  /**
   * Path relative to the `assistant/` cwd, posix-separated; a trailing `/`
   * marks a directory prefix.
   */
  readonly path: string;
  /** Tier namespaces this path may read — and only these. */
  readonly keys: readonly TierKey[];
}

/**
 * Files allowed to read `memory.v2.*` / `memory.v3.*` config keys directly,
 * paired with the exact namespaces each may read. Frozen — do not add and do
 * not widen an entry's keys: route new tier decisions through
 * `src/config/memory-v3-gate.ts` (or `memory-tier.ts`) and new substrate
 * tunables through `substrate/tuning.ts`; see the tier deletion runbooks
 * before touching this list.
 *
 * - `config/memory-v3-gate.ts` (both) — the gate module; the one sanctioned
 *   home for raw tier-predicate reads, and it compares v2 against v3.
 * - `config/loader.ts` (v3) — seeds/normalizes the persisted `memory.v3`
 *   shape.
 * - `telemetry/config-setting-snapshot.ts` (both) — reports both tier keys
 *   as-is.
 * - `persistence/migrations/` (v2), `workspace/migrations/` (both) —
 *   append-only history that rewrites or reads historical tier keys.
 * - `substrate/tuning.ts` (v2) — the substrate tunable resolver; the
 *   substrate→`memory.v2` fallback lives here by design.
 * - `v2/` (v2), `v3/` (v3) — each engine reads its own tuning namespace and
 *   never the other engine's.
 * - `graph/conversation-graph-memory.ts` (v2) — reads `memory.v2.router` for
 *   the all-tier dispatcher's historical-pairs routing.
 * - `graph-topology/build-memory-graph.ts` (v3) — reads `memory.v3.edge`
 *   tuning when building the graph view.
 * - `src/memory-v2-routes.ts` (v2) — the v2 tuning routes read and merge
 *   `memory.v2` config directly.
 */
const TIER_KEY_READ_ALLOWLIST: readonly TierKeyExemption[] = [
  { path: "src/config/loader.ts", keys: ["v3"] },
  { path: "src/config/memory-v3-gate.ts", keys: ["v2", "v3"] },
  { path: "src/persistence/migrations/", keys: ["v2"] },
  {
    path: "src/plugins/defaults/memory/graph-topology/build-memory-graph.ts",
    keys: ["v3"],
  },
  {
    path: "src/plugins/defaults/memory/graph/conversation-graph-memory.ts",
    keys: ["v2"],
  },
  {
    path: "src/plugins/defaults/memory/src/memory-v2-routes.ts",
    keys: ["v2"],
  },
  { path: "src/plugins/defaults/memory/substrate/tuning.ts", keys: ["v2"] },
  { path: "src/plugins/defaults/memory/v2/", keys: ["v2"] },
  { path: "src/plugins/defaults/memory/v3/", keys: ["v3"] },
  { path: "src/telemetry/config-setting-snapshot.ts", keys: ["v2", "v3"] },
  { path: "src/workspace/migrations/", keys: ["v2", "v3"] },
];

/** Matches `import ... from "X"`, `export ... from "X"`, `import("X")`,
 *  `require("X")`, and side-effect `import "X"` — including multi-line forms,
 *  since the between-keyword-and-`from` span never contains a quote. */
function importSpecifierRegex(): RegExp {
  return /(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
}

/** Tier directory a plugin-root-relative path lives in, or `"spine"`. */
function tierOf(relToMem: string): Tier | "spine" {
  const first = relToMem.split("/")[0]!;
  return (TIER_DIRS as readonly string[]).includes(first)
    ? (first as Tier)
    : "spine";
}

/**
 * Production `.ts`/`.tsx` files under `root`, posix-relative, tests excluded.
 * TSX ships too (the assistant tsconfig includes TSX under `src/`), so it is
 * scanned alongside TS.
 */
function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const rel of new Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
    const posix = rel.split("\\").join("/");
    if (
      posix.endsWith(".test.ts") ||
      posix.endsWith(".test.tsx") ||
      posix.split("/").includes("__tests__")
    ) {
      continue;
    }
    files.push(posix);
  }
  return files.sort();
}

interface TierImport {
  /** Importing file, relative to the plugin root. */
  file: string;
  sourceTier: Tier | "spine";
  targetTier: Tier;
  specifier: string;
}

/** Every intra-plugin import that lands in a tier directory. */
function collectTierImports(): TierImport[] {
  const imports: TierImport[] = [];
  for (const file of productionFiles(MEM_ABS)) {
    const absPath = join(MEM_ABS, file);
    const source = readFileSync(absPath, "utf-8");
    const regex = importSpecifierRegex();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier || !specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolve(dirname(absPath), specifier);
      const relToMem = relative(MEM_ABS, resolved).split("\\").join("/");
      if (relToMem.startsWith("..")) {
        continue;
      }
      const targetTier = tierOf(relToMem);
      if (targetTier === "spine") {
        continue;
      }
      imports.push({
        file,
        sourceTier: tierOf(file),
        targetTier,
        specifier,
      });
    }
  }
  return imports;
}

/** Distinct tier directories each spine file imports from. */
function spineTierUsage(imports: TierImport[]): Map<string, Set<Tier>> {
  const usage = new Map<string, Set<Tier>>();
  for (const imp of imports) {
    if (imp.sourceTier !== "spine") {
      continue;
    }
    let tiers = usage.get(imp.file);
    if (!tiers) {
      usage.set(imp.file, (tiers = new Set()));
    }
    tiers.add(imp.targetTier);
  }
  return usage;
}

/**
 * Source with comments and string/template literals blanked out, so tier-key
 * matching only sees executable property chains. Bare `"v2"` / `"v3"`
 * literals survive verbatim — they are the key half of computed access
 * (`config.memory["v3"]`) — while every other literal, including compound
 * names like "memory.v2.sweep", is dropped. Line structure is preserved.
 * Template interpolations (`${...}`) are kept — they are code — via a mode
 * stack that tracks nested templates and interpolation braces. Regex
 * literals are not lexed; single/double-quoted string skipping stops at
 * end-of-line so a quote inside a regex desyncs at most one line.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  // Interpolation brace depths for enclosing template literals, innermost
  // last; empty means top-level code.
  const templateDepths: number[] = [];
  let braceDepth = 0;

  const keepNewlinesOf = (text: string): void => {
    out += text.replace(/[^\n]/g, "");
  };

  // Scans template-literal content from `start` (just past the opening
  // backtick, or past an interpolation's closing brace), appending newlines.
  // Stops after the closing backtick, or pushes interpolation state and
  // stops after a `${`. Returns the index to resume lexing at.
  const scanTemplateContent = (start: number): number => {
    let j = start;
    while (j < n) {
      if (source[j] === "\\") {
        j += 2;
        continue;
      }
      if (source[j] === "`") {
        return j + 1;
      }
      if (source[j] === "$" && source[j + 1] === "{") {
        templateDepths.push(braceDepth);
        braceDepth = 0;
        return j + 2;
      }
      if (source[j] === "\n") {
        out += "\n";
      }
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      keepNewlinesOf(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = ++i;
      while (i < n && source[i] !== c && source[i] !== "\n") {
        i += source[i] === "\\" ? 2 : 1;
      }
      const content = source.slice(start, i);
      if (source[i] === c) {
        i++;
      }
      // Tier-key literals stay so computed access survives stripping.
      if (content === "v2" || content === "v3") {
        out += `${c}${content}${c}`;
      }
      continue;
    }
    if (c === "`") {
      i = scanTemplateContent(i + 1);
      continue;
    }
    if (templateDepths.length > 0) {
      if (c === "{") {
        braceDepth++;
      } else if (c === "}") {
        if (braceDepth === 0) {
          // Interpolation closed — resume the enclosing template literal.
          braceDepth = templateDepths.pop()!;
          i = scanTemplateContent(i + 1);
          continue;
        }
        braceDepth--;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** `memory.v2` / `memory.v3` property chain, incl. `config.memory?.v3?.live`. */
const TIER_KEY_DOT_READ = /\bmemory\s*\??\.\s*(v[23])\b/g;

/** Computed literal access — `config.memory["v3"]`, `memory?.['v2']`. */
const TIER_KEY_COMPUTED_READ =
  /\bmemory\s*(?:\?\.)?\s*\[\s*(['"])(v[23])\1\s*\]/g;

/** A `const`/`let`/`var` destructuring declaration: pattern and its source. */
const DESTRUCTURING_DECLARATION =
  /\b(?:const|let|var)\s+(\{[\s\S]*?\})\s*=\s*([^;\n]+)/g;

/** A right-hand side that is (a chain ending in) a `memory` object. */
const DESTRUCTURED_FROM_MEMORY = /(?:^|\.)\s*memory\s*$/;

/** A `memory: { ... }` sub-pattern inside a destructuring pattern. */
const NESTED_MEMORY_PATTERN = /\bmemory\s*:\s*(\{[^{}]*\})/g;

/** A tier key bound at the top level of an object pattern: `{ v2, v3: t }`. */
const PATTERN_TIER_KEY = /[{,]\s*(v[23])\s*(?=[,:}=])/g;

/**
 * Pattern text at the outermost brace depth, with nested groups blanked, so
 * only the keys destructured directly off the object are read.
 */
function topLevelPatternContent(pattern: string): string {
  let depth = 0;
  let out = "";
  for (const char of pattern) {
    if (char === "{" || char === "[") {
      depth++;
      out += depth === 1 ? char : " ";
      continue;
    }
    if (char === "}" || char === "]") {
      out += depth === 1 ? char : " ";
      depth--;
      continue;
    }
    out += depth === 1 ? char : " ";
  }
  return out;
}

/**
 * Tier namespaces the stripped source reads: dot chains, computed literal
 * access, and destructuring off a `memory` object. Dynamic computed keys
 * (`memory[key]`) are out of reach of a lexer this size.
 */
function tierKeysRead(stripped: string): Set<TierKey> {
  const keys = new Set<TierKey>();
  for (const match of stripped.matchAll(TIER_KEY_DOT_READ)) {
    keys.add(match[1] as TierKey);
  }
  for (const match of stripped.matchAll(TIER_KEY_COMPUTED_READ)) {
    keys.add(match[2] as TierKey);
  }
  for (const declaration of stripped.matchAll(DESTRUCTURING_DECLARATION)) {
    const pattern = declaration[1]!;
    const patterns: string[] = [];
    if (DESTRUCTURED_FROM_MEMORY.test(declaration[2]!.trim())) {
      patterns.push(topLevelPatternContent(pattern));
    }
    for (const nested of pattern.matchAll(NESTED_MEMORY_PATTERN)) {
      patterns.push(nested[1]!);
    }
    for (const candidate of patterns) {
      for (const key of candidate.matchAll(PATTERN_TIER_KEY)) {
        keys.add(key[1] as TierKey);
      }
    }
  }
  return keys;
}

function isTierKeyExempt(file: string, key: TierKey): boolean {
  return TIER_KEY_READ_ALLOWLIST.some(
    (entry) =>
      (entry.path.endsWith("/")
        ? file.startsWith(entry.path)
        : file === entry.path) && entry.keys.includes(key),
  );
}

/** Production files under `src/` mapped to the tier keys each one reads. */
function collectTierKeyReaders(): Map<string, Set<TierKey>> {
  const readers = new Map<string, Set<TierKey>>();
  for (const file of productionFiles(join(process.cwd(), "src"))) {
    const posix = `src/${file}`;
    const stripped = stripCommentsAndStrings(
      readFileSync(join(process.cwd(), posix), "utf-8"),
    );
    const keys = tierKeysRead(stripped);
    if (keys.size > 0) {
      readers.set(posix, keys);
    }
  }
  return readers;
}

describe("memory tier boundary guard", () => {
  const tierImports = collectTierImports();

  test("tier directories only import their allowed tiers", () => {
    const violations: string[] = [];
    for (const imp of tierImports) {
      if (imp.sourceTier === "spine" || imp.sourceTier === imp.targetTier) {
        continue;
      }
      if (FORBIDDEN_TIER_IMPORTS[imp.sourceTier].has(imp.targetTier)) {
        violations.push(
          `  - ${MEM_REL}/${imp.file} (${imp.sourceTier}/) imports "${imp.specifier}" (${imp.targetTier}/)`,
        );
      }
    }
    violations.sort();
    const message = [
      "Forbidden tier import edges in the memory plugin:",
      ...violations,
      "",
      "substrate/ imports no tier; v1/ imports no other tier; v2/ may import",
      "substrate/ only; v3/ and v3-eval/ may import substrate/ (and each",
      "other) only. Shared code belongs in substrate/ or the plugin spine.",
    ].join("\n");
    expect(violations, message).toEqual([]);
  });

  test("multi-tier composition only happens at frozen spine files", () => {
    const violations: string[] = [];
    for (const [file, tiers] of spineTierUsage(tierImports)) {
      if (tiers.size >= 2 && !SPINE_ALLOWLIST.has(file)) {
        violations.push(
          `  - ${MEM_REL}/${file} imports from {${[...tiers].sort().join(", ")}}`,
        );
      }
    }
    violations.sort();
    const message = [
      "Spine files newly composing multiple tiers (not on SPINE_ALLOWLIST):",
      ...violations,
      "",
      "The allowlist is frozen — do not add. Route new multi-tier wiring",
      "through an existing composition point, or push the shared logic into",
      "substrate/.",
    ].join("\n");
    expect(violations, message).toEqual([]);
  });

  test("every spine allowlist entry still composes multiple tiers", () => {
    const usage = spineTierUsage(tierImports);
    const stale: string[] = [];
    for (const file of [...SPINE_ALLOWLIST].sort()) {
      if ((usage.get(file)?.size ?? 0) < 2) {
        stale.push(`  - ${file}`);
      }
    }
    const message = [
      "Stale SPINE_ALLOWLIST entries (no longer import 2+ tiers — remove",
      "them so the freeze stays tight):",
      ...stale,
    ].join("\n");
    expect(stale, message).toEqual([]);
  });

  test("tier-key config reads are frozen to the gate module and exemptions", () => {
    const violations: string[] = [];
    for (const [file, keys] of collectTierKeyReaders()) {
      for (const key of [...keys].sort()) {
        if (!isTierKeyExempt(file, key)) {
          violations.push(`  - ${file} reads memory.${key}.*`);
        }
      }
    }
    violations.sort();
    const message = [
      "New memory.v2.* / memory.v3.* config reads outside the frozen",
      "TIER_KEY_READ_ALLOWLIST (an engine directory is exempt for its own",
      "tier key only):",
      ...violations,
      "",
      "Tier decisions go through src/config/memory-v3-gate.ts (or",
      "src/config/memory-tier.ts); substrate tunables resolve via",
      "substrate/tuning.ts. Do not extend the allowlist.",
    ].join("\n");
    expect(violations, message).toEqual([]);
  });

  test("every tier-key exemption still has a matching tier-key read", () => {
    const readers = collectTierKeyReaders();
    const stale: string[] = [];
    for (const entry of TIER_KEY_READ_ALLOWLIST) {
      for (const key of entry.keys) {
        const matched = [...readers].some(
          ([file, keys]) =>
            (entry.path.endsWith("/")
              ? file.startsWith(entry.path)
              : file === entry.path) && keys.has(key),
        );
        if (!matched) {
          stale.push(`  - ${entry.path} (memory.${key}.*)`);
        }
      }
    }
    stale.sort();
    const message = [
      "Stale TIER_KEY_READ_ALLOWLIST (path, key) pairs (no tier-key read",
      "matches — remove them so the freeze stays tight):",
      ...stale,
    ].join("\n");
    expect(stale, message).toEqual([]);
  });
});

describe("tier-key read detection", () => {
  const keysOf = (source: string): TierKey[] =>
    [...tierKeysRead(stripCommentsAndStrings(source))].sort();

  test("property chains are detected, with and without optional chaining", () => {
    expect(keysOf(`const on = config.memory.v2.enabled;`)).toEqual(["v2"]);
    expect(keysOf(`return config.memory?.v3?.live === true;`)).toEqual(["v3"]);
    expect(keysOf(`seed.memory.v3 = { live: seed.memory.v3.live };`)).toEqual([
      "v3",
    ]);
  });

  test("computed literal access is detected", () => {
    expect(keysOf(`const live = config.memory["v3"].live;`)).toEqual(["v3"]);
    expect(keysOf(`const k = config.memory['v2'].k;`)).toEqual(["v2"]);
    expect(keysOf(`const live = config.memory?.["v3"]?.live;`)).toEqual(["v3"]);
    expect(keysOf(`const both = [memory["v2"], memory["v3"]];`)).toEqual([
      "v2",
      "v3",
    ]);
  });

  test("destructuring off a memory object is detected", () => {
    expect(keysOf(`const { v2 } = config.memory;`)).toEqual(["v2"]);
    expect(keysOf(`const { v3: tuning } = getConfig().memory;`)).toEqual([
      "v3",
    ]);
    expect(keysOf(`const { v2, v3 } = config?.memory;`)).toEqual(["v2", "v3"]);
    expect(keysOf(`const { memory: { v3 } } = config;`)).toEqual(["v3"]);
  });

  test("string literals and comments are ignored", () => {
    expect(keysOf(`enqueue("memory.v2.sweep");`)).toEqual([]);
    expect(keysOf(`const job = { name: "memory.v2.sweep" };`)).toEqual([]);
    expect(keysOf(`// falls back to memory.v2.k\nconst k = 1;`)).toEqual([]);
    expect(
      keysOf(`/** memory.v3.live gates injection */\nconst x = 1;`),
    ).toEqual([]);
    expect(keysOf("const label = `memory.v3.edge tuning`;")).toEqual([]);
  });

  test("bare tier-key literals survive stripping without matching alone", () => {
    expect(keysOf(`const tier = "v3";`)).toEqual([]);
    expect(keysOf(`log("v2", "memory.v2.sweep");`)).toEqual([]);
    expect(keysOf(`const t = pages["v2"];`)).toEqual([]);
  });

  test("reads inside template interpolations are detected", () => {
    expect(keysOf("const msg = `k=${config.memory.v2.k}`;")).toEqual(["v2"]);
    expect(
      keysOf("const msg = `memory.v3.live=${config.memory?.v3?.live}`;"),
    ).toEqual(["v3"]);
    expect(keysOf('const msg = `live=${config.memory["v3"].live}`;')).toEqual([
      "v3",
    ]);
  });

  test("unrelated identifiers do not match", () => {
    expect(keysOf(`const memoryV2 = loadV2();`)).toEqual([]);
    expect(keysOf(`const x = inMemory.v2Cache;`)).toEqual([]);
    expect(keysOf(`const { v2 } = engines;`)).toEqual([]);
    expect(keysOf(`const { lanes: { v3 } } = registry;`)).toEqual([]);
  });
});
