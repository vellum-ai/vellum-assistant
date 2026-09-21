import { nullAsOmitted } from "@vellumai/plugin-api";
import { z } from "zod";

import {
  RecallDepthSchema,
  RecallSourceSchema,
} from "../../../../api/events/tool-result.js";
import { MAX_RECALL_MAX_RESULTS, MIN_RECALL_MAX_RESULTS } from "./limits.js";

/**
 * The `recall` tool's input: parsed at the top of its `execute`, and the
 * source of the `input_schema` the model is shown, so the two cannot drift.
 *
 * `max_results` accepts any number, which `normalizeRecallInput` clamps, and
 * reads anything else as absent; an explicit `null` on an optional field means
 * omitted. An unknown source or depth is rejected.
 */
export const RecallInputSchema = z.looseObject({
  query: z
    .string()
    .describe(
      "What you're looking for. Be specific and descriptive: include the topic, person, project, decision, time period, or file clues when known.",
    ),
  sources: nullAsOmitted(z.array(RecallSourceSchema)).describe(
    "Optional local sources to search. Omit to search memory, conversations, and workspace files.",
  ),
  max_results: z.number().optional().catch(undefined).meta({
    type: "integer",
    minimum: MIN_RECALL_MAX_RESULTS,
    maximum: MAX_RECALL_MAX_RESULTS,
    description: "Maximum number of evidence items to return.",
  }),
  depth: nullAsOmitted(RecallDepthSchema).describe(
    "Search effort. Use fast for quick lookups, standard by default, and deep when the answer may require multiple local searches.",
  ),
});

export type RecallInput = z.infer<typeof RecallInputSchema>;
