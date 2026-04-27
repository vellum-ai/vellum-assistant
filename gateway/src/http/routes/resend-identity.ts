/**
 * Resend identity validation — validates an API key is functional.
 *
 * Resend has no identity/account-owner endpoint, so the best we can do
 * is confirm the stored API key works (proving account ownership).
 */

import { getLogger } from "../../logger.js";
import type { EmailValidationResult } from "./inbound-register.js";

const log = getLogger("resend-identity");

/**
 * Validate the Resend API key by listing domains.
 *
 * A successful response proves the caller controls the Resend account.
 * Returns binding fields when the key is functional, null otherwise.
 */
export async function validateResendEmail(
  apiKey: string,
  guardianEmail: string,
): Promise<EmailValidationResult | null> {
  try {
    const response = await fetch("https://api.resend.com/domains", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "vellum-gateway/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status },
        "Resend API key validation failed — key may be invalid or expired",
      );
      return null;
    }

    log.info("Resend API key validated — trusting provided guardian email");
    return {
      channel: "email",
      externalUserId: guardianEmail,
      deliveryChatId: guardianEmail,
      displayName: guardianEmail,
    };
  } catch (err) {
    log.warn({ err }, "Resend API key validation request failed");
    return null;
  }
}
