import { z } from "zod";

import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext } from "../types.js";

/**
 * Selector fields shared by the subagent tools: target a subagent by
 * `subagent_id` or by `label`. Spread into each tool's input schema.
 */
export const subagentSelectorFields = {
  subagent_id: z.string().nullish(),
  label: z.string().nullish(),
};

/**
 * Resolve a subagent ID from parsed tool input.
 * Accepts either `subagent_id` (direct UUID) or `label` (case-insensitive lookup).
 */
export function resolveSubagentId(
  input: { subagent_id?: string | null; label?: string | null },
  context: ToolContext,
): string | undefined {
  if (input.subagent_id) return input.subagent_id;
  if (input.label) {
    const state = getSubagentManager().getByLabel(
      input.label,
      context.conversationId,
    );
    return state?.config.id;
  }
  return undefined;
}
