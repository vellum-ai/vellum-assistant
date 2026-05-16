/**
 * A2A channel configuration handler.
 *
 * Follows the same pattern as config-telegram.ts:
 * - getA2AConfig()       — read a2a.enabled, count active a2a contact_channels
 * - setA2AConfig()       — set a2a.enabled = true, register callback routes
 * - clearA2AConfig()     — set a2a.enabled = false
 * - connectToAssistant() — resolve handle, create contact + channel
 */

import { AGENT_CARD_PATH } from "../../a2a/protocol-constants.js";
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
import { getDb } from "../../memory/db-connection.js";
import { assistantContactMetadata } from "../../memory/schema.js";
// ── Result types ────────────────────────────────────────────────────

export interface A2AConfigResult {
  success: boolean;
  enabled: boolean;
  activeConnections: number;
  error?: string;
}

export interface ConnectToAssistantResult {
  success: boolean;
  contactId?: string;
  error?: string;
  alreadyConnected?: boolean;
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

// ── Handle resolution (stubbable) ───────────────────────────────────

export interface ResolvedAssistant {
  assistantId: string;
  gatewayUrl: string;
  displayName: string;
}

/**
 * Resolve a guardian handle to an assistant's gateway URL and identity.
 *
 * For MVP, this fetches the peer's agent card from the gateway URL.
 * When the platform API for handle resolution is available, this function
 * will be updated to use it.
 */
export async function resolveGuardianHandle(
  guardianHandle: string,
  gatewayUrl?: string,
): Promise<ResolvedAssistant> {
  if (!gatewayUrl) {
    throw new Error(
      `A2A connection requires the peer's gatewayUrl. ` +
        `Please provide gatewayUrl for handle "${guardianHandle}".`,
    );
  }

  const cardUrl = `${gatewayUrl}${AGENT_CARD_PATH}`;
  try {
    const res = await fetch(cardUrl);
    if (!res.ok) {
      throw new Error(
        `Agent card fetch failed (${res.status}): ${await res.text()}`,
      );
    }
    const card = (await res.json()) as { name?: string };
    return {
      assistantId: guardianHandle,
      gatewayUrl,
      displayName: card.name ?? guardianHandle,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Agent card fetch")) {
      throw err;
    }
    throw new Error(
      `Failed to reach peer assistant at ${cardUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Connection initiation ───────────────────────────────────────────

export async function connectToAssistant(params: {
  guardianHandle: string;
  gatewayUrl?: string;
}): Promise<ConnectToAssistantResult> {
  const { guardianHandle, gatewayUrl } = params;

  // 1. Ensure A2A channel is enabled (auto-enable on first connect)
  const config = getA2AConfig();
  if (!config.enabled) {
    setA2AConfig();
  }

  // 2. Resolve the peer assistant's identity
  let resolved: ResolvedAssistant;
  try {
    resolved = await resolveGuardianHandle(guardianHandle, gatewayUrl);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Check for existing connection (idempotent)
  const existing = findContactByAddress("a2a", resolved.assistantId);
  if (existing) {
    const activeChannel = existing.channels.find(
      (ch) => ch.type === "a2a" && ch.status === "active",
    );
    if (activeChannel) {
      return {
        success: true,
        contactId: existing.id,
        alreadyConnected: true,
      };
    }
  }

  // 4. Create local contact + channel + assistant_contact_metadata
  const contact = upsertContact({
    displayName: resolved.displayName,
    contactType: "assistant",
    role: "contact",
    channels: [
      {
        type: "a2a",
        address: resolved.assistantId,
        externalUserId: resolved.assistantId,
        status: "active",
        policy: "allow",
      },
    ],
  });

  const db = getDb();
  const metadataJson = JSON.stringify({
    assistantId: resolved.assistantId,
    gatewayUrl: resolved.gatewayUrl,
  } satisfies VellumAssistantMetadata);

  db.insert(assistantContactMetadata)
    .values({
      contactId: contact.id,
      species: "vellum",
      metadata: metadataJson,
    })
    .onConflictDoUpdate({
      target: assistantContactMetadata.contactId,
      set: {
        species: "vellum",
        metadata: metadataJson,
      },
    })
    .run();

  return { success: true, contactId: contact.id };
}
