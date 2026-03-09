import { z } from "zod";

export const TimeoutConfigSchema = z.object({
  shellMaxTimeoutSec: z
    .number({ error: "timeouts.shellMaxTimeoutSec must be a number" })
    .finite("timeouts.shellMaxTimeoutSec must be finite")
    .positive("timeouts.shellMaxTimeoutSec must be a positive number")
    .default(600),
  shellDefaultTimeoutSec: z
    .number({ error: "timeouts.shellDefaultTimeoutSec must be a number" })
    .finite("timeouts.shellDefaultTimeoutSec must be finite")
    .positive("timeouts.shellDefaultTimeoutSec must be a positive number")
    .default(120),
  permissionTimeoutSec: z
    .number({ error: "timeouts.permissionTimeoutSec must be a number" })
    .finite("timeouts.permissionTimeoutSec must be finite")
    .positive("timeouts.permissionTimeoutSec must be a positive number")
    .default(300),
  toolExecutionTimeoutSec: z
    .number({ error: "timeouts.toolExecutionTimeoutSec must be a number" })
    .finite("timeouts.toolExecutionTimeoutSec must be finite")
    .positive("timeouts.toolExecutionTimeoutSec must be a positive number")
    .default(120),
  providerStreamTimeoutSec: z
    .number({ error: "timeouts.providerStreamTimeoutSec must be a number" })
    .finite("timeouts.providerStreamTimeoutSec must be finite")
    .positive("timeouts.providerStreamTimeoutSec must be a positive number")
    .default(300),
});

export const RateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z
    .number({ error: "rateLimit.maxRequestsPerMinute must be a number" })
    .int("rateLimit.maxRequestsPerMinute must be an integer")
    .nonnegative(
      "rateLimit.maxRequestsPerMinute must be a non-negative integer",
    )
    .default(0),
  maxTokensPerSession: z
    .number({ error: "rateLimit.maxTokensPerSession must be a number" })
    .int("rateLimit.maxTokensPerSession must be an integer")
    .nonnegative("rateLimit.maxTokensPerSession must be a non-negative integer")
    .default(0),
});

export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
