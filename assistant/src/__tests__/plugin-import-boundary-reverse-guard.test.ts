import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Reverse guard for the plugin import boundary. The forward guard
 * (plugin-import-boundary-guard.test.ts) ratchets what a plugin under
 * `src/plugins/defaults/<plugin>/` may reach OUT to; this file ratchets the
 * other direction: host code reaching INTO a plugin's internals.
 *
 * Encapsulation is bidirectional. A host file that imports from
 * `plugins/defaults/<plugin>/` couples the host to that plugin's
 * implementation — the plugin can no longer be disabled, replaced, or
 * supplied by a third party without host changes. Plugins are meant to be
 * reachable only through their registered contributions (hooks, tools,
 * routes, injectors, job handlers), so this baseline ratchets toward empty.
 *
 * Out of scope:
 *   - `src/plugins/defaults/index.ts` — the bundled-plugin registration
 *     barrel. Bundled defaults are compiled into the daemon, so the barrel is
 *     their loading mechanism: the in-process analog of loading an external
 *     plugin from its manifest.
 *   - Imports of modules directly under `defaults/` (e.g.
 *     `injector-order.js`) — those are host-level shared modules, not plugin
 *     internals.
 *   - Test files (`*.test.ts`, `__tests__/`) — the boundary guarded here is
 *     the shipped host runtime; test fixtures legitimately reference plugin
 *     paths.
 *
 * Baseline granularity is the IMPORTING FILE, not the imported specifier:
 * entries stay stable while a plugin refactors internally, and new coupling
 * almost always arrives as a new host file. The failure message prints the
 * offending specifiers for context.
 *
 * The scan sees string-literal module references only: `import`/`export from`
 * clauses, `import()`/`require()`/`import.meta.resolve()` calls, bare
 * side-effect imports, and `new URL("...", import.meta.url)` process/worker
 * entry points. A reference built from a non-literal string is invisible to
 * it.
 *
 * Tests run from `assistant/`, so paths are resolved against `process.cwd()`.
 */

/** `assistant/src/plugins/defaults`, relative to the `assistant/` cwd. */
const DEFAULTS_REL = join("src", "plugins", "defaults");
const DEFAULTS_ABS = join(process.cwd(), DEFAULTS_REL);

/** The bundled-plugin registration barrel — the sanctioned host→plugin edge. */
const COMPOSITION_ROOT = join(DEFAULTS_REL, "index.ts");

/**
 * Allowed host→plugin reaches: plugin name → sorted list of host files (paths
 * relative to `assistant/`) that import that plugin's internals.
 *
 * Regenerate after an intentional change with:
 *   UPDATE_HOST_PLUGIN_IMPORT_BASELINE=1 bun test src/__tests__/plugin-import-boundary-reverse-guard.test.ts
 * and paste the printed object here. A new entry needs a justification in
 * your PR: prefer routing the dependency through a registered contribution or
 * `@vellumai/plugin-api` instead of adding one.
 */
