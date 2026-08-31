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

const log = getLogger("contact-prompt");

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

  // Claim before writing anything, exactly as the record form does: the form
  // went to every connected client, and an answer landing near the deadline
  // must stop that deadline rather than race the write it started. A dismissal
  // takes the same claim, so it cannot report "cancelled" over an answer that
  // is already committing.
  const claim = await claimPrompt(requestId);
  if (!claim.claimed) {
    log.warn(
      { requestId, reason: claim.reason },
      "contact-prompt-submit: submission did not get the claim",
    );
    return lostClaimResponse(claim.reason);
  }
  const settleDeadline = Date.now() + (claim.settleMs ?? DEFAULT_SETTLE_MS);

  if (body.cancelled === true) {
    await reportFailure(requestId, "Cancelled by user", settleDeadline);
    return Response.json({ accepted: true });
  }

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
        return await channelResolutionError(requestId, settleDeadline);
      }

      // Non-guardian is fully resolved by upsertContact; skip the guardian-only
      // Phase 2 channel-creation block below and go straight to resolve.
      return await resolveContactPrompt({
        requestId,
        contactId,
        channelId,
        channelType,
        address: normalizedAddress,
        verify: body.verify,
        settleDeadline,
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
      await reportFailure(
        requestId,
        "Channel already assigned to another contact",
        settleDeadline,
      );
      return Response.json(
        {
          accepted: false,
          error: "Channel already assigned to another contact",
        },
        { status: 409 },
      );
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

        // Notify daemon of failure so the CLI doesn't hang.
        await reportFailure(
          requestId,
          "Failed to create contact channel",
          settleDeadline,
        );
        return Response.json(
          { accepted: false, error: "Failed to create contact channel" },
          { status: 500 },
        );
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
        return await channelResolutionError(requestId, settleDeadline);
      }

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: created new channel",
      );
    }
  } catch (err) {
    log.error({ err, requestId }, "contact-prompt-submit: DB error");
    await reportFailure(requestId, "Database error", settleDeadline);
    return Response.json(
      { accepted: false, error: "Database error" },
      { status: 500 },
    );
  }

  // Invalidate the daemon guardian-id/role caches after a gateway-owned
  // guardian bind/rebind/reuse.
  void ipcCallAssistant("emit_event", {
    body: { kind: "contacts_changed" },
  } as unknown as Record<string, unknown>).catch(() => {});

  return await resolveContactPrompt({
    requestId,
    contactId,
    channelId,
    channelType,
    address: normalizedAddress,
    verify: body.verify,
    settleDeadline,
  });
}

/**
 * Notify the daemon of a failed channel resolution and return 500. Used when the
 * gateway DB read can't find the just-bound channel — resolving the prompt with
 * an empty channelId would falsely report success for a channel-less contact.
 */
async function channelResolutionError(
  requestId: string,
  deadline: number,
): Promise<Response> {
  await reportFailure(requestId, "Channel resolution failed", deadline);
  return Response.json(
    { accepted: false, error: "Channel resolution failed" },
    { status: 500 },
  );
}

/**
 * Notify the daemon to unblock the waiting contacts/prompt IPC call, then
 * return { accepted: true }. IPC failures are best-effort — they only mean the
 * CLI may time out, not that the write failed.
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

async function resolveContactPrompt(args: {
  requestId: string;
  contactId: string;
  channelId: string;
  channelType: string;
  address: string;
  verify: boolean | undefined;
  settleDeadline: number;
}): Promise<Response> {
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
      // exists as it stood, not a failed submission. Letting this throw would
      // skip the report and park the command on a claimed form. Read the
      // channel rather than assuming unverified: attesting one that already
      // was leaves it verified, and reporting otherwise invents a downgrade.
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
  await reportResolution(
    requestId,
    { requestId, contactId, channelId, channelType, address, verified },
    args.settleDeadline,
  );

  return Response.json({ accepted: true });
}

/**
 * Tell the waiting call that its form ended in an error.
 *
 * Claiming a form takes ownership of its ending, so a failure owes the caller
 * a report as much as a success does: a claimed form nobody reports on parks
 * the command until its settle timer, and the client's retry comes back as a
 * duplicate because the claim is still held. Retried on the same window a
 * committed write gets.
 */
