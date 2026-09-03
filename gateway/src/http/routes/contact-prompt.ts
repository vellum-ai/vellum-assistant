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
import { ContactStore, MergeContactsError } from "../../db/contact-store.js";
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
  mergeContactsCore,
  notesReachedMirror,
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
  /**
   * The contact the broadcast named as the binding target, echoed back. The
   * parked form is authoritative; this stands in when it cannot be read.
   */
  contactId?: string;
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
  // A non-string contactId reads as omitted, leaving the parked form to say
  // what this submission binds to.
  const echoedContactId =
    typeof body.contactId === "string" ? body.contactId : undefined;

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
        contactId: echoedContactId,
        verify: body.verify,
      }),
  });
}

/** What the daemon reports a parked address form was opened with. */
interface ParkedPromptTarget {
  /**
   * Whether a form is still parked under the id. A daemon that predates the
   * field sends none, so only an explicit false says the form is gone.
   */
  known?: boolean;
  verify?: boolean;
  contactId?: string;
  displayName?: string;
  notes?: string;
}

/**
 * What the parked form says this submission is for.
 *
 * Read from the daemon rather than taken from the client, so a client that
 * does not send the target fields still binds where the command said. Returns
 * null when the daemon could not be reached, which leaves the client's echo as
 * the only thing the caller has to bind by.
 */
async function readParkedPromptTarget(
  requestId: string,
): Promise<ParkedPromptTarget | null> {
  try {
    const result = await ipcCallAssistant("contact_prompt_flags", {
      body: { requestId },
    });
    // A daemon that answers with no object leaves nothing to read the target
    // from, which is the same position as an unreachable one.
    return result && typeof result === "object"
      ? (result as ParkedPromptTarget)
      : null;
  } catch (err) {
    log.warn(
      { err, requestId },
      "contact-prompt-submit: contact_prompt_flags IPC failed; the parked target is unreadable",
    );
    return null;
  }
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
  contactId?: string;
  verify?: boolean;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, address, channelType, role, displayName } = input;

  const normalizedAddress =
    canonicalizeInboundIdentity(channelType, address) ?? address.trim();

  const parked = await readParkedPromptTarget(requestId);

  // An untargeted form and a targeted one whose target cannot be read look
  // identical from here, so resolving from the address risks handing the
  // address to a contact other than the one the guardian's card named. The
  // claim this write holds was granted moments ago, which makes an unreadable
  // target an anomaly worth refusing: nothing is written and the guardian can
  // submit again. A daemon holding no such form answers known:false, which is
  // what a restart between the claim and this read leaves behind.
  const parkedTargetUnreadable = parked === null || parked.known === false;
  if (parkedTargetUnreadable && !input.contactId) {
    log.error(
      { requestId, channelType, address: normalizedAddress, parked },
      "contact-prompt-submit: the parked target is unreadable and the client echoed none",
    );
    return {
      failure: {
        error:
          "Could not read the form's target from the assistant. Nothing was written; try again.",
        status: 503,
      },
    };
  }

  const parkedVerify = parked?.verify;
  // The command fixes the target and the form cannot edit it, so a readable
  // parked form is the only word on it: a readable form naming no target means
  // there is none, and an echo is honored only when that form cannot be read.
  // The name is the form's own field, so the submitted one leads and the parked
  // value stands in for a client with nowhere to type it.
  const targetContactId = parkedTargetUnreadable
    ? input.contactId
    : parked?.contactId;
  const proposedName = displayName ?? parked?.displayName;
  const proposedNotes = parked?.notes;

  try {
    // A named target decides the bind, whatever role the client sent: the form
    // showed that contact, so binding the address anywhere else would grant an
    // identity the guardian never saw. The target's row is read before the
    // upsert because upsertContact INSERTs an unknown explicit id, which would
    // mint a stray contact for a typo'd one.
    if (targetContactId) {
      const target = getStore().getContact(targetContactId);

      if (!target) {
        log.warn(
          { requestId, contactId: targetContactId, channelType },
          "contact-prompt-submit: the form's target contact does not exist",
        );
        return {
          failure: {
            error: `Contact "${targetContactId}" not found. Run 'assistant contacts list' to find contact ids.`,
            status: 404,
          },
        };
      }

      return await bindChannelToContact({
        requestId,
        contactId: target.id,
        contactDisplayName: target.displayName,
        channelType,
        address: normalizedAddress,
        verify: input.verify,
        parkedVerify,
        conflictHint: MERGE_HINT,
      });
    }

    if (role === "guardian") {
      return await bindGuardianChannel({
        requestId,
        channelType,
        address: normalizedAddress,
        displayName: proposedName,
        notes: proposedNotes,
        verify: input.verify,
        parkedVerify,
      });
    }

    // Any proposal is intent to create the contact, so the address turning out
    // to belong to somebody else is a conflict here rather than the silent
    // rewrite of that contact an upsert matching on the channel would do.
    // Notes count as a proposal: they land on whichever contact the upsert
    // resolves to, which for a matched address is a bystander's record.
    if (proposedName !== undefined || proposedNotes !== undefined) {
      const existingChannel = findChannelByAddress(
        channelType,
        normalizedAddress,
      );
      if (existingChannel) {
        log.warn(
          {
            requestId,
            channelType,
            address: normalizedAddress,
            existingContactId: existingChannel.contactId,
          },
          "contact-prompt-submit: the proposed contact's address belongs to another contact",
        );
        return channelOwnedByAnotherContact(
          existingChannel.contactId,
          channelType,
          MERGE_HINT,
        );
      }

      return await bindAddressToItsOwnContact({
        requestId,
        channelType,
        address: normalizedAddress,
        displayName: proposedName,
        notes: proposedNotes,
        verify: input.verify,
        parkedVerify,
      });
    }

    // Nothing was proposed, so the address speaks for itself: the contact that
    // holds it, or a new one named after it.
    return await bindAddressToItsOwnContact({
      requestId,
      channelType,
      address: normalizedAddress,
      verify: input.verify,
      parkedVerify,
    });
  } catch (err) {
    log.error({ err, requestId }, "contact-prompt-submit: DB error");
    return { failure: { error: "Database error", status: 500 } };
  }
}

