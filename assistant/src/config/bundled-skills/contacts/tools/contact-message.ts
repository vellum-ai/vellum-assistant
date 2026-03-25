/**
 * Bundled tool: contact-message
 *
 * Sends a message to a known assistant contact via the A2A outbound sender.
 * Gated behind the `feature_flags.assistant-a2a.enabled` feature flag.
 */

import {
  getContact,
  searchContacts,
} from "../../../../contacts/contact-store.js";
import { sendA2AMessage } from "../../../../runtime/a2a/outbound-client.js";
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
      return {
        content: `Error: No assistant contact found matching "${contactName}"`,
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
  } else {
    return {
      content:
        "Error: Either contact_id or contact_name is required to identify the target assistant",
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

export { executeContactMessage as run };
