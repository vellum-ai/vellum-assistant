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

import {
  assistantDbQuery,
  assistantDbRun,
} from "../../db/assistant-db-proxy.js";
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
    // Check if a channel with this (type, address) already exists.
    const existing = await assistantDbQuery<{
      channelId: string;
      contactId: string;
    }>(
      `SELECT cc.id AS channelId, cc.contact_id AS contactId
       FROM contact_channels cc
       WHERE cc.type = ? AND cc.address = ?
       LIMIT 1`,
      [channelType, normalizedAddress],
    );

    if (existing.length > 0) {
      contactId = existing[0].contactId;
      channelId = existing[0].channelId;
      log.info(
        { channelType, address: normalizedAddress, contactId, channelId },
        "contact-prompt-submit: channel already exists",
      );
    } else {
      contactId = crypto.randomUUID();
      channelId = crypto.randomUUID();

      await assistantDbRun(
        `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
         VALUES (?, ?, ?, 'human', ?, ?)`,
        [contactId, effectiveDisplayName, effectiveRole, now, now],
      );

      try {
        await assistantDbRun(
          `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'unverified', 'allow', 0, ?, ?)`,
          [channelId, contactId, channelType, normalizedAddress, now, now],
        );
      } catch (channelErr) {
        // Compensating delete — remove the orphaned contact row.
        log.error(
          { channelErr, contactId, channelType },
          "contact-prompt-submit: channel INSERT failed, rolling back contact",
        );
        await assistantDbRun("DELETE FROM contacts WHERE id = ?", [contactId]);

        // Notify daemon of failure so the CLI doesn't hang.
        await ipcCallAssistant("resolve_contact_prompt", {
          requestId,
          error: "Failed to create contact channel",
        });
        return Response.json(
          { accepted: false, error: "Failed to create contact channel" },
          { status: 500 },
        );
      }

      log.info(
        { channelType, address: normalizedAddress, contactId, channelId, role: effectiveRole },
        "contact-prompt-submit: created new contact + channel",
      );
    }
  } catch (err) {
    log.error({ err, requestId }, "contact-prompt-submit: DB error");
    await ipcCallAssistant("resolve_contact_prompt", {
      requestId,
      error: "Database error",
    });
    return Response.json({ accepted: false, error: "Database error" }, { status: 500 });
  }

  // Notify daemon to unblock the waiting contacts/prompt IPC call.
  await ipcCallAssistant("resolve_contact_prompt", {
    requestId,
    contactId,
    channelId,
    channelType,
    address: normalizedAddress,
  });

  return Response.json({ accepted: true });
}
