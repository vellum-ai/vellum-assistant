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
 * appears only for `ToolDefinition` (a `tools/tool-types.js` type
 * distinct from plugin-api's), which the anti-backslide guard enforces.
 *
 * Regenerate after an intentional change with:
 *   UPDATE_PLUGIN_IMPORT_BASELINE=1 bun test src/__tests__/plugin-import-boundary-guard.test.ts
 * and paste the printed object here, explaining the new coupling in your PR.
 */
const BASELINE: Record<string, readonly string[]> = {
  channel: ["../../types.js", "../injector-order.js"],
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
  documents: [
    "../../../documents/document-comments-store.js",
    "../../types.js",
    "../injector-order.js",
  ],
  "image-fallback": ["bun:sqlite", "node:crypto", "node:fs", "node:path"],
  "image-recovery": [
    "../../../agent/image-optimize.js",
    "../../../context/image-dimensions.js",
    "../../../persistence/conversation-crud.js",
    "../../../util/logger.js",
  ],
  memory: [
    "../../../../../config/types.js",
    "../../../../../messaging/providers/slack/message-metadata.js",
    "../../../../../persistence/auto-analysis-constants.js",
    "../../../../../persistence/checkpoints.js",
    "../../../../../persistence/db-connection.js",
    "../../../../../persistence/embeddings/embed.js",
    "../../../../../persistence/embeddings/embedding-backend.js",
    "../../../../../persistence/raw-query.js",
    "../../../../../persistence/schema/index.js",
    "../../../../../security/untrusted-content.js",
    "../../../../../util/logger.js",
    "../../../../../util/platform.js",
    "../../../../agent/image-optimize.js",
    "../../../../api/responses/memory-v3-selection-log.js",
    "../../../../channels/types.js",
    "../../../../cli/program.js",
    "../../../../config/assistant-feature-flags.js",
    "../../../../config/default-profile-catalog.js",
    "../../../../config/loader.js",
    "../../../../config/memory-v3-gate.js",
    "../../../../config/schema.js",
    "../../../../config/skill-state.js",
    "../../../../config/skills.js",
    "../../../../config/types.js",
    "../../../../context/token-estimator.js",
    "../../../../daemon/conversation-error.js",
    "../../../../daemon/conversation-notices.js",
    "../../../../daemon/conversation-registry.js",
    "../../../../daemon/conversation-runtime-assembly.js",
    "../../../../daemon/embedding-reconcile.js",
    "../../../../daemon/message-protocol.js",
    "../../../../daemon/message-types/memory.js",
    "../../../../daemon/trust-context.js",
    "../../../../notifications/emit-signal.js",
    "../../../../persistence/checkpoints.js",
    "../../../../persistence/db-connection.js",
    "../../../../persistence/embeddings/embed.js",
    "../../../../persistence/embeddings/embedding-backend.js",
    "../../../../persistence/embeddings/embedding-billing-breaker.js",
    "../../../../persistence/embeddings/embedding-cache.js",
    "../../../../persistence/embeddings/embedding-types.js",
    "../../../../persistence/embeddings/qdrant-circuit-breaker.js",
    "../../../../persistence/embeddings/qdrant-client.js",
    "../../../../persistence/embeddings/sparse-tokenize.js",
    "../../../../persistence/job-utils.js",
    "../../../../persistence/jobs-store.js",
    "../../../../persistence/raw-query.js",
    "../../../../persistence/schema/conversations.js",
    "../../../../persistence/schema/index.js",
    "../../../../prompts/system-prompt.js",
    "../../../../providers/platform-proxy/context.js",
    "../../../../runtime/assistant-event-hub.js",
    "../../../../runtime/auth/route-policy.js",
    "../../../../runtime/background-job-runner.js",
    "../../../../runtime/routes/errors.js",
    "../../../../runtime/routes/types.js",
    "../../../../security/secret-scanner.js",
    "../../../../skills/catalog-cache.js",
    "../../../../telemetry/watchdog-events-store.js",
    "../../../../tools/skills/delete-managed.js",
    "../../../../util/abort-reasons.js",
    "../../../../util/errors.js",
    "../../../../util/log-redact.js",
    "../../../../util/logger.js",
    "../../../../util/platform.js",
    "../../../../util/process-liveness.js",
    "../../../../util/retry.js",
    "../../../../util/strip-comment-lines.js",
    "../../../../util/truncate.js",
    "../../../channels/types.js",
    "../../../config/assistant-feature-flags.js",
    "../../../config/loader.js",
    "../../../config/memory-v3-gate.js",
    "../../../config/schema.js",
    "../../../config/schemas/memory-v2.js",
    "../../../config/schemas/memory.js",
    "../../../config/types.js",
    "../../../contacts/guardian-delivery-reader.js",
    "../../../context/compactor.js",
    "../../../context/strip-injections.js",
    "../../../context/token-estimator.js",
    "../../../conversations/job-handlers/summarization.js",
    "../../../daemon/date-context.js",
    "../../../daemon/disk-pressure-background-gate.js",
    "../../../daemon/embedding-reconcile.js",
    "../../../daemon/pkb-context-tracker.js",
    "../../../daemon/pkb-reminder-builder.js",
    "../../../daemon/skill-memory-refresh.js",
    "../../../daemon/tool-setup-types.js",
    "../../../daemon/trust-context-types.js",
    "../../../daemon/trust-context.js",
    "../../../home/job-handlers/conversation-starters.js",
    "../../../media/job-handlers/media-processing.js",
    "../../../permissions/types.js",
    "../../../persistence/checkpoints.js",
    "../../../persistence/cleanup-schedule-state.js",
    "../../../persistence/conversation-crud.js",
    "../../../persistence/db-connection.js",
    "../../../persistence/db-maintenance.js",
    "../../../persistence/embeddings/embedding-backend.js",
    "../../../persistence/embeddings/embedding-billing-breaker.js",
    "../../../persistence/embeddings/embedding-runtime-manager.js",
    "../../../persistence/embeddings/embedding-types.js",
    "../../../persistence/embeddings/messages-lexical-index.js",
    "../../../persistence/embeddings/qdrant-circuit-breaker.js",
    "../../../persistence/embeddings/qdrant-client.js",
    "../../../persistence/embeddings/qdrant-manager.js",
    "../../../persistence/job-handlers/cleanup.js",
    "../../../persistence/job-handlers/message-lexical-backfill.js",
    "../../../persistence/job-handlers/message-lexical.js",
    "../../../persistence/job-utils.js",
    "../../../persistence/jobs-store.js",
    "../../../persistence/raw-query.js",
    "../../../persistence/schema/index.js",
    "../../../persistence/worker-control.js",
    "../../../prompts/persona-resolver.js",
    "../../../prompts/system-prompt.js",
    "../../../prompts/template-detection.js",
    "../../../runtime/actor-trust-resolver.js",
    "../../../runtime/agent-wake.js",
    "../../../runtime/background-job-runner.js",
    "../../../runtime/capabilities.js",
    "../../../runtime/services/auto-analysis-guard.js",
    "../../../runtime/sync/resource-sync-events.js",
    "../../../tools/registry.js",
    "../../../tools/types.js",
    "../../../types.js",
    "../../../util/logger.js",
    "../../../util/platform.js",
    "../../../util/promise-guard.js",
    "../../../util/sqlite-retry.js",
    "../../../util/strip-comment-lines.js",
    "../../../util/worker-memory.js",
    "../../types.js",
    "../injection-presence.js",
    "../injector-order.js",
    "@qdrant/js-client-rest",
    "crypto",
    "drizzle-orm",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "uuid",
    "yaml",
    "zod",
  ],
  session: [
    "../../../config/loader.js",
    "../../types.js",
    "../injector-order.js",
  ],
  "title-generate": [
    "../../../../config/loader.js",
    "../../../../persistence/conversation-crud.js",
    "../../../../persistence/conversation-title-service.js",
  ],
  "turn-context": [
    "../../../daemon/conversation-runtime-assembly.js",
    "../../../runtime/capabilities.js",
    "../../types.js",
    "../injector-order.js",
  ],
  workspace: [
    "../../../config/loader.js",
    "../../../context/strip-injections.js",
    "../../../daemon/conversation-registry.js",
    "../../../daemon/conversation-workspace.js",
    "../../../daemon/now-scratchpad.js",
    "../../../daemon/trust-context-types.js",
    "../../../daemon/trust-context.js",
    "../../../util/platform.js",
    "../../types.js",
    "../injection-presence.js",
    "../injector-order.js",
    "node:fs",
  ],
};

/**
 * Symbols that `@vellumai/plugin-api` re-exports from `providers/types.js`. A
 * plugin must import these from the public API, not the host module. NOT
 * listed (and therefore allowed from `providers/types.js`): `ToolDefinition`,
 * which `providers/types.js` re-exports from `tools/tool-types.js`
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
      if (norm.endsWith(".test.ts") || norm.endsWith(".test.tsx")) {
        continue;
      }
      if (norm.split(sep).includes("__tests__")) {
        continue;
      }
      const underDefaults = relative(DEFAULTS_REL, norm);
      const segments = underDefaults.split(sep);
      // A file directly under defaults/ (e.g. index.ts) is the registry, not a
      // plugin — it has no plugin directory segment.
      if (segments.length < 2) {
        continue;
      }
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
      if (!specifier || specifier === "@vellumai/plugin-api") {
        continue;
      }
      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file.absPath), specifier);
        // Stays inside the plugin's own directory → allowed.
        if (!relative(pluginRoot, resolved).startsWith("..")) {
          continue;
        }
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
    if (!set) {
      sets.set(e.plugin, (set = new Set()));
    }
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

/** Sentinel returned by {@link symbolsImportedFrom} for a namespace import
 *  (`import * as NS from "X"` / `import type * as NS from "X"`): it binds the
 *  module's entire export surface, so it counts as importing every re-exported
 *  symbol. `*` cannot collide with a real named-import identifier. */
const NAMESPACE_IMPORT = "*";

/** Symbols a plugin file imports from a host module whose specifier ends with
 *  `hostPathSuffix` (e.g. `providers/types.js`), across multi-line clauses. A
 *  namespace import yields the {@link NAMESPACE_IMPORT} sentinel — it reaches
 *  the whole surface, so it must not slip past the anti-backslide check. */
function symbolsImportedFrom(source: string, hostPathSuffix: string): string[] {
  const escaped = hostPathSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const from = String.raw`\s*from\s*['"]([^'"]*` + escaped + String.raw`)['"]`;
  const namedRegex = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([^}]*)\}` + from,
    "g",
  );
  const namespaceRegex = new RegExp(
    String.raw`import\s+(?:type\s+)?\*\s+as\s+\w+` + from,
    "g",
  );
  const symbols: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = namedRegex.exec(source)) !== null) {
    symbols.push(...parseNamedSymbols(match[1]!));
  }
  while (namespaceRegex.exec(source) !== null) {
    symbols.push(NAMESPACE_IMPORT);
  }
  return symbols;
}

/** Anti-backslide violations for one plugin file against one guarded host
 *  module: any re-exported symbol imported by name, plus any namespace import
 *  (which binds the whole surface, and thus every guarded symbol). */
function guardedImportViolations(
  file: PluginFile,
  hostPathSuffix: string,
  guarded: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const symbol of symbolsImportedFrom(file.source, hostPathSuffix)) {
    if (symbol === NAMESPACE_IMPORT) {
      violations.push(
        `  - ${file.relPath}: "import * as … from ${hostPathSuffix}" reaches all re-exported symbols`,
      );
    } else if (guarded.has(symbol)) {
      violations.push(
        `  - ${file.relPath}: "${symbol}" from ${hostPathSuffix}`,
      );
    }
  }
  return violations;
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
      exampleFile.set(`${e.plugin} ${e.specifier}`, e.relPath);
    }

    const plugins = new Set([...byPlugin.keys(), ...Object.keys(BASELINE)]);
    const added: string[] = [];
    const stale: string[] = [];
    for (const plugin of [...plugins].sort()) {
      const found = new Set(byPlugin.get(plugin) ?? []);
      const allowed = new Set(BASELINE[plugin] ?? []);
      for (const spec of [...found].sort()) {
        if (!allowed.has(spec)) {
          const where = exampleFile.get(`${plugin} ${spec}`);
          added.push(`  - ${plugin}: "${spec}"  (e.g. ${where})`);
        }
      }
      for (const spec of [...allowed].sort()) {
        if (!found.has(spec)) {
          stale.push(`  - ${plugin}: "${spec}"`);
        }
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
      if (problems.length > 0) {
        problems.push("");
      }
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
      violations.push(
        ...guardedImportViolations(
          file,
          "providers/types.js",
          PLUGIN_API_PROVIDER_TYPES,
        ),
        ...guardedImportViolations(
          file,
          "config/schemas/llm.js",
          PLUGIN_API_LLM_TYPES,
        ),
      );
    }

    const message = [
      "Plugin files import symbols from host modules that @vellumai/plugin-api",
      "already re-exports. Import them from @vellumai/plugin-api instead:",
      ...violations,
      "",
      "(ToolDefinition from providers/types.js is allowed — it is a distinct",
      "tools/tool-types.js type, not plugin-api's ToolDefinition.)",
    ].join("\n");

    expect(violations, message).toEqual([]);
  });
});

describe("anti-backslide symbol extraction", () => {
  const fileWith = (source: string): PluginFile => ({
    plugin: "compaction",
    relPath: "src/plugins/defaults/compaction/example.ts",
    absPath: "/example.ts",
    source,
  });

  test("a re-exported type imported by name is flagged", () => {
    const file = fileWith(
      `import type { Message } from "../../../providers/types.js";`,
    );
    expect(
      guardedImportViolations(
        file,
        "providers/types.js",
        PLUGIN_API_PROVIDER_TYPES,
      ),
    ).not.toEqual([]);
  });

  test("the allowed ToolDefinition named import stays clean", () => {
    const file = fileWith(
      `import type { ToolDefinition } from "../../../providers/types.js";`,
    );
    expect(
      guardedImportViolations(
        file,
        "providers/types.js",
        PLUGIN_API_PROVIDER_TYPES,
      ),
    ).toEqual([]);
  });

  // A namespace import binds the whole surface (`NS.Message`), so it must be
  // caught even though the anti-backslide check extracts no named symbols and
  // the specifier is already in the ratchet baseline.
  test("a namespace import of a guarded module is flagged", () => {
    for (const source of [
      `import * as ProviderTypes from "../../../providers/types.js";`,
      `import type * as ProviderTypes from "../../../providers/types.js";`,
    ]) {
      expect(
        guardedImportViolations(
          fileWith(source),
          "providers/types.js",
          PLUGIN_API_PROVIDER_TYPES,
        ),
        source,
      ).not.toEqual([]);
    }
  });
});
