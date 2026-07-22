import { z } from "zod";

/**
 * Default per-minute request budget for authenticated remote (non-loopback)
 * clients on the runtime `/v1/*` API. Kept in sync with the limiter's built-in
 * fallback in `runtime/middleware/rate-limiter.ts`, so an unset config
 * preserves the current 300 req/min behavior.
 */
export const DEFAULT_AUTHENTICATED_API_MAX_REQUESTS_PER_MINUTE = 300;

export const ApiRateLimitConfigSchema = z
  .object({
    authenticatedMaxRequestsPerMinute: z
      .number({
        error:
          "apiRateLimit.authenticatedMaxRequestsPerMinute must be a number",
      })
      .int("apiRateLimit.authenticatedMaxRequestsPerMinute must be an integer")
      .positive(
        "apiRateLimit.authenticatedMaxRequestsPerMinute must be a positive integer",
      )
      .default(DEFAULT_AUTHENTICATED_API_MAX_REQUESTS_PER_MINUTE)
      .describe(
        "Per-minute request budget for authenticated remote (non-loopback) clients on the runtime /v1/* API. The higher loopback budget and the lower unauthenticated (per-IP) budget are fixed and unaffected by this value.",
      ),
  })
  .describe(
    "Rate limiting for the authenticated runtime HTTP API (per-client-IP).",
  );

export type ApiRateLimitConfig = z.infer<typeof ApiRateLimitConfigSchema>;
