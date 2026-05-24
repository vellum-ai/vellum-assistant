import type { ToolDefinition } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { coreAppProxyTools } from "./apps/definitions.js";
import { registerAppTools } from "./apps/registry.js";
import { allComputerUseTools } from "./computer-use/definitions.js";
import { hostFileEditTool } from "./host-filesystem/edit.js";
import { hostFileReadTool } from "./host-filesystem/read.js";
import { hostFileTransferTool } from "./host-filesystem/transfer.js";
import { hostFileWriteTool } from "./host-filesystem/write.js";
import { hostShellTool } from "./host-terminal/host-shell.js";
import { toProviderSafeToolName } from "./provider-tool-name.js";
import { registerSystemTools } from "./system/register.js";
import type { LoadedPluginTool, Tool } from "./types.js";
import { allUiSurfaceTools } from "./ui-surface/definitions.js";
import { registerUiSurfaceTools } from "./ui-surface/registry.js";

const log = getLogger("tool-registry");

const tools = new Map<string, Tool>();

// ── External tool registry ───────────────────────────────────────────
// Skills register their tools here at initialization time so the tool
// manifest can include them without importing from `../skills/`.
//
// Each registration is stored as a provider closure. Closures are
// resolved at `getExternalTools()` time (which `initializeTools()`
// calls), not at registration time — this lets a skill defer its
// feature-flag check until after the daemon has run
// `mergeDefaultWorkspaceConfig()`, so skills see the merged config
// instead of forcing an early `loadConfig()` against unmerged defaults.
const externalToolProviders: Array<() => Tool[]> = [];

/**
 * Register tools provided by an external skill. Called during skill
 * initialization (e.g. meet-join bootstrap).
 *
 * Accepts either a concrete `Tool[]` (resolved eagerly at the caller)
 * or a `() => Tool[]` closure (resolved lazily inside
 * `getExternalTools()`). Skills that perform feature-flag or config
 * reads to decide which tools to surface must pass a closure so the
 * read happens after daemon-startup config merging.
 *
 * Lives in registry.ts (not tool-manifest.ts) to avoid a circular
 * dependency: skills/load.ts → … → meet-join/register.ts → tool-manifest.ts
 * → skills/load.ts. Keeping it here lets external skill bootstraps import
 * from registry.ts, which is already a leaf in the dependency graph.
 */
export function registerExternalTools(
  toolsOrProvider: Tool[] | (() => Tool[]),
): void {
  const provider =
    typeof toolsOrProvider === "function"
      ? toolsOrProvider
      : () => toolsOrProvider;
  externalToolProviders.push(provider);
}

/** Return all externally registered tools. */
function getExternalTools(): Tool[] {
  return externalToolProviders.flatMap((provider) => provider());
}

// Snapshot of core tools captured after initializeTools() completes.
// Used by __resetRegistryForTesting() to restore eager tools that cannot
// be re-registered because ESM import caching prevents side effects
// from running a second time.
let coreToolsSnapshot: Map<string, Tool> | null = null;

// Tracks how many sessions are currently using each skill's tools.
// Tools are only removed from the global registry when this drops to 0.
const skillRefCount = new Map<string, number>();

// Plugin-tool refcount lives in its own namespace so plugin and skill IDs
// cannot collide in the ref map even if a plugin's `manifest.name` happens to
// match a skill id. Conflict detection on `tools` (keyed by tool name) is
// separate and covers the case of two extensions choosing the same tool name.
const pluginRefCount = new Map<string, number>();

// Stash of original core tools that have been replaced by a plugin override.
// Keyed by tool name. When a plugin with `allowCoreOverride: true` registers
// a tool whose name matches a core tool, the original is moved here so it
// can be restored on `unregisterPluginTools(<owner>)`. See
// {@link Tool.allowCoreOverride} for the trust posture and {@link
// registerPluginTools} for the registration-side handling.
const coreToolOverrides = new Map<string, Tool>();

