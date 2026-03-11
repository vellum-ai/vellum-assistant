import { z } from "zod";

export const PlatformConfigSchema = z.object({
  baseUrl: z
    .string({ error: "platform.baseUrl must be a string" })
    .refine(
      (val) => val === "" || /^https?:\/\//i.test(val),
      "platform.baseUrl must be an absolute URL starting with http:// or https://",
    )
    .default(""),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

export const DaemonConfigSchema = z.object({
  startupSocketWaitMs: z
    .number({ error: "daemon.startupSocketWaitMs must be a number" })
    .int("daemon.startupSocketWaitMs must be an integer")
    .positive("daemon.startupSocketWaitMs must be a positive integer")
    .default(5000),
  stopTimeoutMs: z
    .number({ error: "daemon.stopTimeoutMs must be a number" })
    .int("daemon.stopTimeoutMs must be an integer")
    .positive("daemon.stopTimeoutMs must be a positive integer")
    .default(5000),
  sigkillGracePeriodMs: z
    .number({ error: "daemon.sigkillGracePeriodMs must be a number" })
    .int("daemon.sigkillGracePeriodMs must be an integer")
    .positive("daemon.sigkillGracePeriodMs must be a positive integer")
    .default(2000),
  titleGenerationMaxTokens: z
    .number({ error: "daemon.titleGenerationMaxTokens must be a number" })
    .int("daemon.titleGenerationMaxTokens must be an integer")
    .positive("daemon.titleGenerationMaxTokens must be a positive integer")
    .default(30),
  standaloneRecording: z
    .boolean({ error: "daemon.standaloneRecording must be a boolean" })
    .default(true),
});

export const UiConfigSchema = z.object({
  userTimezone: z
    .string({ error: "ui.userTimezone must be a string" })
    .optional(),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
