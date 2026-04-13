/**
 * Email provider registry.
 *
 * AgentMail has been removed. Email is now handled through the platform
 * (VellumPlatformClient + Mailgun). This module remains as a minimal
 * stub for backward compatibility with callers that haven't been migrated.
 */

import { ConfigError } from "../../util/errors.js";
import type { EmailProvider } from "../provider.js";

export const SUPPORTED_PROVIDERS = [] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Read the active email provider from config.
 * No providers are currently supported via the local provider system.
 * Email is handled through the platform (Mailgun).
 */
export function getActiveProviderName(): string {
  return "platform";
}

/**
 * Create an EmailProvider instance.
 * Always throws — local email providers have been removed.
 * Email is handled through the platform API (VellumPlatformClient).
 */
export async function createProvider(): Promise<EmailProvider> {
  throw new ConfigError(
    "Local email providers have been removed. Email is now handled through the platform. " +
      "Use `assistant email register` to set up an email address.",
  );
}
