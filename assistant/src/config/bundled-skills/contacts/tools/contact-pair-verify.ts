/**
 * Bundled tool: contact-pair-verify
 *
 * Sends a 6-digit verification code to complete an A2A pairing handshake.
 * Gated behind the `feature_flags.assistant-a2a.enabled` feature flag.
 */

import { sendPairingVerify } from "../../../../runtime/a2a/pairing.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isAssistantFeatureFlagEnabled } from "../../../assistant-feature-flags.js";
import { getConfig } from "../../../loader.js";

export async function executeContactPairVerify(
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

  const code = input.code as string | undefined;

  if (!code || typeof code !== "string" || code.trim().length === 0) {
    return {
      content: "Error: code is required and must be a non-empty string",
      isError: true,
    };
  }

  const result = await sendPairingVerify(code.trim());

  if (result.ok) {
    return {
      content:
        "Verification code sent successfully. Pairing will complete once the remote assistant validates the code.",
      isError: false,
    };
  }

  return {
    content: `Failed to verify pairing: ${result.error ?? "Unknown error"}`,
    isError: true,
  };
}

export { executeContactPairVerify as run };
