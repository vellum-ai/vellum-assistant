import { z } from "zod";

const IANA_TIMEZONE_IDENTIFIER_RE =
  /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

function canonicalizeIanaTimezone(timezone: string): string | null {
  const trimmed = timezone.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (!IANA_TIMEZONE_IDENTIFIER_RE.test(trimmed)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: trimmed,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function timezoneConfigField(path: string) {
  return z
    .string({ error: `${path} must be a string` })
    .transform((value, ctx) => {
      const canonical = canonicalizeIanaTimezone(value);
      if (canonical === null) {
        ctx.addIssue({
          code: "custom",
          message: `${path} must be a valid IANA timezone identifier or an empty string`,
        });
        return z.NEVER;
      }
      return canonical;
    });
}

export const PlatformConfigSchema = z
  .object({
    baseUrl: z
      .string({ error: "platform.baseUrl must be a string" })
      .refine(
        (val) => val === "" || /^https?:\/\//i.test(val),
        "platform.baseUrl must be an absolute URL starting with http:// or https://",
      )
      .default("")
      .describe("Base URL of the Vellum platform API"),
    subdomain: z
      .string({ error: "platform.subdomain must be a string" })
      .default("")
      .describe(
        "Registered subdomain on vellum.me (e.g. 'apollobot' → apollobot.vellum.me). Set automatically by 'assistant domain register'.",
      ),
  })
  .describe("Vellum platform connection settings");

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

export const DaemonConfigSchema = z
  .object({
    startupSocketWaitMs: z
      .number({ error: "daemon.startupSocketWaitMs must be a number" })
      .int("daemon.startupSocketWaitMs must be an integer")
      .positive("daemon.startupSocketWaitMs must be a positive integer")
      .default(5000)
      .describe(
        "How long to wait for the daemon socket to become available on startup (ms)",
      ),
    stopTimeoutMs: z
      .number({ error: "daemon.stopTimeoutMs must be a number" })
      .int("daemon.stopTimeoutMs must be an integer")
      .positive("daemon.stopTimeoutMs must be a positive integer")
      .default(5000)
      .describe(
        "How long to wait for the daemon to stop gracefully before force-killing (ms)",
      ),
    sigkillGracePeriodMs: z
      .number({ error: "daemon.sigkillGracePeriodMs must be a number" })
      .int("daemon.sigkillGracePeriodMs must be an integer")
      .positive("daemon.sigkillGracePeriodMs must be a positive integer")
      .default(2000)
      .describe("Grace period after SIGTERM before sending SIGKILL (ms)"),
    standaloneRecording: z
      .boolean({ error: "daemon.standaloneRecording must be a boolean" })
      .default(true)
      .describe(
        "Whether the daemon records conversations even when no client is connected",
      ),
  })
  .describe("Background daemon process configuration");

export const UiConfigSchema = z
  .object({
    userTimezone: timezoneConfigField("ui.userTimezone")
      .optional()
      .describe(
        "Manual IANA timezone override used for assistant temporal grounding and date/time display (e.g. 'America/New_York'). Use an empty string to clear the setting.",
      ),
    detectedTimezone: timezoneConfigField("ui.detectedTimezone")
      .optional()
      .describe(
        "IANA timezone identifier detected from the client environment for assistant temporal grounding when no manual override is configured (e.g. 'America/New_York'). Use an empty string to clear the setting.",
      ),
  })
  .describe(
    "User interface display settings. Empty-state greeting model selection lives under llm.callSites.emptyStateGreeting.",
  );

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