function withProviderSafeToolName(tool: Tool): Tool {
  const safeName = toProviderSafeToolName(tool.name);
  if (safeName === tool.name) {
    return tool;
  }

  return {
    ...tool,
    name: safeName,
    getDefinition(): ToolDefinition {
      return {
        ...tool.getDefinition(),
        name: safeName,
      };
    },
  };
}

export function registerTool(tool: Tool): void {
  const existing = tools.get(tool.name);
  if (existing) {
    if (existing === tool) return; // same object, skip
    log.warn({ name: tool.name }, "Tool already registered, overwriting");
  }
  tools.set(tool.name, tool);
  log.info({ name: tool.name, category: tool.category }, "Tool registered");
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function getAllTools(): Tool[] {
  return Array.from(tools.values());
}

/**
 * Register multiple skill-origin tools at once.
 * Skips any tool whose name collides with a core tool (logs a warning instead
 * of throwing so the remaining tools in the batch still get registered).
 * Throws if a tool name collides with a skill tool owned by a different skill.
 * Allows replacement when the incoming tool has the same ownerSkillId as the existing one,
 * which supports hot-reloading a skill without tearing down first.
 */
export function registerSkillTools(newTools: Tool[]): Tool[] {
  // Filter out tools that collide with core tools, and validate the rest.
  const accepted: Tool[] = [];
  for (const tool of newTools) {
    const existing = tools.get(tool.name);
    if (existing) {
      const existingIsCore = existing.origin === "core" || !existing.origin;
      if (existingIsCore) {
        log.warn(
          { toolName: tool.name, skillId: tool.ownerSkillId },
          `Skill "${tool.ownerSkillId}" tried to register tool "${tool.name}" which conflicts with a core tool. Skipping.`,
        );
        continue;
      }
      // Existing is from a different origin (plugin/mcp) or a different
      // skill — skill tools can only replace themselves (hot-reload).
      if (
        existing.origin !== "skill" ||
        existing.ownerSkillId !== tool.ownerSkillId
      ) {
        const owner =
          existing.origin === "skill"
            ? `skill "${existing.ownerSkillId}"`
            : existing.origin === "plugin"
              ? `plugin "${existing.ownerPluginId}"`
              : existing.origin === "mcp"
                ? `MCP server "${existing.ownerMcpServerId}"`
                : `${existing.origin ?? "unknown"}-origin tool`;
        throw new Error(
          `Skill tool "${tool.name}" is already registered by ${owner}`,
        );
      }
    }
    accepted.push(tool);
  }

  // Collect unique skill IDs from the batch to bump ref counts
  const skillIds = new Set<string>();
  for (const tool of accepted) {
    tools.set(tool.name, tool);
    if (tool.ownerSkillId) skillIds.add(tool.ownerSkillId);
    log.info(
      { name: tool.name, ownerSkillId: tool.ownerSkillId },
      "Skill tool registered",
    );
  }

  for (const id of skillIds) {
    skillRefCount.set(id, (skillRefCount.get(id) ?? 0) + 1);
  }

  return accepted;
}

/**
 * Register tools contributed by a plugin. Stamps `origin: "plugin"` and
 * `ownerPluginId: pluginName` on every incoming tool so plugin ownership is
 * tracked in a namespace disjoint from skill tools — if a plugin's
 * `manifest.name` happens to match a skill id, the two do not share refcount
 * state or conflict-detection paths.
 *
 * Conflict handling:
 * - **Core collisions, no override flag:** mirrors {@link registerSkillTools}
 *   — log a warning and skip the colliding tool.
 * - **Core collisions, `allowCoreOverride: true`:** the original core tool
 *   is stashed in {@link coreToolOverrides} and the plugin tool takes its
 *   place. {@link unregisterPluginTools} restores the original on teardown.
 *   At most one override per core tool name is allowed — a second plugin
 *   trying to override the same name throws.
 * - **Plugin collisions:** re-registering the same plugin's own tool (hot
 *   reload) is allowed; cross-plugin collisions throw.
 * - **Skill/MCP collisions:** throw — plugin tools cannot replace tools
 *   owned by skills or MCP servers, regardless of `allowCoreOverride`.
 *
 * The stamp is authoritative: any pre-existing `origin` / `ownerPluginId` /
 * `ownerSkillId` / `ownerMcpServerId` fields on the incoming tools are
 * overwritten so the bootstrap cannot be spoofed into claiming tools on
 * behalf of an unrelated extension. `allowCoreOverride` is NOT stamped over
 * — it remains as the plugin author declared it so {@link
 * unregisterPluginTools} can recognize override tools at teardown time.
 */
export function registerPluginTools(
  pluginName: string,
  newTools: LoadedPluginTool[],
): Tool[] {
  const stamped: Tool[] = newTools.map((pluginTool) => {
    const { input_schema, ...rest } = pluginTool;
    const tool: Tool = {
      ...rest,
      category: "plugin",
      origin: "plugin" as const,
      ownerPluginId: pluginName,
      ownerSkillId: undefined,
      ownerMcpServerId: undefined,
      ownerSkillBundled: undefined,
      ownerSkillVersionHash: undefined,
      getDefinition(): ToolDefinition {
        return {
          name: pluginTool.name,
          description: pluginTool.description,
          input_schema,
        };
      },
    };
    return withProviderSafeToolName(tool);
  });

  const accepted: Tool[] = [];
  // Track which accepted tools are overriding a core tool — used below to
  // stash the original core tool only after we've validated the entire
  // batch (so a downstream throw doesn't leave the registry half-mutated).
  const pendingCoreOverrides = new Map<string, Tool>();
  for (const tool of stamped) {
    const existing = tools.get(tool.name);
    if (existing) {
      const existingIsCore = existing.origin === "core" || !existing.origin;
      if (existingIsCore) {
        if (tool.allowCoreOverride === true) {
          // The original core tool will be stashed below (after the full
          // batch validates) so it can be restored when the overriding
          // plugin unregisters.
          pendingCoreOverrides.set(tool.name, existing);
          accepted.push(tool);
          continue;
        }
        log.warn(
          { toolName: tool.name, pluginName },
          `Plugin "${pluginName}" tried to register tool "${tool.name}" which conflicts with a core tool. Skipping.`,
        );
        continue;
      }
      if (existing.origin === "plugin") {
        if (existing.ownerPluginId !== pluginName) {
          // A different plugin owns this name. If our incoming tool sets
          // allowCoreOverride: true and the existing one is itself an
          // override of a core tool, refuse — only one active override per
          // name. The clear path is for the first plugin to unregister
          // (which restores the core tool) before the second registers.
          if (
            tool.allowCoreOverride === true &&
            coreToolOverrides.has(tool.name)
          ) {
            throw new Error(
              `Plugin "${pluginName}" tried to override core tool "${tool.name}" but plugin "${existing.ownerPluginId}" already overrides it. ` +
                `Unregister "${existing.ownerPluginId}" first.`,
            );
          }
          throw new Error(
            `Plugin tool "${tool.name}" is already registered by plugin "${existing.ownerPluginId}"`,
          );
        }
        // Same plugin re-registering its own tool (hot reload) — allow.
        // If this tool currently overrides a core tool, the stash entry
        // stays untouched; the replacement tool keeps the same override
        // role and the core tool will still be restored on unregister.
      } else {
        // Conflict with a skill or MCP-owned tool.
        throw new Error(
          `Plugin "${pluginName}" tried to register tool "${tool.name}" which conflicts with a ${existing.origin}-origin tool`,
        );
      }
    }
    accepted.push(tool);
  }

  // Commit any pending core-tool stashes now that the batch has validated.
  for (const [name, original] of pendingCoreOverrides) {
    coreToolOverrides.set(name, original);
  }

  for (const tool of accepted) {
    const isOverride = pendingCoreOverrides.has(tool.name);
    tools.set(tool.name, tool);
    if (isOverride) {
      log.info(
        {
          name: tool.name,
          ownerPluginId: tool.ownerPluginId,
          action: "core-override",
        },
        `Plugin tool "${tool.name}" registered as core override`,
      );
    } else {
      log.info(
        { name: tool.name, ownerPluginId: tool.ownerPluginId },
        "Plugin tool registered",
      );
    }
  }

  if (accepted.length > 0) {
    pluginRefCount.set(pluginName, (pluginRefCount.get(pluginName) ?? 0) + 1);
  }

  return accepted;
}

/**
 * Decrement the reference count for a plugin and remove its tools only when
 * no more references remain. Safe to call when the plugin never contributed
 * tools (no-op).
 *
 * When a plugin's tool is overriding a core tool (registered with
 * `allowCoreOverride: true`), removal restores the original core tool from
 * {@link coreToolOverrides} in the same slot. This makes core-override
 * teardown reversible: after a plugin unloads, the core tool is back in the
 * registry as if the plugin had never run.
 */
export function unregisterPluginTools(pluginName: string): void {
  const current = pluginRefCount.get(pluginName) ?? 0;
  if (current > 1) {
    pluginRefCount.set(pluginName, current - 1);
    log.info(
      { pluginName, remaining: current - 1 },
      "Decremented plugin ref count, tools kept",
    );
    return;
  }

  pluginRefCount.delete(pluginName);
  for (const [name, tool] of tools) {
    if (tool.origin === "plugin" && tool.ownerPluginId === pluginName) {
      const stashedCore = coreToolOverrides.get(name);
      if (stashedCore) {
        coreToolOverrides.delete(name);
        tools.set(name, stashedCore);
        log.info(
          { name, pluginName, action: "core-restore" },
          `Plugin tool "${name}" unregistered, original core tool restored`,
        );
      } else {
        tools.delete(name);
        log.info({ name, pluginName }, "Plugin tool unregistered");
      }
    }
  }
}

/**
 * Return the current reference count for a plugin's tools. Exposed for testing.
 */
export function getPluginRefCount(pluginName: string): number {
  return pluginRefCount.get(pluginName) ?? 0;
}

/**
 * If a plugin tool is currently overriding the core tool named `name`,
 * return the stashed original core tool. Returns `undefined` when no
 * override is active for that name.
 *
 * Exposed primarily for introspection (debugging, tests, "what's
 * overriding what" diagnostics). Production code paths should not need to
 * reach into the stash directly — registration and teardown handle the
 * full lifecycle.
 */
export function getCoreToolOverride(name: string): Tool | undefined {
  return coreToolOverrides.get(name);
}

/**
 * Decrement the reference count for a skill and remove its tools only when
 * no more sessions reference them.
 */
export function unregisterSkillTools(skillId: string): void {
  const current = skillRefCount.get(skillId) ?? 0;
  if (current > 1) {
    skillRefCount.set(skillId, current - 1);
    log.info(
      { skillId, remaining: current - 1 },
      "Decremented skill ref count, tools kept",
    );
    return;
  }

  // Last reference - actually remove the tools
  skillRefCount.delete(skillId);
  for (const [name, tool] of tools) {
    if (tool.origin === "skill" && tool.ownerSkillId === skillId) {
      tools.delete(name);
      log.info({ name, skillId }, "Skill tool unregistered");
    }
  }
}

/**
 * Register multiple MCP-origin tools at once.
 * Skips any tool whose name collides with a core tool (logs a warning).
 * Throws if a tool name collides with a tool owned by a different MCP server.
 */
export function registerMcpTools(newTools: Tool[]): Tool[] {
  const accepted: Tool[] = [];
  for (const tool of newTools) {
    const existing = tools.get(tool.name);
    if (existing) {
      const existingIsCore = existing.origin === "core" || !existing.origin;
      if (existingIsCore) {
        log.warn(
          { toolName: tool.name, serverId: tool.ownerMcpServerId },
          `MCP server "${tool.ownerMcpServerId}" tried to register tool "${tool.name}" which conflicts with a core tool. Skipping.`,
        );
        continue;
      }
      if (existing.origin === "skill") {
        log.warn(
          {
            toolName: tool.name,
            serverId: tool.ownerMcpServerId,
            skillId: existing.ownerSkillId,
          },
          `MCP server "${tool.ownerMcpServerId}" tried to register tool "${tool.name}" which conflicts with skill tool from "${existing.ownerSkillId}". Skipping.`,
        );
        continue;
      }
      if (existing.origin === "plugin") {
        log.warn(
          {
            toolName: tool.name,
            serverId: tool.ownerMcpServerId,
            pluginName: existing.ownerPluginId,
          },
          `MCP server "${tool.ownerMcpServerId}" tried to register tool "${tool.name}" which conflicts with plugin tool from "${existing.ownerPluginId}". Skipping.`,
        );
        continue;
      }
      if (
        existing.origin === "mcp" &&
        existing.ownerMcpServerId !== tool.ownerMcpServerId
      ) {
        throw new Error(
          `MCP tool "${tool.name}" is already registered by MCP server "${existing.ownerMcpServerId}"`,
        );
      }
    }
    accepted.push(tool);
  }

  for (const tool of accepted) {
    tools.set(tool.name, tool);
    log.info(
      { name: tool.name, ownerMcpServerId: tool.ownerMcpServerId },
      "MCP tool registered",
    );
  }

  return accepted;
}

/**
 * Unregister all MCP-origin tools from the registry.
 */
export function unregisterAllMcpTools(): void {
  for (const [name, tool] of tools) {
    if (tool.origin === "mcp") {
      tools.delete(name);
      log.info({ name }, "MCP tool unregistered (reload)");
    }
  }
}

/**
 * Return tool definitions for all currently registered MCP-origin tools.
 * Used by the session resolver to dynamically pick up MCP tools that
 * were registered after session creation (e.g. via `vellum mcp reload`).
 */
export function getMcpToolDefinitions(): ToolDefinition[] {
  return Array.from(tools.values())
    .filter((t) => t.origin === "mcp")
    .map((t) => t.getDefinition());
}

/**
 * Return the names of all currently registered skill-origin tools.
 */
export function getSkillToolNames(): string[] {
  return Array.from(tools.values())
    .filter((t) => t.origin === "skill")
    .map((t) => t.name);
}

/**
 * Return the current reference count for a skill's tools. Exposed for testing.
 */
export function getSkillRefCount(skillId: string): number {
  return skillRefCount.get(skillId) ?? 0;
}

export function getAllToolDefinitions(): ToolDefinition[] {
  // Exclude proxy tools (e.g. computer_use_* tools) - they are projected
  // into sessions by the skill system, not via the global tool list.
  // Exclude skill-origin tools - they are managed by the session-level
  // skill projection system (projectSkillTools) and must not leak into
  // the base tool list, which is shared across sessions via the global
  // registry.  Including them here causes "Tool names must be unique"
  // errors when the projection appends the same tools a second time.
  return getAllTools()
    .filter((t) => t.executionMode !== "proxy" && t.origin !== "skill")
    .map((t) => t.getDefinition());
}

export async function initializeTools(): Promise<void> {
  const {
    loadEagerModules,
    eagerModuleToolNames,
    explicitTools,
    getCesToolsIfEnabled,
    cesTools,
  } = await import("./tool-manifest.js");

  // Capture tool names already in the registry before any manifest
  // registrations.  In production this is empty; in tests a non-skill tool
  // may have been registered before the first initializeTools() call.
  const preExisting = new Set(tools.keys());

  // Import tool modules to trigger registration side effects.
  await loadEagerModules();

  // Explicit tool instances - no side-effect import required.
  for (const tool of explicitTools) {
    registerTool(tool);
  }

  // External skill tools — registered by skill bootstrap modules via
  // `registerExternalTools()`. Called at init time (not spread into
  // `explicitTools`) so registrations that happen between module-load
  // and `initializeTools()` are picked up.
  const extTools = getExternalTools();
  for (const tool of extTools) {
    registerTool(tool);
  }

  // Host tools are registered explicitly so host access stays opt-in until
  // this point in startup, rather than as module side effects.
  const hostTools = [
    hostFileReadTool,
    hostFileWriteTool,
    hostFileEditTool,
    hostFileTransferTool,
    hostShellTool,
  ];
  for (const tool of hostTools) {
    registerTool(tool);
  }

  // CES tools - registered only when the CES feature flag is enabled.
  const activeCesTools = getCesToolsIfEnabled();
  for (const tool of activeCesTools) {
    registerTool(tool);
  }

  registerUiSurfaceTools();
  registerAppTools();
  registerSystemTools();

  // Snapshot core tools for __resetRegistryForTesting().  We include every
  // non-skill tool that was registered by the manifest, while excluding
  // arbitrary test tools that were registered before init.
  //
  // A pre-existing tool is included only if it is a known manifest tool
  // (declared in eagerModuleToolNames, explicitTools, hostTools, or any
  // registered external skill tool).  This handles ESM cache hits where
  // eager-module tools are already in the registry before init ran.
  if (!coreToolsSnapshot) {
    const manifestToolNames = new Set<string>([
      ...eagerModuleToolNames,
      ...explicitTools.map((t: Tool) => t.name),
      ...extTools.map((t: Tool) => t.name),
      ...hostTools.map((t: Tool) => t.name),
      ...cesTools.map((t: Tool) => t.name),
      ...allComputerUseTools.map((t: Tool) => t.name),
      ...allUiSurfaceTools.map((t: Tool) => t.name),
      ...coreAppProxyTools.map((t: Tool) => t.name),
    ]);

    coreToolsSnapshot = new Map<string, Tool>();
    for (const [name, tool] of tools) {
      if (tool.origin === "skill") continue;
      if (tool.origin === "plugin") continue;
      // Exclude pre-existing tools not declared in the manifest
      if (preExisting.has(name) && !manifestToolNames.has(name)) continue;
      coreToolsSnapshot.set(name, tool);
    }
  }

  log.info({ count: tools.size }, "Tools initialized");
}

/**
 * Reset registry to its post-initializeTools() baseline. Exposed
 * exclusively for test isolation - prevents cross-file contamination
 * when multiple test suites share a single Bun process.
 *
 * Restores core tools from a snapshot taken after the first
 * initializeTools() call, because ESM import caching means eager
 * side-effect modules will not re-register their tools on subsequent
 * initializeTools() calls.
 */
export function __resetRegistryForTesting(): void {
  tools.clear();
  skillRefCount.clear();
  pluginRefCount.clear();
  // Drop any pending core-tool overrides so they don't leak into the next
  // test. The snapshot restore below puts the original core tools back, so
  // the override stash would be stale anyway.
  coreToolOverrides.clear();

  if (coreToolsSnapshot) {
    for (const [name, tool] of coreToolsSnapshot) {
      tools.set(name, tool);
    }
  }
}

/**
 * Completely empty the registry (no snapshot restore). Exposed
 * exclusively for tests that need to verify a registration function
 * actually adds tools to an empty registry (i.e. non-vacuous assertions).
 */
export function __clearRegistryForTesting(): void {
  tools.clear();
  skillRefCount.clear();
  pluginRefCount.clear();
  coreToolOverrides.clear();
}

/**
 * Drop every registered external-tool provider. Exposed exclusively for
 * tests that want to verify a single `registerExternalTools()` call in
 * isolation — the provider array otherwise accumulates across cases
 * because ESM import caching prevents re-running the tool-manifest
 * bootstrap.
 */
export function __clearExternalToolProvidersForTesting(): void {
  externalToolProviders.length = 0;
}
