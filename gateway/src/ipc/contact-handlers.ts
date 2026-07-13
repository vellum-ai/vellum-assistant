/**
 * IPC route definitions for contact reads and writes.
 *
 * Read methods expose gateway-owned contact data to the assistant daemon.
 * The `create_contact` write method upserts a contact+channel via
 * `ContactStore.upsertContact`, which writes the gateway DB (source of truth)
 * and best-effort mirrors to the assistant DB.
 */

import {
  GetContactIpcParamsSchema,
  GetGuardianContactIpcParamsSchema,
  GetGuardianContactIpcResponseSchema,
  ListContactsIpcParamsSchema,
  MarkChannelRevokedIpcParamsSchema,
  MarkChannelRevokedIpcResponseSchema,
  MergeContactsIpcParamsSchema,
  UpdateContactChannelIpcParamsSchema,
  UpsertVerifiedChannelIpcParamsSchema,
  UpsertVerifiedChannelIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";
import { z } from "zod";

import { ContactStore } from "../db/contact-store.js";
import {
  mergeContactsCore,
  updateContactChannelCore,
} from "../http/routes/contacts-control-plane-proxy.js";
import { getLogger } from "../logger.js";
import {
  getGatewayChannelByKey,
  upsertVerifiedContactChannel,
} from "../verification/contact-helpers.js";
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
  // Rich reads expose the shared ContactRead shape (gateway ACL + assistant
  // info) for the daemon's list/get relay. Additive — the lean list_contacts /
  // get_contact methods above stay for gateway-internal callers.
  {
    method: "contacts_list_rich",
    schema: ListContactsIpcParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const parsed = ListContactsIpcParamsSchema.parse(params);
      const contacts = await getStore().listContactsRich(parsed);
      return { ok: true, contacts };
    },
  },
  {
    method: "contacts_get_rich",
    schema: GetContactIpcParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const { contactId } = GetContactIpcParamsSchema.parse(params);
      const result = await getStore().getContactRich(contactId);
      // Return null on miss (mirrors get_contact); the daemon relay maps a
      // null/not-found result to a 404.
      if (!result) return null;
      return {
        ok: true,
        contact: result.contact,
        ...(result.assistantMetadata
          ? { assistantMetadata: result.assistantMetadata }
          : {}),
      };
    },
  },
  {
    // Exposes the guardian contact id(s) from the gateway DB (source of truth)
    // so the daemon can determine the guardian without reading the local
    // contacts.role column.
    method: "get_guardian_contact",
    schema: GetGuardianContactIpcParamsSchema,
    handler: () => {
      const guardianIds = getStore().listGuardianContactIds();
      return GetGuardianContactIpcResponseSchema.parse({
        ok: true,
        guardianIds,
      });
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

      const store = getStore();
      // Omit displayName when the caller didn't supply one: upsertContact is
      // omit-to-preserve, so an existing contact keeps its current name and a
      // brand-new contact falls back to the canonical address. Passing a
      // synthesized name here would clobber a custom name on retry.
      //
      // Omit status/policy/externalChatId: syncChannels and the assistant-DB
      // mirror default a new channel but preserve an existing channel's values
      // on retry. Passing them here would demote a trusted channel below the
      // trusted_contacts admission floor (mirrors verification/contact-helpers)
      // or clear a delivery chat id.
      const { contact } = await store.upsertContact({
        displayName,
        channels: [
          {
            type: channelType,
            address: canonicalAddress,
            isPrimary: true,
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
  {
    method: "update_contact_channel",
    schema: UpdateContactChannelIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = UpdateContactChannelIpcParamsSchema.parse(params);
      // Thrown ContactChannelNativeError carries statusCode/code, which the IPC
      // server's buildErrorResponse mirrors into the wire envelope; unexpected
      // errors propagate as a generic IPC error (no fallback).
      return updateContactChannelCore(parsed);
    },
  },
  {
    method: "merge_contacts",
    schema: MergeContactsIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = MergeContactsIpcParamsSchema.parse(params);
      // Thrown MergeContactsError carries statusCode/code, which the IPC
      // server's buildErrorResponse mirrors into the wire envelope; unexpected
      // errors propagate as a generic IPC error (no fallback).
      return mergeContactsCore(parsed);
    },
  },
  {
    method: "upsert_verified_channel",
    schema: UpsertVerifiedChannelIpcParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const {
        type,
        address,
        externalChatId,
        displayName,
        username,
        verifiedVia,
        contactId,
        allowRevokedReactivation,
      } = UpsertVerifiedChannelIpcParamsSchema.parse(params);

      const { verified } = await upsertVerifiedContactChannel({
        sourceChannel: type,
        externalUserId: address,
        externalChatId,
        displayName,
        username,
        verifiedVia,
        contactId,
        allowRevokedReactivation,
      });

      // A blocked/revoked skip is not an error: surface it as verified:false
      // with no channel rather than throwing.
      if (!verified) {
        return UpsertVerifiedChannelIpcResponseSchema.parse({
          ok: true,
          verified: false,
        });
      }

      // Read the post-write state from the gateway (source of truth) by the
      // canonical logical key the helper writes under.
      const canonicalAddress =
        canonicalizeInboundIdentity(type, address) ?? address;
      const channel = getGatewayChannelByKey(type, canonicalAddress);
      return UpsertVerifiedChannelIpcResponseSchema.parse({
        ok: true,
        verified: true,
        ...(channel ? { channel } : {}),
      });
    },
  },
  {
    method: "mark_channel_revoked",
    schema: MarkChannelRevokedIpcParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const { contactChannelId, reason } =
        MarkChannelRevokedIpcParamsSchema.parse(params);
      const result = await getStore().markChannelRevoked(
        contactChannelId,
        reason,
      );
      if (!result) {
        throw new Error(`Channel "${contactChannelId}" not found`);
      }
      const { channel, didWrite } = result;
      return MarkChannelRevokedIpcResponseSchema.parse({
        ok: true,
        didWrite,
        channel: {
          id: channel.id,
          contactId: channel.contactId,
          type: channel.type,
          address: channel.address,
          status: channel.status,
          revokedReason: channel.revokedReason,
        },
      });
    },
  },
];