const BASELINE: Record<string, readonly string[]> = {
  compaction: [
    "src/agent/loop.ts",
    "src/daemon/conversation-agent-loop-handlers.ts",
    "src/daemon/conversation-history.ts",
    "src/daemon/conversation-lifecycle.ts",
    "src/daemon/conversation-media-retry.ts",
    "src/daemon/conversation-process.ts",
    "src/daemon/conversation-runtime-assembly.ts",
    "src/daemon/conversation.ts",
  ],
  "history-repair": [
    "src/daemon/conversation-error.ts",
    "src/daemon/conversation.ts",
  ],
  "image-recovery": ["src/daemon/conversation-error.ts"],
  memory: [
    "src/cli/commands/memory/memory-retrospective.ts",
    "src/cli/commands/memory/memory-v2-compare-render.ts",
    "src/cli/commands/memory/memory-v2.ts",
    "src/cli/commands/memory/memory-v3.ts",
    "src/cli/commands/memory/nodes.ts",
    "src/config/bundled-skills/messaging/tools/messaging-analyze-style.ts",
    "src/config/bundled-skills/playbooks/tools/playbook-create.ts",
    "src/config/bundled-skills/playbooks/tools/playbook-delete.ts",
    "src/config/bundled-skills/playbooks/tools/playbook-update.ts",
    "src/context/strip-injections.ts",
    "src/daemon/conversation-agent-loop-handlers.ts",
    "src/daemon/conversation-agent-loop.ts",
    "src/daemon/conversation-lifecycle.ts",
    "src/daemon/conversation-runtime-assembly.ts",
    "src/daemon/conversation-surfaces.ts",
    "src/daemon/conversation-turn-finalize.ts",
    "src/daemon/conversation.ts",
    "src/daemon/embedding-reconcile.ts",
    "src/daemon/handlers/skills.ts",
    "src/daemon/skill-memory-refresh.ts",
    "src/daemon/tool-side-effects.ts",
    "src/daemon/trust-context.ts",
    "src/home/feed-source-enrichment.ts",
    "src/permissions/checker.ts",
    "src/persistence/conversation-crud.ts",
    "src/persistence/steps.ts",
    "src/prompts/system-prompt.ts",
    "src/runtime/routes/consolidation-routes.ts",
    "src/runtime/routes/conversation-query-routes.ts",
    "src/runtime/routes/conversation-routes.ts",
    "src/runtime/routes/conversations-import-routes.ts",
    "src/runtime/routes/filing-routes.ts",
    "src/runtime/routes/global-search-routes.ts",
    "src/runtime/routes/index.ts",
    "src/runtime/routes/retrospective-routes.ts",
    "src/runtime/routes/secret-routes.ts",
    "src/schedule/scheduler.ts",
    "src/skills/managed-store.ts",
    "src/skills/uninstall.ts",
    "src/tools/filesystem/write.ts",
    "src/tools/skills/find-similar-skills.ts",
    "src/tools/skills/scaffold-managed.ts",
    "src/tools/tool-manifest.ts",
    "src/workflows/leaf-runner.ts",
  ],
  "tool-result-truncate": ["src/context/tool-result-truncation.ts"],
};

function importSpecifierRegex(): RegExp {
  return /(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:import\.meta\.resolve|import|require)\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]|new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/gm;
}

