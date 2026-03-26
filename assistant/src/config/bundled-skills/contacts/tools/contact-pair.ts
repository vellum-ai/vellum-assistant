/**
 * Bundled tool: contact-pair
 *
 * Initiates A2A pairing with a remote assistant by gateway URL and assistant ID.
 * Gated behind the `feature_flags.assistant-a2a.enabled` feature flag.
 */

import { initiatePairing } from "../../../../runtime/a2a/pairing.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isAssistantFeatureFlagEnabled } from "../../../assistant-feature-flags.js";
import { getConfig } from "../../../loader.js";

export async function executeContactPair(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  // Feature flag gate
  const config = getConfig();
  if (
    !isAssistantFeatureFlagEnabled(
      "feature_flags.assistant-a2a.enabled",
      config,
    )
  ) {
    return {
      content:
        "Error: Assistant-to-assistant messaging is not enabled. Enable the assistant-a2a feature flag to use this tool.",
      isError: true,
    };
  }

  const gatewayUrl = input.gateway_url as string | undefined;
  const assistantId = input.assistant_id as string | undefined;

  if (
    !gatewayUrl ||
    typeof gatewayUrl !== "string" ||
    gatewayUrl.trim().length === 0
  ) {
    return {
      content: "Error: gateway_url is required and must be a non-empty string",
      isError: true,
    };
  }

  if (
    !assistantId ||
    typeof assistantId !== "string" ||
    assistantId.trim().length === 0
  ) {
    return {
      content: "Error: assistant_id is required and must be a non-empty string",
      isError: true,
    };
  }

  try {
    await initiatePairing(assistantId.trim(), gatewayUrl.trim());

    return {
      content:
        "Pairing request sent. The other assistant's guardian will need to approve and share a 6-digit verification code with you.",
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Failed to initiate pairing: ${message}`,
      isError: true,
    };
  }
}

export { executeContactPair as run };
