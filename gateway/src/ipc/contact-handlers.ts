/**
 * IPC route definitions for contact reads and writes.
 *
 * Read methods expose gateway-owned contact data to the assistant daemon.
 * The `create_contact` write method upserts a contact+channel via the
 * assistant DB proxy (raw SQL), so the gateway owns the write path.
 */

import { z } from "zod";

import {
  assistantDbQuery,
  assistantDbRun,
} from "../db/assistant-db-proxy.js";
import { ContactStore } from "../db/contact-store.js";
import { getLogger } from "../logger.js";
import type { IpcRoute } from "./server.js";

const log = getLogger("contact-handlers");

let store: ContactStore | null = null;

function getStore(): ContactStore {
  if (!store) {
    store = new ContactStore();
  }
  return store;
}

const CreateContactParamsSchema = z.object({
  channelType: z.string().min(1),
  address: z.string().min(1),
  role: z.enum(["guardian", "trusted-contact", "unknown"]).optional(),
  displayName: z.string().optional(),
});

const GetContactParamsSchema = z.object({
  contactId: z.string(),
});

const GetContactByChannelParamsSchema = z.object({
  channelType: z.string(),
  externalUserId: z.string(),
});

const GetChannelsForContactParamsSchema = z.object({
  contactId: z.string(),
});

export const contactRoutes: IpcRoute[] = [
  {
    method: "list_contacts",
    handler: () => getStore().listContacts(),
  },
  {
    method: "get_contact",
    schema: GetContactParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const contactId = params?.contactId as string;
      return getStore().getContact(contactId) ?? null;
    },
  },
  {
    method: "get_contact_by_channel",
    schema: GetContactByChannelParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const channelType = params?.channelType as string;
      const externalUserId = params?.externalUserId as string;
      return (
        getStore().getContactByChannel(channelType, externalUserId) ?? null
      );
    },
  },
  {
    method: "get_channels_for_contact",
    schema: GetChannelsForContactParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const contactId = params?.contactId as string;
      return getStore().getChannelsForContact(contactId);
    },
  },
  {
    method: "create_contact",
    schema: CreateContactParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const { channelType, address, role, displayName } =
        CreateContactParamsSchema.parse(params);

      const normalizedAddress = address.toLowerCase().trim();
      const effectiveDisplayName = displayName ?? normalizedAddress;
      // Map prompt roles to valid ContactRole values ("guardian" | "contact").
      const effectiveRole: string =
        role === "guardian" ? "guardian" : "contact";
      const now = Date.now();

      // Check if a channel with this (type, address) already exists.
      const existing = await assistantDbQuery<{
        channelId: string;
        contactId: string;
      }>(
        `SELECT cc.id AS channelId, cc.contact_id AS contactId
         FROM contact_channels cc
         WHERE cc.type = ? AND cc.address = ?
         LIMIT 1`,
        [channelType, normalizedAddress],
      );

      if (existing.length > 0) {
        const { channelId, contactId } = existing[0];
        log.info(
          { channelType, address: normalizedAddress, contactId, channelId },
          "create_contact: channel already exists, returning existing record",
        );
        return { contactId, channelId };
      }

      // Create a new contact + channel.
      // Two separate INSERTs — use a compensating DELETE on channel failure.
      const contactId = crypto.randomUUID();
      const channelId = crypto.randomUUID();

      await assistantDbRun(
        `INSERT INTO contacts (id, display_name, role, contact_type, interaction_count, created_at, updated_at)
         VALUES (?, ?, ?, 'human', 0, ?, ?)`,
        [contactId, effectiveDisplayName, effectiveRole, now, now],
      );

      try {
        await assistantDbRun(
          `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'unverified', 'allow', 0, ?, ?)`,
          [channelId, contactId, channelType, normalizedAddress, now, now],
        );
      } catch (channelErr) {
        // Compensating delete — remove the orphaned contact row.
        log.error(
          { channelErr, contactId, channelType, address: normalizedAddress },
          "create_contact: channel INSERT failed, rolling back contact row",
        );
        await assistantDbRun("DELETE FROM contacts WHERE id = ?", [contactId]);
        throw channelErr;
      }

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId, role: effectiveRole },
        "create_contact: created new contact + channel",
      );

      return { contactId, channelId };
    },
  },
];
