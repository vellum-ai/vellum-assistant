/**
 * Decide whether the research-onboarding flow ADOPTS an already-provisioned
 * local assistant instead of running the managed background hatch.
 *
 * The explicit `?hosting` choice wins when present: local/docker hosting means
 * the hatching screen provisioned the assistant in the foreground, and
 * "vellum-cloud" means a managed hatch is wanted even though the desktop
 * build reports local mode. When the param is absent (a refresh that lost the
 * query string, a back-navigation from the check-in overlay, a direct visit),
 * fall back to the app's own state: a live gateway-auth session in a
 * local-mode build IS a connected local assistant, and running the managed
 * hatch against it would strand the flow on a "Waking up" gate for an
 * assistant that is already up.
 */
export function shouldAdoptExistingAssistant({
  hostingParam,
  localMode,
  gatewayAuthSession,
}: {
  /** The research route's `?hosting` value, or null when absent. */
  hostingParam: string | null;
  /** Build-time local mode (`isLocalMode()`). */
  localMode: boolean;
  /** A live local gateway session exists (`isGatewayAuthMode()`). */
  gatewayAuthSession: boolean;
}): boolean {
  if (!localMode) {
    return false;
  }
  if (hostingParam !== null) {
    return hostingParam !== "vellum-cloud";
  }
  return gatewayAuthSession;
}
