/**
 * Retrying self-heal for an SSE client subscription that registered without an
 * actor principal.
 *
 * In `DISABLE_HTTP_AUTH` deployments the SSE subscribe path cannot await, so it
 * resolves the dev-bypass actor principal from an IO-free peek at the
 * guardian-delivery cache. A cold cache registers the subscription with
 * `actorPrincipalId: undefined`, and every host-proxy result that client
 * submits then fails the same-actor gate with `missing_target`: a 403 that only
 * a fresh registration clears.
 *
 * The heal resolves the guardian asynchronously and patches the live hub
 * record. Each attempt can come back empty, since the lookup goes over the
 * gateway IPC and yields nothing both when the transport fails (unreachable
 * gateway, its 2s timeout, a pod still starting) and when no guardian binding
 * exists yet, so attempts repeat on a bounded backoff. The loop stops on the
 * first success, when the connection is gone or already carries a principal, or
 * when the schedule is exhausted.
 *
 * Callers must pass a cache-bypassing lookup: the guardian-delivery reader
 * caches a successful empty result for minutes, which outlives the whole
 * schedule, so a cached read would spend every attempt on the same stale
 * answer.
 */
import { getLogger } from "../../util/logger.js";

const log = getLogger("sse-actor-heal");

/**
 * The hub surface this module needs: a liveness check and the fill. Narrow by
 * design so tests can drive the loop without a real hub.
 */
export interface ActorPrincipalHealHub {
  needsActorPrincipalHeal(connectionId: string): boolean;
  fillClientActorPrincipalId(
    connectionId: string,
    actorPrincipalId: string,
  ): void;
}

/**
 * Delay before each attempt, in milliseconds. The leading zero dispatches the
 * first attempt inline with the subscribe; the rest back off to cover a gateway
 * that is slow to come up, without holding a timer for the life of a long-lived
 * stream. Total span is about 44s.
 */
export const ACTOR_PRINCIPAL_HEAL_DELAYS_MS: readonly number[] = [
  0, 1_000, 3_000, 10_000, 30_000,
];

/**
 * Start the retrying heal for `connectionId`. Fire-and-forget: never awaited by
 * the route, never delays the stream.
 *
 * `resolve` performs the daemon's own server-side guardian lookup, bypassing
 * the guardian-delivery cache. The value must never come from client input. It
 * may resolve `undefined` (no binding yet, or the gateway is unreachable) or
 * reject; both count as a failed attempt.
 */
export function startActorPrincipalHeal(args: {
  hub: ActorPrincipalHealHub;
  connectionId: string;
  resolve: () => Promise<string | undefined>;
  /** Override the backoff schedule. Tests pass all-zero delays. */
  delaysMs?: readonly number[];
}): void {
  const { hub, connectionId, resolve } = args;
  const delays = args.delaysMs ?? ACTOR_PRINCIPAL_HEAL_DELAYS_MS;

  void (async () => {
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delayMs = delays[attempt] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      // Re-check every pass: the connection may have closed, been replaced by a
      // reconnect, or been healed by another path since the last one.
      if (!hub.needsActorPrincipalHeal(connectionId)) {
        return;
      }

      let resolved: string | undefined;
      try {
        resolved = await resolve();
      } catch {
        resolved = undefined;
      }
      if (resolved) {
        hub.fillClientActorPrincipalId(connectionId, resolved);
        return;
      }
    }

    // Log the give-up so a principal-less subscription is greppable next to the
    // same-actor rejections it causes, rather than surfacing only as opaque
    // 403s on the client.
    if (hub.needsActorPrincipalHeal(connectionId)) {
      log.warn(
        { connectionId, attempts: delays.length },
        "gave up healing missing actorPrincipalId for client subscription; host-proxy results from this connection are rejected until it reconnects",
      );
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process (or a test runner) open on a pending backoff.
    (timer as { unref?: () => void }).unref?.();
  });
}
