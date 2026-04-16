import { z } from "zod";

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
    userTimezone: z
      .string({ error: "ui.userTimezone must be a string" })
      .optional()
      .describe(
        "IANA timezone identifier for displaying dates and times (e.g. 'America/New_York')",
      ),
  })
  .describe(
    "User interface display settings. Empty-state greeting model selection lives under llm.callSites.emptyStateGreeting.",
  );

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
