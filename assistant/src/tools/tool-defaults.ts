/**
 * Single source of truth for the defaults applied when a `ToolDefinition`
 * omits one of the normally-required fields, plus the `finalizeTool`
 * helper that lifts a `ToolDefinition` into a `Tool`.
 *
 * Plugins, external loaders, and any other registration boundary that
 * accepts loose `ToolDefinition` objects from authors must run them
 * through `finalizeTool` before handing the result to a `registerXxxTools`
 * call. The registry types make this a hard rule: every registered tool
 * is a `Tool` (`Required<ToolDefinition>`).
 */

import { resolveExecutionTarget } from "./execution-target.js";
import type { RiskLevel } from "./tool-types.js";
import type { Tool, ToolDefinition, ToolExecutionResult } from "./types.js";

/**
 * Default values applied by `finalizeTool` when the author omits a field.
 *
 * - `description` defaults to empty — the model sees the tool name only
 *   for un-documented tools, which is the correct minimal-info signal.
 * - `defaultRiskLevel` defaults to `medium` — the safe middle band that
 *   forces explicit approval for risky calls without spamming approval
 *   prompts on no-op tools.
 * - `input_schema` defaults to an empty closed object — the model is
 *   allowed to call the tool with no arguments, and unknown arguments
 *   are rejected at the JSON-schema layer.
 * - `executionTarget` defaults to `sandbox` — author-supplied tool code
 *   runs in the assistant container by default; opt in to `host` when
 *   the tool proxies work to the connected client. The name-prefix
 *   heuristic (`host_*` / `computer_use_*` resolves to host) is applied
 *   by `resolveExecutionTarget` in `finalizeTool`, so a tool named
 *   `host_my_thing` defaults to host even without an explicit field.
 * - `category` defaults to empty — Slack channel `allowedToolCategories`
 *   policy denies uncategorized tools when a category allow-list is set,
 *   which is the correct deny-by-default for tools the author didn't
 *   explicitly bucket.
 *
 * `execute` has no constant default because the default closure needs to
 * close over the tool's name to produce a useful error message; see
 * `finalizeTool` below.
 */
export const TOOL_DEFAULTS = Object.freeze({
  description: "",
  defaultRiskLevel: "medium" as RiskLevel,
  input_schema: Object.freeze({
    type: "object",
    properties: {},
    additionalProperties: false,
  }) as object,
  executionTarget: "sandbox" as const,
  category: "",
});

/**
 * Fill the five normally-required `ToolDefinition` fields with documented
 * defaults when the author omitted them, attach the registration-time
 * `name` (preferring an explicit override on the literal over the
 * file-derived default), and return a `Tool` that is safe to hand to a
 * `registerXxxTools` call.
 *
 * `defaultName` is optional — when omitted, the tool's own `name` field
 * is the source of truth and `""` is the last-ditch fallback. The
 * empty-string fallback is fail-loud: `registerSkillTools` rejects any
 * tool with an empty name with a clear "tool.name is required" error.
 *
 * The default `execute` returns an error result so the model sees a clear
 * "this tool isn't wired up" signal at call time. The owning loader still
 * registers the tool cleanly — a broken individual tool must never block
 * the registration batch.
 */
export function finalizeTool(tool: ToolDefinition, defaultName = ""): Tool {
  const name = tool.name ?? defaultName;
  const description =
    typeof tool.description === "string"
      ? tool.description
      : TOOL_DEFAULTS.description;
  const defaultRiskLevel =
    typeof tool.defaultRiskLevel === "string"
      ? tool.defaultRiskLevel
      : TOOL_DEFAULTS.defaultRiskLevel;
  const input_schema =
    tool.input_schema !== null && typeof tool.input_schema === "object"
      ? tool.input_schema
      : TOOL_DEFAULTS.input_schema;
  const execute =
    typeof tool.execute === "function"
      ? tool.execute
      : async (): Promise<ToolExecutionResult> => ({
          content: `tool ${name} has no execute implementation`,
          isError: true,
        });
  const executionTarget =
    tool.executionTarget ?? resolveExecutionTarget({ name });
  const category = tool.category ?? TOOL_DEFAULTS.category;
  const exclusive = tool.exclusive ?? false;
  return {
    ...tool,
    name,
    description,
    defaultRiskLevel,
    input_schema,
    executionTarget,
    execute,
    category,
    exclusive,
  };
}
