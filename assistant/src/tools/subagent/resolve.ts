import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext } from "../types.js";

/**
 * Resolve a subagent ID from tool input.
 * Accepts either `subagent_id` (direct UUID) or `label` (case-insensitive lookup).
 */
export function resolveSubagentId(
  input: Record<string, unknown>,
  context: ToolContext,
): string | undefined {
  if (input.subagent_id) return input.subagent_id as string;
  if (input.label) {
    const state = getSubagentManager().getByLabel(
      input.label as string,
      context.conversationId,
    );
    return state?.config.id;
  }
  return undefined;
}
