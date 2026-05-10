/**
 * Gateway HTTP handler for the contact prompt submission endpoint.
 *
 * POST /v1/contacts/prompt/submit
 *
 * Called by the client after the user fills in a contact address in response
 * to a `contact_request` broadcast from the daemon. This route:
 *   1. Validates the submitted contact info.
 *   2. Upserts the contact + channel via the assistant DB proxy (gateway owns writes).
 *   3. Calls daemon IPC `resolve_contact_prompt` to unblock the waiting CLI.
 *   4. Returns { accepted: true } to the client.
 *
 * Auth: edge (same as all ingress contact routes).
 */

import { eq } from "drizzle-orm";

import {
  assistantDbQuery,
  assistantDbRun,
} from "../../db/assistant-db-proxy.js";
import { getGatewayDb } from "../../db/connection.js";
import {
  contactChannels as gwContactChannels,
  contacts as gwContacts,
} from "../../db/schema.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";

const log = getLogger("contact-prompt");

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

export async function handleContactPromptSubmit(req: Request): Promise<Response> {
  let body: ContactPromptSubmitBody;
  try {
    body = (await req.json()) as ContactPromptSubmitBody;
  } catch {
    return Response.json({ accepted: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { requestId, address, channelType, role, displayName } = body;

  if (!requestId || typeof requestId !== "string") {
    return Response.json({ accepted: false, error: "requestId is required" }, { status: 400 });
  }
  if (!address || typeof address !== "string") {
    return Response.json({ accepted: false, error: "address is required" }, { status: 400 });
  }
  if (!channelType || typeof channelType !== "string") {
    return Response.json({ accepted: false, error: "channelType is required" }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase().trim();
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
      const guardianRows = await assistantDbQuery<{ id: string }>(
        `SELECT id FROM contacts WHERE role = 'guardian' ORDER BY created_at ASC LIMIT 1`,
        [],
      );
      if (guardianRows.length > 0) {
        contactId = guardianRows[0].id;
      } else {
        // Bootstrap hasn't run yet — create the guardian contact.
        log.warn(
          { channelType, address: normalizedAddress },
          "contact-prompt-submit: no guardian contact found, creating one",
        );
        contactId = crypto.randomUUID();
        createdNewContact = true;
        await assistantDbRun(
          `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
           VALUES (?, ?, 'guardian', 'human', ?, ?)`,
          [contactId, effectiveDisplayName, now, now],
        );
        try {
          getGatewayDb()
            .insert(gwContacts)
            .values({ id: contactId, displayName: effectiveDisplayName, role: "guardian", createdAt: now, updatedAt: now })
            .onConflictDoNothing()
            .run();
        } catch (gwErr) {
          log.warn({ err: gwErr }, "contact-prompt-submit: gateway DB guardian contact INSERT dual-write failed");
        }
      }
    } else {
      // Reuse an existing contact if this channel address is already known.
      const existingForChannel = await assistantDbQuery<{ contactId: string }>(
        `SELECT contact_id AS contactId FROM contact_channels WHERE type = ? AND address = ? LIMIT 1`,
        [channelType, normalizedAddress],
      );
      if (existingForChannel.length > 0) {
        contactId = existingForChannel[0].contactId;
      } else {
        contactId = crypto.randomUUID();
        createdNewContact = true;
        await assistantDbRun(
          `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
           VALUES (?, ?, ?, 'human', ?, ?)`,
          [contactId, effectiveDisplayName, effectiveRole, now, now],
        );
        try {
          getGatewayDb()
            .insert(gwContacts)
            .values({ id: contactId, displayName: effectiveDisplayName, role: effectiveRole, createdAt: now, updatedAt: now })
            .onConflictDoNothing()
            .run();
        } catch (gwErr) {
          log.warn({ err: gwErr }, "contact-prompt-submit: gateway DB contact INSERT dual-write failed");
        }
      }
    }

    // -----------------------------------------------------------------------
    // Phase 2: Resolve channel
    //
    // If a channel for (type, address) already points to our contact, reuse it.
    // If it points to a different contact and we are binding as guardian, that
    // is a conflict the caller must resolve — return 409.  Otherwise create a
    // new channel bound to the resolved contact.
    // -----------------------------------------------------------------------
    const existingChannel = await assistantDbQuery<{ id: string; contactId: string }>(
      `SELECT id, contact_id AS contactId FROM contact_channels WHERE type = ? AND address = ? LIMIT 1`,
      [channelType, normalizedAddress],
    );

    if (existingChannel.length > 0 && existingChannel[0].contactId === contactId) {
      channelId = existingChannel[0].id;
      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: channel already exists",
      );
    } else if (existingChannel.length > 0) {
      // Channel exists but belongs to a different contact.  The caller must
      // clean up the stale binding before a guardian channel can be created.
      log.warn(
        { channelType, address: normalizedAddress, contactId, existingContactId: existingChannel[0].contactId },
        "contact-prompt-submit: channel already assigned to another contact",
      );
      await notifyDaemonResolveError(
        requestId,
        "Channel already assigned to another contact",
      );
      return Response.json(
        { accepted: false, error: "Channel already assigned to another contact" },
        { status: 409 },
      );
    } else {
      channelId = crypto.randomUUID();

      try {
        await assistantDbRun(
          `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'unverified', 'allow', 0, ?, ?)`,
          [channelId, contactId, channelType, normalizedAddress, now, now],
        );
        try {
          getGatewayDb()
            .insert(gwContactChannels)
            .values({
              id: channelId,
              contactId,
              type: channelType,
              address: normalizedAddress,
              isPrimary: true,
              status: "unverified",
              policy: "allow",
              interactionCount: 0,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing()
            .run();
        } catch (gwErr) {
          log.warn({ err: gwErr }, "contact-prompt-submit: gateway DB channel INSERT dual-write failed");
        }
      } catch (channelErr) {
        // Compensating delete — only remove the contact if we created it here.
        log.error(
          { channelErr, contactId, channelType },
          "contact-prompt-submit: channel INSERT failed, rolling back contact",
        );
        if (createdNewContact) {
          await assistantDbRun("DELETE FROM contacts WHERE id = ?", [contactId]);
          try {
            getGatewayDb()
              .delete(gwContacts)
              .where(eq(gwContacts.id, contactId))
              .run();
          } catch (gwErr) {
            log.warn({ err: gwErr }, "contact-prompt-submit: gateway DB contact rollback DELETE dual-write failed");
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
    return Response.json({ accepted: false, error: "Database error" }, { status: 500 });
  }

  // Notify daemon to unblock the waiting contacts/prompt IPC call.
  try {
    const ipcResult = await ipcCallAssistant("resolve_contact_prompt", {
      body: { requestId, contactId, channelId, channelType, address: normalizedAddress },
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
