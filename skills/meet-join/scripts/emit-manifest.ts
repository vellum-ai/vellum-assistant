/**
 * emit-manifest — drive the skill's `register(host)` through a
 * manifest-collecting `SkillHost` stub, then write the captured tool
 * definitions, route pattern/method pairs, and shutdown-hook names to
 * a JSON manifest file. A content hash over every `.ts` file under
 * `skills/meet-join/` is embedded so the daemon-side manifest loader
 * (PR 28) can reject a mismatched skill source tree before spawning
 * the external meet-host.
 *
 * The collector host implements only the methods `register.ts`
 * actually invokes — `registries.registerTools`, `registerSkillRoute`,
 * `registerShutdownHook`, plus a feature-flag read. Every other facet
 * is a throwing proxy so any future drift (a tool read attempting to
 * touch `host.events.*`, say) fails loudly during manifest emission
 * rather than silently producing a partial manifest.
 *
 * Run:
 *   bun run skills/meet-join/scripts/emit-manifest.ts --output <path>
 *
 * Defaults to `skills/meet-join/manifest.json` when `--output` is
 * omitted. The output path is resolved relative to the current
 * working directory.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type {
  SkillHost,
  SkillRoute,
  SkillRouteHandle,
  Tool,
} from "@vellumai/skill-host-contracts";

/** Serialized tool entry in the manifest. */
interface ToolManifestEntry {
  name: string;
  description: string;
  category: string;
  risk: string;
  input_schema: unknown;
}

/** Serialized route entry in the manifest. */
interface RouteManifestEntry {
  pattern: string;
  methods: string[];
}

/** Top-level manifest shape written to disk. */
interface Manifest {
  skill: string;
  tools: ToolManifestEntry[];
  routes: RouteManifestEntry[];
  shutdownHooks: string[];
  sourceHash: string;
}

// ---------------------------------------------------------------------------
// Collector host
// ---------------------------------------------------------------------------

interface CapturedRoute {
  pattern: RegExp;
  methods: string[];
}

interface Captured {
  toolProviders: Array<() => Tool[]>;
  routes: CapturedRoute[];
  shutdownHooks: string[];
}

/**
 * Build a fake `SkillHost` that captures every registration call the
 * skill's `register()` makes. Facets the emitter does not expect to be
 * used surface as thrown errors so drift is caught here rather than
 * producing a silently-incomplete manifest.
 */
function buildCollectorHost(captured: Captured): SkillHost {
  const unreachable = (path: string): never => {
    throw new Error(
      `emit-manifest: collector SkillHost facet "${path}" was unexpectedly accessed during register(); the emitter is only supposed to drive registry calls, not runtime logic.`,
    );
  };
  const throwingProxy = (path: string) =>
    new Proxy(
      {},
      { get: (_target, prop) => unreachable(`${path}.${String(prop)}`) },
    );

  // `register.ts` does not read the logger today. Returning a silent
  // no-op logger rather than a thrower keeps the manifest emitter
  // tolerant of an intentional future `host.logger.get("register")`
  // call — a logger read is side-effect-free and does not leak into
  // the manifest.
  const silentLogger = {
    debug: (): void => {},
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
  };
  return {
    logger: {
      get: () => silentLogger,
    },
    config: {
      // Flag read must return `true` so the tool provider closure in
      // register.ts returns the full tool list. The manifest is the
      // superset of tools the skill can register — runtime flag gating
      // happens in the daemon.
      isFeatureFlagEnabled: () => true,
      getSection: () => undefined,
    },
    identity: {
      getAssistantName: () => undefined,
      internalAssistantId: "manifest-emitter",
    },
    platform: throwingProxy("platform") as SkillHost["platform"],
    providers: throwingProxy("providers") as SkillHost["providers"],
    memory: throwingProxy("memory") as SkillHost["memory"],
    events: throwingProxy("events") as SkillHost["events"],
    registries: {
      registerTools: (provider) => {
        if (typeof provider !== "function") {
          throw new Error(
            "emit-manifest: expected a lazy tool provider closure",
          );
        }
        captured.toolProviders.push(provider);
      },
      registerSkillRoute: (route: SkillRoute): SkillRouteHandle => {
        captured.routes.push({
          pattern: route.pattern,
          methods: [...route.methods],
        });
        return Object.freeze({}) as SkillRouteHandle;
      },
      registerShutdownHook: (name: string) => {
        captured.shutdownHooks.push(name);
      },
    },
    speakers: throwingProxy("speakers") as SkillHost["speakers"],
  };
}

