/**
 * Bundled tool: contact-message
 *
 * Sends a message to a known assistant contact via the A2A outbound sender.
 * When the target isn't a contact yet but gateway_url and assistant_id are
 * provided, automatically initiates A2A pairing — the user then submits the
 * 6-digit verification code via contact_pair_verify to complete pairing
 * before the message can be sent.
 *
 * Gated behind the `feature_flags.assistant-a2a.enabled` feature flag.
 */

import {
  getContact,
  searchContacts,
} from "../../../../contacts/contact-store.js";
import { sendA2AMessage } from "../../../../runtime/a2a/outbound-client.js";
import { initiatePairing } from "../../../../runtime/a2a/pairing.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isAssistantFeatureFlagEnabled } from "../../../assistant-feature-flags.js";
import { getConfig } from "../../../loader.js";

export async function executeContactMessage(
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

  const contactId = input.contact_id as string | undefined;
  const contactName = input.contact_name as string | undefined;
  const message = input.message as string | undefined;
  const gatewayUrl = input.gateway_url as string | undefined;
  const assistantId = input.assistant_id as string | undefined;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return {
      content: "Error: message is required and must be a non-empty string",
      isError: true,
    };
  }

  // Resolve contact: by ID or by name search
  let resolvedContactId: string | undefined;
  let displayName: string | undefined;

  if (contactId) {
    const contact = getContact(contactId);
    if (!contact) {
      return {
        content: `Error: Contact not found with ID: ${contactId}`,
        isError: true,
      };
    }
    resolvedContactId = contact.id;
    displayName = contact.displayName;
  } else if (contactName) {
    const results = searchContacts({
      query: contactName,
      contactType: "assistant",
      limit: 5,
    });

    if (results.length === 0) {
      // No contact found — attempt auto-pairing if gateway info is provided
      if (gatewayUrl && assistantId) {
        return await attemptAutoPairing(
          gatewayUrl.trim(),
          assistantId.trim(),
          contactName,
        );
      }
      return {
        content: `No assistant contact found matching "${contactName}". To message an unknown assistant, provide gateway_url and assistant_id so pairing can be initiated automatically.`,
        isError: true,
      };
    }

    if (results.length > 1) {
      const matches = results
        .map((c) => `- ${c.displayName} (ID: ${c.id})`)
        .join("\n");
      return {
        content: `Multiple assistant contacts match "${contactName}". Please specify a contact_id:\n${matches}`,
        isError: true,
      };
    }

    resolvedContactId = results[0].id;
    displayName = results[0].displayName;
  } else if (gatewayUrl && assistantId) {
    // No contact_id or contact_name, but gateway info provided — try to find
    // an existing contact by assistant_id, or initiate pairing
    const results = searchContacts({
      query: assistantId,
      contactType: "assistant",
      limit: 5,
    });

    const exactMatch = results.find((c) => {
      // Check if any channel address matches the assistant ID
      return c.channels?.some(
        (ch) => ch.address === assistantId || ch.externalUserId === assistantId,
      );
    });

    if (exactMatch) {
      resolvedContactId = exactMatch.id;
      displayName = exactMatch.displayName;
    } else {
      return await attemptAutoPairing(gatewayUrl.trim(), assistantId.trim());
    }
  } else {
    return {
      content:
        "Error: Either contact_id, contact_name, or both gateway_url and assistant_id are required to identify the target assistant",
      isError: true,
    };
  }

  const result = await sendA2AMessage(resolvedContactId, message.trim());

  if (result.ok) {
    return {
      content: `Message sent to ${displayName ?? resolvedContactId} successfully.`,
      isError: false,
    };
  }

  return {
    content: `Failed to send message to ${displayName ?? resolvedContactId}: ${result.error}`,
    isError: true,
  };
}

/**
 * Attempt to auto-initiate A2A pairing when the target assistant is not
 * a known contact. Returns a tool result asking the user for the
 * verification code.
 */
async function attemptAutoPairing(
  gatewayUrl: string,
  assistantId: string,
  contactName?: string,
): Promise<ToolExecutionResult> {
  try {
    await initiatePairing(assistantId, gatewayUrl);

    const target = contactName
      ? `"${contactName}" (${assistantId})`
      : assistantId;

    return {
      content:
        `I've sent a pairing request to ${target} at ${gatewayUrl}. ` +
        `Their guardian needs to approve it and share a 6-digit verification code with you. ` +
        `Once you have the code, provide it using the contact_pair_verify tool, ` +
        `and then I'll send the message.`,
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Failed to initiate pairing with assistant at ${gatewayUrl}: ${message}`,
      isError: true,
    };
  }
}

export { executeContactMessage as run };
