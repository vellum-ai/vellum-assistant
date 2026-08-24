/**
 * Standing contact_tool grants for sandbox workspace commands.
 *
 * A grant authorizes one trusted contact (every channel address on that
 * contact) to run sandbox `bash` in their conversations without a
 * per-command guardian card. High-risk bash still escalates. host_bash
 * is never covered.
 */

import { getContact } from "../contacts/contact-store.js";
import { mintGrantFromDecision } from "./approval-primitive.js";
import {
  _internal,
  type ScopedApprovalGrant,
} from "./scoped-approval-grants.js";

const {
  findActiveContactToolGrant,
  hasActiveContactToolGrant,
  revokeContactToolGrants,
} = _internal;

/** Sandbox tool covered by a contact workspace-commands grant. */
export const CONTACT_WORKSPACE_COMMANDS_TOOL = "bash";

/**
 * Standing grants last until revoked. expireScopedApprovalGrants sweeps
 * any row whose expiresAt is in the past, so this must be far in the future.
 */
export const CONTACT_TOOL_GRANT_EXPIRES_AT = Date.parse(
  "2099-12-31T00:00:00.000Z",
);

export function contactChannelAddresses(contactId: string): string[] {
  const contact = getContact(contactId);
  if (!contact) {
    return [];
  }
  const addresses = new Set<string>();
  for (const channel of contact.channels) {
    const address = channel.address.trim();
    if (address) {
      addresses.add(address);
    }
  }
  return [...addresses];
}

export function upsertContactToolGrants(params: {
  contactId: string;
  requestChannel: string;
  decisionChannel: string;
  guardianExternalUserId?: string | null;
  toolName?: string;
}): ScopedApprovalGrant[] {
  const toolName = params.toolName ?? CONTACT_WORKSPACE_COMMANDS_TOOL;
  const addresses = contactChannelAddresses(params.contactId);
  if (addresses.length === 0) {
    throw new Error(
      "Contact has no channel addresses. Add a channel before granting workspace commands.",
    );
  }

  return addresses.map((requesterExternalUserId) => {
    const existing = findActiveContactToolGrant({
      toolName,
      requesterExternalUserId,
    });
    if (existing) {
      return existing;
    }

    const result = mintGrantFromDecision({
      scopeMode: "contact_tool",
      toolName,
      requestChannel: params.requestChannel,
      decisionChannel: params.decisionChannel,
      requesterExternalUserId,
      guardianExternalUserId: params.guardianExternalUserId ?? null,
      expiresAt: CONTACT_TOOL_GRANT_EXPIRES_AT,
    });

    if (!result.ok) {
      throw new Error(`Failed to mint contact_tool grant: ${result.reason}`);
    }

    return result.grant;
  });
}

export function contactWorkspaceCommandsEnabled(
  contactId: string,
  toolName: string = CONTACT_WORKSPACE_COMMANDS_TOOL,
): boolean {
  return hasActiveContactToolGrant({
    toolName,
    requesterExternalUserIds: contactChannelAddresses(contactId),
  });
}

export function disableContactWorkspaceCommands(
  contactId: string,
  toolName: string = CONTACT_WORKSPACE_COMMANDS_TOOL,
): number {
  return revokeContactToolGrants(
    contactChannelAddresses(contactId),
    toolName,
  );
}
