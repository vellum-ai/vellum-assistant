/**
 * Gateway HTTP handlers for the two contact-form submission endpoints.
 *
 * POST /v1/contacts/prompt/submit   an address the guardian typed (binds a channel)
 * POST /v1/contacts/record/submit   a contact record the guardian confirmed
 *
 * Both are the second half of the same rail: the daemon parks a CLI call and
 * broadcasts a form, the guardian submits it in their app, and the client
 * posts here. The daemon never writes contacts; the gateway does, then calls
 * `resolve_contact_prompt` to unblock the parked call. A write reaching this
 * file therefore always carries a human's submit behind it.
 *
 * Auth: edge (same as all ingress contact routes).
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { getGatewayDb } from "../../db/connection.js";
import { ContactStore } from "../../db/contact-store.js";
import {
  contactChannels as gwContactChannels,
  contacts as gwContacts,
} from "../../db/schema.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import { canonicalizeInboundIdentity } from "../../verification/identity.js";
import {
  ContactRecordNativeError,
  deleteContactCore,
  upsertContactRecordCore,
} from "./contacts-control-plane-proxy.js";
import {
  type GuardianFormWriteOutcome,
  submitGuardianForm,
} from "./guardian-form-submit.js";

const log = getLogger("contact-prompt");

/**
 * Guardian-form kinds these routes write for.
 *
 * The daemon opens its forms under the same strings and now rejects a claim
 * that names a different one, so these are a cross-package contract, pinned on
 * both sides by `contact-form-kinds.test.ts`.
 */
export const ADDRESS_FORM = "contacts.address";
export const RECORD_FORM = "contacts.record";

/**
 * The contact forms' own IPC names, which predate the form-agnostic pair. Kept
 * so a gateway running against an older daemon still reaches routes it serves.
 */
const CONTACT_FORM_IPC = {
  claimOperation: "contact_prompt_claim",
  resolveOperation: "resolve_contact_prompt",
} as const;

let store: ContactStore | null = null;

function getStore(): ContactStore {
  if (!store) {
    store = new ContactStore();
  }
  return store;
}

/**
 * Resolve the id of the just-bound channel from the gateway DB (the source of
 * truth `upsertContact` wrote to). Returns "" if not found.
 */
