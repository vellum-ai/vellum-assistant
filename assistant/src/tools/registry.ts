import { isPluginDisabled } from "../plugins/disabled-state.js";
import { getLogger } from "../util/logger.js";
import { coreAppProxyTools } from "./apps/definitions.js";
import { registerAppTools } from "./apps/registry.js";
import { hostFileEditTool } from "./host-filesystem/edit.js";
import { hostFileReadTool } from "./host-filesystem/read.js";
import { hostFileTransferTool } from "./host-filesystem/transfer.js";
import { hostFileWriteTool } from "./host-filesystem/write.js";
import { hostShellTool } from "./host-terminal/host-shell.js";
import { toProviderSafeToolName } from "./provider-tool-name.js";
import { registerSystemTools } from "./system/register.js";
import { finalizeTool } from "./tool-defaults.js";
import type { OwnerInfo, Tool, ToolDefinition } from "./types.js";
import { allUiSurfaceTools } from "./ui-surface/definitions.js";
import { registerUiSurfaceTools } from "./ui-surface/registry.js";

const log = getLogger("tool-registry");

const tools = new Map<string, Tool>();

// Authoritative map of tool ownership, keyed by tool name. Populated by the
// `register*` functions and read by `getToolOwner()`. Lives on the registry
// (not on the `Tool` object) so callers cannot spoof ownership by writing a
// field on the manifest — the only way to claim a tool is to go through a
// `register*` function, which stamps the owner from its arguments. Built-in
// tools are stamped with the shared {@link DEFAULT_TOOL_OWNER} by
// `registerTool`, so every registered tool has an entry and `getToolOwner` is a
// plain lookup — a missing entry means the name is not registered at all.
const ownersByName = new Map<string, OwnerInfo>();

// Owner recorded for built-in tools — those registered via `registerTool`
// without an explicit extension owner. One frozen instance is shared across all
// built-ins; `id` is a constant sentinel because built-ins are not a distinct
// installable extension.
const DEFAULT_TOOL_OWNER: OwnerInfo = Object.freeze({
  kind: "default",
  id: "default",
});

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
const externalToolProviders: Array<{
  owner: OwnerInfo;
  provider: () => Tool[];
}> = [];

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
 *
 * `owner` records which extension produced these tools — typed
 * {@link OwnerInfo} so ownership flows through `ownersByName` at
 * `initializeTools()` time, the same way `register*` registers it for
 * IPC-loaded tools. Eager (boot-time) skill bootstraps go through this
 * path rather than `registerSkillTools`, so this is where their owner
 * lookup gets established.
 */
export function registerExternalTools(
  owner: OwnerInfo,
  toolsOrProvider: Tool[] | (() => Tool[]),
): void {
  const provider =
    typeof toolsOrProvider === "function"
      ? toolsOrProvider
      : () => toolsOrProvider;
  externalToolProviders.push({ owner, provider });
}

/** Return all externally registered tools paired with their owners. */
function getExternalTools(): Array<{ owner: OwnerInfo; tool: Tool }> {
  return externalToolProviders.flatMap(({ owner, provider }) =>
    provider().map((tool) => ({ owner, tool })),
  );
}

// Snapshot of core tools (with their owners) captured after initializeTools()
// completes. Lets __resetRegistryForTesting() restore the core baseline — tools
// and ownership together — synchronously, without re-running the async
// initializeTools() bootstrap.
let coreToolsSnapshot: Map<string, { tool: Tool; owner: OwnerInfo }> | null =
  null;

// Cached promise for the one-time tool-registry initialization. `initializeTools`
// returns this so repeated calls (across entry points, or an eventual
// getter-triggered ensure) run the underlying work exactly once. Cleared by the
// test-reset helpers so each test can re-initialize from a clean baseline.
let toolsInitPromise: Promise<void> | null = null;

// Tracks how many sessions are currently using each skill's tools.
// Tools are only removed from the global registry when this drops to 0.
const skillRefCount = new Map<string, number>();

// Plugin-tool refcount lives in its own namespace so plugin and skill IDs
// cannot collide in the ref map even if a plugin's `manifest.name` happens to
// match a skill id. Conflict detection on `tools` (keyed by tool name) is
// separate and covers the case of two extensions choosing the same tool name.
const pluginRefCount = new Map<string, number>();

/**
 * Format an owner for log messages and error strings. Returns a stable
 * human-readable description (e.g. `skill "deploy"`, `plugin "weather"`,
 * `MCP server "github"`, `workspace tool override`). When an owner is
 * missing (core tool) or has an unrecognized kind, returns a fallback
 * string so log/error sites never produce `undefined` interpolations.
 */
function describeOwner(owner: OwnerInfo | undefined): string {
  if (!owner) {
    return "core tool";
  }
  switch (owner.kind) {
    case "skill":
      return `skill "${owner.id}"`;
    case "plugin":
      return `plugin "${owner.id}"`;
    case "mcp":
      return `MCP server "${owner.id}"`;
    case "workspace":
      return `workspace tool override`;
    default:
      return `${(owner as OwnerInfo).kind}-origin tool`;
  }
}

