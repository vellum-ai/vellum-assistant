import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for the plugin import boundary. Each immediate subdirectory of
 * `assistant/src/plugins/defaults/` is one self-contained plugin. A plugin's
 * production code may import only:
 *   1. from `@vellumai/plugin-api` (the public plugin API surface), or
 *   2. from within its own plugin directory.
 *
 * Anything else is an "escaping import": a relative import resolving outside
 * the plugin's own directory (reaching into assistant host code, a sibling
 * plugin, or `plugins/types.js`), or a bare specifier other than
 * `@vellumai/plugin-api` (node:*, bun:*, or a third-party package).
 *
 * Two guards run here:
 *   - A baseline RATCHET ({@link BASELINE}) that fails when a NEW escaping
 *     import appears for a plugin (and when a baseline entry goes stale), so
 *     coupling to host internals cannot silently grow.
 *   - An ANTI-BACKSLIDE check that forbids importing, from `providers/types.js`
 *     or `config/schemas/llm.js`, any symbol that `@vellumai/plugin-api`
 *     already re-exports — locking in the migration that moved those type
 *     imports onto the public API.
 *
 * Tests run from `assistant/`, so paths are resolved against `process.cwd()`.
 * Test files (`*.test.ts`, `__tests__/`) are out of scope — the boundary we
 * guard is the shipped plugin runtime, and plugin tests legitimately import
 * test infrastructure.
 */

/** `assistant/src/plugins/defaults`, relative to the `assistant/` cwd. */
const DEFAULTS_REL = join("src", "plugins", "defaults");
const DEFAULTS_ABS = join(process.cwd(), DEFAULTS_REL);

/**
 * Allowed escaping imports per plugin: plugin name → sorted list of distinct
 * specifiers it reaches for outside itself. These are host-internal couplings
 * with no `@vellumai/plugin-api` equivalent (memory/daemon/context/config
 * internals, runtime builtins, third-party packages). `providers/types.js`
 * appears only for `ToolDefinition` (a `@vellumai/skill-host-contracts` type
 * distinct from plugin-api's), which the anti-backslide guard enforces.
 *
 * Regenerate after an intentional change with:
 *   UPDATE_PLUGIN_IMPORT_BASELINE=1 bun test src/__tests__/plugin-import-boundary-guard.test.ts
 * and paste the printed object here, explaining the new coupling in your PR.
 */
const BASELINE: Record<string, readonly string[]> = {
  compaction: [
    "../../../config/loader.js",
    "../../../config/schemas/compaction.js",
    "../../../config/schemas/inference.js",
    "../../../config/types.js",
    "../../../context/compactor.js",
    "../../../context/token-estimator.js",
    "../../../context/tool-result-truncation.js",
    "../../../daemon/conversation-media-retry.js",
    "../../../daemon/conversation-registry.js",
    "../../../daemon/conversation-runtime-assembly.js",
    "../../../providers/types.js",
    "../../../runtime/actor-trust-resolver.js",
    "../../../util/logger.js",
    "../../types.js",
  ],
  "exploration-drift": ["../../../../subagent/index.js"],
  "image-fallback": [
    "../../../../providers/provider-send-message.js",
    "node:crypto",
    "node:fs",
    "node:path",
  ],
  "image-recovery": [
    "../../../agent/image-optimize.js",
    "../../../context/image-dimensions.js",
    "../../../memory/conversation-crud.js",
    "../../../util/logger.js",
  ],
  "max-tokens-continue": ["../../../../agent/loop.js"],
  "memory-retrieval": [
    "../../../../config/loader.js",
    "../../../../config/memory-v3-gate.js",
    "../../../../daemon/conversation-registry.js",
    "../../../../daemon/conversation-runtime-assembly.js",
    "../../../../daemon/message-types/memory.js",
    "../../../../daemon/trust-context.js",
    "../../../../memory/conversation-crud.js",
    "../../../../memory/graph/conversation-graph-memory.js",
    "../../../../memory/memory-recall-log-store.js",
    "../../../../runtime/assistant-event-hub.js",
    "../../../config/loader.js",
    "../../../context/strip-injections.js",
    "../../../daemon/conversation-registry.js",
    "../../../daemon/conversation-runtime-assembly.js",
    "../../../daemon/conversation-workspace.js",
    "../../../daemon/now-scratchpad.js",
    "../../../daemon/pkb-context-tracker.js",
    "../../../daemon/pkb-reminder-builder.js",
    "../../../daemon/trust-context.js",
    "../../../documents/document-comments-store.js",
    "../../../memory/graph/conversation-graph-memory.js",
    "../../../memory/pkb/autoinject.js",
    "../../../memory/pkb/context.js",
    "../../../memory/pkb/pkb-search.js",
    "../../../memory/pkb/types.js",
    "../../../memory/v2/static-context.js",
    "../../../runtime/capabilities.js",
    "../../../types.js",
    "../../../util/logger.js",
    "../../../util/platform.js",
    "../../memory-v3-shadow/ever-injected-store.js",
    "../../types.js",
    "../memory-v3-shadow/injector.js",
    "node:fs",
    "node:path",
  ],
  "memory-v3-shadow": [
    "../../../api/responses/memory-v3-selection-log.js",
    "../../../config/loader.js",
    "../../../config/memory-v3-gate.js",
    "../../../config/schema.js",
    "../../../config/skills.js",
    "../../../config/types.js",
    "../../../daemon/conversation-error.js",
    "../../../daemon/conversation-notices.js",
    "../../../daemon/conversation-registry.js",
    "../../../daemon/trust-context.js",
    "../../../memory/checkpoints.js",
    "../../../memory/conversation-crud.js",
    "../../../memory/db-connection.js",
    "../../../memory/embedding-backend.js",
    "../../../memory/embedding-billing-breaker.js",
    "../../../memory/embedding-cache.js",
    "../../../memory/embedding-types.js",
    "../../../memory/jobs-store.js",
    "../../../memory/memory-marker.js",
    "../../../memory/message-content.js",
    "../../../memory/prompt-override.js",
    "../../../memory/qdrant-client.js",
    "../../../memory/v2/cli-command-store.js",
    "../../../memory/v2/injected-block-slugs.js",
    "../../../memory/v2/page-index.js",
    "../../../memory/v2/page-store.js",
    "../../../memory/v2/skill-store.js",
    "../../../providers/cache-control.js",
    "../../../providers/provider-send-message.js",
    "../../../providers/types.js",
    "../../../skills/frontmatter.js",
    "../../../util/log-redact.js",
    "../../../util/logger.js",
    "../../../util/platform.js",
    "../../../util/strip-comment-lines.js",
    "../../../util/truncate.js",
    "../../types.js",
    "@qdrant/js-client-rest",
    "node:crypto",
    "node:fs",
    "node:path",
    "uuid",
    "zod",
  ],
  "task-progress-nudge": [
    "../../../../daemon/conversation-registry.js",
    "../../../../providers/weak-open-model.js",
    "../../../../subagent/index.js",
  ],
  "title-generate": [
    "../../../../config/loader.js",
    "../../../../memory/conversation-crud.js",
    "../../../../memory/conversation-title-service.js",
  ],
};

