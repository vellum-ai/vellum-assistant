import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PluginsTab } from "@/domains/intelligence/components/plugins/plugins-tab";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Plugins tab for the "About Assistant" pages.
 *
 * Gated by the `external-plugins` assistant feature flag (store key
 * `externalPlugins`). When the flag is off, the route redirects back to
 * the Identity tab — Plugins is an unstable surface that may change
 * shape before stabilizing (see
 * `assistant/src/plugins/feature-gate.ts` and the registry entry in
 * `meta/feature-flags/feature-flag-registry.json`).
 *
 * The redirect waits for the assistant feature flag store to hydrate
 * (`hasHydrated`) before firing. Without this wait, deep-links and
 * refreshes to `/assistant/plugins` would redirect to Identity during
 * the initial defaults-window (registry default is `false`) even for
 * users who actually have the flag enabled — the new route would
 * silently behave as unavailable. See the `hasHydrated` doc on
 * `assistant-feature-flag-store.ts`.
 *
 * The tab is also conditionally rendered by `IntelligenceLayout` so
 * users without the flag never see the entry point. This redirect
 * exists to handle direct URL access.
 */
export function PluginsPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const assistantId = useActiveAssistantId();

  // Wait for the first real /feature-flags response before deciding to
  // redirect. Rendering nothing for one render is preferable to bouncing
  // a user who genuinely has the flag enabled away from a valid URL.
  if (!hasHydrated) {
    return null;
  }

  if (!externalPlugins) {
    return <Navigate to={routes.identity} replace />;
  }

  return <PluginsTab assistantId={assistantId} />;
}
