/**
 * System tool: set_permission_mode
 *
 * Allows the LLM to deterministically switch permission mode axes via the
 * PermissionModeStore rather than relying on model-generated text.
 *
 * This tool is always available (no permission check required) when the
 * `permission-controls-v2` feature flag is enabled — it IS the permission
 * mechanism.
 */

import {
  getMode,
  setAskBeforeActing,
  setHostAccess,
} from "../../permissions/permission-mode-store.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

class SetPermissionModeTool implements Tool {
  name = "set_permission_mode";
  description =
    "Change the assistant's permission mode. Supports partial updates — " +
    "only the provided fields are changed. Use this to toggle whether the " +
    "assistant asks before acting or whether host access is enabled.";
  category = "system";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          askBeforeActing: {
            type: "boolean",
            description:
              "When true, the assistant checks in with the user before taking actions.",
          },
          hostAccess: {
            type: "boolean",
            description:
              "When true, the assistant can execute commands on the host machine without prompting.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const { askBeforeActing, hostAccess } = input;

    // Validate that at least one field is provided
    if (askBeforeActing === undefined && hostAccess === undefined) {
      return {
        content:
          "Error: at least one of askBeforeActing or hostAccess must be provided.",
        isError: true,
      };
    }

    // Validate types of provided fields
    if (askBeforeActing !== undefined && typeof askBeforeActing !== "boolean") {
      return {
        content: `Error: askBeforeActing must be a boolean, got ${typeof askBeforeActing}.`,
        isError: true,
      };
    }
    if (hostAccess !== undefined && typeof hostAccess !== "boolean") {
      return {
        content: `Error: hostAccess must be a boolean, got ${typeof hostAccess}.`,
        isError: true,
      };
    }

    // Apply changes for provided fields
    if (typeof askBeforeActing === "boolean") {
      setAskBeforeActing(askBeforeActing);
    }

    if (typeof hostAccess === "boolean") {
      setHostAccess(hostAccess);
    }

    // Return confirmation with the new state
    const mode = getMode();
    return {
      content: [
        "Permission mode updated.",
        `  askBeforeActing: ${mode.askBeforeActing}`,
        `  hostAccess: ${mode.hostAccess}`,
      ].join("\n"),
      isError: false,
    };
  }
}

export const setPermissionModeTool = new SetPermissionModeTool();