/**
 * Bind the address to the guardian contact, minting that contact when
 * bootstrap has not yet run. There must only ever be one.
 *
 * The proposed name and notes seed a guardian this bind mints. A guardian that
 * already exists keeps both: the form is about the address, and rewriting the
 * record behind it is what `contacts update` confirms separately.
 */
async function bindGuardianChannel(args: {
  requestId: string;
  channelType: string;
  address: string;
  displayName?: string;
  notes?: string;
  verify: boolean | undefined;
  parkedVerify: boolean | undefined;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, channelType, address, displayName, notes } = args;

  // The guardian lives in the gateway DB (source of truth), so resolve from
  // there rather than from the assistant mirror.
  const guardianRow = getGatewayDb()
    .select({ id: gwContacts.id })
    .from(gwContacts)
    .where(eq(gwContacts.role, "guardian"))
    .orderBy(asc(gwContacts.createdAt))
    .get();

  if (guardianRow) {
    return await bindChannelToContact({
      requestId,
      contactId: guardianRow.id,
      channelType,
      address,
      verify: args.verify,
      parkedVerify: args.parkedVerify,
      conflictHint: GUARDIAN_CONFLICT_HINT,
    });
  }

  // Bootstrap has not run, so create the guardian contact gateway-first.
  // upsertContact can't be used here: its create path forces role="contact".
  // Guardian role writes stay raw per the ContactStore.upsertContact SECURITY
  // note, but hit the gateway DB (source of truth) first, then mirror to the
  // assistant DB best-effort.
  log.warn(
    { channelType, address },
    "contact-prompt-submit: no guardian contact found, creating one",
  );
  const now = Date.now();
  const contactId = crypto.randomUUID();
  const effectiveDisplayName = displayName ?? address;
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
        // Notes are assistant-owned, so the mirror is the only side that has
        // a column for them.
        notes,
      },
    });
  } catch (mirrorErr) {
    log.warn(
      { err: mirrorErr },
      "contact-prompt-submit: assistant DB guardian contact mirror INSERT failed",
    );
  }

  return await bindChannelToContact({
    requestId,
    contactId,
    channelType,
    address,
    verify: args.verify,
    parkedVerify: args.parkedVerify,
    conflictHint: GUARDIAN_CONFLICT_HINT,
    // Compensating delete for the contact this bind was created for.
    // "Stale over lost": delete gateway-first, then mirror the delete to the
    // assistant DB best-effort.
    onRollback: async () => {
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
    },
  });
}

