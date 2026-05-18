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
import {
  isPrivateOrLocalHost,
  type ResolveHostAddresses,
  resolveHostAddresses,
  resolveRequestAddress,
} from "../../tools/network/url-safety.js";
// ── Result types ────────────────────────────────────────────────────

const AGENT_CARD_FETCH_TIMEOUT_MS = 5_000;

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

interface ResolveGuardianHandleOptions {
  fetchImpl?: typeof fetch;
  resolveHostAddresses?: ResolveHostAddresses;
}

function parsePeerGatewayUrl(gatewayUrl: string): URL {
  const trimmed = gatewayUrl.trim();
  if (trimmed.includes("#")) {
    throw new Error("A2A gatewayUrl must not include a URL fragment.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("A2A gatewayUrl must be a valid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("A2A gatewayUrl must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("A2A gatewayUrl must not include credentials.");
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error(
      "A2A gatewayUrl must not target a local or private network address.",
    );
  }

  return new URL(parsed.origin);
}

async function assertPublicGatewayHost(
  gatewayUrl: URL,
  resolveHost: ResolveHostAddresses,
): Promise<void> {
  const resolution = await resolveRequestAddress(
    gatewayUrl.hostname,
    resolveHost,
    false,
  );
  if (resolution.blockedAddress) {
    throw new Error(
      "A2A gatewayUrl must not resolve to a local or private network address.",
    );
  }
  if (resolution.addresses.length === 0) {
    throw new Error("Unable to resolve A2A gatewayUrl host.");
  }
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
  options: ResolveGuardianHandleOptions = {},
): Promise<ResolvedAssistant> {
  if (!gatewayUrl) {
    throw new Error(
      `A2A connection requires the peer's gatewayUrl. ` +
        `Please provide gatewayUrl for handle "${guardianHandle}".`,
    );
  }

  const normalizedGuardianHandle = guardianHandle.trim();
  const peerGatewayUrl = parsePeerGatewayUrl(gatewayUrl);
  await assertPublicGatewayHost(
    peerGatewayUrl,
    options.resolveHostAddresses ?? resolveHostAddresses,
  );

  const cardUrl = new URL(AGENT_CARD_PATH, peerGatewayUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(cardUrl.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(AGENT_CARD_FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      throw new Error("Timed out fetching peer assistant agent card.");
    }
    throw new Error("Failed to fetch peer assistant agent card.");
  }

  if (res.status >= 300 && res.status < 400) {
    throw new Error("Agent card fetch failed: redirects are not allowed.");
  }
  if (!res.ok) {
    throw new Error(`Agent card fetch failed with status ${res.status}.`);
  }

  let card: { name?: unknown };
  try {
    card = (await res.json()) as { name?: unknown };
  } catch {
    throw new Error("Agent card response was not valid JSON.");
  }

  const displayName =
    typeof card.name === "string" && card.name.trim()
      ? card.name
      : normalizedGuardianHandle;

  return {
    assistantId: normalizedGuardianHandle,
    gatewayUrl: peerGatewayUrl.origin,
    displayName,
  };
}

// ── Connection initiation ───────────────────────────────────────────

export async function connectToAssistant(params: {
  guardianHandle: string;
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  resolveHostAddresses?: ResolveHostAddresses;
}): Promise<ConnectToAssistantResult> {
  const guardianHandle = params.guardianHandle.trim();
  const { gatewayUrl } = params;
  if (!guardianHandle) {
    return {
      success: false,
      error: "guardianHandle is required",
    };
  }

  // 1. Ensure A2A channel is enabled (auto-enable on first connect)
  const config = getA2AConfig();
  if (!config.enabled) {
    setA2AConfig();
  }

  // 2. Resolve the peer assistant's identity
  let resolved: ResolvedAssistant;
  try {
    resolved = await resolveGuardianHandle(guardianHandle, gatewayUrl, {
      fetchImpl: params.fetchImpl,
      resolveHostAddresses: params.resolveHostAddresses,
    });
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