// ── Workspace tool overrides ─────────────────────────────────────────
// Two distinct workspace-tool operations both move a core tool entry
// into this stash:
//
// 1. {@link registerWorkspaceTools} — workspace tool with same name as a
//    core tool registers; the original is stashed and the workspace tool
//    takes its place in `tools`. {@link unregisterWorkspaceTool} restores
//    on teardown.
// 2. {@link removeCoreToolViaWorkspace} — a `<name>.removed` sentinel in
//    `<workspaceDir>/tools/` strips a core tool from the registry. The
//    original is stashed; `tools[name]` is cleared without a replacement.
//    {@link restoreStrippedCoreTool} restores when the sentinel is gone.
//
// Both operations are reversible because the stash holds the original
// core entry verbatim. The two states are distinguished by what (if
// anything) sits in `tools[name]` and `ownersByName[name]`:
//
// - `ownersByName[name].kind === "workspace"` + stash present → override
// - `tools[name]` absent + stash present → stripped via `.removed`
// - `tools[name]` present + no owner → normal core tool
// - `ownersByName[name].kind === "workspace"` + no stash → net-new workspace tool
//
// Keyed by tool name. At most one stashed entry per name — the registry
// rejects a second workspace registration for the same name without an
// explicit unregister/restore.
//
// Plugin/skill/MCP code paths consult this map only indirectly: they see
// a workspace-kind entry in `ownersByName` (or a stash entry but no live
// entry) and refuse to register over it, preserving the
// single-canonical-source invariant the override / strip paths exist to
// enforce.
const coreToolOverrides = new Map<string, Tool>();

function withProviderSafeToolName(tool: Tool): Tool {
  const safeName = toProviderSafeToolName(tool.name);
  if (safeName === tool.name) {
    return tool;
  }

  return {
    ...tool,
    name: safeName,
  };
}

/**
 * Memoize `finalizeTool(definition, name)` by the definition reference so
 * idempotent re-registration (e.g. repeated initializeTools() calls across
 * test files) stays a silent no-op — the same `ToolDefinition` always
 * finalizes to the same `Tool` instance, and the existing `existing === tool`
 * short-circuit below keeps working.
 */
const finalizedByDefinition = new WeakMap<ToolDefinition, Tool>();

export function registerTool(definition: ToolDefinition): void {
  const name = definition.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      "registerTool: tool.name is required — set it on the literal or finalize through `finalizeTool(def, name)` first",
    );
  }
  let tool = finalizedByDefinition.get(definition);
  if (!tool) {
    tool = finalizeTool(definition, name);
    finalizedByDefinition.set(definition, tool);
  }
  const existing = tools.get(name);
  if (existing) {
    if (existing === tool) {
      return;
    } // same definition re-registered, skip
    log.warn({ name }, "Tool already registered, overwriting");
  }
  tools.set(name, tool);
  // A tool registered through this bare path has no explicit extension owner,
  // so it is a built-in: record the shared `default` owner by name. Callers
  // that own the tool (external skill bootstraps) overwrite this entry with
  // their own owner immediately after calling `registerTool`.
  ownersByName.set(name, DEFAULT_TOOL_OWNER);
  log.info({ name, category: tool.category }, "Tool registered");
}

/**
 * Resolve a registered tool by name, ensuring the registry has been
 * initialized first. Mirrors `getHooksFor`, which awaits its reconcile before
 * reading — so a caller on a cold registry gets a populated result instead of
 * a spurious `undefined`. Prefer this in any async context.
 */
export async function getTool(name: string): Promise<Tool | undefined> {
  await initializeTools();
  return tools.get(name);
}

/**
 * Synchronous read that does NOT trigger initialization. For hot-path callers
 * that run only after the registry is known to be populated — e.g. the agent
 * loop's exclusive-tool predicate, invoked mid-turn once tools are resolved.
 * Returns `undefined` if the tool is absent or the registry is not yet
 * initialized; use {@link getTool} when readiness is not already guaranteed.
 */
export function peekTool(name: string): Tool | undefined {
  return tools.get(name);
}

/**
 * True once {@link initializeTools} has populated the core registry (the core
 * snapshot is captured at the end of init). Callers that must not run before the
 * read-only baseline (`file_read`/`web_fetch`/etc.) exists — e.g. the scheduler
 * deferring boot-time workflow triggers — gate on this. It only ever flips
 * false→true, so a true reading is stable for the process lifetime.
 */
export function areCoreToolsInitialized(): boolean {
  return coreToolsSnapshot !== null;
}

export function getAllTools(): Tool[] {
  return Array.from(tools.values());
}

/**
 * Return every registered tool except those contributed by a currently
 * disabled plugin. The `.disabled` sentinel is checked at read time so
 * `assistant plugins disable <name>` drops the plugin's tools from the
 * listing on the next call without a daemon restart — mirroring the
 * filtering in {@link getPluginToolDefinitions} and `getHooksFor`.
 *
 * Plugin tools stay in the underlying `tools` map while disabled (they are
 * only torn out when the plugin's refcount drops to zero), so callers that
 * report the *available* tool surface — e.g. the `tools_get` route behind
 * `assistant tools list` — must filter here rather than read `getAllTools()`
 * directly, which would keep showing a disabled plugin's tools.
 */
