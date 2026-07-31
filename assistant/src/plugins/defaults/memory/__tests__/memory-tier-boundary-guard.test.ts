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
 *   - A file outside the plugin reaching into a tier directory is a host
 *     importer and must be on the frozen {@link HOST_TIER_IMPORT_ALLOWLIST}.
 *     Host importers are the set the tier deletion runbooks enumerate: a
 *     deletion that skips them leaves broken imports and an unbuildable tree.
 *
 * Guard 2 — tier-key config reads (`memory.substrate.*` / `memory.v2.*` /
 * `memory.v3.*`) across all of `assistant/src/`. Tier selection flows through
 * the predicates in `src/config/memory-v3-gate.ts` (from which
 * `src/config/memory-tier.ts` derives) and substrate tunables resolve via
 * `substrate/tuning.ts`, so raw tier-key reads outside the frozen
 * {@link TIER_KEY_READ_ALLOWLIST} are a layering leak. Each finding carries
 * WHICH key it read, and every exemption is a (path, keys) pair — so the
 * `v2/` engine stays exempt for `memory.v2` only and `v3/` for `memory.v3`
 * only, matching the documented boundary that an engine reads its own tuning
 * namespace and no other.
 *
 * Both guards read one TypeScript AST per file (`ts.createSourceFile`, no
 * type-checker): {@link scanProductionSources} parses every production file
 * under `src/` once and hands each guard the projection it needs, so no file
 * is parsed twice.
 *
 * Guard 1 collects module specifiers from the AST — `import`/`export ... from`
 * (including `import type`), `import x = require("…")`, dynamic `import("…")`,
 * `require("…")`, and type-position `import("…").Foo` — so import-shaped text
 * in a comment or string literal can neither invent an edge nor hide a real
 * one.
 *
 * Guard 2 walks the AST for reads off a `memory` object: property access
 * including optional chaining (`config.memory?.v3.live`), element access with
 * a string literal (`config.memory["v3"]`), and destructuring in any position
 * — variable declarations (`const { v2 } = config.memory ?? {}`), assignments
 * (`({ v3 } = config.memory)`), function and catch parameters, and nested
 * patterns (`const { memory: { v3 } } = config`). Identifiers aliased to a
 * memory object (`const memoryConfig = getConfig().memory`) count as memory
 * objects too — see {@link collectMemoryAliases}. The parser classifies
 * comments and string, template, and regex literals for us, so job names
 * like "memory.v2.sweep" and doc comments never false-positive and no
 * literal can desync the scan.
 *
 * All three allowlists carry a reverse "stale exemption" test — per (path,
 * tier) pair for host imports and per (path, key) pair for tier keys — so an
 * entry whose import or tier-key read disappears fails loudly and gets removed
 * instead of lingering.
 *
 * Tests run from `assistant/`, so paths resolve against `process.cwd()`.
 * Both `.ts` and `.tsx` production files are scanned (the assistant tsconfig
 * ships both); test files (`*.test.ts`, `*.test.tsx`, `__tests__/`) are out
 * of scope — the boundary guarded is the shipped runtime.
 */

/**
 * `assistant/src/plugins/defaults/memory`, relative to the `assistant/` cwd
 * and posix-separated (every path this guard compares is posix).
 */
const MEM_REL = "src/plugins/defaults/memory";
const MEM_ABS = join(process.cwd(), ...MEM_REL.split("/"));

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

interface HostTierImportExemption {
  /**
   * Path relative to the `assistant/` cwd, posix-separated; a trailing `/`
   * marks a directory prefix.
   */
  readonly path: string;
  /** Tier directories this path may import from — and only these. */
  readonly tiers: readonly Tier[];
}

/**
 * Files outside the memory plugin allowed to import a tier directory
 * directly, paired with the exact tiers each may reach. Frozen — do not add:
 * host code should depend on the plugin spine, and this list is the deletion
 * runbooks' inventory of what a tier removal has to rewrite. Shrinking it is
 * how retiring an engine finishes.
 *
 * The `substrate/` entries are the shared concept-page surface the daemon and
 * routes read (page/edge indexes, Qdrant collections, static context, boot
 * maintenance, tuning); the `v1/` entries are the legacy PKB engine's
 * remaining host reach (the migration step, semantic search, and PKB file
 * indexing); the `v2/` and `v3/` entries are engine-specific inspector,
 * activation/selection log, and CLI-harness surfaces.
 */