interface HostFile {
  /** Path relative to the `assistant/` cwd, for messages and the baseline. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  source: string;
}

/**
 * Production host files: everything under `src/` except plugin directories,
 * the composition root, and tests.
 */
function collectHostFiles(): HostFile[] {
  const files: HostFile[] = [];
  for (const ext of ["ts", "tsx"]) {
    for (const rel of new Glob(`src/**/*.${ext}`).scanSync({
      cwd: process.cwd(),
    })) {
      const norm = rel.split("/").join(sep);
      if (norm.endsWith(".test.ts") || norm.endsWith(".test.tsx")) {
        continue;
      }
      if (norm.split(sep).includes("__tests__")) {
        continue;
      }
      if (norm === COMPOSITION_ROOT) {
        continue;
      }
      // A file at least two segments below defaults/ belongs to a plugin —
      // that side of the boundary is the forward guard's domain. Files
      // directly under defaults/ (registry, shared host-level modules) are
      // host code and stay in scope.
      const underDefaults = relative(DEFAULTS_REL, norm);
      if (
        !underDefaults.startsWith("..") &&
        underDefaults.split(sep).length >= 2
      ) {
        continue;
      }
      const absPath = join(process.cwd(), norm);
      files.push({
        relPath: norm,
        absPath,
        source: readFileSync(absPath, "utf-8"),
      });
    }
  }
  return files;
}

interface Reach {
  /** Plugin directory name (first path segment under `defaults/`). */
  plugin: string;
  /** Importing host file, relative to the `assistant/` cwd. */
  relPath: string;
  specifier: string;
}

/** Every host import that resolves inside a plugin directory. */
function collectReaches(files: HostFile[]): Reach[] {
  const reaches: Reach[] = [];
  for (const file of files) {
    const regex = importSpecifierRegex();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(file.source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      // Only relative specifiers can resolve into a plugin directory.
      if (!specifier || !specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolve(dirname(file.absPath), specifier);
      const underDefaults = relative(DEFAULTS_ABS, resolved);
      if (underDefaults.startsWith("..") || underDefaults === "") {
        continue;
      }
      const segments = underDefaults.split(sep);
      // One segment = a host-level shared module directly under defaults/.
      if (segments.length < 2) {
        continue;
      }
      reaches.push({
        plugin: segments[0]!,
        relPath: file.relPath,
        specifier,
      });
    }
  }
  return reaches;
}

/** Distinct importing host files per plugin, sorted — the ratchet's view. */
function reachesByPlugin(reaches: Reach[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const r of reaches) {
    let set = sets.get(r.plugin);
    if (!set) {
      sets.set(r.plugin, (set = new Set()));
    }
    set.add(r.relPath);
  }
  return new Map(
    [...sets].map(([plugin, set]) => [plugin, [...set].sort()] as const),
  );
}

describe("plugin import boundary (reverse: host → plugin)", () => {
  const files = collectHostFiles();
  const reaches = collectReaches(files);
  const byPlugin = reachesByPlugin(reaches);

  test("no new host file imports a plugin's internals beyond the committed baseline", () => {
    if (process.env.UPDATE_HOST_PLUGIN_IMPORT_BASELINE === "1") {
      const regenerated: Record<string, string[]> = {};
      for (const plugin of [...byPlugin.keys()].sort()) {
        regenerated[plugin] = byPlugin.get(plugin)!;
      }

      console.log(
        "Regenerated host→plugin import baseline — paste into BASELINE:\n" +
          JSON.stringify(regenerated, null, 2),
      );
    }

    const exampleSpecifiers = new Map<string, string[]>();
    for (const r of reaches) {
      const key = `${r.plugin} ${r.relPath}`;
      const list = exampleSpecifiers.get(key) ?? [];
      if (!list.includes(r.specifier)) {
        list.push(r.specifier);
      }
      exampleSpecifiers.set(key, list);
    }

    const plugins = new Set([...byPlugin.keys(), ...Object.keys(BASELINE)]);
    const added: string[] = [];
    const stale: string[] = [];
    for (const plugin of [...plugins].sort()) {
      const found = new Set(byPlugin.get(plugin) ?? []);
      const allowed = new Set(BASELINE[plugin] ?? []);
      for (const relPath of [...found].sort()) {
        if (!allowed.has(relPath)) {
          const specs = exampleSpecifiers.get(`${plugin} ${relPath}`) ?? [];
          added.push(
            `  - ${plugin}: ${relPath}  (imports ${specs.join(", ")})`,
          );
        }
      }
      for (const relPath of [...allowed].sort()) {
        if (!found.has(relPath)) {
          stale.push(`  - ${plugin}: ${relPath}`);
        }
      }
    }

    const problems: string[] = [];
    if (added.length > 0) {
      problems.push(
        "New host→plugin imports (host code reached into a plugin's",
        "internals):",
        ...added,
        "",
        "Host code must not depend on a specific plugin's implementation.",
        "Route the dependency through a registered contribution (hook, tool,",
        "route, injector, job handler) or `@vellumai/plugin-api`. If the",
        "coupling is genuinely necessary, regenerate the baseline with",
        "UPDATE_HOST_PLUGIN_IMPORT_BASELINE=1 and justify the new edge in",
        "your PR.",
      );
    }
    if (stale.length > 0) {
      if (problems.length > 0) {
        problems.push("");
      }
      problems.push(
        "Stale baseline entries (no longer importing — tighten the baseline):",
        ...stale,
        "",
        "Regenerate with UPDATE_HOST_PLUGIN_IMPORT_BASELINE=1 to drop them.",
      );
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });
});