export function getEnabledTools(): Tool[] {
  return getAllTools().filter((t) => {
    const owner = ownersByName.get(t.name);
    return !(owner?.kind === "plugin" && isPluginDisabled(owner.id));
  });
}

/**
 * Return the owner recorded for a tool. Extension tools return their
 * {@link OwnerInfo} (skill / plugin / MCP / workspace); built-ins return the
 * shared {@link DEFAULT_TOOL_OWNER} (`kind: "default"`) that `registerTool`
 * stamps by name. Returns `undefined` only when `name` is not registered at all
 * — an unknown tool, which callers treat as "not a real tool" (skip / deny),
 * never as a built-in.
 *
 * Because a tool cannot be invoked unless it was registered first, an invocable
 * tool always has a defined owner in practice.
 *
 * Consumers that gate behavior on which extension contributed a tool
 * (permissions checker, approval-handler load hints, conversation-skill-tools
 * projection) call this rather than reading owner off the `Tool` object — the
 * registry is the single source of truth for ownership.
 */
export function getToolOwner(name: string): OwnerInfo | undefined {
  return ownersByName.get(name);
}

/**
 * Register multiple skill-origin tools owned by `skillId`.
 *
 * Skips any tool whose name collides with a core tool (logs a warning instead
 * of throwing so the remaining tools in the batch still get registered).
 * Also skips when the name is owned by a workspace tool — workspace
 * overrides are authoritative and silently win over skill registration.
 * Throws if a tool name collides with a skill tool owned by a different skill.
 * Allows replacement when the incoming tool has the same skill owner id as
 * the existing one, which supports hot-reloading a skill without tearing
 * down first.
 *
 * Ownership is recorded in {@link ownersByName} keyed by tool name; the
 * `Tool` object itself carries no owner metadata, so callers cannot spoof
 * ownership by writing fields on the manifest.
 */
export function registerSkillTools(skillId: string, newTools: Tool[]): Tool[] {
  // Filter out tools that collide with core tools, and validate the rest.
  const accepted: Tool[] = [];
  for (const tool of newTools) {
    // A workspace `.removed` sentinel stripped a core tool of this name —
    // the slot is reserved by the stash even though `tools` has no live
    // entry. Refuse to fill the slot from a non-workspace surface.
    if (!tools.has(tool.name) && coreToolOverrides.has(tool.name)) {
      log.warn(
        { toolName: tool.name, skillId },
        `Skill "${skillId}" tried to register tool "${tool.name}" which is reserved by a workspace .removed sentinel. Skipping.`,
      );
      continue;
    }
    const existing = tools.get(tool.name);
    if (existing) {
      const existingOwner = ownersByName.get(tool.name);
      const existingIsCore = !existingOwner || existingOwner.kind === "default";
      if (existingIsCore) {
        log.warn(
          { toolName: tool.name, ownerSkillId: skillId },
          `Skill "${skillId}" tried to register tool "${tool.name}" which conflicts with a core tool. Skipping.`,
        );
        continue;
      }
      if (existingOwner?.kind === "workspace") {
        log.warn(
          { toolName: tool.name, skillId },
          `Skill "${skillId}" tried to register tool "${tool.name}" which is owned by a workspace tool override. Skipping.`,
        );
        continue;
      }
      // Existing is from a different owner (plugin/mcp) or a different
      // skill — skill tools can only replace themselves (hot-reload).
      const existingSkillId =
        existingOwner?.kind === "skill" ? existingOwner.id : undefined;
      if (existingOwner?.kind !== "skill" || existingSkillId !== skillId) {
        throw new Error(
          `Skill tool "${tool.name}" is already registered by ${describeOwner(existingOwner)}`,
        );
      }
    }
    accepted.push(tool);
  }

  for (const tool of accepted) {
    tools.set(tool.name, tool);
    ownersByName.set(tool.name, { kind: "skill", id: skillId });
    log.info(
      { name: tool.name, ownerSkillId: skillId },
      "Skill tool registered",
    );
  }

  if (accepted.length > 0) {
    skillRefCount.set(skillId, (skillRefCount.get(skillId) ?? 0) + 1);
  }

  return accepted;
}

/**
 * Register tools contributed by the plugin named `pluginName`. Records the
 * plugin owner in {@link ownersByName} keyed by tool name — ownership lives
 * on the registry, never on the `Tool` object itself, so the bootstrap
 * cannot be spoofed into claiming tools on behalf of an unrelated extension
 * by forging fields on the manifest. Plugin ownership is tracked in a
 * namespace disjoint from skill tools: if a plugin's `manifest.name`
 * happens to match a skill id, the two do not share refcount state or
 * conflict-detection paths.
 *
 * Conflict handling mirrors {@link registerSkillTools}: collisions with core
 * tools log a warning and skip; collisions with tools owned by a different
 * plugin, skill, or MCP server throw; re-registering the same plugin's own
 * tool (hot reload) is allowed.
 */