const HOST_TIER_IMPORT_ALLOWLIST: readonly HostTierImportExemption[] = [
  {
    path: "src/cli/commands/memory/memory-v2-compare-render.ts",
    tiers: ["v2"],
  },
  { path: "src/cli/commands/memory/memory-v2.ts", tiers: ["v2"] },
  {
    path: "src/daemon/conversation-agent-loop-handlers.ts",
    tiers: ["v2", "v3"],
  },
  { path: "src/daemon/conversation-runtime-assembly.ts", tiers: ["v3"] },
  { path: "src/daemon/conversation.ts", tiers: ["v3"] },
  { path: "src/daemon/embedding-reconcile.ts", tiers: ["substrate", "v3"] },
  { path: "src/daemon/skill-memory-refresh.ts", tiers: ["substrate"] },
  { path: "src/daemon/tool-side-effects.ts", tiers: ["substrate"] },
  { path: "src/daemon/trust-context.ts", tiers: ["substrate"] },
  { path: "src/persistence/steps.ts", tiers: ["v1"] },
  { path: "src/runtime/routes/consolidation-routes.ts", tiers: ["substrate"] },
  {
    path: "src/runtime/routes/conversation-query-routes.ts",
    tiers: ["v2", "v3"],
  },
  { path: "src/runtime/routes/global-search-routes.ts", tiers: ["v1"] },
  { path: "src/runtime/routes/secret-routes.ts", tiers: ["substrate"] },
  { path: "src/tools/filesystem/write.ts", tiers: ["v1"] },
  { path: "src/tools/skills/find-similar-skills.ts", tiers: ["v3"] },
];

/** The tier config namespaces this guard tracks. */
const TIER_KEYS = ["substrate", "v2", "v3"] as const;
type TierKey = (typeof TIER_KEYS)[number];

function isTierKey(key: string | undefined): key is TierKey {
  return (TIER_KEYS as readonly (string | undefined)[]).includes(key);
}

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
 * - the six named migrations — append-only history that rewrites or reads the
 *   historical tier keys it was written for. Listed per file, not per
 *   directory: a future migration reading a tier key is a new decision and
 *   gets challenged like any other.
 * - `substrate/tuning.ts` (substrate, v2) — the substrate tunable resolver;
 *   the `memory.substrate`→`memory.v2` fallback lives here by design.
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
  {
    path: "src/persistence/migrations/335-collapse-memory-embed-backlog.ts",
    keys: ["v2"],
  },
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
  {
    path: "src/plugins/defaults/memory/substrate/tuning.ts",
    keys: ["substrate", "v2"],
  },
  { path: "src/plugins/defaults/memory/v2/", keys: ["v2"] },
  { path: "src/plugins/defaults/memory/v3/", keys: ["v3"] },
  { path: "src/telemetry/config-setting-snapshot.ts", keys: ["v2", "v3"] },
  {
    path: "src/workspace/migrations/085-memory-v2-bm25-b-reembed-disabled-v2-pages.ts",
    keys: ["v2"],
  },
  {
    path: "src/workspace/migrations/105-enable-memory-v3-live-for-new-workspaces.ts",
    keys: ["v3"],
  },
  {
    path: "src/workspace/migrations/117-normalize-stale-lean-memory-v3-defaults.ts",
    keys: ["v3"],
  },
  {
    path: "src/workspace/migrations/119-strip-persisted-memory-v3-tuning-defaults.ts",
    keys: ["v3"],
  },
  {
    path: "src/workspace/migrations/135-copy-substrate-tunables.ts",
    keys: ["substrate", "v2"],
  },
];

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
  /** Importing file, relative to the `assistant/` cwd, posix-separated. */
  file: string;
  /**
   * Importing file relative to the plugin root, or `undefined` when the
   * importer lives outside the plugin.
   */
  pluginFile: string | undefined;
  /** `"host"` when the importer lives outside the plugin. */
  sourceTier: Tier | "spine" | "host";
  targetTier: Tier;
  specifier: string;
}

/**
 * Every import that lands in a tier directory, from anywhere under `src/`.
 * Importers inside the plugin carry their own tier (or `"spine"`); importers
 * outside it are `"host"`, which is what makes a host file reaching into
 * `v1/`, `v2/`, `v3/`, `v3-eval/`, or `substrate/` visible to the guard.
 */
