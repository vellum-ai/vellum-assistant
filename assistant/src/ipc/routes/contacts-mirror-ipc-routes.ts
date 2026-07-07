/**
 * IPC-only contact identity-mirror methods called by the gateway over the
 * assistant IPC socket (`ipcCallAssistant`).
 *
 * The gateway DB owns the ACL verdict; these handlers write only the local
 * identity/info mirror (contact + channel display fields), running on top of
 * the `contact-store` upsert/delete primitives, which write info-only columns
 * and never touch the gateway-owned ACL columns.
 *
 * No HTTP surface: registered directly on the IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array.
 */

import { z } from "zod";

import {
  deleteContact,
  mergeContactMirror,
  upsertContact,
  upsertContactMirrorFull,
} from "../../contacts/contact-store.js";
import { upsertContactChannel } from "../../contacts/contacts-write.js";
import { getDb } from "../../persistence/db-connection.js";
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
  // Mark the channel primary. The guardian-bootstrap mirror sets true so its
  // sole channel keeps the primary flag the gateway binding assigns; omitted
  // callers leave the flag untouched (existing) or default false (new).
  isPrimary: z.boolean().optional(),
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
  applyUpsertChannel(UpsertChannelParamsSchema.parse(body));
  return { ok: true };
}

/** Run the channel upsert primitive for an already-parsed op payload. */
function applyUpsertChannel(
  params: z.infer<typeof UpsertChannelParamsSchema>,
): void {
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
    isPrimary: params.isPrimary,
    // The mirror never seeds a persona file: a mirror-created contact keeps
    // user_file NULL.
    userFileOnCreate: null,
  });
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
 * contact-prompt bootstrap). `userFile` is left null — the mirror never seeds
 * a persona file.
 */
export function handleContactsMirrorUpsertContact({
  body = {},
}: RouteHandlerArgs) {
  applyUpsertContact(UpsertContactParamsSchema.parse(body));
  return { ok: true };
}

/** Run the contact upsert primitive for an already-parsed op payload. */
function applyUpsertContact(
  params: z.infer<typeof UpsertContactParamsSchema>,
): void {
  upsertContact({
    id: params.contactId,
    displayName: params.displayName,
    contactType: params.contactType,
    notes: params.notes,
    userFile: null,
  });
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
  applyDeleteContact(DeleteContactParamsSchema.parse(body));
  return { ok: true };
}

/** Run the contact delete primitive for an already-parsed op payload. */
function applyDeleteContact(
  params: z.infer<typeof DeleteContactParamsSchema>,
): void {
  deleteContact(params.contactId);
}

const UpsertFullChannelSchema = z.object({
  // Gateway-minted channel id, adopted on INSERT so both stores share one
  // canonical id for the same logical channel; omit to mint one.
  id: z.string().min(1).optional(),
  type: z.string().min(1),
  address: z.string().min(1),
  isPrimary: z.boolean().optional(),
  // Omit to preserve an existing channel's external_chat_id; explicit null
  // clears it; a new channel defaults to null.
  externalChatId: z.string().nullable().optional(),
});

const UpsertFullParamsSchema = z.object({
  contactId: z.string().min(1),
  // Sparse: omitted on update preserves the mirror's name; a create falls
  // back to the first channel address, then "Unknown".
  displayName: z.string().optional(),
  contactType: ContactTypeSchema.optional(),
  notes: z.string().nullable().optional(),
  assistantMetadata: z
    .object({
      species: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
  channels: z.array(UpsertFullChannelSchema).optional(),
});

/**
 * Full contact + channels identity-mirror upsert — the typed replacement for
 * the gateway's raw dual-write (`dualWriteContactToAssistantDb`). One daemon
 * transaction; sparse omit-to-preserve update, slug-resolved user_file on
 * create, assistant_contact_metadata upsert, and channel conflict-skip /
 * gateway-id-adoption sync (see `upsertContactMirrorFull`).
 */
export function handleContactsMirrorUpsertFull({
  body = {},
}: RouteHandlerArgs) {
  upsertContactMirrorFull(UpsertFullParamsSchema.parse(body));
  return { ok: true };
}

const MergeContactParamsSchema = z.object({
  keepContactId: z.string().min(1),
  mergeContactId: z.string().min(1),
  // Survivor identity for the dual-write-gap INSERT (survivor row missing from
  // the mirror); ignored when the survivor exists — the merge never clobbers
  // an existing display name or user_file.
  keepDisplayName: z.string().min(1),
  // Gateway-resolved user_file slug for that same INSERT (principal-sibling
  // reuse needs the gateway DB, so the daemon can't resolve it here).
  resolvedUserFile: z.string().min(1).optional(),
});

/**
 * Atomically mirror a gateway contact merge: concat donor notes onto the
 * survivor, reparent donor channels by (type, address NOCASE), delete the
 * donor — one daemon-DB transaction, so the mirror is never left partially
 * merged. A donor already gone is a no-op success (idempotent gateway retry).
 */
export function handleContactsMirrorMergeContact({
  body = {},
}: RouteHandlerArgs) {
  const params = MergeContactParamsSchema.parse(body);
  if (params.keepContactId === params.mergeContactId) {
    throw new Error("keepContactId and mergeContactId must differ");
  }
  mergeContactMirror(params);
  return { ok: true };
}

/**
 * A single identity-mirror operation, tagged by `op`. Each variant reuses the
 * exact zod schema (and applier) of the corresponding single-row method, so the
 * per-op semantics are identical — the only added guarantee is atomicity across
 * ops.
 */
const MirrorOpSchema = z.discriminatedUnion("op", [
  UpsertChannelParamsSchema.extend({ op: z.literal("upsert_channel") }),
  UpsertContactParamsSchema.extend({ op: z.literal("upsert_contact") }),
  DeleteContactParamsSchema.extend({ op: z.literal("delete_contact") }),
]);

const ApplyParamsSchema = z.object({
  ops: z.array(MirrorOpSchema).min(1),
});

/**
 * Apply an ordered batch of identity-mirror ops in ONE daemon-side transaction.
 * Every op runs against the same connection between BEGIN and COMMIT, so a
 * mid-batch failure rolls back the entire batch — the mirror is never left
 * partially applied. Used by the gateway's transactional mirror sites
 * (guardian bootstrap) whose several writes must land atomically.
 */
export function handleContactsMirrorApply({ body = {} }: RouteHandlerArgs) {
  const { ops } = ApplyParamsSchema.parse(body);
  getDb().transaction(() => {
    for (const op of ops) {
      switch (op.op) {
        case "upsert_channel":
          applyUpsertChannel(op);
          break;
        case "upsert_contact":
          applyUpsertContact(op);
          break;
        case "delete_contact":
          applyDeleteContact(op);
          break;
      }
    }
  });
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
  contacts_mirror_upsert_full: handleContactsMirrorUpsertFull,
  contacts_mirror_delete_contact: handleContactsMirrorDeleteContact,
  contacts_mirror_merge_contact: handleContactsMirrorMergeContact,
  contacts_mirror_apply: handleContactsMirrorApply,
};
