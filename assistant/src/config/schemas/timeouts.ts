import { z } from "zod";

export const TimeoutConfigSchema = z
  .object({
    shellMaxTimeoutSec: z
      .number({ error: "timeouts.shellMaxTimeoutSec must be a number" })
      .finite("timeouts.shellMaxTimeoutSec must be finite")
      .positive("timeouts.shellMaxTimeoutSec must be a positive number")
      .default(600)
      .describe(
        "Maximum allowed timeout for shell command execution in seconds",
      ),
    shellDefaultTimeoutSec: z
      .number({ error: "timeouts.shellDefaultTimeoutSec must be a number" })
      .finite("timeouts.shellDefaultTimeoutSec must be finite")
      .positive("timeouts.shellDefaultTimeoutSec must be a positive number")
      .default(120)
      .describe(
        "Default timeout for shell commands when no explicit timeout is specified (seconds)",
      ),
    permissionTimeoutSec: z
      .number({ error: "timeouts.permissionTimeoutSec must be a number" })
      .finite("timeouts.permissionTimeoutSec must be finite")
      .positive("timeouts.permissionTimeoutSec must be a positive number")
      .default(300)
      .describe(
        "How long to wait for user permission approval before timing out (seconds)",
      ),
    toolExecutionTimeoutSec: z
      .number({ error: "timeouts.toolExecutionTimeoutSec must be a number" })
      .finite("timeouts.toolExecutionTimeoutSec must be finite")
      .positive("timeouts.toolExecutionTimeoutSec must be a positive number")
      .default(120)
      .describe("Default timeout for tool execution in seconds"),
    toolDeferralThresholdSec: z
      .number({ error: "timeouts.toolDeferralThresholdSec must be a number" })
      .finite("timeouts.toolDeferralThresholdSec must be finite")
      .positive("timeouts.toolDeferralThresholdSec must be a positive number")
      .default(10)
      .describe(
        "If a tool execution exceeds this threshold (seconds), the agent loop defers it to the background and continues the assistant turn with a placeholder result. Only effective when the tool-deferral feature flag is enabled.",
      ),
    providerStreamTimeoutSec: z
      .number({ error: "timeouts.providerStreamTimeoutSec must be a number" })
      .finite("timeouts.providerStreamTimeoutSec must be finite")
      .positive("timeouts.providerStreamTimeoutSec must be a positive number")
      .default(1800)
      .describe(
        "Timeout for waiting on the LLM provider's streaming response (seconds)",
      ),
  })
  .describe("Timeout configuration for various operations");

export const RateLimitConfigSchema = z
  .object({
    maxRequestsPerMinute: z
      .number({ error: "rateLimit.maxRequestsPerMinute must be a number" })
      .int("rateLimit.maxRequestsPerMinute must be an integer")
      .nonnegative(
        "rateLimit.maxRequestsPerMinute must be a non-negative integer",
      )
      .default(0)
      .describe("Maximum number of LLM requests per minute (0 = unlimited)"),
  })
  .describe("Rate limiting for LLM provider requests");

export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
