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

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { createGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../../db/connection.js";
import { contacts as gwContacts } from "../../db/schema.js";
import { getLogger } from "../../logger.js";
import { canonicalizeInboundIdentity } from "../../verification/identity.js";

const log = getLogger("guardian-channel-create");

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const GuardianChannelRequestSchema = z.object({
  type: z.string().trim().toLowerCase(),
  address: z.string().trim(),
  externalUserId: z.string().trim(),
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
 * Find the existing guardian contact (any channel) in the gateway DB. Returns
 * null if no guardian has been verified yet or if the guardian has no
 * principal_id.
 */
export async function findGuardian(): Promise<
  (GuardianRow & { principal_id: string }) | null
> {
  const row =
    getGatewayDb()
      .select({ id: gwContacts.id, principalId: gwContacts.principalId })
      .from(gwContacts)
      // Skip principal-less guardian stubs (e.g. created by the gateway-first
      // contact-prompt path before bootstrap); pick the oldest real guardian.
      .where(
        and(eq(gwContacts.role, "guardian"), isNotNull(gwContacts.principalId)),
      )
      .orderBy(asc(gwContacts.createdAt))
      .limit(1)
      .get() ?? null;

  if (!row?.principalId) return null;
  return { id: row.id, principal_id: row.principalId };
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

    const raw = parsed.data;
    const body = {
      ...raw,
      address:
        canonicalizeInboundIdentity(raw.type, raw.address) ?? raw.address,
      externalUserId:
        canonicalizeInboundIdentity(raw.type, raw.externalUserId) ??
        raw.externalUserId,
    };

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