async function reportFailure(
  requestId: string,
  error: string,
  deadline: number,
): Promise<void> {
  await reportResolution(requestId, { requestId, error }, deadline);
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
    const cancelClaim = await claimPrompt(requestId);
    if (!cancelClaim.claimed) {
      log.info(
        { requestId, reason: cancelClaim.reason },
        "contact-record-submit: dismissal did not get the claim",
      );
      return lostClaimResponse(cancelClaim.reason);
    }
    await reportResolution(
      requestId,
      { requestId, error: "Cancelled by user" },
      Date.now() + (cancelClaim.settleMs ?? DEFAULT_SETTLE_MS),
    );
    return Response.json({ accepted: true });
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

  // Claim the form before writing. It is broadcast to every connected client,
  // so a second one can answer it with the values it was seeded with and
  // overwrite the answer the guardian actually gave on the first.
  const claim = await claimPrompt(requestId);
  if (!claim.claimed) {
    log.warn(
      { requestId, operation, reason: claim.reason },
      "contact-record-submit: submission did not get the claim",
    );
    return lostClaimResponse(claim.reason);
  }
  const settleDeadline = Date.now() + (claim.settleMs ?? DEFAULT_SETTLE_MS);

  try {
    if (operation === "delete") {
      // Deleting cascades the contact's channels, and the confirmation listed
      // the ones it had when the form opened. The core compares them against
      // the contact's channels in the same transaction as the delete, so a
      // channel reparented in between (an invite redeemed, say) is not
      // cascaded away unseen.
      await deleteContactCore(
        contactId!,
        Array.isArray(body.expectedChannels)
          ? body.expectedChannels
          : undefined,
      );
      log.info({ requestId, contactId }, "contact-record-submit: deleted");
      return await resolveRecordPrompt(requestId, contactId!, settleDeadline);
    }

    const { contact, notesSaved, nothingWritten } =
      await upsertContactRecordCore({
        operation,
        contactId: operation === "update" ? contactId : undefined,
        displayName,
        notes: body.notes,
      });
    const writtenId = contact.id as string;
    log.info(
      { requestId, contactId: writtenId, operation },
      "contact-record-submit: wrote contact record",
    );
    return await resolveRecordPrompt(
      requestId,
      writtenId,
      settleDeadline,
      notesSaved,
      nothingWritten,
    );
  } catch (err) {
    if (err instanceof ContactRecordNativeError) {
      await reportFailure(requestId, err.message, settleDeadline);
      return Response.json(
        { accepted: false, error: err.message },
        { status: err.statusCode },
      );
    }
    log.error({ err, requestId, operation }, "contact-record-submit: failed");
    await reportFailure(requestId, "Contact write failed", settleDeadline);
    return Response.json(
      { accepted: false, error: "Contact write failed" },
      { status: 500 },
    );
  }
}

/**
 * Ask the daemon to claim this form for the caller.
 *
 * A transport failure is a lost claim rather than a granted one: the daemon
 * holds the waiting call, so a write it cannot hear about has nobody to report
 * to. `unreachable` is kept distinct from the daemon's own answers, because a
 * caller that cannot be reached says nothing about whether the form was
 * already answered.
 */
