/**
 * IPC-only contact identity-mirror methods called by the gateway over the
 * assistant IPC socket (`ipcCallAssistant`).
 *
 * The gateway DB owns the ACL verdict; these handlers write only the local
 * identity/info mirror (contact + channel display fields). They replace the
 * gateway's former raw `assistantDbRun` single-row mirror writes, running on
 * top of the `contact-store` upsert/delete primitives, which write info-only
 * columns and never touch the gateway-owned ACL columns.
 *
 * No HTTP surface: registered directly on the IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array.
 */

import { z } from "zod";

import { deleteContact, upsertContact } from "../../contacts/contact-store.js";
import { upsertContactChannel } from "../../contacts/contacts-write.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

const ContactTypeSchema = z.enum(["human", "assistant"]);

const UpsertChannelParamsSchema = z.object({
  contactId: z.string().min(1).optional(),
  // Gateway-minted channel id for a NEW channel: reused verbatim so the mirror
  // row and the gateway row share an id (id-keyed gateway read-backs match).
  channelId: z.string().min(1).optional(),
  type: z.string().min(1),
  address: z.string().min(1),
  // Omit to preserve an existing channel's external_chat_id; an explicit value
  // overwrites; a new channel defaults to null.
  externalChatId: z.string().min(1).optional(),
  displayName: z.string().optional(),
  contactType: ContactTypeSchema.optional(),
  notes: z.string().optional(),
  // Inbound identity-seed callers set this so a changed platform profile name
  // refreshes the mirror; invite-binding callers omit it to preserve a curated
  // name.
  refreshDisplayName: z.boolean().optional(),
  // Reparent a conflicting (type,address) channel owned by another contact to
  // this one. Invite/verified binding sets true; the inbound identity-seed
  // mirror sets false to match the gateway insert's onConflictDoNothing (a
  // first-seen race must not steal the channel from the contact the gateway
  // kept). Omitted → the primitive defaults to `!!contactId`.
  reassignConflictingChannels: z.boolean().optional(),
});

/**
 * Upsert a contact + channel identity row, faithfully replicating gateway
 * identity: it reuses the gateway-minted channel id for a new channel,
 * optionally re-parents a channel whose (type,address) belongs to another
 * contact (`reassignConflictingChannels`; invite/verified binding only —
 * inbound seeds pass false to match the gateway insert's onConflictDoNothing),
 * refreshes external_chat_id, and — for a mirror-created contact — leaves
 * user_file NULL (never a generated persona-file stub). The display name is
 * refreshed for inbound seeds (`refreshDisplayName`) and preserved for the
 * invite-binding path.
 */
export function handleContactsMirrorUpsertChannel({
  body = {},
}: RouteHandlerArgs) {
  const params = UpsertChannelParamsSchema.parse(body);
  upsertContactChannel({
    sourceChannel: params.type,
    externalUserId: params.address,
    externalChatId: params.externalChatId,
    displayName: params.displayName,
    contactId: params.contactId,
    channelId: params.channelId,
    contactType: params.contactType,
    notes: params.notes,
    refreshDisplayName: params.refreshDisplayName,
    reassignConflictingChannels: params.reassignConflictingChannels,
    // The mirror never seeds a persona file: a mirror-created contact keeps
    // user_file NULL, matching the gateway's former raw INSERT.
    userFileOnCreate: null,
  });
  return { ok: true };
}

const UpsertContactParamsSchema = z.object({
  contactId: z.string().min(1),
  displayName: z.string().min(1),
  contactType: ContactTypeSchema.optional(),
  notes: z.string().optional(),
});

/**
 * Upsert an identity/display contact row (no channel). Used where the gateway
 * creates a contact whose channel is bound separately (e.g. the guardian
 * contact-prompt bootstrap). `userFile` is left null to match the gateway's
 * former raw INSERT — the mirror never seeds a persona file.
 */
export function handleContactsMirrorUpsertContact({
  body = {},
}: RouteHandlerArgs) {
  const params = UpsertContactParamsSchema.parse(body);
  upsertContact({
    id: params.contactId,
    displayName: params.displayName,
    contactType: params.contactType,
    notes: params.notes,
    userFile: null,
  });
  return { ok: true };
}

const DeleteContactParamsSchema = z.object({
  contactId: z.string().min(1),
});

/**
 * Delete a contact identity row from the mirror (channels cascade). Replaces
 * the gateway's orphan-GC / rollback / delete raw mirror writes.
 */
export function handleContactsMirrorDeleteContact({
  body = {},
}: RouteHandlerArgs) {
  const params = DeleteContactParamsSchema.parse(body);
  deleteContact(params.contactId);
  return { ok: true };
}

/**
 * IPC-only contact identity-mirror methods, keyed by IPC operationId.
 * Registered directly on the assistant IPC server (see `assistant-server.ts`).
 */
export const CONTACTS_MIRROR_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  contacts_mirror_upsert_channel: handleContactsMirrorUpsertChannel,
  contacts_mirror_upsert_contact: handleContactsMirrorUpsertContact,
  contacts_mirror_delete_contact: handleContactsMirrorDeleteContact,
};