/**
 * Attach the address to a contact that already exists.
 *
 * A channel the contact already holds for the address is reused; one another
 * contact holds is a conflict, since reassigning it would move an admitted
 * address out from under whoever it belongs to.
 *
 * `onRollback` undoes a contact minted for this bind. Its absence is what
 * makes a missed read-back still worth a cache invalidation: the contact
 * predates the bind, so the committed channel write stands.
 */
async function bindChannelToContact(args: {
  requestId: string;
  contactId: string;
  /**
   * The contact's stored name. Carried into the mirror writes so a repair of a
   * missing mirror row names it, rather than falling back to the address.
   */
  contactDisplayName?: string;
  channelType: string;
  address: string;
  verify: boolean | undefined;
  parkedVerify: boolean | undefined;
  onRollback?: () => Promise<void>;
  conflictHint: string;
}): Promise<GuardianFormWriteOutcome> {
  const {
    requestId,
    contactId,
    contactDisplayName,
    channelType,
    address,
    onRollback,
  } = args;

  const existingChannel = findChannelByAddress(channelType, address);
  let channelId: string;

  if (existingChannel && existingChannel.contactId === contactId) {
    // Reuse is success-guaranteed: the gateway channel already belongs to this
    // contact. Best-effort heal the assistant-DB mirror (passing the contact's
    // id keys the update to it, keeping the gateway DB authoritative). The
    // gateway-side syncChannels UPDATE here is incidental, the real purpose is
    // recovering a stale mirror, so a transient gateway error must never fail
    // the request.
    try {
      await getStore().upsertContact({
        id: contactId,
        displayName: contactDisplayName,
        channels: [{ type: channelType, address, isPrimary: true }],
      });
    } catch (healErr) {
      log.warn(
        { err: healErr, contactId, channelType, address },
        "contact-prompt-submit: reuse mirror-heal failed (best-effort), continuing with existing channel",
      );
    }
    channelId = existingChannel.id;
    log.info(
      { channelType, address, contactId, channelId },
      "contact-prompt-submit: channel already exists",
    );
  } else if (existingChannel) {
    log.warn(
      {
        channelType,
        address,
        contactId,
        existingContactId: existingChannel.contactId,
      },
      "contact-prompt-submit: channel already assigned to another contact",
    );
    return channelOwnedByAnotherContact(
      existingChannel.contactId,
      channelType,
      args.conflictHint,
    );
  } else {
    try {
      // Bind gateway-first. Passing the contact's id keys the update to the
      // existing contact; the gateway DB is authoritative for the ACL fields
      // and the channel, and the assistant mirror carries identity/info only.
      await getStore().upsertContact({
        id: contactId,
        displayName: contactDisplayName,
        channels: [{ type: channelType, address, isPrimary: true }],
      });
      channelId = resolveChannelId(contactId, channelType, address);
    } catch (channelErr) {
      log.error(
        { channelErr, contactId, channelType },
        "contact-prompt-submit: channel bind failed",
      );
      await onRollback?.();

      return {
        failure: { error: "Failed to create contact channel", status: 500 },
      };
    }

    if (!channelId) {
      log.error(
        { channelType, address, contactId },
        "contact-prompt-submit: channel resolution failed after bind",
      );
      if (onRollback) {
        // The contact this bind minted is gone with it, so the pair is a net
        // no change and the daemon's caches never saw either.
        await onRollback();
      } else {
        emitContactsChanged();
      }
      return CHANNEL_RESOLUTION_FAILED;
    }

    log.info(
      { channelType, address, contactId, channelId },
      "contact-prompt-submit: created new channel",
    );
  }

  // Invalidate the daemon guardian-id/role caches after a gateway-owned
  // bind/rebind/reuse.
  emitContactsChanged();

  return await channelResolution({
    requestId,
    contactId,
    channelId,
    channelType,
    address,
    verify: args.verify,
    parkedVerify: args.parkedVerify,
  });
}

