/**
 * Resend identity validation — validates an API key is functional.
 *
 * Resend has no identity/account-owner endpoint, so the best we can do
 * is confirm the stored API key works (proving account ownership).
 */

import { getLogger } from "../../logger.js";

const log = getLogger("resend-identity");

/**
 * Validate the Resend API key by listing domains.
 *
 * A successful response proves the caller controls the Resend account.
 * Returns true when the key is functional.
 */
export async function validateResendEmail(
  apiKey: string,
  _guardianEmail: string,
): Promise<boolean> {
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
      return false;
    }

    log.info("Resend API key validated — trusting provided guardian_email");
    return true;
  } catch (err) {
    log.warn({ err }, "Resend API key validation request failed");
    return false;
  }
}
