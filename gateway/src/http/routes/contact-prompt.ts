/**
 * Gateway HTTP handler for the contact prompt submission endpoint.
 *
 * POST /v1/contacts/prompt/submit
 *
 * Called by the client after the user fills in a contact address in response
 * to a `contact_request` broadcast from the daemon. This route:
 *   1. Validates the submitted contact info.
 *   2. Upserts the contact + channel gateway-first via ContactStore.upsertContact
 *      (gateway DB is the source of truth; assistant DB is a best-effort mirror).
 *   3. Calls daemon IPC `resolve_contact_prompt` to unblock the waiting CLI.
 *   4. Returns { accepted: true } to the client.
 *
 * Auth: edge (same as all ingress contact routes).
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { assistantDbRun } from "../../db/assistant-db-proxy.js";
import { getGatewayDb } from "../../db/connection.js";
import { ContactStore } from "../../db/contact-store.js";
import {
  contactChannels as gwContactChannels,
  contacts as gwContacts,
} from "../../db/schema.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import { canonicalizeInboundIdentity } from "../../verification/identity.js";

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

  const { requestId, address, channelType, role, displayName } = body;

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
  // Map prompt roles to valid ContactRole values ("guardian" | "contact").
  const effectiveRole: string = role === "guardian" ? "guardian" : "contact";
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

    if (effectiveRole === "guardian") {
      // Guardian lives in the gateway DB (source of truth) — bootstrap
      // dual-writes it there. Resolve from there, not the assistant mirror.
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
          await assistantDbRun(
            `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
             VALUES (?, ?, 'guardian', 'human', ?, ?)`,
            [contactId, effectiveDisplayName, now, now],
          );
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
      channelId = resolveChannelId(contactId, channelType, normalizedAddress);

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: upserted contact + channel via ContactStore",
      );

      // Non-guardian is fully resolved by upsertContact; skip the guardian-only
      // Phase 2 channel-creation block below and go straight to resolve.
      return await resolveContactPrompt({
        requestId,
        contactId,
        channelId,
        channelType,
        address: normalizedAddress,
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
      try {
        // Bind gateway-first. Passing the guardian's id keys the update to the
        // existing guardian and preserves role="guardian" (upsertContact's
        // id-path role preservation); the gateway channel is the source of
        // truth, the assistant mirror is dual-written best-effort.
        await getStore().upsertContact({
          id: contactId,
          channels: [
            { type: channelType, address: normalizedAddress, isPrimary: true },
          ],
        });
        channelId = resolveChannelId(contactId, channelType, normalizedAddress);
      } catch (channelErr) {
        // Compensating delete — only remove the contact if we created it here.
        // "Stale over lost": delete gateway-first, then mirror the delete to
        // the assistant DB best-effort.
        log.error(
          { channelErr, contactId, channelType },
          "contact-prompt-submit: channel bind failed, rolling back contact",
        );
        if (createdNewContact) {
          getGatewayDb()
            .delete(gwContacts)
            .where(eq(gwContacts.id, contactId))
            .run();
          try {
            await assistantDbRun("DELETE FROM contacts WHERE id = ?", [
              contactId,
            ]);
          } catch (mirrorErr) {
            log.warn(
              { err: mirrorErr },
              "contact-prompt-submit: assistant DB contact rollback mirror DELETE failed",
            );
          }
        }

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

  return await resolveContactPrompt({
    requestId,
    contactId,
    channelId,
    channelType,
    address: normalizedAddress,
  });
}

/**
 * Notify the daemon to unblock the waiting contacts/prompt IPC call, then
 * return { accepted: true }. IPC failures are best-effort — they only mean the
 * CLI may time out, not that the write failed.
 */
async function resolveContactPrompt(args: {
  requestId: string;
  contactId: string;
  channelId: string;
  channelType: string;
  address: string;
}): Promise<Response> {
  const { requestId, contactId, channelId, channelType, address } = args;
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
