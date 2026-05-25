/**
 * Vellum identity validation — platform-managed email.
 *
 * The route's edge-scoped auth already authenticates the platform,
 * so no external API key validation is needed.
 */

import { getLogger } from "../../logger.js";
import type { EmailValidationResult } from "./inbound-register.js";

const log = getLogger("vellum-identity");

export async function validateVellumEmail(
  _apiKey: string,
  guardianEmail: string,
): Promise<EmailValidationResult | null> {
  log.info("Platform-managed email — trusting provided guardian email");
  return {
    channel: "email",
    externalUserId: guardianEmail,
    deliveryChatId: guardianEmail,
    displayName: guardianEmail,
  };
}
