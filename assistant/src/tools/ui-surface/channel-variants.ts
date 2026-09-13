/**
 * Per-conversation wire projections of the UI surface tool definitions.
 *
 * Surface definitions stay identical across channels and background turns.
 * A channel's renderer validates the surface it can display when ui_show or
 * ui_update executes, while background turns persist surface content for the
 * next capable client that opens the conversation. Activation-rail
 * conversations alone receive the optional `activation_moment` telemetry
 * parameter because that per-conversation state is stable.
 */

import type { ToolDefinition } from "../../providers/types.js";
import { ACTIVATION_MOMENT_PARAMS } from "../../telemetry/activation-funnel.js";

const ACTIVATION_MOMENT_PROPERTY = {
  type: "string",
  enum: ACTIVATION_MOMENT_PARAMS,
  description:
    "Activation-rail telemetry tag. Set this when this surface IS one of the activation funnel moments; the milestone is recorded automatically when the user commits the surface. Omit for all non-activation surfaces.",
};

/**
 * Add the optional `activation_moment` param to ui_show's schema. Applied
 * only for activation-rail conversations (`isActivationSession`) — the rail
 * bootstrap prompt instructs the tagging, and the daemon's emit path reads
 * the tag from tool input independently of this schema.
 */
export function injectActivationMomentParam(
  definitions: ToolDefinition[],
): ToolDefinition[] {
  return definitions.map((def) => {
    if (def.name !== "ui_show") {
      return def;
    }
    const schema = def.input_schema as {
      properties?: Record<string, unknown>;
    };
    return {
      ...def,
      input_schema: {
        ...schema,
        properties: {
          ...schema.properties,
          activation_moment: ACTIVATION_MOMENT_PROPERTY,
        },
      },
    };
  });
}
