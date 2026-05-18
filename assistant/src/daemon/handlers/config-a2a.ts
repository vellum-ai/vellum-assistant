/**
 * A2A channel configuration handler.
 *
 * - getA2AConfig()     — read a2a.enabled, count active a2a contact_channels
 * - setA2AConfig()     — set a2a.enabled = true
 * - clearA2AConfig()   — set a2a.enabled = false
 * - createA2AInvite()  — create a shareable invite token for link-based contact creation
 */

import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { searchContacts, upsertContact } from "../../contacts/contact-store.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { createInvite } from "../../memory/invite-store.js";
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
