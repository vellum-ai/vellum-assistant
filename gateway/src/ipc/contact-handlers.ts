/**
 * IPC route definitions for contact reads and writes.
 *
 * Read methods expose gateway-owned contact data to the assistant daemon.
 * The `create_contact` write method upserts a contact+channel via
 * `ContactStore.upsertContact`, which writes the gateway DB (source of truth)
 * and best-effort mirrors to the assistant DB.
 */

import { z } from "zod";

import { ContactStore } from "../db/contact-store.js";
import { getLogger } from "../logger.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";
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
      const { channelType, address, displayName } =
        CreateContactParamsSchema.parse(params);

      // Canonicalize once here; upsertContact canonicalizes internally too, so
      // passing the canonical form keeps a single source of truth.
      // NOTE: `role` is intentionally not honored. Guardian binding is owned by
      // guardian-bootstrap (see ContactStore.upsertContact SECURITY note); a
      // contact created here always gets role="contact".
      const canonicalAddress =
        canonicalizeInboundIdentity(channelType, address) ?? address.trim();
      const effectiveDisplayName = displayName ?? canonicalAddress;

      const store = getStore();
      const { contact } = await store.upsertContact({
        displayName: effectiveDisplayName,
        channels: [
          {
            type: channelType,
            address: canonicalAddress,
            isPrimary: true,
            status: "unverified",
            policy: "allow",
          },
        ],
      });

      const contactId = contact.id;
      // Resolve the channel id from the gateway DB (source of truth). The
      // upsertContact result's channels can be empty when the assistant-DB
      // read-back is unavailable (best-effort), so don't rely on it here.
      const channel = store
        .getChannelsForContact(contactId)
        .find(
          (ch) =>
            ch.type === channelType &&
            ch.address.toLowerCase() === canonicalAddress.toLowerCase(),
        );
      const channelId = channel?.id ?? "";

      log.info(
        { channelType, address: canonicalAddress, contactId, channelId },
        "create_contact: upserted contact + channel via ContactStore",
      );

      return { contactId, channelId };
    },
  },
];
