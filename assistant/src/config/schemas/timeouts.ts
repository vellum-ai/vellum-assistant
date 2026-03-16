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
    providerStreamTimeoutSec: z
      .number({ error: "timeouts.providerStreamTimeoutSec must be a number" })
      .finite("timeouts.providerStreamTimeoutSec must be finite")
      .positive("timeouts.providerStreamTimeoutSec must be a positive number")
      .default(300)
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
    maxTokensPerSession: z
      .number({ error: "rateLimit.maxTokensPerSession must be a number" })
      .int("rateLimit.maxTokensPerSession must be an integer")
      .nonnegative(
        "rateLimit.maxTokensPerSession must be a non-negative integer",
      )
      .default(0)
      .describe(
        "Maximum total tokens (input + output) per conversation session (0 = unlimited)",
      ),
  })
  .describe("Rate limiting for LLM provider requests");

export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
