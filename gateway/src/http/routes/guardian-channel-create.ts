/**
 * POST /v1/contacts/guardian/channel — create a guardian channel binding
 * via platform auto-verify.
 *
 * This route is called by the platform's `assistant email register` flow
 * to auto-verify the owner's email channel. It creates a guardian email
 * channel binding directly in both the assistant and gateway databases.
 *
 * Auth is `edge-guardian`: the route is reachable only via vembda's
 * trusted `gateway-query` proxy, and edge-guardian validates the
 * proxy-signed request before the handler runs.
 */

import { z } from "zod";

import { createGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { assistantDbQuery } from "../../db/assistant-db-proxy.js";
import { getLogger } from "../../logger.js";

const log = getLogger("guardian-channel-create");

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const GuardianChannelRequestSchema = z.object({
  type: z.string().trim().toLowerCase(),
  address: z.string().trim().toLowerCase(),
  externalUserId: z.string().trim().toLowerCase(),
  status: z.literal("active"),
});

// ---------------------------------------------------------------------------
// Guardian lookup
// ---------------------------------------------------------------------------

interface GuardianRow {
  id: string;
  principal_id: string | null;
}

/**
 * Find the existing guardian contact (any channel). Returns null if no
 * guardian has been verified yet or if the guardian has no principal_id.
 */
async function findGuardian(): Promise<
  (GuardianRow & { principal_id: string }) | null
> {
  const rows = await assistantDbQuery<GuardianRow>(
    `SELECT id, principal_id FROM contacts WHERE role = 'guardian' LIMIT 1`,
  );

  const row = rows[0] ?? null;
  if (!row?.principal_id) return null;
  return row as GuardianRow & { principal_id: string };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGuardianChannelHandler() {
  return async function handleGuardianChannelCreate(
    req: Request,
  ): Promise<Response> {
    // ── Parse & validate request body ─────────────────────────────

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = GuardianChannelRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const body = parsed.data;

    // ── Find existing guardian ─────────────────────────────────────

    const guardian = await findGuardian();
    if (!guardian) {
      log.warn("No guardian contact exists — cannot create guardian channel");
      return Response.json(
        {
          error:
            "No guardian contact exists. The guardian must be verified on at least one channel first.",
        },
        { status: 404 },
      );
    }

    // ── Create guardian channel binding ────────────────────────────
    // CRITICAL: deliveryChatId MUST be set to body.externalUserId (not
    // body.address) — the ACL lookup in findContactChannel
    // (contact-store.ts:780) queries on external_user_id and
    // external_chat_id, NOT address. For email, all three values are
    // typically the same email string, but the param mapping must be
    // explicit.

    try {
      await createGuardianBinding({
        channel: body.type,
        externalUserId: body.externalUserId,
        deliveryChatId: body.externalUserId,
        guardianPrincipalId: guardian.principal_id,
        displayName: body.address,
        verifiedVia: "platform_auto_register",
      });
    } catch (err) {
      log.error({ err }, "Failed to create guardian channel binding");
      return Response.json(
        { error: "Failed to create guardian channel" },
        { status: 500 },
      );
    }

    log.info(
      { channel: body.type, address: body.address },
      "Auto-verified guardian channel via platform auto-register",
    );

    return Response.json({
      ok: true,
      verified_via: "platform_auto_register",
    });
  };
}
