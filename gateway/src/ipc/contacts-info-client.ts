/**
 * Typed gateway → daemon IPC client for contact INFO reads.
 *
 * Wraps `ipcCallAssistant` for the daemon's contact info-read methods (see
 * assistant/src/ipc/routes/contacts-info-ipc-routes.ts), replacing the raw
 * `db_proxy` SELECTs the gateway used to run against the assistant DB. The
 * assistant DB owns purely informational fields (`notes`, `user_file`,
 * `contact_type`, `assistant_contact_metadata`) and channel identity; ACL data
 * stays gateway-owned and is never read here.
 *
 * These helpers throw (IpcTransportError / IpcHandlerError) on failure — the
 * callers own soft-fail handling so an info read never blocks the ACL path.
 */

import { ipcCallAssistant } from "./assistant-client.js";

export interface ContactInfoBatchEntry {
  contactId: string;
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  assistantMetadata: {
    species: string;
    metadata: Record<string, unknown> | null;
  } | null;
}

/**
 * Batch-read assistant-owned info fields for a set of contact IDs. Returns one
 * entry per contact present in the assistant DB; contacts absent there are
 * omitted. No query is issued for an empty input.
 */
export async function fetchContactsInfoBatch(
  contactIds: string[],
): Promise<ContactInfoBatchEntry[]> {
  if (contactIds.length === 0) return [];
  const result = (await ipcCallAssistant("contacts_info_batch", {
    body: { contactIds },
  })) as { infos?: ContactInfoBatchEntry[] };
  return result.infos ?? [];
}

export interface ChannelIdentity {
  id: string;
  contactId: string;
  type: string;
  address: string;
  externalChatId: string | null;
  displayName: string | null;
}

/**
 * Resolve a contact-channel identity by channel id, or by logical
 * `(type, address)` key. Returns null when no channel matches.
 */
export async function lookupContactChannelIdentity(
  selector: { channelId: string } | { type: string; address: string },
): Promise<ChannelIdentity | null> {
  const result = (await ipcCallAssistant("contact_channel_identity_lookup", {
    body: selector,
  })) as { channel?: ChannelIdentity | null };
  return result.channel ?? null;
}

export interface ContactMirrorProbe {
  /** Whether a `contacts` row exists in the assistant mirror. */
  exists: boolean;
  /** Whether the contact has any channels in the assistant mirror. */
  hasChannels: boolean;
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  /** Whether an `assistant_contact_metadata` row exists for the contact. */
  hasMetadata: boolean;
}

/**
 * Probe the assistant mirror for a single contact — presence, channels, info
 * fields, and metadata presence — for the gateway orphan-veto and delete-target
 * decisions.
 */
export async function probeContactMirror(
  contactId: string,
): Promise<ContactMirrorProbe> {
  return (await ipcCallAssistant("contact_mirror_probe", {
    body: { contactId },
  })) as ContactMirrorProbe;
}

/**
 * List the assistant-DB `user_file` slugs matching `prefix%`, for the gateway's
 * collision-suffixed slug allocation.
 */
export async function listContactUserFileSlugs(
  prefix: string,
): Promise<string[]> {
  const result = (await ipcCallAssistant("contact_user_file_slugs", {
    body: { prefix },
  })) as { userFiles?: string[] };
  return result.userFiles ?? [];
}
