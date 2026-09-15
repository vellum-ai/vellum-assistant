/**
 * Conversation-stable wire projections of the UI surface tool definitions.
 *
 * `ui_show`, `ui_update`, and `ui_dismiss` keep one definition across every
 * channel and across live vs clientless turns. Channel renderers enforce the
 * surfaces they can display at execution. Clientless calls persist surface
 * content for the next capable client that opens the conversation.
 *
 * `activation_moment` is the remaining schema projection. It applies only to
 * activation-rail conversations, whose marker is written before the first
 * tool resolution, so the extra property is stable for that conversation's
 * lifetime. It must not vary by channel or turn presence.
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
 * only for activation-rail conversations (`isActivationSession`). The rail
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
