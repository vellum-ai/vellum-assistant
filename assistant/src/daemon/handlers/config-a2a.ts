/**
 * A2A channel configuration handler.
 *
 * - getA2AConfig()     — read a2a.enabled, count active a2a contact_channels
 * - setA2AConfig()     — set a2a.enabled = true
 * - clearA2AConfig()   — set a2a.enabled = false
 * - createA2AInvite()  — create a shareable invite token for link-based contact creation
 * - completeA2AInvite() — sender-side: claim token and return sender identity
 * - redeemA2AInvite()  — receiver-side: create trusted contact from sender identity
 * - acceptA2AInvite()  — self-hosted broker: orchestrate complete + redeem across daemons
 */

import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  findContactByAddress,
  searchContacts,
  upsertContact,
} from "../../contacts/contact-store.js";
import type { VellumAssistantMetadata } from "../../contacts/types.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { getDb } from "../../memory/db-connection.js";
import {
  claimA2AInvite,
  createInvite,
  hashToken,
} from "../../memory/invite-store.js";
import { assistantContactMetadata } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { getAssistantName } from "../identity-helpers.js";
const log = getLogger("config-a2a");

// ── Result types ────────────────────────────────────────────────────

export interface A2AConfigResult {
  success: boolean;
  enabled: boolean;
  activeConnections: number;
  error?: string;
}

export interface CreateA2AInviteResult {
  success: boolean;
  inviteId?: string;
  token?: string;
  expiresAt?: number;
  senderGatewayUrl?: string;
  error?: string;
}

export interface CompleteA2AInviteResult {
  success: boolean;
  sender?: { assistantId: string; displayName: string; gatewayUrl: string };
  error?: string;
}

export interface RedeemA2AInviteResult {
  success: boolean;
  contactId?: string;
  alreadyConnected?: boolean;
  error?: string;
}

export interface AcceptA2AInviteResult {
  success: boolean;
  contactId?: string;
  alreadyConnected?: boolean;
  error?: string;
  errorCode?: string;
}

// ── Config operations ───────────────────────────────────────────────

export function getA2AConfig(): A2AConfigResult {
  const config = getConfig();
  const enabled = config.a2a?.enabled ?? false;

  const contacts = searchContacts({ channelType: "a2a" });
  const activeConnections = contacts.reduce((count, c) => {
    return (
      count +
      c.channels.filter((ch) => ch.type === "a2a" && ch.status === "active")
        .length
    );
  }, 0);

  return { success: true, enabled, activeConnections };
}

export function setA2AConfig(): A2AConfigResult {
  const raw = loadRawConfig();
  setNestedValue(raw, "a2a.enabled", true);
  saveRawConfig(raw);
  invalidateConfigCache();

  const result = getA2AConfig();
  return { ...result, success: true };
}

export function clearA2AConfig(): A2AConfigResult {
  const raw = loadRawConfig();
  setNestedValue(raw, "a2a.enabled", false);
  saveRawConfig(raw);
  invalidateConfigCache();

  return { success: true, enabled: false, activeConnections: 0 };
}

// ── A2A invite creation ────────────────────────────────────────────

export function createA2AInvite(params: {
  expiresInHours?: number;
}): CreateA2AInviteResult {
  // 1. Ensure A2A channel is enabled (auto-enable on first invite)
  const config = getA2AConfig();
  if (!config.enabled) {
    setA2AConfig();
  }

  // 2. Resolve public base URL
  let publicBaseUrl: string;
  try {
    publicBaseUrl = getPublicBaseUrl(getConfig());
  } catch {
    return {
      success: false,
      error:
        "No public base URL configured. Set ingress.publicBaseUrl in config.",
    };
  }

  // 3. Create placeholder contact (no channels — will be bound on acceptance)
  const contact = upsertContact({
    displayName: "Pending A2A invite",
    contactType: "assistant",
    role: "contact",
  });

  // 4. Create the invite
  const expiresInMs = (params.expiresInHours ?? 72) * 60 * 60 * 1000;
  const { invite, rawToken } = createInvite({
    sourceChannel: "a2a",
    contactId: contact.id,
    maxUses: 1,
    expiresInMs,
  });

  return {
    success: true,
    inviteId: invite.id,
    token: rawToken,
    expiresAt: invite.expiresAt,
    senderGatewayUrl: publicBaseUrl,
  };
}

