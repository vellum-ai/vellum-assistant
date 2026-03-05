/**
 * Shared Twilio phone number resolution utilities.
 *
 * Multiple subsystems (readiness probes, invite adapters, call config) need to
 * resolve phone numbers with the same precedence chain. This module provides a
 * single source of truth for that logic so changes propagate everywhere.
 */

import { getTwilioPhoneNumberEnv } from "../config/env.js";
import { loadRawConfig } from "../config/loader.js";
import { getSecureKey } from "../security/secure-keys.js";

/**
 * Resolve SMS/voice phone number with canonical precedence:
 * env override -> config sms.phoneNumber -> secure key fallback.
 */
export function resolveSmsPhoneNumber(): string {
  try {
    const raw = loadRawConfig();
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    return (
      getTwilioPhoneNumberEnv() ||
      (smsConfig.phoneNumber as string) ||
      getSecureKey("credential:twilio:phone_number") ||
      ""
    );
  } catch {
    return (
      getTwilioPhoneNumberEnv() ||
      getSecureKey("credential:twilio:phone_number") ||
      ""
    );
  }
}

/**
 * Resolve the WhatsApp phone number with canonical precedence:
 * env override -> config whatsapp.phoneNumber -> config sms.phoneNumber
 * -> secure key fallback.
 *
 * WhatsApp typically shares the Twilio phone number with SMS, but
 * allows a channel-specific override via config.
 */
export function resolveWhatsAppPhoneNumber(): string {
  try {
    const raw = loadRawConfig();
    const whatsappConfig = (raw?.whatsapp ?? {}) as Record<string, unknown>;
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    return (
      getTwilioPhoneNumberEnv() ||
      (whatsappConfig.phoneNumber as string) ||
      (smsConfig.phoneNumber as string) ||
      getSecureKey("credential:twilio:phone_number") ||
      ""
    );
  } catch {
    return (
      getTwilioPhoneNumberEnv() ||
      getSecureKey("credential:twilio:phone_number") ||
      ""
    );
  }
}
