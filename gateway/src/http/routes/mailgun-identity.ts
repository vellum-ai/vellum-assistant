/**
 * Mailgun identity validation — cross-verifies a guardian email against
 * the Mailgun account owner via `GET /v5/users/me`.
 */

import { getLogger } from "../../logger.js";
import type { EmailValidationResult } from "./inbound-register.js";

const log = getLogger("mailgun-identity");

/**
 * Fetch the Mailgun account owner's email and compare it to the
 * provided guardian email.
 *
 * Returns binding fields when the API key is valid AND the owner email
 * matches, null otherwise.
 */
export async function validateMailgunEmail(
  apiKey: string,
  guardianEmail: string,
): Promise<EmailValidationResult | null> {
  let ownerEmail: string | null = null;

  for (const baseUrl of [
    "https://api.mailgun.net",
    "https://api.eu.mailgun.net",
  ]) {
    try {
      const response = await fetch(`${baseUrl}/v5/users/me`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        const data = (await response.json()) as { email?: string };
        ownerEmail = data.email?.trim().toLowerCase() ?? null;
        break;
      }

      if (response.status === 401) continue;

      log.warn(
        { status: response.status, baseUrl },
        "Mailgun /v5/users/me returned non-OK status",
      );
    } catch (err) {
      log.warn({ err, baseUrl }, "Failed to fetch Mailgun owner email");
    }
  }

  if (!ownerEmail) {
    log.warn("Could not fetch Mailgun account owner email from any region");
    return null;
  }

  if (ownerEmail !== guardianEmail) {
    log.warn("Mailgun owner email does not match provided guardian email");
    return null;
  }

  log.info("Mailgun owner email matches guardian email");
  return {
    channel: "email",
    externalUserId: guardianEmail,
    deliveryChatId: guardianEmail,
    displayName: guardianEmail,
  };
}
