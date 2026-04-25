/**
 * IPC route definitions for contact reads and writes.
 *
 * Exposes gateway-owned contact data (auth/authz) to the assistant
 * daemon over the IPC socket. Write methods support the dual-write
 * pattern: the assistant writes to its own DB first, then syncs
 * ingress-relevant fields to the gateway via these IPC routes.
 */

import { z } from "zod";

import type {
  UpsertContactChannelParams,
  UpsertContactParams,
} from "../db/contact-store.js";
import { ContactStore } from "../db/contact-store.js";
import { getLogger } from "../logger.js";
import type { IpcRoute } from "./server.js";

const log = getLogger("contact-ipc");

let store: ContactStore | null = null;

function getStore(): ContactStore {
  if (!store) {
    store = new ContactStore();
  }
  return store;
}

// ── Read schemas ─────────────────────────────────────────────────────────────

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

// ── Write schemas ────────────────────────────────────────────────────────────

const ContactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  principalId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ChannelSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  externalUserId: z.string().nullable(),
  externalChatId: z.string().nullable(),
  status: z.string(),
  policy: z.string(),
  verifiedAt: z.number().nullable(),
  verifiedVia: z.string().nullable(),
  inviteId: z.string().nullable(),
  revokedReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number(),
  lastInteraction: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number().nullable(),
});

const UpsertContactWithChannelsSchema = z.object({
  contact: ContactSchema,
  channels: z.array(ChannelSchema),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export const contactRoutes: IpcRoute[] = [
  // ── Reads ──
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

  // ── Writes (dual-write targets) ──
  {
    method: "upsert_contact_with_channels",
    schema: UpsertContactWithChannelsSchema,
    handler: (params?: Record<string, unknown>) => {
      const p = params as z.infer<typeof UpsertContactWithChannelsSchema>;
      getStore().upsertContactWithChannels(
        p.contact as UpsertContactParams,
        p.channels as UpsertContactChannelParams[],
      );
      log.info(
        { contactId: p.contact.id, channelCount: p.channels.length },
        "Dual-write: upserted contact with channels",
      );
      return { success: true };
    },
  },
];
