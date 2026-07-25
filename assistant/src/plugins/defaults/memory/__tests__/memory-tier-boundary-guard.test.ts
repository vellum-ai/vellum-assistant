import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";
import ts from "typescript";

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
 * Detection parses each production file into a TypeScript AST
 * (`ts.createSourceFile`, no type-checker) and walks it for reads off a
 * `memory` object: property access including optional chaining
 * (`config.memory?.v3.live`), element access with a string literal
 * (`config.memory["v3"]`), and destructuring in any position — variable
 * declarations (`const { v2 } = config.memory ?? {}`), assignments
 * (`({ v3 } = config.memory)`), function and catch parameters, and nested
 * patterns (`const { memory: { v3 } } = config`). The parser classifies
 * comments and string, template, and regex literals for us, so job names
 * like "memory.v2.sweep" and doc comments never false-positive and no
 * literal can desync the scan.
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

/** An object destructuring pattern, in binding or assignment-target form. */
type ObjectPattern = ts.ObjectBindingPattern | ts.ObjectLiteralExpression;

/** One property destructured by an {@link ObjectPattern}. */
interface PatternEntry {
  /** Property read off the source object; `undefined` when computed. */
  readonly key: string | undefined;
  /** Sub-pattern this property destructures into, if it has one. */
  readonly nested: ObjectPattern | undefined;
}

/** Parses one file; `.tsx` parses as TSX, everything else as TS. */
function parseSourceFile(fileName: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Expression with parentheses, `!`, and type assertions peeled off. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Text of a string-ish literal, or `undefined` for anything computed. */
function literalText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node)
    ? node.text
    : undefined;
}

/** Static name of a property or binding name, or `undefined` if computed. */
function staticNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/**
 * Whether an expression resolves to a `memory` object: a bare `memory`
 * identifier, any `.memory` / `["memory"]` access, or either arm of a
 * `??`/`||` fallback or a conditional (`config.memory ?? {}`).
 */
function resolvesToMemory(node: ts.Expression): boolean {
  const expr = unwrapExpression(node);
  if (ts.isIdentifier(expr)) {
    return expr.text === "memory";
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "memory";
  }
  if (ts.isElementAccessExpression(expr)) {
    return literalText(expr.argumentExpression) === "memory";
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return resolvesToMemory(expr.left) || resolvesToMemory(expr.right);
  }
  if (ts.isConditionalExpression(expr)) {
    return resolvesToMemory(expr.whenTrue) || resolvesToMemory(expr.whenFalse);
  }
  return false;
}

/** Assignment-pattern target with its parentheses and `= default` removed. */
function unwrapAssignmentTarget(node: ts.Expression): ts.Expression {
  const expr = unwrapExpression(node);
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return unwrapAssignmentTarget(expr.left);
  }
  return expr;
}

/** Properties a pattern destructures, in either binding or assignment form. */
function patternEntries(pattern: ObjectPattern): PatternEntry[] {
  const entries: PatternEntry[] = [];
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined) {
        // A rest element carries no single key.
        continue;
      }
      entries.push({
        key: staticNameText(element.propertyName ?? element.name),
        nested: ts.isObjectBindingPattern(element.name)
          ? element.name
          : undefined,
      });
    }
    return entries;
  }
  for (const property of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      entries.push({ key: property.name.text, nested: undefined });
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      // Spreads and methods carry no single key.
      continue;
    }
    const target = unwrapAssignmentTarget(property.initializer);
    entries.push({
      key: staticNameText(property.name),
      nested: ts.isObjectLiteralExpression(target) ? target : undefined,
    });
  }
  return entries;
}

/** Adds every tier key bound directly by `pattern`. */
function addTopLevelTierKeys(pattern: ObjectPattern, keys: Set<TierKey>): void {
  for (const entry of patternEntries(pattern)) {
    if (entry.key === "v2" || entry.key === "v3") {
      keys.add(entry.key);
    }
  }
}

/**
 * Adds tier keys taken through a nested `memory:` sub-pattern at any depth,
 * as in `const { memory: { v3 } } = config`.
 */
function addNestedMemoryPatternKeys(
  pattern: ObjectPattern,
  keys: Set<TierKey>,
): void {
  for (const entry of patternEntries(pattern)) {
    if (entry.nested === undefined) {
      continue;
    }
    if (entry.key === "memory") {
      addTopLevelTierKeys(entry.nested, keys);
    }
    addNestedMemoryPatternKeys(entry.nested, keys);
  }
}

