/**
 * IPC route definitions for contact reads.
 *
 * Exposes gateway-owned contact data (auth/authz) to the assistant
 * daemon over the IPC socket. All methods are read-only.
 */

import { z } from "zod";

import { ContactStore } from "../db/contact-store.js";
import type { IpcRoute } from "./server.js";

let store: ContactStore | null = null;

function getStore(): ContactStore {
  if (!store) {
    store = new ContactStore();
  }
  return store;
}

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
];