function resolveChannelId(
  contactId: string,
  channelType: string,
  address: string,
): string {
  const channel = getStore()
    .getChannelsForContact(contactId)
    .find(
      (ch) =>
        ch.type === channelType &&
        ch.address.toLowerCase() === address.toLowerCase(),
    );
  return channel?.id ?? "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContactPromptSubmitBody {
  requestId: string;
  address: string;
  channelType: string;
  role?: "guardian" | "trusted-contact" | "unknown";
  displayName?: string;
  /**
   * Whether the guardian left the "mark verified" box checked. The CLI's
   * `--verify` only pre-checks it; this is the answer that decides the write,
   * so what the form showed is what gets attested. Omitted by clients older
   * than the checkbox, which fall back to the parked flag (see
   * {@link promptWantsVerify}).
   */
  verify?: boolean;
  /** The guardian dismissed the form. Unblocks the waiting call without writing. */
  cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleContactPromptSubmit(
  req: Request,
): Promise<Response> {
  let body: ContactPromptSubmitBody;
  try {
    body = (await req.json()) as ContactPromptSubmitBody;
  } catch {
    return Response.json(
      { accepted: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { requestId, address, channelType, role } = body;
  // Treat a non-string displayName (incl. an explicit null) as omitted, so
  // upsertContact preserves an existing contact's name instead of writing the
  // value through to the NOT NULL display_name column (which would 500).
  const displayName =
    typeof body.displayName === "string" ? body.displayName : undefined;

  if (!requestId || typeof requestId !== "string") {
    return Response.json(
      { accepted: false, error: "requestId is required" },
      { status: 400 },
    );
  }
  if (body.cancelled !== true) {
    if (!address || typeof address !== "string") {
      return Response.json(
        { accepted: false, error: "address is required" },
        { status: 400 },
      );
    }
    if (!channelType || typeof channelType !== "string") {
      return Response.json(
        { accepted: false, error: "channelType is required" },
        { status: 400 },
      );
    }
  }

  if (body.cancelled === true) {
    return submitGuardianForm({
      requestId,
      cancelled: true,
      logContext: { form: ADDRESS_FORM },
      formKind: ADDRESS_FORM,
      ...CONTACT_FORM_IPC,
    });
  }

  return submitGuardianForm({
    requestId,
    logContext: { form: ADDRESS_FORM, channelType },
    formKind: ADDRESS_FORM,
    ...CONTACT_FORM_IPC,
    write: () =>
      bindSubmittedChannel({
        requestId,
        address,
        channelType,
        role,
        displayName,
        verify: body.verify,
      }),
  });
}

/**
 * Bind the address the guardian submitted to a contact and a channel.
 *
 * Runs with the form's claim already held, so the submission it is writing is
 * the only one that will land.
 */
async function bindSubmittedChannel(input: {
  requestId: string;
  address: string;
  channelType: string;
  role?: "guardian" | "trusted-contact" | "unknown";
  displayName?: string;
  verify?: boolean;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, address, channelType, role, displayName } = input;

  const normalizedAddress =
    canonicalizeInboundIdentity(channelType, address) ?? address.trim();
  const effectiveDisplayName = displayName ?? normalizedAddress;
  const isGuardian = role === "guardian";
  const now = Date.now();

  let contactId: string;
  let channelId: string;

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Resolve contact
    //
    // Guardian prompts always bind to the existing guardian contact — there
    // must only ever be one.  Non-guardian prompts reuse an existing contact
    // (found via a matching channel address) or create a new one.
    // -----------------------------------------------------------------------
    let createdNewContact = false;

    if (isGuardian) {
      // Guardian lives in the gateway DB (source of truth). Resolve from the
      // gateway DB, not the assistant mirror.
      const guardianRow = getGatewayDb()
        .select({ id: gwContacts.id })
        .from(gwContacts)
        .where(eq(gwContacts.role, "guardian"))
        .orderBy(asc(gwContacts.createdAt))
        .get();
      if (guardianRow) {
        contactId = guardianRow.id;
      } else {
        // Bootstrap hasn't run yet — create the guardian contact gateway-first.
        // upsertContact can't be used here: its create path forces
        // role="contact". Guardian role writes stay raw per the
        // ContactStore.upsertContact SECURITY note, but hit the gateway DB
        // (source of truth) first, then mirror to the assistant DB best-effort.
        log.warn(
          { channelType, address: normalizedAddress },
          "contact-prompt-submit: no guardian contact found, creating one",
        );
        contactId = crypto.randomUUID();
        createdNewContact = true;
        getGatewayDb()
          .insert(gwContacts)
          .values({
            id: contactId,
            displayName: effectiveDisplayName,
            role: "guardian",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        try {
          await ipcCallAssistant("contacts_mirror_upsert_contact", {
            body: {
              contactId,
              displayName: effectiveDisplayName,
              contactType: "human",
            },
          });
        } catch (mirrorErr) {
          log.warn(
            { err: mirrorErr },
            "contact-prompt-submit: assistant DB guardian contact mirror INSERT failed",
          );
        }
      }
    } else {
      // Non-guardian: resolve/create the contact + channel gateway-first via
      // ContactStore.upsertContact. The gateway DB is the source of truth; the
      // assistant DB receives a best-effort mirror.
      const store = getStore();
      const { contact } = await store.upsertContact({
        // omit-to-preserve: pass the caller's optional displayName, NOT
        // effectiveDisplayName. An existing contact keeps its name; a brand-new
        // contact falls back to the canonical channel address inside upsertContact.
        displayName,
        channels: [
          { type: channelType, address: normalizedAddress, isPrimary: true },
        ],
      });
      contactId = contact.id;

      // Invalidate the daemon guardian-id/role caches after the committed
      // gateway contact write — before the read-back guard, so a
      // resolveChannelId miss still drops the stale caches.
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});

      channelId = resolveChannelId(contactId, channelType, normalizedAddress);

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: upserted contact + channel via ContactStore",
      );

      if (!channelId) {
        log.error(
          { channelType, address: normalizedAddress, contactId },
          "contact-prompt-submit: channel resolution failed after upsert",
        );
        return CHANNEL_RESOLUTION_FAILED;
      }

      // Non-guardian is fully resolved by upsertContact; skip the guardian-only
      // Phase 2 channel-creation block below and go straight to resolve.
      return await channelResolution({
        requestId,
        contactId,
        channelId,
        channelType,
        address: normalizedAddress,
        verify: input.verify,
      });
    }

    // -----------------------------------------------------------------------
    // Phase 2: Resolve channel
    //
    // If a channel for (type, address) already points to our contact, reuse it.
    // If it points to a different contact and we are binding as guardian, that
    // is a conflict the caller must resolve — return 409.  Otherwise create a
    // new channel bound to the resolved contact.
    // -----------------------------------------------------------------------
    const existingChannel = getGatewayDb()
      .select({
        id: gwContactChannels.id,
        contactId: gwContactChannels.contactId,
      })
      .from(gwContactChannels)
      .where(
        and(
          eq(gwContactChannels.type, channelType),
          sql`${gwContactChannels.address} = ${normalizedAddress} COLLATE NOCASE`,
        ),
      )
      .get();

    if (existingChannel && existingChannel.contactId === contactId) {
      // Reuse is success-guaranteed: the gateway channel already belongs to
      // this guardian. Best-effort heal the assistant-DB mirror (passing the
      // guardian's id keeps the gateway DB authoritative for role="guardian").
      // The gateway-side syncChannels UPDATE here is incidental — the real
      // purpose is recovering a stale mirror — so a transient gateway error
      // must never fail the request.
      try {
        await getStore().upsertContact({
          id: contactId,
          channels: [
            { type: channelType, address: normalizedAddress, isPrimary: true },
          ],
        });
      } catch (healErr) {
        log.warn(
          { err: healErr, contactId, channelType, address: normalizedAddress },
          "contact-prompt-submit: guardian reuse mirror-heal failed (best-effort), continuing with existing channel",
        );
      }
      channelId = existingChannel.id;
      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: channel already exists",
      );
    } else if (existingChannel) {
      // Channel exists but belongs to a different contact.  The caller must
      // clean up the stale binding before a guardian channel can be created.
      log.warn(
        {
          channelType,
          address: normalizedAddress,
          contactId,
          existingContactId: existingChannel.contactId,
        },
        "contact-prompt-submit: channel already assigned to another contact",
      );
      return {
        failure: {
          error: "Channel already assigned to another contact",
          status: 409,
        },
      };
    } else {
      // Compensating delete — only remove the contact if we created it here.
      // "Stale over lost": delete gateway-first, then mirror the delete to
      // the assistant DB best-effort. Used by both the bind-failure path and
      // the empty-channelId guard below.
      const rollbackCreatedContact = async (): Promise<void> => {
        if (!createdNewContact) return;
        getGatewayDb()
          .delete(gwContacts)
          .where(eq(gwContacts.id, contactId))
          .run();
        try {
          await ipcCallAssistant("contacts_mirror_delete_contact", {
            body: { contactId },
          });
        } catch (mirrorErr) {
          log.warn(
            { err: mirrorErr },
            "contact-prompt-submit: assistant DB contact rollback mirror DELETE failed",
          );
        }
      };

      try {
        // Bind gateway-first. Passing the guardian's id keys the update to the
        // existing guardian; the gateway DB is authoritative for role="guardian"
        // and the channel, and the assistant mirror carries identity/info only.
        await getStore().upsertContact({
          id: contactId,
          channels: [
            { type: channelType, address: normalizedAddress, isPrimary: true },
          ],
        });
        channelId = resolveChannelId(contactId, channelType, normalizedAddress);
      } catch (channelErr) {
        log.error(
          { channelErr, contactId, channelType },
          "contact-prompt-submit: channel bind failed, rolling back contact",
        );
        await rollbackCreatedContact();

        return {
          failure: { error: "Failed to create contact channel", status: 500 },
        };
      }

      if (!channelId) {
        log.error(
          { channelType, address: normalizedAddress, contactId },
          "contact-prompt-submit: channel resolution failed after guardian bind, rolling back contact",
        );
        await rollbackCreatedContact();
        // A freshly-created guardian was just rolled back (net no change). An
        // existing guardian's channel bind committed and is NOT rolled back, so
        // invalidate the daemon caches even though the read-back missed.
        if (!createdNewContact) {
          void ipcCallAssistant("emit_event", {
            body: { kind: "contacts_changed" },
          } as unknown as Record<string, unknown>).catch(() => {});
        }
        return CHANNEL_RESOLUTION_FAILED;
      }

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: created new channel",
      );
    }
  } catch (err) {
    log.error({ err, requestId }, "contact-prompt-submit: DB error");
    return { failure: { error: "Database error", status: 500 } };
  }

  // Invalidate the daemon guardian-id/role caches after a gateway-owned
  // guardian bind/rebind/reuse.
  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});

  return await channelResolution({
    requestId,
    contactId,
    channelId,
    channelType,
    address: normalizedAddress,
    verify: input.verify,
  });
}