/**
 * Tier namespaces a source file reads off a `memory` object, found by walking
 * its TypeScript AST: property access (`config.memory?.v3.live`), element
 * access with a string literal (`config.memory["v3"]`), and destructuring in
 * every position — declarations, assignments, parameters, and nested
 * patterns. Comments and string, template, and regex literals are classified
 * by the parser, so no literal reads as code or desyncs the walk. Dynamic
 * computed keys (`memory[key]`) stay out of reach without a type-checker.
 */
function tierKeysRead(sourceText: string, fileName: string): Set<TierKey> {
  const keys = new Set<TierKey>();

  const readPattern = (
    pattern: ObjectPattern,
    source: ts.Expression | undefined,
  ): void => {
    if (source !== undefined && resolvesToMemory(source)) {
      addTopLevelTierKeys(pattern, keys);
    }
    addNestedMemoryPatternKeys(pattern, keys);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      resolvesToMemory(node.expression)
    ) {
      const key = node.name.text;
      if (key === "v2" || key === "v3") {
        keys.add(key);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      resolvesToMemory(node.expression)
    ) {
      const key = literalText(node.argumentExpression);
      if (key === "v2" || key === "v3") {
        keys.add(key);
      }
    } else if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      // A binding element's initializer is its default value — reading a
      // tier key from it is still a raw read.
      readPattern(node.name, node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = unwrapExpression(node.left);
      if (ts.isObjectLiteralExpression(target)) {
        readPattern(target, node.right);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parseSourceFile(fileName, sourceText), visit);
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
    const absolute = join(process.cwd(), posix);
    const keys = tierKeysRead(readFileSync(absolute, "utf-8"), absolute);
    if (keys.size > 0) {
      readers.set(posix, keys);
    }
  }
  return readers;
}

describe("memory tier boundary guard", () => {
  const tierImports = collectTierImports();
  // Scanned once and shared: the forward and reverse tier-key tests read the
  // same snapshot of the tree.
  const tierKeyReaders = collectTierKeyReaders();

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
    for (const [file, keys] of tierKeyReaders) {
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
    const readers = tierKeyReaders;
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
    [...tierKeysRead(source, "guard-fixture.ts")].sort();

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

  test("destructuring is detected through wrappers and in every position", () => {
    expect(keysOf(`const { v2 } = config.memory ?? {};`)).toEqual(["v2"]);
    expect(keysOf(`const { v3 } = (config.memory as MemoryConfig)!;`)).toEqual([
      "v3",
    ]);
    expect(keysOf(`({ v3 } = config.memory);`)).toEqual(["v3"]);
    expect(keysOf(`({ memory: { v3 } } = config);`)).toEqual(["v3"]);
    expect(keysOf(`function read({ v2 } = config.memory) {}`)).toEqual(["v2"]);
    expect(keysOf(`try { run(); } catch ({ memory: { v3 } }) {}`)).toEqual([
      "v3",
    ]);
  });

  test("string literals and comments are ignored", () => {
    expect(keysOf(`enqueue("memory.v2.sweep");`)).toEqual([]);
    expect(keysOf(`const job = { name: "memory.v2.sweep" };`)).toEqual([]);
    expect(keysOf(`"memory.v2.sweep";`)).toEqual([]);
    expect(keysOf(`// falls back to memory.v2.k\nconst k = 1;`)).toEqual([]);
    expect(keysOf(`// memory.v3.live gates injection\nconst x = 1;`)).toEqual(
      [],
    );
    expect(
      keysOf(`/** memory.v3.live gates injection */\nconst x = 1;`),
    ).toEqual([]);
    expect(keysOf("const label = `memory.v3.edge tuning`;")).toEqual([]);
  });

  test("a regex literal containing a quote cannot hide a read", () => {
    expect(
      keysOf(`const on = /"/.test(v) && config.memory.v2.enabled;`),
    ).toEqual(["v2"]);
    expect(keysOf(`const q = /"/.test(v);`)).toEqual([]);
  });

  test("bare tier-key literals do not match on their own", () => {
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
    expect(keysOf(`const seed = { memory: { v3: { live: true } } };`)).toEqual(
      [],
    );
  });
});