function collectTierImports(sources: readonly ScannedSource[]): TierImport[] {
  const imports: TierImport[] = [];
  const memPrefix = `${MEM_REL}/`;
  for (const source of sources) {
    const inPlugin = source.path.startsWith(memPrefix);
    const pluginFile = inPlugin
      ? source.path.slice(memPrefix.length)
      : undefined;
    const absPath = join(process.cwd(), ...source.path.split("/"));
    for (const specifier of source.specifiers) {
      if (!specifier.startsWith(".")) {
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
        file: source.path,
        pluginFile,
        sourceTier: pluginFile === undefined ? "host" : tierOf(pluginFile),
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
    if (imp.sourceTier !== "spine" || imp.pluginFile === undefined) {
      continue;
    }
    let tiers = usage.get(imp.pluginFile);
    if (!tiers) {
      usage.set(imp.pluginFile, (tiers = new Set()));
    }
    tiers.add(imp.targetTier);
  }
  return usage;
}

/** Distinct tier directories each host file (outside the plugin) imports. */
function hostTierUsage(imports: TierImport[]): Map<string, Set<Tier>> {
  const usage = new Map<string, Set<Tier>>();
  for (const imp of imports) {
    if (imp.sourceTier !== "host") {
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

/**
 * Module specifiers a file depends on, taken from the AST: `import ... from`
 * and re-exporting `export ... from` declarations, `import x = require("…")`,
 * dynamic `import("…")`, `require("…")`, and type-position
 * `import("…").Foo`. Type-only imports count — the guard freezes layering,
 * not emitted code, and a `v3/` file importing a `v1/` type is still a tier
 * edge. Only string-literal specifiers are collected; a computed
 * `import(path)` has no static target to attribute.
 */
function importSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    const text = literalText(node);
    if (text !== undefined) {
      specifiers.push(text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // An `export { x }` with no module specifier is not an edge.
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall =
        ts.isIdentifier(callee) && callee.text === "require";
      if (isImportCall || isRequireCall) {
        add(node.arguments[0]);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return specifiers;
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
 * identifier or a known `aliases` identifier, any `.memory` / `["memory"]`
 * access, or either arm of a `??`/`||` fallback or a conditional
 * (`config.memory ?? {}`).
 */
function resolvesToMemory(
  node: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  const expr = unwrapExpression(node);
  if (ts.isIdentifier(expr)) {
    return expr.text === "memory" || aliases.has(expr.text);
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
    return (
      resolvesToMemory(expr.left, aliases) ||
      resolvesToMemory(expr.right, aliases)
    );
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      resolvesToMemory(expr.whenTrue, aliases) ||
      resolvesToMemory(expr.whenFalse, aliases)
    );
  }
  return false;
}

/** A binding that may name a `memory` object. */
interface AliasCandidate {
  /** Identifier the binding introduces. */
  readonly name: string;
  /** Initializer (or default value) the binding takes, if any. */
  readonly initializer: ts.Expression | undefined;
  /** Whether the binding destructures a `memory` property off its source. */
  readonly fromMemoryProperty: boolean;
}

/** Every identifier binding in a file that could name a `memory` object. */
function aliasCandidates(sourceFile: ts.SourceFile): AliasCandidate[] {
  const candidates: AliasCandidate[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      candidates.push({
        name: node.name.text,
        initializer: node.initializer,
        fromMemoryProperty:
          ts.isBindingElement(node) &&
          staticNameText(node.propertyName ?? node.name) === "memory",
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return candidates;
}

/**
 * Identifiers a file binds to a `memory` config object, so later reads through
 * the alias are seen: `const memoryConfig = getConfig().memory` (the shape
 * `workspace/migrations/105-enable-memory-v3-live-for-new-workspaces.ts`
 * uses), `const m = config.memory ?? {}`, `const { memory: m } = config`, and
 * a parameter defaulted to any of those. Aliases of aliases resolve too — the
 * pass iterates to a fixed point, so `const a = config.memory; const b = a;`
 * makes both `a` and `b` memory objects.
 *
 * The set is file-level and scope-free on purpose: an inner scope that
 * shadows an alias name with something unrelated is deliberately still
 * treated as the alias. That over-detects rather than under-detects, which is
 * the safe direction for a freeze guard — the cost of a shadowed name is one
 * exemption discussion, while missing an aliased read is a silent layering
 * leak. Reassignment (`let m; m = config.memory;`) is out of scope; use a
 * declaration.
 */
function collectMemoryAliases(sourceFile: ts.SourceFile): Set<string> {
  const candidates = aliasCandidates(sourceFile);
  const aliases = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.fromMemoryProperty) {
      aliases.add(candidate.name);
    }
  }
  // Alias chains resolve in any declaration order, so iterate until the set
  // stops growing (bounded by the number of candidates).
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of candidates) {
      if (aliases.has(candidate.name) || candidate.initializer === undefined) {
        continue;
      }
      if (resolvesToMemory(candidate.initializer, aliases)) {
        aliases.add(candidate.name);
        grew = true;
      }
    }
  }
  return aliases;
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
    if (isTierKey(entry.key)) {
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
 * patterns. Identifiers aliased to a memory object count as memory objects
 * (see {@link collectMemoryAliases}), so `alias.v3.live`, `alias["v2"]`, and
 * `const { v3 } = alias` are all reads. Comments and string, template, and
 * regex literals are classified by the parser, so no literal reads as code or
 * desyncs the walk. Dynamic computed keys (`memory[key]`) stay out of reach
 * without a type-checker.
 */
function tierKeysOf(sourceFile: ts.SourceFile): Set<TierKey> {
  const keys = new Set<TierKey>();
  const aliases = collectMemoryAliases(sourceFile);

  const readPattern = (
    pattern: ObjectPattern,
    source: ts.Expression | undefined,
  ): void => {
    if (source !== undefined && resolvesToMemory(source, aliases)) {
      addTopLevelTierKeys(pattern, keys);
    }
    addNestedMemoryPatternKeys(pattern, keys);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      resolvesToMemory(node.expression, aliases)
    ) {
      const key = node.name.text;
      if (isTierKey(key)) {
        keys.add(key);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      resolvesToMemory(node.expression, aliases)
    ) {
      const key = literalText(node.argumentExpression);
      if (isTierKey(key)) {
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

  ts.forEachChild(sourceFile, visit);
  return keys;
}

/**
 * Whether `file` is covered by an allowlist entry's path: an exact match, or
 * any file under it when the entry ends in `/` and so names a directory.
 */
function matchesExemptPath(file: string, exemptPath: string): boolean {
  return exemptPath.endsWith("/")
    ? file.startsWith(exemptPath)
    : file === exemptPath;
}

function isTierKeyExempt(file: string, key: TierKey): boolean {
  return TIER_KEY_READ_ALLOWLIST.some(
    (entry) => matchesExemptPath(file, entry.path) && entry.keys.includes(key),
  );
}

function isHostTierImportExempt(file: string, tier: Tier): boolean {
  return HOST_TIER_IMPORT_ALLOWLIST.some(
    (entry) =>
      matchesExemptPath(file, entry.path) && entry.tiers.includes(tier),
  );
}

/** One production source file, parsed once and projected for both guards. */
interface ScannedSource {
  /** Path relative to the `assistant/` cwd, posix-separated. */
  readonly path: string;
  /** Module specifiers this file imports, re-exports, or requires. */
  readonly specifiers: readonly string[];
  /** Tier namespaces this file reads off a `memory` object. */
  readonly tierKeys: Set<TierKey>;
}

/**
 * Every production file under `src/`, parsed once. Both guards read this one
 * pass, and guard 1 needs specifiers from every file — a host importer of a
 * tier directory is an edge no matter where it lives — so specifiers and tier
 * keys come off the same AST.
 */
function scanProductionSources(): ScannedSource[] {
  const srcRoot = join(process.cwd(), "src");
  const sources: ScannedSource[] = [];
  for (const file of productionFiles(srcRoot)) {
    const absolute = join(srcRoot, ...file.split("/"));
    const sourceFile = parseSourceFile(
      absolute,
      readFileSync(absolute, "utf-8"),
    );
    sources.push({
      path: `src/${file}`,
      specifiers: importSpecifiers(sourceFile),
      tierKeys: tierKeysOf(sourceFile),
    });
  }
  return sources;
}

describe("memory tier boundary guard", () => {
  // Parsed once and shared: every guard test reads the same snapshot of the
  // tree, and no file is parsed twice.
  const sources = scanProductionSources();
  const tierImports = collectTierImports(sources);
  const tierKeyReaders = sources.filter((source) => source.tierKeys.size > 0);

  test("tier directories only import their allowed tiers", () => {
    const violations: string[] = [];
    for (const imp of tierImports) {
      if (
        imp.sourceTier === "spine" ||
        imp.sourceTier === "host" ||
        imp.sourceTier === imp.targetTier
      ) {
        continue;
      }
      if (FORBIDDEN_TIER_IMPORTS[imp.sourceTier].has(imp.targetTier)) {
        violations.push(
          `  - ${imp.file} (${imp.sourceTier}/) imports "${imp.specifier}" (${imp.targetTier}/)`,
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

  test("files outside the plugin only import frozen host tiers", () => {
    const found = new Set<string>();
    for (const [file, tiers] of hostTierUsage(tierImports)) {
      for (const tier of tiers) {
        if (!isHostTierImportExempt(file, tier)) {
          found.add(`  - ${file} imports ${MEM_REL}/${tier}/`);
        }
      }
    }
    const violations = [...found].sort();
    const message = [
      "Host files reaching into a memory tier directory without a",
      "HOST_TIER_IMPORT_ALLOWLIST entry:",
      ...violations,
      "",
      "The allowlist is frozen — do not add. Host code depends on the plugin",
      "spine (or a substrate export re-exported by it), never on an engine",
      "directly; every entry here is work a tier deletion has to undo.",
    ].join("\n");
    expect(violations, message).toEqual([]);
  });

  test("every host tier-import exemption still has a matching import", () => {
    const usage = hostTierUsage(tierImports);
    const stale: string[] = [];
    for (const entry of HOST_TIER_IMPORT_ALLOWLIST) {
      for (const tier of entry.tiers) {
        const matched = [...usage].some(
          ([file, tiers]) =>
            matchesExemptPath(file, entry.path) && tiers.has(tier),
        );
        if (!matched) {
          stale.push(`  - ${entry.path} (${MEM_REL}/${tier}/)`);
        }
      }
    }
    stale.sort();
    const message = [
      "Stale HOST_TIER_IMPORT_ALLOWLIST (path, tier) pairs (no import",
      "matches — remove them so the freeze stays tight):",
      ...stale,
    ].join("\n");
    expect(stale, message).toEqual([]);
  });

  test("tier-key config reads are frozen to the gate module and exemptions", () => {
    const violations: string[] = [];
    for (const { path, tierKeys } of tierKeyReaders) {
      for (const key of [...tierKeys].sort()) {
        if (!isTierKeyExempt(path, key)) {
          violations.push(`  - ${path} reads memory.${key}.*`);
        }
      }
    }
    violations.sort();
    const message = [
      "New memory.substrate.* / memory.v2.* / memory.v3.* config reads",
      "outside the frozen TIER_KEY_READ_ALLOWLIST (an engine directory is",
      "exempt for its own tier key only):",
      ...violations,
      "",
      "Tier decisions go through src/config/memory-v3-gate.ts (or",
      "src/config/memory-tier.ts); substrate tunables resolve via",
      "substrate/tuning.ts. Do not extend the allowlist.",
    ].join("\n");
    expect(violations, message).toEqual([]);
  });

  test("every tier-key exemption still has a matching tier-key read", () => {
    const stale: string[] = [];
    for (const entry of TIER_KEY_READ_ALLOWLIST) {
      for (const key of entry.keys) {
        const matched = tierKeyReaders.some(
          (source) =>
            matchesExemptPath(source.path, entry.path) &&
            source.tierKeys.has(key),
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
    [...tierKeysOf(parseSourceFile("guard-fixture.ts", source))].sort();

  test("property chains are detected, with and without optional chaining", () => {
    expect(keysOf(`const on = config.memory.v2.enabled;`)).toEqual(["v2"]);
    expect(keysOf(`return config.memory?.v3?.live === true;`)).toEqual(["v3"]);
    expect(keysOf(`seed.memory.v3 = { live: seed.memory.v3.live };`)).toEqual([
      "v3",
    ]);
  });

  test("the substrate namespace is tracked alongside the engine tiers", () => {
    expect(keysOf(`const k1 = config.memory.substrate.bm25_k1;`)).toEqual([
      "substrate",
    ]);
    expect(keysOf(`const b = config.memory?.["substrate"]?.bm25_b;`)).toEqual([
      "substrate",
    ]);
    expect(keysOf(`const { substrate } = config.memory ?? {};`)).toEqual([
      "substrate",
    ]);
    expect(keysOf(`const { substrate, v2 } = getConfig().memory;`)).toEqual([
      "substrate",
      "v2",
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
    expect(keysOf(`const t = pages["v2"];`)).toEqual([]);
    expect(keysOf(`const dir = plugin.substrate;`)).toEqual([]);
    expect(keysOf(`const seed = { memory: { v3: { live: true } } };`)).toEqual(
      [],
    );
  });

  test("reads through an aliased memory object are detected", () => {
    expect(
      keysOf(`const memoryConfig = getConfig().memory;\nmemoryConfig.v3.live;`),
    ).toEqual(["v3"]);
    expect(
      keysOf(`const m = config.memory ?? {};\nconst k = m["v2"].k;`),
    ).toEqual(["v2"]);
    expect(keysOf(`const m = config.memory;\nconst { v3 } = m;`)).toEqual([
      "v3",
    ]);
    expect(keysOf(`const { memory: m } = config;\nm.v2.enabled;`)).toEqual([
      "v2",
    ]);
    expect(
      keysOf(`function read(m = config.memory) { return m.v3.live; }`),
    ).toEqual(["v3"]);
    // The migration-105 shape: cast, then re-alias the cast.
    expect(
      keysOf(
        `const memory = config.memory;\nconst memoryConfig = memory as Record<string, unknown>;\nif (memoryConfig.v3 === undefined) memoryConfig.v3 = {};`,
      ),
    ).toEqual(["v3"]);
  });

  test("alias chains resolve in any declaration order", () => {
    expect(keysOf(`const a = config.memory;\nconst b = a;\nb.v2.k;`)).toEqual([
      "v2",
    ]);
    expect(
      keysOf(
        `function f() { return b.v3.live; }\nconst b = a;\nconst a = m.memory;`,
      ),
    ).toEqual(["v3"]);
  });

  test("aliases of unrelated objects do not match", () => {
    expect(keysOf(`const cfg = getConfig();\nconst k = cfg.v2;`)).toEqual([]);
    expect(keysOf(`const store = memories.byId;\nstore.v3.live;`)).toEqual([]);
  });
});

describe("import specifier detection", () => {
  const specifiersOf = (source: string): string[] =>
    importSpecifiers(parseSourceFile("guard-fixture.ts", source)).sort();

  test("every import form is collected", () => {
    expect(specifiersOf(`import { a } from "./v1/a.js";`)).toEqual([
      "./v1/a.js",
    ]);
    expect(specifiersOf(`import "./v1/side-effect.js";`)).toEqual([
      "./v1/side-effect.js",
    ]);
    expect(specifiersOf(`import type { A } from "./v1/types.js";`)).toEqual([
      "./v1/types.js",
    ]);
    expect(specifiersOf(`export { a } from "./v2/a.js";`)).toEqual([
      "./v2/a.js",
    ]);
    expect(specifiersOf(`export * from "./v2/all.js";`)).toEqual([
      "./v2/all.js",
    ]);
    expect(specifiersOf(`const m = await import("./v3/lazy.js");`)).toEqual([
      "./v3/lazy.js",
    ]);
    expect(specifiersOf(`const m = require("./v3/legacy.js");`)).toEqual([
      "./v3/legacy.js",
    ]);
    expect(specifiersOf(`import a = require("./v1/legacy.js");`)).toEqual([
      "./v1/legacy.js",
    ]);
    expect(specifiersOf(`type A = import("./v1/types.js").A;`)).toEqual([
      "./v1/types.js",
    ]);
    expect(
      specifiersOf(
        `import {\n  a,\n} from\n  "./v1/multiline.js";\nexport { b };`,
      ),
    ).toEqual(["./v1/multiline.js"]);
  });

  test("import-shaped text in comments and strings is not an edge", () => {
    expect(
      specifiersOf(`// import { x } from "./v1/x.js";\nconst a = 1;`),
    ).toEqual([]);
    expect(
      specifiersOf(
        `/** Replaces \`import { x } from "./v1/x.js"\`. */\nconst a = 1;`,
      ),
    ).toEqual([]);
    expect(
      specifiersOf(`throw new Error('add import { x } from "./v2/x.js"');`),
    ).toEqual([]);
    expect(specifiersOf('const hint = `import("./v3/x.js")`;')).toEqual([]);
  });
});