/**
 * Symbols that `@vellumai/plugin-api` re-exports from `providers/types.js`. A
 * plugin must import these from the public API, not the host module. NOT
 * listed (and therefore allowed from `providers/types.js`): `ToolDefinition`,
 * which `providers/types.js` re-exports from `@vellumai/skill-host-contracts`
 * — a different type than plugin-api's own `ToolDefinition`.
 */
const PLUGIN_API_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "ContentBlock",
  "FileContent",
  "ImageContent",
  "Message",
  "Provider",
  "ProviderEvent",
  "ProviderResponse",
  "RedactedThinkingContent",
  "SendMessageConfig",
  "SendMessageOptions",
  "ServerToolUseContent",
  "TextContent",
  "ThinkingContent",
  "ToolResultContent",
  "ToolUseContent",
  "WebSearchToolResultContent",
]);

/** Symbols `@vellumai/plugin-api` re-exports from `config/schemas/llm.js`. */
const PLUGIN_API_LLM_TYPES: ReadonlySet<string> = new Set(["LLMCallSite"]);

/** Matches `import ... from "X"`, `export ... from "X"`, `import("X")`,
 *  `require("X")`, and side-effect `import "X"` — including multi-line forms,
 *  since the between-keyword-and-`from` span never contains a quote. */
function importSpecifierRegex(): RegExp {
  return /(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
}

interface PluginFile {
  /** Plugin directory name (first path segment under `defaults/`). */
  plugin: string;
  /** Path relative to the `assistant/` cwd, for messages. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  source: string;
}

/** Production plugin files: one per plugin subdirectory, tests excluded. */
function collectPluginFiles(): PluginFile[] {
  const files: PluginFile[] = [];
  for (const ext of ["ts", "tsx"]) {
    for (const rel of new Glob(`${DEFAULTS_REL}/**/*.${ext}`).scanSync({
      cwd: process.cwd(),
    })) {
      const norm = rel.split("/").join(sep);
      if (norm.endsWith(".test.ts") || norm.endsWith(".test.tsx")) continue;
      if (norm.split(sep).includes("__tests__")) continue;
      const underDefaults = relative(DEFAULTS_REL, norm);
      const segments = underDefaults.split(sep);
      // A file directly under defaults/ (e.g. index.ts) is the registry, not a
      // plugin — it has no plugin directory segment.
      if (segments.length < 2) continue;
      const absPath = join(process.cwd(), norm);
      files.push({
        plugin: segments[0]!,
        relPath: norm,
        absPath,
        source: readFileSync(absPath, "utf-8"),
      });
    }
  }
  return files;
}

interface Escape {
  plugin: string;
  specifier: string;
  relPath: string;
}

/** Every escaping import across the production plugin files. */
function collectEscapes(files: PluginFile[]): Escape[] {
  const escapes: Escape[] = [];
  for (const file of files) {
    const pluginRoot = join(DEFAULTS_ABS, file.plugin);
    const regex = importSpecifierRegex();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(file.source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier || specifier === "@vellumai/plugin-api") continue;
      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file.absPath), specifier);
        // Stays inside the plugin's own directory → allowed.
        if (!relative(pluginRoot, resolved).startsWith("..")) continue;
      }
      escapes.push({ plugin: file.plugin, specifier, relPath: file.relPath });
    }
  }
  return escapes;
}

