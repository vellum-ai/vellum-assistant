import { z } from "zod";

import { getSubagentManager } from "../../subagent/index.js";
import { nullAsOmitted } from "../shared/zod-tool-schema.js";
import type { ToolContext } from "../types.js";

/**
 * Shared model-input schema for the subagent tools that address an existing
 * subagent by `subagent_id` or `label` (`subagent_status` / `subagent_abort`,
 * extended by `subagent_message` / `subagent_read`). Same in-tool pattern and
 * TOOLS.json drift guard as the other bundled-skill tools — see
 * `subagent-tool-input-schemas.test.ts` and the schema block in
 * `tools/document/document-tool.ts` for the framework. The
 * '"subagent_id" or "label" is required' / not-found error messages stay
 * bespoke in each executor.
 */
export const subagentRefInputSchema = z.looseObject({
  subagent_id: nullAsOmitted(z.string()),
  label: nullAsOmitted(z.string()),
});

export type SubagentRefInput = z.infer<typeof subagentRefInputSchema>;

/**
 * Resolve a subagent ID from parsed tool input.
 * Accepts either `subagent_id` (direct UUID) or `label` (case-insensitive lookup).
 */
export function resolveSubagentId(
  input: SubagentRefInput,
  context: ToolContext,
): string | undefined {
  if (input.subagent_id) {
    return input.subagent_id;
  }
  if (input.label) {
    const state = getSubagentManager().getByLabel(
      input.label,
      context.conversationId,
    );
    return state?.config.id;
  }
  return undefined;
}