// ── A2A invite completion (sender side) ───────────────────────────

export function completeA2AInvite(params: {
  token: string;
  senderAssistantId: string;
  acceptor: {
    assistantId: string;
    displayName: string;
    gatewayUrl: string;
  };
}): CompleteA2AInviteResult {
  // Resolve sender identity before any mutations so we fail cleanly
  const displayName = getAssistantName() ?? "Vellum Assistant";
  let gatewayUrl: string;
  try {
    gatewayUrl = getPublicBaseUrl(getConfig());
  } catch {
    return {
      success: false,
      error:
        "No public base URL configured. Set ingress.publicBaseUrl in config.",
    };
  }

  const tokenHash = hashToken(params.token);
  const claimResult = claimA2AInvite({
    tokenHash,
    redeemedByExternalUserId: params.acceptor.assistantId,
  });

  if (!claimResult.claimed || !claimResult.invite) {
    return { success: false, error: claimResult.error };
  }

  const invite = claimResult.invite;

  // Promote the placeholder contact with the acceptor's identity
  upsertContact({
    id: invite.contactId,
    displayName: params.acceptor.displayName,
    contactType: "assistant",
    role: "contact",
    channels: [
      {
        type: "a2a",
        address: params.acceptor.assistantId.toLowerCase(),
        externalUserId: params.acceptor.assistantId,
        status: "active",
        policy: "allow",
      },
    ],
  });

  // Write assistant contact metadata
  const db = getDb();
  const metadataJson = JSON.stringify({
    assistantId: params.acceptor.assistantId,
    gatewayUrl: params.acceptor.gatewayUrl,
  } satisfies VellumAssistantMetadata);
  db.insert(assistantContactMetadata)
    .values({
      contactId: invite.contactId,
      species: "vellum",
      metadata: metadataJson,
    })
    .onConflictDoUpdate({
      target: assistantContactMetadata.contactId,
      set: { species: "vellum", metadata: metadataJson },
    })
    .run();

  return {
    success: true,
    sender: {
      assistantId: params.senderAssistantId,
      displayName,
      gatewayUrl,
    },
  };
}

// ── A2A invite redemption (receiver side) ─────────────────────────

export function redeemA2AInvite(params: {
  sender: {
    assistantId: string;
    displayName: string;
    gatewayUrl: string;
  };
}): RedeemA2AInviteResult {
  // 1. Ensure A2A channel is enabled (auto-enable if needed)
  const config = getA2AConfig();
  if (!config.enabled) {
    setA2AConfig();
  }

  // 2. Check for existing active contact with this sender
  const existing = findContactByAddress("a2a", params.sender.assistantId);
  if (
    existing &&
    existing.channels.some((ch) => ch.type === "a2a" && ch.status === "active")
  ) {
    return { success: true, alreadyConnected: true, contactId: existing.id };
  }

  // 3. Create the sender as a local trusted contact
  const contact = upsertContact({
    displayName: params.sender.displayName,
    contactType: "assistant",
    role: "contact",
    channels: [
      {
        type: "a2a",
        address: params.sender.assistantId.toLowerCase(),
        externalUserId: params.sender.assistantId,
        status: "active",
        policy: "allow",
      },
    ],
  });

  // 4. Write assistant contact metadata
  const db = getDb();
  const metadataJson = JSON.stringify({
    assistantId: params.sender.assistantId,
    gatewayUrl: params.sender.gatewayUrl,
  } satisfies VellumAssistantMetadata);
  db.insert(assistantContactMetadata)
    .values({
      contactId: contact.id,
      species: "vellum",
      metadata: metadataJson,
    })
    .onConflictDoUpdate({
      target: assistantContactMetadata.contactId,
      set: { species: "vellum", metadata: metadataJson },
    })
    .run();

  return { success: true, contactId: contact.id };
}