/**
 * Resolve the address to the contact that owns it, creating one when nothing
 * does. Gateway-first via ContactStore.upsertContact: the gateway DB is the
 * source of truth; the assistant DB receives a best-effort mirror.
 */
async function bindAddressToItsOwnContact(args: {
  requestId: string;
  channelType: string;
  address: string;
  displayName?: string;
  notes?: string;
  verify: boolean | undefined;
  parkedVerify: boolean | undefined;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, channelType, address, displayName, notes } = args;

  const { contact } = await getStore().upsertContact({
    // omit-to-preserve: an existing contact keeps its name, and a brand-new one
    // with none falls back to the canonical channel address inside
    // upsertContact.
    displayName,
    notes,
    channels: [{ type: channelType, address, isPrimary: true }],
  });
  const contactId = contact.id;

  // Invalidate the daemon guardian-id/role caches after the committed gateway
  // contact write, before the read-back guard, so a resolveChannelId miss
  // still drops the stale caches.
  emitContactsChanged();

  const channelId = resolveChannelId(contactId, channelType, address);

  log.info(
    { channelType, address, contactId, channelId },
    "contact-prompt-submit: upserted contact + channel via ContactStore",
  );

  if (!channelId) {
    log.error(
      { channelType, address, contactId },
      "contact-prompt-submit: channel resolution failed after upsert",
    );
    return CHANNEL_RESOLUTION_FAILED;
  }

  const outcome = await channelResolution({
    requestId,
    contactId,
    channelId,
    channelType,
    address,
    verify: args.verify,
    parkedVerify: args.parkedVerify,
  });

  // The contact and the channel are committed in the gateway DB, but notes
  // live only in the assistant mirror and upsertContact swallows a failed
  // mirror write. Reporting success without saying so would claim notes that
  // are nowhere, so read them back and let the caller say which it got.
  if (notes === undefined || !("resolution" in outcome)) {
    return outcome;
  }
  return {
    resolution: {
      ...outcome.resolution,
      notesSaved: await notesReachedMirror(contactId, notes),
    },
  };
}

/** The channel bound to a (type, address) pair, if there is one. */
function findChannelByAddress(
  channelType: string,
  address: string,
): { id: string; contactId: string } | undefined {
  return getGatewayDb()
    .select({
      id: gwContactChannels.id,
      contactId: gwContactChannels.contactId,
    })
    .from(gwContactChannels)
    .where(
      and(
        eq(gwContactChannels.type, channelType),
        sql`${gwContactChannels.address} = ${address} COLLATE NOCASE`,
      ),
    )
    .get();
}

/** What to do about an address bound to a contact other than the target. */
const MERGE_HINT =
  "Run 'assistant contacts merge <keepId> <donorId>' if they are the same person.";

/** The guardian's channel cannot be minted while another contact holds it. */
const GUARDIAN_CONFLICT_HINT =
  "Clear that binding before binding the address to the guardian.";

/**
 * The address belongs to somebody else. Naming them is what makes the refusal
 * actionable: the guardian can see whether it is the same person under two
 * records or a genuinely different one.
 */
function channelOwnedByAnotherContact(
  otherContactId: string,
  channelType: string,
  conflictHint: string,
): GuardianFormWriteOutcome {
  const other = getStore().getContact(otherContactId);
  return {
    failure: {
      error: `That ${channelType} address is already bound to "${other?.displayName ?? "Unknown"}" (${otherContactId}). ${conflictHint}`,
      status: 409,
    },
  };
}

/** Drop the daemon's contact caches after a committed gateway contact write. */
function emitContactsChanged(): void {
  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});
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
 *
 * The checkbox is the answer: `--verify` only pre-checks it, so a guardian who
 * unchecks the box must not get a verified channel. A client with no checkbox
 * sends no answer, and the parked flag stands in for one.
 */
