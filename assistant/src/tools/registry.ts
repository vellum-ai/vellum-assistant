import type { ToolDefinition } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { coreAppProxyTools } from "./apps/definitions.js";
import { registerAppTools } from "./apps/registry.js";
import { allComputerUseTools } from "./computer-use/definitions.js";
import { hostFileEditTool } from "./host-filesystem/edit.js";
import { hostFileReadTool } from "./host-filesystem/read.js";
import { hostFileWriteTool } from "./host-filesystem/write.js";
import { hostShellTool } from "./host-terminal/host-shell.js";
import type { Tool } from "./types.js";
import { allUiSurfaceTools } from "./ui-surface/definitions.js";
import { registerUiSurfaceTools } from "./ui-surface/registry.js";

const log = getLogger("tool-registry");

const tools = new Map<string, Tool>();

// Snapshot of core tools captured after initializeTools() completes.
// Used by __resetRegistryForTesting() to restore eager tools that cannot
// be re-registered because ESM import caching prevents side effects
// from running a second time.
let coreToolsSnapshot: Map<string, Tool> | null = null;

// Tracks how many sessions are currently using each skill's tools.
// Tools are only removed from the global registry when this drops to 0.
const skillRefCount = new Map<string, number>();

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
      // Existing is also a skill tool — only allow replacement from the same owner.
      if (existing.ownerSkillId !== tool.ownerSkillId) {
        throw new Error(
          `Skill tool "${tool.name}" is already registered by skill "${existing.ownerSkillId}"`,
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

  // Last reference — actually remove the tools
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
 * Unregister all tools belonging to a specific MCP server.
 */
export function unregisterMcpTools(serverId: string): void {
  for (const [name, tool] of tools) {
    if (tool.origin === "mcp" && tool.ownerMcpServerId === serverId) {
      tools.delete(name);
      log.info({ name, serverId }, "MCP tool unregistered");
    }
  }
}

/**
 * Return the names of all currently registered MCP-origin tools.
 */
export function getMcpToolNames(): string[] {
  return Array.from(tools.values())
    .filter((t) => t.origin === "mcp")
    .map((t) => t.name);
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
  // Exclude proxy tools (e.g. computer_use_* tools) — they are projected
  // into sessions by the skill system, not via the global tool list.
  // Exclude skill-origin tools — they are managed by the session-level
  // skill projection system (projectSkillTools) and must not leak into
  // the base tool list, which is shared across sessions via the global
  // registry.  Including them here causes "Tool names must be unique"
  // errors when the projection appends the same tools a second time.
  return getAllTools()
    .filter((t) => t.executionMode !== "proxy" && t.origin !== "skill")
    .map((t) => t.getDefinition());
}

export async function initializeTools(): Promise<void> {
  const { loadEagerModules, eagerModuleToolNames, explicitTools } =
    await import("./tool-manifest.js");

  // Capture tool names already in the registry before any manifest
  // registrations.  In production this is empty; in tests a non-skill tool
  // may have been registered before the first initializeTools() call.
  const preExisting = new Set(tools.keys());

  // Import tool modules to trigger registration side effects.
  await loadEagerModules();

  // Explicit tool instances — no side-effect import required.
  for (const tool of explicitTools) {
    registerTool(tool);
  }

  // Host tools are registered explicitly so host access stays opt-in until
  // this point in startup, rather than as module side effects.
  const hostTools = [
    hostFileReadTool,
    hostFileWriteTool,
    hostFileEditTool,
    hostShellTool,
  ];
  for (const tool of hostTools) {
    registerTool(tool);
  }

  registerUiSurfaceTools();
  registerAppTools();

  // Snapshot core tools for __resetRegistryForTesting().  We include every
  // non-skill tool that was registered by the manifest, while excluding
  // arbitrary test tools that were registered before init.
  //
  // A pre-existing tool is included only if it is a known manifest tool
  // (declared in eagerModuleToolNames, explicitTools, or hostTools).
  // This handles ESM cache hits where eager-module tools are already in
  // the registry before init ran.
  if (!coreToolsSnapshot) {
    const manifestToolNames = new Set<string>([
      ...eagerModuleToolNames,
      ...explicitTools.map((t: Tool) => t.name),
      ...hostTools.map((t: Tool) => t.name),
      ...allComputerUseTools.map((t: Tool) => t.name),
      ...allUiSurfaceTools.map((t: Tool) => t.name),
      ...coreAppProxyTools.map((t: Tool) => t.name),
    ]);

    coreToolsSnapshot = new Map<string, Tool>();
    for (const [name, tool] of tools) {
      if (tool.origin === "skill") continue;
      // Exclude pre-existing tools not declared in the manifest
      if (preExisting.has(name) && !manifestToolNames.has(name)) continue;
      coreToolsSnapshot.set(name, tool);
    }
  }

  log.info({ count: tools.size }, "Tools initialized");
}

/**
 * Reset registry to its post-initializeTools() baseline. Exposed
 * exclusively for test isolation — prevents cross-file contamination
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
}
