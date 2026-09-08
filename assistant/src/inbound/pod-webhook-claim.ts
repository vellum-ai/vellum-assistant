/**
 * The platform-pod tier of webhook URL resolution, shared by the two seams that
 * resolve callback URLs: `resolveCallbackUrl` and the `webhooks_register` route
 * handler.
 *
 * A pod's Velay tunnel only forwards subpaths the gateway has claimed, so the
 * published ingress URL is handed out only once the claim succeeds. Anything
 * else leaves the caller to register with the platform instead.
 */

/**
 * The published ingress URL for a webhook, or undefined when the pod should
 * fall back to platform registration.
 *
 * `ingressUrl` is a lazy supplier because the builders behind it throw when no
 * public base URL has been published yet, and on a pod that throw is not fatal:
 * a pod owner with no tunnel yet, or one who turned ingress off, must not lose
 * webhooks entirely.
 *
 * @param ingressUrl - Lazy supplier for the published ingress callback URL.
 * @param claimRoute - Claims the subpath on the gateway; false when the gateway
 *   refuses the claim or cannot be reached.
 */
export async function resolveClaimedPodWebhookUrl(
  ingressUrl: () => string,
  claimRoute: () => Promise<boolean>,
): Promise<string | undefined> {
  let url: string;
  try {
    url = ingressUrl();
  } catch {
    return undefined;
  }
  return (await claimRoute()) ? url : undefined;
}
