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

import { createGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { assistantDbQuery } from "../../db/assistant-db-proxy.js";
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
};

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
async function findGuardian(): Promise<(GuardianRow & { principal_id: string }) | null> {
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