/**
 * The read-back after a bind could not find the channel. Reporting an empty
 * channelId would claim success for a channel-less contact.
 */
const CHANNEL_RESOLUTION_FAILED: GuardianFormWriteOutcome = {
  failure: { error: "Channel resolution failed", status: 500 },
};

/**
 * Whether the guardian left the "mark verified" box checked.
 */
async function promptWantsVerify(
  requestId: string,
  submitted: boolean | undefined,
): Promise<boolean> {
  // The checkbox is the answer. `--verify` only pre-checks it, so a guardian
  // who unchecks the box must not get a verified channel.
  if (typeof submitted === "boolean") {
    return submitted;
  }
  // A client with no checkbox sends no answer, so the parked flag stands in
  // for one. Read out of band because such a client has no field to echo it
  // back in.
  try {
    const result = await ipcCallAssistant("contact_prompt_flags", {
      body: { requestId },
    });
    return (result as { verify?: boolean }).verify === true;
  } catch (err) {
    log.warn(
      { err, requestId },
      "contact-prompt-submit: contact_prompt_flags IPC failed; leaving channel unverified",
    );
    return false;
  }
}

/**
 * The outcome for a committed channel bind, attesting it first if the guardian
 * asked for that.
 */
async function channelResolution(args: {
  requestId: string;
  contactId: string;
  channelId: string;
  channelType: string;
  address: string;
  verify: boolean | undefined;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, contactId, channelId, channelType, address } = args;
  // What the channel ends up as, not what was asked for: the guardian's box
  // decides, an attest that fails leaves it unverified, and an address that
  // reuses an already verified channel stays verified whether or not this
  // submission asked for it.
  let verified = false;
  if (await promptWantsVerify(requestId, args.verify)) {
    try {
      // A resolved row means the channel is attested, whether this call is what
      // wrote it or it already was.
      verified = (await getStore().markChannelVerified(channelId)) !== null;
    } catch (err) {
      // The binding is already committed, so a failed attest is a channel that
      // exists as it stood, not a failed submission. Read the channel rather
      // than assuming unverified: attesting one that already was leaves it
      // verified, and reporting otherwise invents a downgrade.
      log.error(
        { err, requestId, contactId, channelId },
        "contact-prompt-submit: attesting the channel threw",
      );
      verified = isChannelVerified(contactId, channelId);
    }
    if (!verified) {
      log.warn(
        { requestId, contactId, channelId },
        "contact-prompt-submit: verification was requested but the channel could not be attested",
      );
    }
  } else {
    verified = isChannelVerified(contactId, channelId);
  }

  return {
    resolution: { contactId, channelId, channelType, address, verified },
  };
}

