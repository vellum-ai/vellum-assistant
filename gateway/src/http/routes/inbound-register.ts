/**
 * POST /inbound/register — auto-verify the guardian's email channel when
 * a BYO email provider (Resend or Mailgun) webhook is registered.
 *
 * The platform provides `guardian_email` in the request body. For
 * providers with an identity API (Mailgun), the gateway cross-verifies
 * the email against the API response. For providers without one
 * (Resend), it validates that the stored API key is functional (proving
 * account ownership) and trusts the provided email.
 *
 * On success, creates a guardian email channel binding directly in both
 * the assistant and gateway databases (dual-write).
 */

import { z } from "zod";

import {
  createGuardianBinding,
  getAssistantDb,
} from "../../auth/guardian-bootstrap.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { getLogger } from "../../logger.js";
import { validateMailgunEmail } from "./mailgun-identity.js";
import { validateResendEmail } from "./resend-identity.js";

const log = getLogger("inbound-register");

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const InboundRegisterRequestSchema = z.object({
  type: z.string().trim().toLowerCase(),
  guardian_email: z.string().trim().toLowerCase().email(),
});

// ---------------------------------------------------------------------------
// Provider → email validator map
// ---------------------------------------------------------------------------

type EmailValidator = (
  apiKey: string,
  guardianEmail: string,
) => Promise<boolean>;

const providerValidators: Record<string, EmailValidator> = {
  resend: validateResendEmail,
  mailgun: validateMailgunEmail,
};

// ---------------------------------------------------------------------------
// Guardian lookup
// ---------------------------------------------------------------------------

interface GuardianRow {
  id: string;
  principal_id: string;
}

/**
 * Find the existing guardian contact (any channel). Returns null if no
 * guardian has been verified yet.
 */
function findGuardian(): GuardianRow | null {
  const db = getAssistantDb();
  return (
    db
      .query<GuardianRow, []>(
        `SELECT id, principal_id FROM contacts WHERE role = 'guardian' LIMIT 1`,
      )
      .get() ?? null
  );
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

    const apiKeyCredKey = credentialKey(providerType, "api_key");
    const apiKey = await credentialCache.get(apiKeyCredKey, { force: true });

    if (!apiKey) {
      log.warn(
        { providerType },
        "No API key configured for provider — cannot auto-verify guardian",
      );
      return Response.json(
        { error: `No API key configured for ${providerType}` },
        { status: 409 },
      );
    }

    // ── Validate email with provider ────────────────────────────

    const valid = await validator(apiKey, guardianEmail);
    if (!valid) {
      log.warn(
        { providerType, guardianEmail },
        "Provider email validation failed — skipping auto-verify",
      );
      return Response.json(
        { error: `Email validation failed for ${providerType}` },
        { status: 422 },
      );
    }

    // ── Find existing guardian and create email channel binding ──

    const guardian = findGuardian();
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
      createGuardianBinding({
        channel: "email",
        externalUserId: guardianEmail,
        deliveryChatId: guardianEmail,
        guardianPrincipalId: guardian.principal_id,
        displayName: guardianEmail,
        verifiedVia: "webhook_registration",
      });
    } catch (err) {
      log.error(
        { err, providerType, guardianEmail },
        "Failed to create guardian email channel binding",
      );
      return Response.json(
        { error: "Failed to create guardian email channel" },
        { status: 500 },
      );
    }

    log.info(
      { providerType, guardianEmail },
      "Auto-verified guardian email channel via webhook registration",
    );

    return Response.json({
      ok: true,
      verified_via: "webhook_registration",
    });
  };
}