// ── Self-hosted broker ──────────────────────────────────────────────

const ACCEPT_TIMEOUT_MS = 15_000;

/**
 * Orchestrate cross-daemon A2A invite acceptance for self-hosted
 * deployments. Calls the sender's `invite/complete` endpoint, then
 * creates a local contact via `redeemA2AInvite`.
 *
 * Trust model: the user explicitly chose to connect to `senderGatewayUrl`
 * and provided a token from the sender's invite link. We trust the
 * invite-link values (`senderAssistantId`, `senderGatewayUrl`) as the
 * canonical sender identity, and only use the `complete` response for the
 * sender's display name (which has no other source in self-hosted mode).
 */
export async function acceptA2AInvite(params: {
  senderGatewayUrl: string;
  senderAssistantId: string;
  token: string;
}): Promise<AcceptA2AInviteResult> {
  const displayName = getAssistantName() ?? "Vellum Assistant";
  let localGatewayUrl: string;
  try {
    localGatewayUrl = getPublicBaseUrl(getConfig());
  } catch {
    return {
      success: false,
      error:
        "No public base URL configured. Set ingress.publicBaseUrl in config.",
      errorCode: "no_public_url",
    };
  }

  // 1. Call the sender's invite/complete endpoint
  const completeUrl = `${params.senderGatewayUrl.replace(/\/+$/, "")}/v1/integrations/a2a/invite/complete`;
  const completeBody = {
    token: params.token,
    senderAssistantId: params.senderAssistantId,
    acceptor: {
      assistantId: localGatewayUrl,
      displayName,
      gatewayUrl: localGatewayUrl,
    },
  };

  let completeData: Record<string, unknown>;
  try {
    const response = await fetch(completeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(completeBody),
      signal: AbortSignal.timeout(ACCEPT_TIMEOUT_MS),
    });

    completeData = (await response.json()) as Record<string, unknown>;

    if (!response.ok || !completeData.success) {
      const error = String(completeData.error ?? "Invite completion failed");
      const errorCode = String(completeData.errorCode ?? "complete_failed");
      log.warn(
        { senderGatewayUrl: params.senderGatewayUrl, error, errorCode },
        "Sender invite/complete returned failure",
      );
      return { success: false, error, errorCode };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { senderGatewayUrl: params.senderGatewayUrl, error: message },
      "Failed to reach sender for invite/complete",
    );
    return {
      success: false,
      error: `Failed to reach sender: ${message}`,
      errorCode: "sender_unreachable",
    };
  }

  // 2. Extract sender display name from the complete response; use
  //    invite-link values for assistantId and gatewayUrl (trusted source).
  const senderFromResponse = completeData.sender as
    | { displayName?: string }
    | undefined;

  const senderIdentity = {
    assistantId: params.senderAssistantId,
    displayName:
      (typeof senderFromResponse?.displayName === "string" &&
        senderFromResponse.displayName) ||
      params.senderAssistantId,
    gatewayUrl: params.senderGatewayUrl,
  };

  // 3. Create the sender as a local trusted contact
  const redeemResult = redeemA2AInvite({ sender: senderIdentity });
  if (!redeemResult.success) {
    log.warn(
      { error: redeemResult.error },
      "Local invite/redeem failed after successful complete",
    );
    return {
      success: false,
      error: redeemResult.error ?? "Failed to create sender contact",
      errorCode: "redeem_failed",
    };
  }

  return {
    success: true,
    contactId: redeemResult.contactId,
    alreadyConnected: redeemResult.alreadyConnected,
  };
}
