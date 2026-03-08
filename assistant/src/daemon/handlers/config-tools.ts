import * as net from "node:net";
import { join } from "node:path";

import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
} from "../../permissions/checker.js";
import { loadSkillCatalog } from "../../skills/catalog.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import {
  type ManifestOverride,
  resolveExecutionTarget,
} from "../../tools/execution-target.js";
import { getAllTools, getTool } from "../../tools/registry.js";
import { isSideEffectTool } from "../../tools/side-effects.js";
import type { ToolPermissionSimulateRequest } from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

export function handleEnvVarsRequest(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) vars[key] = value;
  }
  ctx.send(socket, { type: "env_vars_response", vars });
}

/**
 * Look up manifest metadata for a tool that isn't in the live registry.
 * Searches all installed skills' TOOLS.json manifests for a matching tool name.
 */
function resolveManifestOverride(
  toolName: string,
): ManifestOverride | undefined {
  if (getTool(toolName)) return undefined;
  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      if (!skill.toolManifest?.present || !skill.toolManifest.valid) continue;
      try {
        const manifest = parseToolManifestFile(
          join(skill.directoryPath, "TOOLS.json"),
        );
        const entry = manifest.tools.find((t) => t.name === toolName);
        if (entry) {
          return { risk: entry.risk, execution_target: entry.execution_target };
        }
      } catch {
        // Skip unparseable manifests
      }
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

export async function handleToolPermissionSimulate(
  msg: ToolPermissionSimulateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (!msg.toolName || typeof msg.toolName !== "string") {
      ctx.send(socket, {
        type: "tool_permission_simulate_response",
        success: false,
        error: "toolName is required",
      });
      return;
    }
    if (!msg.input || typeof msg.input !== "object") {
      ctx.send(socket, {
        type: "tool_permission_simulate_response",
        success: false,
        error: "input is required and must be an object",
      });
      return;
    }

    const workingDir = msg.workingDir ?? process.cwd();

    // For unregistered skill tools, resolve manifest metadata so the simulation
    // uses accurate risk/execution_target values instead of falling back to defaults.
    const manifestOverride = resolveManifestOverride(msg.toolName);

    const executionTarget = resolveExecutionTarget(
      msg.toolName,
      manifestOverride,
    );
    const policyContext = { executionTarget };

    const riskLevel = await classifyRisk(
      msg.toolName,
      msg.input,
      workingDir,
      undefined,
      manifestOverride,
    );
    const result = await check(
      msg.toolName,
      msg.input,
      workingDir,
      policyContext,
      manifestOverride,
    );

    // Private-thread override: promote allow → prompt for side-effect tools
    if (
      msg.forcePromptSideEffects &&
      result.decision === "allow" &&
      isSideEffectTool(msg.toolName, msg.input)
    ) {
      result.decision = "prompt";
      result.reason =
        "Private thread: side-effect tools require explicit approval";
    }

    // Non-interactive override: convert prompt → deny
    if (msg.isInteractive === false && result.decision === "prompt") {
      result.decision = "deny";
      result.reason = "Non-interactive session: no client to approve prompt";
    }

    // When decision is prompt, generate the full payload the UI needs
    let promptPayload:
      | {
          allowlistOptions: Array<{
            label: string;
            description: string;
            pattern: string;
          }>;
          scopeOptions: Array<{ label: string; scope: string }>;
          persistentDecisionsAllowed: boolean;
        }
      | undefined;

    if (result.decision === "prompt") {
      const allowlistOptions = await generateAllowlistOptions(
        msg.toolName,
        msg.input,
      );
      const scopeOptions = generateScopeOptions(workingDir, msg.toolName);
      promptPayload = {
        allowlistOptions,
        scopeOptions,
        persistentDecisionsAllowed: true,
      };
    }

    ctx.send(socket, {
      type: "tool_permission_simulate_response",
      success: true,
      decision: result.decision,
      riskLevel,
      reason: result.reason,
      executionTarget,
      matchedRuleId: result.matchedRule?.id,
      promptPayload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to simulate tool permission");
    ctx.send(socket, {
      type: "tool_permission_simulate_response",
      success: false,
      error: message,
    });
  }
}

export function handleToolNamesList(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const tools = getAllTools();
  const nameSet = new Set(tools.map((t) => t.name));
  const schemas: Record<string, import("../ipc-protocol.js").ToolInputSchema> =
    {};
  for (const tool of tools) {
    try {
      const def = tool.getDefinition();
      schemas[tool.name] =
        def.input_schema as import("../ipc-protocol.js").ToolInputSchema;
    } catch {
      // Skip tools whose definitions can't be resolved
    }
  }

  // Include tools from all installed skills, even those not currently
  // activated in any session.
  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      if (!skill.toolManifest?.present || !skill.toolManifest.valid) continue;
      try {
        const manifest = parseToolManifestFile(
          join(skill.directoryPath, "TOOLS.json"),
        );
        for (const entry of manifest.tools) {
          if (nameSet.has(entry.name)) continue;
          nameSet.add(entry.name);
          schemas[entry.name] =
            entry.input_schema as unknown as import("../ipc-protocol.js").ToolInputSchema;
        }
      } catch {
        // Skip skills whose manifests can't be parsed
      }
    }
  } catch {
    // Non-fatal — fall back to registered tools only
  }

  const names = Array.from(nameSet).sort((a, b) => a.localeCompare(b));
  ctx.send(socket, { type: "tool_names_list_response", names, schemas });
}

export const toolHandlers = defineHandlers({
  env_vars_request: (_msg, socket, ctx) => handleEnvVarsRequest(socket, ctx),
  tool_permission_simulate: handleToolPermissionSimulate,
  tool_names_list: (_msg, socket, ctx) => handleToolNamesList(socket, ctx),
});
