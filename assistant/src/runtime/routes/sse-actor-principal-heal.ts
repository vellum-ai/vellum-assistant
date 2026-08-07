/**
 * Retrying self-heal for an SSE client subscription that registered without
 * an actor principal.
 *
 * In `DISABLE_HTTP_AUTH` deployments the SSE subscribe path cannot await, so
 * it resolves the dev-bypass actor principal from an IO-free peek at the
 * guardian-delivery cache. On a cold cache the subscription registers with
 * `actorPrincipalId: undefined`, and every host-proxy result the client
 * submits then fails the same-actor gate with `missing_target` — a 403 the
 * client can only escape by reconnecting.
 *
 * The route closes that window by resolving the guardian asynchronously after
 * the eager subscribe and patching the live hub record. A single attempt is
 * not enough: the guardian read goes over the gateway IPC, which returns
 * `null` on ANY transport failure (unreachable gateway, 2s timeout, a pod that
 * has not finished starting). One failed attempt left the subscription
 * principal-less for its whole lifetime, so the client 403'd every host-proxy
 * result until the user manually reconnected — and, for a Chrome extension
 * whose MV3 service worker suspends and reconnects on its own schedule, each
 * reconnect was a fresh coin flip on whether the read happened to succeed.
 * That is the "reconnect fixes it, then it breaks again" report.
 *
 * So the heal retries on a bounded backoff, re-checking before each attempt
 * whether the subscription still needs healing. It stops on the first success,
 * when the connection is gone or already carries a principal, or when the
 * schedule is exhausted (a reconnect retries from scratch either way).
 */
import { getLogger } from "../../util/logger.js";

const log = getLogger("sse-actor-heal");

/**
 * The hub surface this module needs: a liveness/need check and the fill.
 * Narrow by design so tests can drive the loop without a real hub.
 */
export interface ActorPrincipalHealHub {
  needsActorPrincipalHeal(connectionId: string): boolean;
  fillClientActorPrincipalId(
    connectionId: string,
    actorPrincipalId: string,
  ): void;
}

/**
 * Delay before each attempt, in milliseconds. The first attempt starts
 * immediately (no timer — the previous single-shot timing is preserved), then
 * the retries back off to cover a gateway that is slow to come up without
 * holding a timer for the life of a long-lived stream. Total span ≈ 44s.
 */
export const ACTOR_PRINCIPAL_HEAL_DELAYS_MS: readonly number[] = [
  0, 1_000, 3_000, 10_000, 30_000,
];

/**
 * Start the retrying heal for `connectionId`. Fire-and-forget: never awaited
 * by the route, never delays the stream.
 *
 * `resolve` performs the daemon's own server-side guardian lookup — the value
 * must never come from client input. It may resolve `undefined` (no binding
 * yet / gateway unreachable) or reject; both count as a failed attempt.
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
      // A zero delay runs inline rather than costing a macrotask, so the
      // first attempt is dispatched synchronously with the subscribe.
      const delayMs = delays[attempt] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      // Re-check every time: the connection may have closed, been replaced by
      // a reconnect, or been healed by a concurrent path since the last pass.
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

    // Exhausted. Log once so a persistently principal-less subscription is
    // greppable next to the same-actor rejections it will cause, rather than
    // showing up only as unexplained 403s on the client.
    if (hub.needsActorPrincipalHeal(connectionId)) {
      log.warn(
        { connectionId, attempts: delays.length },
        "gave up healing missing actorPrincipalId for client subscription; host-proxy results from this connection will be rejected until it reconnects",
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