export function registerPluginTools(
  pluginName: string,
  newTools: Tool[],
): Tool[] {
  const stamped: Tool[] = newTools.map((pluginTool) => {
    const tool: Tool = {
      ...pluginTool,
      category: "plugin",
    };
    return withProviderSafeToolName(tool);
  });

  const accepted: Tool[] = [];
  for (const tool of stamped) {
    // A workspace `.removed` sentinel stripped a core tool of this name —
    // the slot is reserved by the stash even though `tools` has no live
    // entry. Refuse to fill the slot from a non-workspace surface.
    if (!tools.has(tool.name) && coreToolOverrides.has(tool.name)) {
      log.warn(
        { toolName: tool.name, pluginName },
        `Plugin "${pluginName}" tried to register tool "${tool.name}" which is reserved by a workspace .removed sentinel. Skipping.`,
      );
      continue;
    }
    const existing = tools.get(tool.name);
    if (existing) {
      const existingOwner = ownersByName.get(tool.name);
      const existingIsCore = !existingOwner || existingOwner.kind === "default";
      if (existingIsCore) {
        log.warn(
          { toolName: tool.name, ownerPluginId: pluginName },
          `Plugin "${pluginName}" tried to register tool "${tool.name}" which conflicts with a core tool. Skipping.`,
        );
        continue;
      }
      if (existingOwner?.kind === "workspace") {
        log.warn(
          { toolName: tool.name, pluginName },
          `Plugin "${pluginName}" tried to register tool "${tool.name}" which is owned by a workspace tool override. Skipping.`,
        );
        continue;
      }
      if (existingOwner?.kind === "plugin") {
        if (existingOwner.id !== pluginName) {
          throw new Error(
            `Plugin tool "${tool.name}" is already registered by plugin "${existingOwner.id}"`,
          );
        }
        // Same plugin re-registering its own tool (hot reload) — allow.
      } else {
        // Conflict with a skill or MCP-owned tool.
        throw new Error(
          `Plugin "${pluginName}" tried to register tool "${tool.name}" which conflicts with ${describeOwner(existingOwner)}`,
        );
      }
    }
    accepted.push(tool);
  }

  for (const tool of accepted) {
    tools.set(tool.name, tool);
    ownersByName.set(tool.name, { kind: "plugin", id: pluginName });
    log.info(
      { name: tool.name, ownerPluginId: pluginName },
      "Plugin tool registered",
    );
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
  for (const [name, owner] of ownersByName) {
    if (owner.kind === "plugin" && owner.id === pluginName) {
      tools.delete(name);
      ownersByName.delete(name);
      log.info({ name, ownerPluginId: pluginName }, "Plugin tool unregistered");
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
  for (const [name, owner] of ownersByName) {
    if (owner.kind === "skill" && owner.id === skillId) {
      tools.delete(name);
      ownersByName.delete(name);
      log.info({ name, ownerSkillId: skillId }, "Skill tool unregistered");
    }
  }
}

/**
 * Register multiple MCP-origin tools owned by the MCP server `serverId`.
 *
 * Skips any tool whose name collides with a core tool (logs a warning).
 * Throws if a tool name collides with a tool owned by a different MCP server.
 *
 * Ownership is recorded in {@link ownersByName} keyed by tool name; the
 * `Tool` object itself carries no owner metadata.
 */
export function registerMcpTools(serverId: string, newTools: Tool[]): Tool[] {
  const accepted: Tool[] = [];
  for (const tool of newTools) {
    // A workspace `.removed` sentinel stripped a core tool of this name —
    // the slot is reserved by the stash even though `tools` has no live
    // entry. Refuse to fill the slot from a non-workspace surface.
    if (!tools.has(tool.name) && coreToolOverrides.has(tool.name)) {
      log.warn(
        { toolName: tool.name, serverId },
        `MCP server "${serverId}" tried to register tool "${tool.name}" which is reserved by a workspace .removed sentinel. Skipping.`,
      );
      continue;
    }
    const existing = tools.get(tool.name);
    if (existing) {
      const existingOwner = ownersByName.get(tool.name);
      const existingIsCore = !existingOwner || existingOwner.kind === "default";
      if (existingIsCore) {
        log.warn(
          { toolName: tool.name, ownerMcpServerId: serverId },
          `MCP server "${serverId}" tried to register tool "${tool.name}" which conflicts with a core tool. Skipping.`,
        );
        continue;
      }
      if (existingOwner?.kind === "workspace") {
        log.warn(
          { toolName: tool.name, serverId },
          `MCP server "${serverId}" tried to register tool "${tool.name}" which is owned by a workspace tool override. Skipping.`,
        );
        continue;
      }
      if (existingOwner?.kind === "skill" || existingOwner?.kind === "plugin") {
        log.warn(
          {
            toolName: tool.name,
            ownerMcpServerId: serverId,
            existingOwner,
          },
          `MCP server "${serverId}" tried to register tool "${tool.name}" which conflicts with ${describeOwner(existingOwner)}. Skipping.`,
        );
        continue;
      }
      if (existingOwner?.kind === "mcp" && existingOwner.id !== serverId) {
        throw new Error(
          `MCP tool "${tool.name}" is already registered by MCP server "${existingOwner.id}"`,
        );
      }
    }
    accepted.push(tool);
  }

  for (const tool of accepted) {
    tools.set(tool.name, tool);
    ownersByName.set(tool.name, { kind: "mcp", id: serverId });
    log.info(
      { name: tool.name, ownerMcpServerId: serverId },
      "MCP tool registered",
    );
  }

  return accepted;
}

/**
 * Unregister all MCP-origin tools from the registry.
 */
export function unregisterAllMcpTools(): void {
  for (const [name, owner] of ownersByName) {
    if (owner.kind === "mcp") {
      tools.delete(name);
      ownersByName.delete(name);
      log.info({ name }, "MCP tool unregistered (reload)");
    }
  }
}

/**
 * Return tool definitions for all currently registered MCP-origin tools.
 * Used by the session resolver to dynamically pick up MCP tools that
 * were registered after session creation (e.g. via `vellum mcp reload`).
 */
export function getMcpToolDefinitions(): Tool[] {
  return Array.from(tools.values()).filter(
    (t) => ownersByName.get(t.name)?.kind === "mcp",
  );
}

/**
 * Return tool definitions for all currently registered plugin-origin tools.
 * Used by the session resolver to dynamically pick up plugin tools that were
 * registered after session creation — e.g. a plugin installed at runtime and
 * activated on a subsequent turn (see `plugins/mtime-cache.ts`). Mirrors
 * {@link getMcpToolDefinitions} so a plugin install behaves like `mcp reload`.
 */
export function getPluginToolDefinitions(): Tool[] {
  return Array.from(tools.values()).filter((t) => {
    const owner = ownersByName.get(t.name);
    if (owner?.kind !== "plugin") {
      return false;
    }
    // Filter out tools contributed by disabled plugins at read time so
    // `assistant plugins disable <name>` takes effect on the next turn
    // without a daemon restart. Mirrors the `.disabled` sentinel filtering
    // in `getHooksFor` (plugins/registry.ts).
    return !isPluginDisabled(owner.id);
  });
}

/**
 * Return MCP tools grouped by their owning server ID. Each entry contains
 * the server ID and the tool definitions registered by that server.
 */
export function getMcpToolsByServer(): Map<string, Tool[]> {
  const byServer = new Map<string, Tool[]>();
  for (const [name, owner] of ownersByName) {
    if (owner.kind !== "mcp") {
      continue;
    }
    const tool = tools.get(name);
    if (!tool) {
      continue;
    }
    let list = byServer.get(owner.id);
    if (!list) {
      list = [];
      byServer.set(owner.id, list);
    }
    list.push(tool);
  }
  return byServer;
}

/**
 * Return the names of all currently registered skill-origin tools.
 */
export function getSkillToolNames(): string[] {
  return Array.from(tools.values())
    .filter((t) => ownersByName.get(t.name)?.kind === "skill")
    .map((t) => t.name);
}

/**
 * Register a batch of workspace-origin tools — entries discovered under
 * `<workspaceDir>/tools/<name>.{ts,js,json}`. Each call records ownership
 * (`kind: "workspace"`, `id: <workspacePath>`) in `ownersByName` keyed by
 * tool name — the `Tool` object itself carries no owner metadata.
 *
 * Conflict handling:
 *
 * - **Core tool same name**: the original core entry is moved into
 *   {@link coreToolOverrides}, and the workspace tool takes its place in
 *   `tools`. {@link unregisterWorkspaceTool} restores the original later.
 * - **Workspace tool same name**: rejected with a hard throw. There is
 *   exactly one canonical source per workspace tool name on disk; a
 *   second registration without an intervening
 *   {@link unregisterWorkspaceTool} is a caller bug.
 * - **Plugin / skill / MCP same name**: rejected with a hard throw.
 *   Workspace tools must register before any other extension category in
 *   the daemon lifecycle (between {@link initializeTools} and
 *   {@link loadUserPlugins}); seeing one of these origins here would mean
 *   a lifecycle-order regression.
 * - **Net-new name (no existing entry)**: registers as a new tool. The
 *   stash stays empty for this name so {@link unregisterWorkspaceTool}
 *   simply removes the tool with no restoration.
 *
 * The batch is validated end-to-end before any mutation lands on `tools`
 * or `coreToolOverrides` — a single rejected entry aborts the whole call
 * so callers never observe a partially-applied registration.
 */
export function registerWorkspaceTools(
  newTools: Array<{
    tool: Tool;
    workspacePath: string;
  }>,
): Tool[] {
  // Build provider-safe Tool objects up front. We do not mutate the
  // registry until the entire batch has cleared the conflict checks
  // below. Ownership (kind + workspace path) is tracked separately
  // alongside each stamped entry so the mutation phase can set
  // `ownersByName` in lockstep with `tools`.
  const stamped: Array<{ tool: Tool; workspacePath: string }> = newTools.map(
    ({ tool: workspaceTool, workspacePath }) => ({
      tool: withProviderSafeToolName(workspaceTool as Tool),
      workspacePath,
    }),
  );

  // Validate the whole batch first so we never leave the registry in a
  // half-applied state. The validation phase only reads; the mutation
  // phase below only fires once every entry has passed.
  const seenInBatch = new Set<string>();
  for (const { tool } of stamped) {
    if (seenInBatch.has(tool.name)) {
      throw new Error(
        `Workspace tool batch contains duplicate name "${tool.name}"`,
      );
    }
    seenInBatch.add(tool.name);

    const existing = tools.get(tool.name);
    if (!existing) {
      continue;
    }

    const existingOwner = ownersByName.get(tool.name);
    if (existingOwner?.kind === "workspace") {
      throw new Error(
        `Workspace tool "${tool.name}" is already registered (path: ${existingOwner.id}). Call unregisterWorkspaceTool("${tool.name}") before re-registering.`,
      );
    }

    // Built-in (default) tool — override allowed, handled in the mutation
    // phase below. `undefined` shouldn't occur (every registered tool has an
    // owner) but is treated the same as a built-in for safety.
    if (!existingOwner || existingOwner.kind === "default") {
      continue;
    }

    throw new Error(
      `Workspace tool "${tool.name}" conflicts with an existing ${describeOwner(existingOwner)}. Workspace tools must register before other extension categories.`,
    );
  }

  for (const { tool, workspacePath } of stamped) {
    const existing = tools.get(tool.name);
    const existingOwner = ownersByName.get(tool.name);
    const existingIsCore =
      existing && (!existingOwner || existingOwner.kind === "default");
    if (existingIsCore) {
      coreToolOverrides.set(tool.name, existing);
      log.info(
        { name: tool.name, workspacePath },
        "Stashing core tool ahead of workspace override",
      );
    }
    tools.set(tool.name, tool);
    ownersByName.set(tool.name, { kind: "workspace", id: workspacePath });
    log.info(
      {
        name: tool.name,
        workspacePath,
        overridesCore: coreToolOverrides.has(tool.name),
      },
      "Workspace tool registered",
    );
  }

  return stamped.map(({ tool }) => tool);
}

/**
 * Remove a workspace tool registration. If the name had a stashed core
 * tool ({@link coreToolOverrides}), the original is restored; otherwise
 * the entry is simply deleted (net-new workspace tool case).
 *
 * No-op when the named tool is not currently registered as a workspace
 * tool — the function is safe to call on every shutdown path without
 * needing to track which tools the loader actually registered.
 */
export function unregisterWorkspaceTool(name: string): void {
  const existingOwner = ownersByName.get(name);
  if (existingOwner?.kind !== "workspace") {
    return;
  }
  const workspacePath = existingOwner.id;

  const stashed = coreToolOverrides.get(name);
  if (stashed) {
    tools.set(name, stashed);
    // The stash only ever holds a displaced built-in, so restore its `default`
    // owner rather than deleting the entry.
    ownersByName.set(name, DEFAULT_TOOL_OWNER);
    coreToolOverrides.delete(name);
    log.info(
      { name, workspacePath },
      "Workspace tool unregistered — core tool restored",
    );
    return;
  }

  tools.delete(name);
  ownersByName.delete(name);
  log.info(
    { name, workspacePath },
    "Workspace tool unregistered (no core tool to restore)",
  );
}

/**
 * Strip a core tool from the registry on behalf of a workspace
 * `<name>.removed` sentinel. The original core entry is stashed (same
 * map as override-style stashing) so {@link restoreStrippedCoreTool} can
 * undo the strip if the sentinel file is later removed.
 *
 * No-op cases (logged at debug, never throws):
 * - `name` doesn't exist in the registry — nothing to strip
 * - `name` is already stripped (stash present, live entry absent) — idempotent
 * - `name` is owned by a non-core origin (plugin / skill / mcp) — workspace
 *   strip cannot evict another extension's tool; that's a namespacing
 *   collision the operator must resolve at the source
 *
 * Throws when `name` is owned by an existing workspace tool. The loader
 * is supposed to filter out files where both `<name>.<ext>` and
 * `<name>.removed` coexist before getting here; if we land in this state
 * something earlier failed and the caller needs to know.
 */
export function removeCoreToolViaWorkspace(name: string): void {
  const existing = tools.get(name);

  if (!existing) {
    if (coreToolOverrides.has(name)) {
      log.debug(
        { name },
        "removeCoreToolViaWorkspace: core tool already stripped — no-op",
      );
      return;
    }
    log.debug(
      { name },
      "removeCoreToolViaWorkspace: no tool registered under this name — no-op",
    );
    return;
  }

  const existingOwner = ownersByName.get(name);
  if (existingOwner?.kind === "workspace") {
    throw new Error(
      `Cannot strip "${name}" via .removed sentinel — name is owned by a workspace tool override (path: ${existingOwner.id}). Remove the workspace tool file first.`,
    );
  }

  if (existingOwner && existingOwner.kind !== "default") {
    log.warn(
      { name, owner: existingOwner },
      `removeCoreToolViaWorkspace: "${name}" is owned by ${describeOwner(existingOwner)}, not a core tool — cannot strip from workspace. Resolve at the source (uninstall the ${existingOwner.kind}).`,
    );
    return;
  }

  coreToolOverrides.set(name, existing);
  tools.delete(name);
  // The stripped built-in no longer has a live entry; drop its owner so
  // `getToolOwner` reports the name as unregistered until it is restored.
  ownersByName.delete(name);
  log.info(
    { name },
    "Stripped core tool via workspace .removed sentinel — stashed for potential restore",
  );
}

/**
 * Restore a core tool that was previously stripped via
 * {@link removeCoreToolViaWorkspace}. Called when the `<name>.removed`
 * sentinel file is deleted (typically by the workspace-tool file watcher).
 *
 * No-op cases (logged at debug, never throws):
 * - No stash exists for `name` — nothing to restore
 * - A workspace tool currently owns the name — the restore is implicit
 *   when the workspace tool is later unregistered; doing it here would
 *   evict the live workspace tool
 * - A core tool already sits at the name — already restored, idempotent
 */
export function restoreStrippedCoreTool(name: string): void {
  const stashed = coreToolOverrides.get(name);
  if (!stashed) {
    log.debug(
      { name },
      "restoreStrippedCoreTool: no stashed core tool — no-op",
    );
    return;
  }
  const existing = tools.get(name);
  if (existing) {
    const existingOwner = ownersByName.get(name);
    if (existingOwner?.kind === "workspace") {
      log.debug(
        { name },
        "restoreStrippedCoreTool: workspace tool currently owns this name — leaving stash in place for the workspace tool's eventual unregister",
      );
      return;
    }
    log.debug(
      { name, currentOwner: existingOwner ?? "core" },
      "restoreStrippedCoreTool: a non-workspace entry already sits at this name — leaving stash in place",
    );
    return;
  }
  tools.set(name, stashed);
  ownersByName.set(name, DEFAULT_TOOL_OWNER);
  coreToolOverrides.delete(name);
  log.info(
    { name },
    "Restored core tool after workspace .removed sentinel was deleted",
  );
}

/**
 * Return the names of all currently registered workspace-origin tools.
 */
export function getWorkspaceToolNames(): string[] {
  return Array.from(tools.values())
    .filter((t) => ownersByName.get(t.name)?.kind === "workspace")
    .map((t) => t.name);
}

/**
 * Return tool definitions for all currently registered workspace-origin
 * tools. Used by the conversation tool resolver to re-read workspace tools
 * from the registry each turn, the same way {@link getMcpToolDefinitions}
 * lets a conversation pick up MCP tools registered after it was created —
 * here so reconciled edits under `<workspaceDir>/tools/` are picked up
 * without recreating the conversation.
 */
export function getWorkspaceToolDefinitions(): Tool[] {
  return Array.from(tools.values()).filter(
    (t) => ownersByName.get(t.name)?.kind === "workspace",
  );
}

/**
 * Return the names of core tools currently stripped via workspace
 * `.removed` sentinels — i.e. names where the stash holds an entry but
 * no live tool sits in the registry.
 */
export function getStrippedCoreToolNames(): string[] {
  const stripped: string[] = [];
  for (const name of coreToolOverrides.keys()) {
    if (!tools.has(name)) {
      stripped.push(name);
    }
  }
  return stripped;
}

/**
 * Inspect the override stash for a tool name. Returns the original core
 * tool that was displaced by a workspace registration (or stripped via
 * `.removed`), or `undefined` when no such override exists.
 *
 * Useful for tooling that needs to show "this core tool is overridden by
 * a workspace entry" without exposing the full stash map.
 */
export function getCoreToolOverride(name: string): Tool | undefined {
  return coreToolOverrides.get(name);
}

/**
 * Return the current reference count for a skill's tools. Exposed for testing.
 */
export function getSkillRefCount(skillId: string): number {
  return skillRefCount.get(skillId) ?? 0;
}

export function getAllToolDefinitions(): Tool[] {
  // Exclude skill-origin tools - they are managed by the session-level
  // skill projection system (projectSkillTools) and must not leak into
  // the base tool list, which is shared across sessions via the global
  // registry.  Including them here causes "Tool names must be unique"
  // errors when the projection appends the same tools a second time.
  //
  // Build on `getEnabledTools()` so tools from a disabled plugin are also
  // excluded. This is the base snapshot the conversation tool resolver
  // captures at creation: a plugin disabled BEFORE a new conversation is
  // created would otherwise leak its tools here, and because the resolver's
  // core/plugin split reads the (filtered) `getPluginToolDefinitions()`, the
  // disabled plugin's tools would be misclassified as core and stay on the
  // wire to the LLM — executable even though `assistant tools list` reports
  // them gone. Filtering here keeps the executable surface and the listing
  // in lockstep.
  return getEnabledTools().filter(
    (t) => ownersByName.get(t.name)?.kind !== "skill",
  );
}

/**
 * Idempotent, cached tool-registry initialization: resolve the tool manifest,
 * register the built-in (default) tools, and load workspace overrides. The
 * first call runs the work; every later call returns the same settled promise
 * without repeating it, so it is safe to call from multiple entry points or
 * lazily on demand.
 *
 * This is the tool-registry analogue of the hook registry's
 * `maybeReconcileFromSentinel()` — the lazy "make sure the registry is
 * populated" step. As the registry read getters migrate to async (mirroring
 * `getHooksFor`), they will `await` this before reading the map, so a read can
 * no longer observe an un-initialized registry.
 */
export function initializeTools(): Promise<void> {
  if (!toolsInitPromise) {
    toolsInitPromise = runToolInitialization().catch((err) => {
      // Don't cache a failed init: clear the slot so a later call retries
      // rather than returning the same rejected promise forever.
      toolsInitPromise = null;
      throw err;
    });
  }
  return toolsInitPromise;
}

async function runToolInitialization(): Promise<void> {
  const { explicitTools } = await import("./tool-manifest.js");

  // Capture tool names already in the registry before any manifest
  // registrations.  In production this is empty; in tests a non-skill tool
  // may have been registered before the first initializeTools() call.
  const preExisting = new Set(tools.keys());

  for (const tool of explicitTools) {
    registerTool(tool);
  }

  // External skill tools — registered by skill bootstrap modules via
  // `registerExternalTools()`. Called at init time (not spread into
  // `explicitTools`) so registrations that happen between module-load
  // and `initializeTools()` are picked up. Each provider pairs its tools
  // with an OwnerInfo so the registry can record ownership in
  // {@link ownersByName} alongside the bare `registerTool()` install.
  const extEntries = getExternalTools();
  for (const { owner, tool } of extEntries) {
    registerTool(tool);
    ownersByName.set(tool.name, owner);
  }

  // Host tools are registered here so host access stays opt-in until this
  // point in startup.
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

  registerUiSurfaceTools();
  registerAppTools();
  registerSystemTools();

  // Snapshot core tools for __resetRegistryForTesting().  We include every
  // non-skill tool that was registered by the manifest, while excluding
  // arbitrary test tools that were registered before init.
  //
  // A pre-existing tool is included only if it is a known manifest tool
  // (declared in explicitTools, hostTools, or any registered external
  // skill tool) — e.g. a test registered a manifest tool directly before
  // its first initializeTools() call.
  if (!coreToolsSnapshot) {
    // Core tool literals always set `name` (verified by `registerTool` —
    // it throws on missing name). The `!` assertions reflect that
    // invariant at the iteration sites.
    const manifestToolNames = new Set<string>([
      ...explicitTools.map((t) => t.name!),
      ...extEntries.map(({ tool }) => tool.name),
      ...hostTools.map((t) => t.name!),
      ...allUiSurfaceTools.map((t) => t.name!),
      ...coreAppProxyTools.map((t) => t.name!),
    ]);

    coreToolsSnapshot = new Map<string, { tool: Tool; owner: OwnerInfo }>();
    for (const [name, tool] of tools) {
      const owner = ownersByName.get(name);
      if (owner?.kind === "skill" || owner?.kind === "plugin") {
        continue;
      }
      // Exclude pre-existing tools not declared in the manifest
      if (preExisting.has(name) && !manifestToolNames.has(name)) {
        continue;
      }
      // Every registered tool carries an owner (built-ins get DEFAULT_TOOL_OWNER
      // stamped by registerTool), so `owner` is defined here.
      coreToolsSnapshot.set(name, { tool, owner: owner! });
    }
  }

  log.info({ count: tools.size }, "Tools initialized");

  // Load workspace tool overrides from `<workspaceDir>/tools/<name>.{ts,js,json}`
  // immediately after core tools have settled, before MCP / plugin
  // registrations get a chance to claim names. This ordering makes
  // workspace tools the canonical owner per name:
  //   core registrations → workspace tools → MCP → plugins.
  // Workspace tools land after the core snapshot above so they're never
  // baked into the test-reset baseline.
  //
  // `loadWorkspaceTools` is idempotent: this is the first reconcile, and
  // conversation reads re-run it later to pick up on-disk edits without a
  // restart (see workspace-tools/loader.ts).
  //
  // Imported dynamically because the loader imports back from this module
  // (registerWorkspaceTools / removeCoreToolViaWorkspace); a static import
  // here would create a registry ↔ loader cycle.
  const { loadWorkspaceTools } = await import("./workspace-tools/loader.js");
  await loadWorkspaceTools();
}

/**
 * Reset registry to its post-initializeTools() baseline. Exposed
 * exclusively for test isolation - prevents cross-file contamination
 * when multiple test suites share a single Bun process.
 *
 * Restores core tools from a snapshot taken after the first
 * initializeTools() call, so the reset is synchronous and does not
 * depend on re-running the async init bootstrap.
 */
export function __resetRegistryForTesting(): void {
  tools.clear();
  ownersByName.clear();
  skillRefCount.clear();
  pluginRefCount.clear();
  // Drop the override stash too — the snapshot already represents the
  // pre-override baseline, so leaving stashed entries here would let a
  // later registerWorkspaceTools() falsely report "overridesCore: true"
  // against a fresh registry.
  coreToolOverrides.clear();
  // Clear the cached init promise so a later initializeTools() re-runs against
  // the freshly reset registry rather than returning the previous settled run.
  toolsInitPromise = null;

  if (coreToolsSnapshot) {
    for (const [name, { tool, owner }] of coreToolsSnapshot) {
      tools.set(name, tool);
      ownersByName.set(name, owner);
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
  ownersByName.clear();
  skillRefCount.clear();
  pluginRefCount.clear();
  coreToolOverrides.clear();
  toolsInitPromise = null;
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