// ---------------------------------------------------------------------------
// Tool introspection
// ---------------------------------------------------------------------------

/**
 * Extract the manifest-facing fields from a `Tool`. The contract's
 * `Tool` interface exposes `name`, `description`, `category`,
 * `defaultRiskLevel`, and `getDefinition()` — we take `input_schema`
 * off the definition rather than re-deriving it.
 */
function toolToEntry(tool: Tool): ToolManifestEntry {
  const definition = tool.getDefinition();
  return {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    risk: String(tool.defaultRiskLevel),
    input_schema: definition.input_schema,
  };
}

// ---------------------------------------------------------------------------
// Source tree content hash
// ---------------------------------------------------------------------------

/**
 * Walk `root` recursively and return every `.ts` file path (relative
 * to `root`). `node_modules`, `__tests__`, and dotfiles are excluded —
 * tests are not part of the shipped skill surface, and node_modules
 * content depends on install-time resolution rather than source.
 *
 * Paths are returned sorted by their POSIX-normalized form so the
 * hash is deterministic across platforms.
 */
async function listSkillSourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const skipDirs = new Set(["node_modules", "__tests__", "scripts"]);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }

  await walk(root);
  return results
    .map((p) => relative(root, p).split("\\").join("/"))
    .sort();
}

/**
 * Compute a SHA-256 over every listed source file. Each file's
 * relative path is hashed before its bytes so renames change the
 * digest even when contents are unchanged.
 */
async function computeSourceHash(root: string): Promise<string> {
  const files = await listSkillSourceFiles(root);
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    const bytes = await readFile(join(root, rel));
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const skillRoot = resolve(scriptDir, "..");
  const defaultOutput = join(skillRoot, "manifest.json");
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { output: { type: "string" } },
    strict: true,
  });
  const outputPath = resolve(process.cwd(), values.output ?? defaultOutput);

  const captured: Captured = {
    toolProviders: [],
    routes: [],
    shutdownHooks: [],
  };
  const host = buildCollectorHost(captured);

  const registerMod = await import("../register.js");
  registerMod.register(host);

  // Sort by name / pattern so the manifest is independent of
  // registration order — reshuffling entries inside register.ts must
  // not change the on-disk bytes unless the set itself changes.
  // Strict lexicographic (not localeCompare) keeps output identical
  // across locales.
  const byKey = <T>(key: (t: T) => string) =>
    (a: T, b: T): number => {
      const ak = key(a);
      const bk = key(b);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    };

  const tools = captured.toolProviders
    .flatMap((provider) => provider())
    .map(toolToEntry)
    .sort(byKey((t) => t.name));

  const routes = captured.routes
    .map((r) => ({ pattern: r.pattern.source, methods: [...r.methods] }))
    .sort(byKey((r) => r.pattern));

  const shutdownHooks = [...captured.shutdownHooks].sort();

  const sourceHash = await computeSourceHash(skillRoot);

  const manifest: Manifest = {
    skill: "meet-join",
    tools,
    routes,
    shutdownHooks,
    sourceHash,
  };

  // Two-space indent + trailing newline gives diff-friendly output.
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(outputPath, serialized, "utf8");
  // eslint-disable-next-line no-console -- CLI script status line
  console.log(
    `emit-manifest: wrote ${tools.length} tool(s), ${routes.length} route(s), ${shutdownHooks.length} shutdown hook(s) to ${outputPath}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- CLI script failure diagnostics
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