// ---------------------------------------------------------------------------
// Record submissions (create / update / delete)
// ---------------------------------------------------------------------------

interface ContactRecordSubmitBody {
  requestId: string;
  operation?: "create" | "update" | "delete";
  contactId?: string;
  displayName?: string;
  notes?: string | null;
  /** The channels the delete confirmation listed. */
  expectedChannels?: Array<{ type: string; address: string }>;
  /** The guardian dismissed the form. Unblocks the CLI instead of writing. */
  cancelled?: boolean;
}

/**
 * POST /v1/contacts/record/submit
 *
 * The record half of the contact-form rail: the guardian confirmed (and may
 * have edited) a create, update, or delete the assistant proposed. Writes it,
 * then unblocks the parked CLI call.
 *
 * The submitted operation is trusted as posted rather than checked against the
 * parked proposal. A caller who can reach this route can already reach
 * `POST /v1/contacts` and `DELETE /v1/contacts/:id` at the same edge auth, so
 * a readback would buy no privilege, only a round trip.
 */
export async function handleContactRecordSubmit(
  req: Request,
): Promise<Response> {
  let body: ContactRecordSubmitBody;
  try {
    body = (await req.json()) as ContactRecordSubmitBody;
  } catch {
    return Response.json(
      { accepted: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { requestId, operation, contactId } = body;

  if (!requestId || typeof requestId !== "string") {
    return Response.json(
      { accepted: false, error: "requestId is required" },
      { status: 400 },
    );
  }

  // Dismissal is a real answer: resolve the parked call now rather than
  // leaving the CLI to time out on a form nobody is going to submit. It takes
  // the same claim as a write, because one client dismissing while another is
  // mid-submit would otherwise tell the caller nothing happened while the
  // other answer was still on its way to the database.
  if (body.cancelled === true) {
    return submitGuardianForm({
      requestId,
      cancelled: true,
      logContext: { form: RECORD_FORM },
      formKind: RECORD_FORM,
      ...CONTACT_FORM_IPC,
    });
  }

  if (
    operation !== "create" &&
    operation !== "update" &&
    operation !== "delete"
  ) {
    return Response.json(
      {
        accepted: false,
        error: 'operation must be one of: "create", "update", "delete"',
      },
      { status: 400 },
    );
  }

  if (operation !== "create" && (!contactId || typeof contactId !== "string")) {
    return Response.json(
      { accepted: false, error: `contactId is required to ${operation}` },
      { status: 400 },
    );
  }

  // A non-string displayName (an explicit null included) reads as omitted, so
  // upsertContactRecordCore preserves an existing name rather than writing the
  // value through to the NOT NULL display_name column.
  const displayName =
    typeof body.displayName === "string" ? body.displayName : undefined;

  return submitGuardianForm({
    requestId,
    logContext: { form: RECORD_FORM, operation, contactId },
    formKind: RECORD_FORM,
    ...CONTACT_FORM_IPC,
    write: () =>
      writeContactRecord({
        requestId,
        operation,
        contactId,
        displayName,
        notes: body.notes,
        expectedChannels: Array.isArray(body.expectedChannels)
          ? body.expectedChannels
          : undefined,
      }),
  });
}

/**
 * Apply the record write the guardian confirmed.
 *
 * Runs with the form's claim already held: the form is broadcast to every
 * connected client, so without it a second one could answer with the values it
 * was seeded with and overwrite the answer the guardian actually gave.
 */
async function writeContactRecord(input: {
  requestId: string;
  operation: "create" | "update" | "delete";
  contactId?: string;
  displayName?: string;
  notes?: string | null;
  expectedChannels?: Array<{ type: string; address: string }>;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, operation, contactId, displayName, notes } = input;

  try {
    if (operation === "delete") {
      // Deleting cascades the contact's channels, and the confirmation listed
      // the ones it had when the form opened. The core compares them against
      // the contact's channels in the same transaction as the delete, so a
      // channel reparented in between (an invite redeemed, say) is not
      // cascaded away unseen.
      await deleteContactCore(contactId!, input.expectedChannels);
      log.info({ requestId, contactId }, "contact-record-submit: deleted");
      return { resolution: { contactId } };
    }

    const { contact, notesSaved, nothingWritten } =
      await upsertContactRecordCore({
        operation,
        contactId: operation === "update" ? contactId : undefined,
        displayName,
        notes,
      });
    const writtenId = contact.id as string;
    log.info(
      { requestId, contactId: writtenId, operation },
      "contact-record-submit: wrote contact record",
    );
    return { resolution: { contactId: writtenId, notesSaved, nothingWritten } };
  } catch (err) {
    if (err instanceof ContactRecordNativeError) {
      return { failure: { error: err.message, status: err.statusCode } };
    }
    log.error({ err, requestId, operation }, "contact-record-submit: failed");
    return { failure: { error: "Contact write failed", status: 500 } };
  }
}

/**
 * Whether the channel already carries an attestation.
 *
 * Read rather than assumed, so a submission that reuses a verified channel
 * without asking for verification reports what the channel is.
 */
function isChannelVerified(contactId: string, channelId: string): boolean {
  try {
    const channel = getStore()
      .getChannelsForContact(contactId)
      .find((ch) => ch.id === channelId);
    return channel?.verifiedAt != null;
  } catch (err) {
    log.warn(
      { err, contactId, channelId },
      "contact-prompt-submit: could not read the channel's verification state",
    );
    return false;
  }
}