async function claimPrompt(
  requestId: string,
): Promise<{ claimed: boolean; reason?: string; settleMs?: number }> {
  try {
    const result = await ipcCallAssistant("contact_prompt_claim", {
      body: { requestId },
    });
    return result as { claimed: boolean; reason?: string; settleMs?: number };
  } catch (err) {
    log.warn(
      { err, requestId },
      "contact-record-submit: contact_prompt_claim IPC failed; refusing the write",
    );
    return { claimed: false, reason: "unreachable" };
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

/** Fallback settle window when a claim did not carry one. */
const DEFAULT_SETTLE_MS = 180_000;

/** Longest a submission waits on the callback before answering its client. */
const RESOLVE_INLINE_BUDGET_MS = 2_000;

/**
 * Report a committed write back to the assistant, retrying until the claimed
 * form's settle window runs out.
 *
 * The write has already happened by the time this runs, so a lost callback is
 * not a lost write: it is a command told its form failed while the contact was
 * created, renamed, or deleted. Retries run to the claim's deadline rather
 * than to a fixed count, which a fast-failing socket would burn through in
 * seconds. The deadline is absolute and dates from the claim, because the
 * window is the daemon's and started running there: measuring it again after
 * a slow write would retry against a form that has already expired.
 *
 * The first couple of seconds are awaited so the ordinary case answers the
 * client with the callback already delivered; past that the retries continue
 * on their own, since the client is waiting on a write that is already done.
 *
 * A callback that never lands leaves the command reporting failure over a
 * write that happened. Nothing here can close that gap, so it is logged at
 * error rather than papered over.
 */
async function reportResolution(
  requestId: string,
  body: Record<string, unknown>,
  deadline: number,
): Promise<void> {
  const inlineUntil = Date.now() + RESOLVE_INLINE_BUDGET_MS;

  const attempt = async (): Promise<boolean> => {
    try {
      const result = await ipcCallAssistant("resolve_contact_prompt", { body });
      if ((result as { resolved?: boolean }).resolved === false) {
        // The form is gone, so nobody is waiting. Retrying cannot change that.
        log.warn(
          { requestId },
          "contact-prompt: resolve found no pending form; the command may already have given up",
        );
      }
      return true;
    } catch (err) {
      log.warn({ err, requestId }, "contact-prompt: resolve failed, retrying");
      return false;
    }
  };

  const retryUntilDeadline = async (waitMs: number): Promise<void> => {
    let backoff = waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
      if (Date.now() >= deadline) {
        break;
      }
      if (await attempt()) {
        return;
      }
      backoff = Math.min(backoff * 2, 10_000);
    }
    log.error(
      { requestId, body },
      "contact-prompt: could not report a committed write to the assistant; the command will report failure over a write that happened",
    );
  };

  if (await attempt()) {
    return;
  }

  // Inline retries while the client's own wait is still short, then hand the
  // rest to the background so the response is not held for the whole window.
  let backoff = 500;
  while (Date.now() < inlineUntil) {
    await new Promise((resolve) => setTimeout(resolve, backoff));
    if (await attempt()) {
      return;
    }
    backoff = Math.min(backoff * 2, 10_000);
  }
  void retryUntilDeadline(backoff);
}

/**
 * The response for a claim the caller did not get.
 *
 * A competing claim is success from this client's side: the form it was
 * showing has been answered, and there is nothing for it to fix. Anything else
 * is a failure it needs to see, so its card stays and can be retried: an
 * unreachable assistant means the submission never landed, and an unknown form
 * means nothing is waiting for one.
 */
function lostClaimResponse(reason: string | undefined): Response {
  if (reason === "already_claimed") {
    return Response.json({ accepted: true, duplicate: true });
  }
  if (reason === "unreachable") {
    return Response.json(
      { accepted: false, error: "Could not reach the assistant" },
      { status: 503 },
    );
  }
  return Response.json(
    {
      accepted: false,
      error: "This request is no longer waiting for an answer",
    },
    { status: 409 },
  );
}

/**
 * Unblock the parked CLI call after a record write. There is no channel to
 * report, so only the contact id crosses back.
 */
async function resolveRecordPrompt(
  requestId: string,
  contactId: string,
  deadline: number,
  notesSaved?: boolean,
  nothingWritten?: boolean,
): Promise<Response> {
  await reportResolution(
    requestId,
    { requestId, contactId, notesSaved, nothingWritten },
    deadline,
  );
  return Response.json({ accepted: true });
}