function promptWantsVerify(
  submitted: boolean | undefined,
  parkedVerify: boolean | undefined,
): boolean {
  if (typeof submitted === "boolean") {
    return submitted;
  }
  return parkedVerify === true;
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
  parkedVerify: boolean | undefined;
}): Promise<GuardianFormWriteOutcome> {
  const { requestId, contactId, channelId, channelType, address } = args;
  // What the channel ends up as, not what was asked for: the guardian's box
  // decides, an attest that fails leaves it unverified, and an address that
  // reuses an already verified channel stays verified whether or not this
  // submission asked for it.
  let verified = false;
  if (promptWantsVerify(args.verify, args.parkedVerify)) {
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
  operation?: "create" | "update" | "delete" | "merge";
  contactId?: string;
  /** The contact being merged away. Required for a merge. */
  donorContactId?: string;
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
 * have edited) a create, update, delete, or merge the assistant proposed.
 * Writes it, then unblocks the parked CLI call.
 *
 * The submitted operation is trusted as posted rather than checked against the
 * parked proposal. A caller who can reach this route can already reach
 * `POST /v1/contacts`, `POST /v1/contacts/merge` and `DELETE /v1/contacts/:id`
 * at the same edge auth, so a readback would buy no privilege, only a round
 * trip.
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

  const { requestId, operation, contactId, donorContactId } = body;

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
    operation !== "delete" &&
    operation !== "merge"
  ) {
    return Response.json(
      {
        accepted: false,
        error:
          'operation must be one of: "create", "update", "delete", "merge"',
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

  if (operation === "merge") {
    if (!donorContactId || typeof donorContactId !== "string") {
      return Response.json(
        { accepted: false, error: "donorContactId is required to merge" },
        { status: 400 },
      );
    }
    if (donorContactId === contactId) {
      return Response.json(
        { accepted: false, error: "Cannot merge a contact with itself" },
        { status: 400 },
      );
    }
    // The merge combines both contacts' notes itself, so a submitted set would
    // either be dropped or overwrite that. A null is an explicit clear on the
    // update path, so it is refused here too rather than passed over.
    if (body.notes !== undefined) {
      return Response.json(
        {
          accepted: false,
          error:
            "A merge combines both contacts' notes, so notes cannot be submitted with it. Edit them afterwards with 'assistant contacts update'.",
        },
        { status: 400 },
      );
    }
    // The rename runs after the merge has committed, so a name that would be
    // refused there has to be refused before anything is written.
    if (typeof body.displayName === "string" && !body.displayName.trim()) {
      return Response.json(
        { accepted: false, error: "displayName must be a non-empty string" },
        { status: 400 },
      );
    }
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
        donorContactId,
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
  operation: "create" | "update" | "delete" | "merge";
  contactId?: string;
  donorContactId?: string;
  displayName?: string;
  notes?: string | null;
  expectedChannels?: Array<{ type: string; address: string }>;
}): Promise<GuardianFormWriteOutcome> {
  const {
    requestId,
    operation,
    contactId,
    donorContactId,
    displayName,
    notes,
  } = input;

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

    if (operation === "merge") {
      // The donor's notes live only in the assistant mirror, so a merge whose
      // mirror op did not land leaves them on an orphaned row rather than
      // combined onto the survivor. The gateway half committed, so this is a
      // partial outcome to report, not a failure.
      const { mirrored } = await mergeContactsCore({
        keepId: contactId!,
        mergeId: donorContactId!,
      });
      // The guardian can rename the survivor on the same form. The rename is
      // its own write, ordered after the merge so a refused merge renames
      // nothing. The merge has committed by this point, so a rename that
      // cannot land leaves the survivor under its old name rather than
      // reporting a merge that happened as failed.
      let renamed: boolean | undefined;
      if (displayName !== undefined) {
        try {
          await upsertContactRecordCore({
            operation: "update",
            contactId: contactId!,
            displayName,
          });
          renamed = true;
        } catch (renameErr) {
          log.error(
            { err: renameErr, requestId, contactId, donorContactId },
            "contact-record-submit: merged, but the survivor could not be renamed",
          );
          renamed = false;
        }
      }
      log.info(
        { requestId, contactId, donorContactId, renamed, mirrored },
        "contact-record-submit: merged",
      );
      return {
        resolution: {
          contactId,
          merged: true,
          ...(renamed === false ? { renamed: false } : {}),
          ...(mirrored ? {} : { mirrored: false }),
        },
      };
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
    if (
      err instanceof ContactRecordNativeError ||
      err instanceof MergeContactsError
    ) {
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
