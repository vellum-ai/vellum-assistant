/**
 * POST /inbound/register — auto-verify the guardian's email channel when
 * an email provider is registered.
 *
 * The platform provides `guardian_email` in the request body. For BYO
 * providers with an identity API (Mailgun), the gateway cross-verifies
 * the email against the API response. For BYO providers without one
 * (Resend), it validates that the stored API key is functional (proving
 * account ownership) and trusts the provided email. For platform-managed
 * email (type "vellum"), the route's edge-scoped auth is sufficient.
 *
 * On success, creates a guardian email channel binding directly in both
 * the assistant and gateway databases (dual-write).
 */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { createGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../../db/connection.js";
import { contacts as gwContacts } from "../../db/schema.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { getLogger } from "../../logger.js";
import { validateMailgunEmail } from "./mailgun-identity.js";
import { validateResendEmail } from "./resend-identity.js";
import { validateVellumEmail } from "./vellum-identity.js";

const log = getLogger("inbound-register");

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const InboundRegisterRequestSchema = z.object({
  type: z.string().trim().toLowerCase(),
  guardian_email: z.string().email().trim().toLowerCase(),
});

// ---------------------------------------------------------------------------
// Provider → email validator map
// ---------------------------------------------------------------------------

export interface EmailValidationResult {
  channel: string;
  externalUserId: string;
  deliveryChatId: string;
  displayName: string;
}

type EmailValidator = (
  apiKey: string,
  guardianEmail: string,
) => Promise<EmailValidationResult | null>;

const providerValidators: Record<string, EmailValidator> = {
  resend: validateResendEmail,
  mailgun: validateMailgunEmail,
  vellum: validateVellumEmail,
};

const selfAuthenticatedProviders = new Set(["vellum"]);

// ---------------------------------------------------------------------------
// Guardian lookup
// ---------------------------------------------------------------------------

interface GuardianRow {
  id: string;
  principal_id: string | null;
}

/**
 * Find the existing guardian contact (any channel) from the gateway DB.
 * Returns null if no guardian has been verified yet or if the guardian has
 * no principal_id.
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

export function createInboundRegisterHandler(
  _config: GatewayConfig,
  credentialCache: CredentialCache,
) {
  return async function handleInboundRegister(
    req: Request,
  ): Promise<Response> {
    // ── Parse & validate request body ─────────────────────────────

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = InboundRegisterRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { type: providerType, guardian_email: guardianEmail } = parsed.data;

    // ── Resolve provider validator ──────────────────────────────

    const validator = providerValidators[providerType];
    if (!validator) {
      return Response.json(
        { error: `Unsupported provider type: ${providerType}` },
        { status: 400 },
      );
    }

    // ── Resolve API key from credential cache ───────────────────

    let apiKey = "";

    if (!selfAuthenticatedProviders.has(providerType)) {
      const apiKeyCredKey = credentialKey(providerType, "api_key");
      const resolvedKey = await credentialCache.get(apiKeyCredKey, {
        force: true,
      });

      if (!resolvedKey) {
        log.warn(
          { providerType },
          "No API key configured for provider — cannot auto-verify guardian",
        );
        return Response.json(
          { error: `No API key configured for ${providerType}` },
          { status: 409 },
        );
      }
      apiKey = resolvedKey;
    }

    // ── Validate email with provider ────────────────────────────

    const binding = await validator(apiKey, guardianEmail);
    if (!binding) {
      log.warn(
        { providerType },
        "Provider email validation failed — skipping auto-verify",
      );
      return Response.json(
        { error: `Email validation failed for ${providerType}` },
        { status: 422 },
      );
    }

    // ── Find existing guardian and create email channel binding ──

    const guardian = await findGuardian();
    if (!guardian) {
      log.warn(
        "No guardian contact exists — cannot auto-verify email channel",
      );
      return Response.json(
        {
          error:
            "No guardian contact exists. The guardian must be verified on at least one channel first.",
        },
        { status: 404 },
      );
    }

    try {
      await createGuardianBinding({
        channel: binding.channel,
        externalUserId: binding.externalUserId,
        deliveryChatId: binding.deliveryChatId,
        guardianPrincipalId: guardian.principal_id,
        displayName: binding.displayName,
        verifiedVia: "webhook_registration",
      });
    } catch (err) {
      log.error(
        { err, providerType },
        "Failed to create guardian email channel binding",
      );
      return Response.json(
        { error: "Failed to create guardian email channel" },
        { status: 500 },
      );
    }

    log.info(
      { providerType },
      "Auto-verified guardian email channel via webhook registration",
    );

    return Response.json({
      ok: true,
      verified_via: "webhook_registration",
    });
  };
}
