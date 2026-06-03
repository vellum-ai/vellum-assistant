/**
 * Memory v3 — shared retry helper for the L1 router and L2 selector model calls.
 *
 * The configured provider is already wrapped in `RetryProvider`
 * (`../../providers/retry.ts`), which retries transient transport failures
 * (network errors, 429s, 5xx, stream aborts) with exponential backoff before it
 * ever throws. This helper therefore adds NO backoff of its own; it exists to:
 *   (a) re-prompt on a malformed-but-successful response — a 200 whose body has
 *       no usable forced `tool_use`, or whose tool input fails schema validation
 *       (the provider's retry never re-runs these, since nothing threw); and
 *   (b) cheaply re-attempt a call that threw after the provider exhausted its
 *       own retries, before the lane degrades to its deterministic fallback.
 *
 * `attempt` signals "unusable, retry me" by returning `null` (or throwing). The
 * first non-null result wins; `null` after `maxAttempts` tells the caller to
 * degrade to the deterministic recall lanes.
 */
export async function retryForResult<T>(
  attempt: () => Promise<T | null>,
  maxAttempts = 3,
): Promise<T | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await attempt();
      if (result !== null) return result;
    } catch {
      // Treat a throw like an unusable result and retry. The provider layer has
      // already backed off transient errors, so there is nothing to wait for.
    }
  }
  return null;
}