/** Distinct escaping specifiers per plugin, sorted — the ratchet's view. */
function escapesByPlugin(escapes: Escape[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const e of escapes) {
    let set = sets.get(e.plugin);
    if (!set) sets.set(e.plugin, (set = new Set()));
    set.add(e.specifier);
  }
  return new Map(
    [...sets].map(([plugin, set]) => [plugin, [...set].sort()] as const),
  );
}

/** Parse the named-import symbols out of a `{ ... }` import clause. */
function parseNamedSymbols(clause: string): string[] {
  return clause
    .split(",")
    .map(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]!,
    )
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Symbols a plugin file imports from a host module whose specifier ends with
 *  `hostPathSuffix` (e.g. `providers/types.js`), across multi-line clauses. */
function symbolsImportedFrom(source: string, hostPathSuffix: string): string[] {
  const escaped = hostPathSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]*` +
      escaped +
      String.raw`)['"]`,
    "g",
  );
  const symbols: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    symbols.push(...parseNamedSymbols(match[1]!));
  }
  return symbols;
}

describe("plugin import boundary", () => {
  const files = collectPluginFiles();
  const escapes = collectEscapes(files);
  const byPlugin = escapesByPlugin(escapes);

  test("no new escaping import beyond the committed baseline", () => {
    if (process.env.UPDATE_PLUGIN_IMPORT_BASELINE === "1") {
      const regenerated: Record<string, string[]> = {};
      for (const plugin of [...byPlugin.keys()].sort()) {
        regenerated[plugin] = byPlugin.get(plugin)!;
      }

      console.log(
        "Regenerated plugin import baseline — paste into BASELINE:\n" +
          JSON.stringify(regenerated, null, 2),
      );
    }

    const exampleFile = new Map<string, string>();
    for (const e of escapes) {
      exampleFile.set(`${e.plugin} ${e.specifier}`, e.relPath);
    }

    const plugins = new Set([...byPlugin.keys(), ...Object.keys(BASELINE)]);
    const added: string[] = [];
    const stale: string[] = [];
    for (const plugin of [...plugins].sort()) {
      const found = new Set(byPlugin.get(plugin) ?? []);
      const allowed = new Set(BASELINE[plugin] ?? []);
      for (const spec of [...found].sort()) {
        if (!allowed.has(spec)) {
          const where = exampleFile.get(`${plugin} ${spec}`);
          added.push(`  - ${plugin}: "${spec}"  (e.g. ${where})`);
        }
      }
      for (const spec of [...allowed].sort()) {
        if (!found.has(spec)) stale.push(`  - ${plugin}: "${spec}"`);
      }
    }

    const problems: string[] = [];
    if (added.length > 0) {
      problems.push(
        "New escaping imports (a plugin reached outside itself for something",
        "not in its baseline):",
        ...added,
        "",
        "If @vellumai/plugin-api already exports this symbol, import it from",
        "there. If this is genuinely host-internal with no plugin-api",
        "equivalent, regenerate the baseline with",
        "UPDATE_PLUGIN_IMPORT_BASELINE=1 and explain the new coupling in your PR.",
      );
    }
    if (stale.length > 0) {
      if (problems.length > 0) problems.push("");
      problems.push(
        "Stale baseline entries (no longer imported — tighten the baseline):",
        ...stale,
        "",
        "Regenerate with UPDATE_PLUGIN_IMPORT_BASELINE=1 to drop them.",
      );
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("plugins import plugin-api-provided types from @vellumai/plugin-api, not host modules", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const symbol of symbolsImportedFrom(
        file.source,
        "providers/types.js",
      )) {
        if (PLUGIN_API_PROVIDER_TYPES.has(symbol)) {
          violations.push(
            `  - ${file.relPath}: "${symbol}" from providers/types.js`,
          );
        }
      }
      for (const symbol of symbolsImportedFrom(
        file.source,
        "config/schemas/llm.js",
      )) {
        if (PLUGIN_API_LLM_TYPES.has(symbol)) {
          violations.push(
            `  - ${file.relPath}: "${symbol}" from config/schemas/llm.js`,
          );
        }
      }
    }

    const message = [
      "Plugin files import symbols from host modules that @vellumai/plugin-api",
      "already re-exports. Import them from @vellumai/plugin-api instead:",
      ...violations,
      "",
      "(ToolDefinition from providers/types.js is allowed — it is a distinct",
      "@vellumai/skill-host-contracts type, not plugin-api's ToolDefinition.)",
    ].join("\n");

    expect(violations, message).toEqual([]);
  });
});
