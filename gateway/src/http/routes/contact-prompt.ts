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
        return await channelResolutionError(requestId);
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
      await notifyDaemonResolveError(
        requestId,
        "Channel already assigned to another contact",
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
        await notifyDaemonResolveError(
          requestId,
          "Failed to create contact channel",
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
        return await channelResolutionError(requestId);
      }

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: created new channel",
      );
    }
  } catch (err) {
    log.error({ err, requestId }, "contact-prompt-submit: DB error");
    await notifyDaemonResolveError(requestId, "Database error");
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
  });
}

/**
 * Notify the daemon of a failed channel resolution and return 500. Used when the
 * gateway DB read can't find the just-bound channel — resolving the prompt with
 * an empty channelId would falsely report success for a channel-less contact.
 */
async function channelResolutionError(requestId: string): Promise<Response> {
  await notifyDaemonResolveError(requestId, "Channel resolution failed");
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
  // Client older than the checkbox: fall back to the parked flag, which is how
  // this worked before the box existed. Read out of band because that client
  // has no field to echo it back in.
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
}): Promise<Response> {
  const { requestId, contactId, channelId, channelType, address } = args;
  if (await promptWantsVerify(requestId, args.verify)) {
    const verified = await getStore().markChannelVerified(channelId);
    if (!verified) {
      log.warn(
        { requestId, contactId, channelId },
        "contact-prompt-submit: --verify was set but the channel could not be attested",
      );
    }
  }
  try {
    const ipcResult = await ipcCallAssistant("resolve_contact_prompt", {
      body: { requestId, contactId, channelId, channelType, address },
    });
    if ((ipcResult as { resolved?: boolean }).resolved === false) {
      log.warn(
        { requestId, contactId },
        "contact-prompt-submit: resolve_contact_prompt IPC did not find a pending prompt — CLI may time out",
      );
    }
  } catch (err) {
    log.warn(
      { err, requestId, contactId },
      "contact-prompt-submit: resolve_contact_prompt IPC failed — CLI may time out",
    );
  }

  return Response.json({ accepted: true });
}

/**
 * Best-effort notification to the daemon that a pending contact prompt has
 * resolved with an error. Failures here must not block the HTTP response —
 * the caller has already decided the request failed; we just want to wake
 * the CLI up.
 */
async function notifyDaemonResolveError(
  requestId: string,
  error: string,
): Promise<void> {
  try {
    await ipcCallAssistant("resolve_contact_prompt", {
      body: { requestId, error },
    });
  } catch (err) {
    log.warn(
      { err, requestId },
      "contact-prompt-submit: resolve_contact_prompt error notification failed",
    );
  }
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
  // leaving the CLI to time out on a form nobody is going to submit.
  if (body.cancelled === true) {
    await notifyDaemonResolveError(requestId, "Cancelled by user");
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
    if (claim.reason === "already_claimed") {
      // Somebody already answered. Report success without writing: their
      // answer stands, and this client has nothing to fix.
      log.info(
        { requestId, operation },
        "contact-record-submit: form already answered, ignoring duplicate",
      );
      return Response.json({ accepted: true, duplicate: true });
    }
    // No such form: it expired or was already resolved, so nothing is waiting
    // on this write and nobody asked for it.
    log.warn(
      { requestId, operation, reason: claim.reason },
      "contact-record-submit: no pending form for this submission",
    );
    return Response.json(
      {
        accepted: false,
        error: "This request is no longer waiting for an answer",
      },
      { status: 409 },
    );
  }

  try {
    if (operation === "delete") {
      await deleteContactCore(contactId!);
      log.info({ requestId, contactId }, "contact-record-submit: deleted");
      return await resolveRecordPrompt(requestId, contactId!);
    }

    const { contact } = await upsertContactRecordCore({
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
    return await resolveRecordPrompt(requestId, writtenId);
  } catch (err) {
    if (err instanceof ContactRecordNativeError) {
      await notifyDaemonResolveError(requestId, err.message);
      return Response.json(
        { accepted: false, error: err.message },
        { status: err.statusCode },
      );
    }
    log.error({ err, requestId, operation }, "contact-record-submit: failed");
    await notifyDaemonResolveError(requestId, "Contact write failed");
    return Response.json(
      { accepted: false, error: "Contact write failed" },
      { status: 500 },
    );
  }
}

/**
 * Ask the daemon to claim this form for the caller.
 *
 * A transport failure is treated as a lost claim: the daemon holds the waiting
 * call, so if it cannot be reached the write has nobody to report to and is
 * better not made.
 */
async function claimPrompt(
  requestId: string,
): Promise<{ claimed: boolean; reason?: string }> {
  try {
    const result = await ipcCallAssistant("contact_prompt_claim", {
      body: { requestId },
    });
    return result as { claimed: boolean; reason?: string };
  } catch (err) {
    log.warn(
      { err, requestId },
      "contact-record-submit: contact_prompt_claim IPC failed; refusing the write",
    );
    return { claimed: false, reason: "unreachable" };
  }
}

/**
 * Unblock the parked CLI call after a record write. There is no channel to
 * report, so only the contact id crosses back.
 */
async function resolveRecordPrompt(
  requestId: string,
  contactId: string,
): Promise<Response> {
  try {
    const ipcResult = await ipcCallAssistant("resolve_contact_prompt", {
      body: { requestId, contactId },
    });
    if ((ipcResult as { resolved?: boolean }).resolved === false) {
      log.warn(
        { requestId, contactId },
        "contact-record-submit: resolve_contact_prompt found no pending prompt; CLI may time out",
      );
    }
  } catch (err) {
    log.warn(
      { err, requestId, contactId },
      "contact-record-submit: resolve_contact_prompt IPC failed; CLI may time out",
    );
  }
  return Response.json({ accepted: true });
}
