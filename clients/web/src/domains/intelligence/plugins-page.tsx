import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PluginsTab } from "@/domains/intelligence/components/plugins/plugins-tab";
import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

/**
 * Plugins tab for the "About Assistant" pages.
 *
 * Gated on the connected assistant being new enough to expose the plugin
 * routes (see `lib/backwards-compat/plugins-surface.ts`). On older
 * assistants the routes 404, so a direct deep-link to `/assistant/plugins`
 * redirects back to Identity rather than rendering a broken catalog. The
 * redirect waits for the assistant version to hydrate so it never bounces
 * a deep-link on a supported assistant during the initial identity fetch.
 */
export function PluginsPage() {
  const version = useAssistantIdentityStore.use.version();
  const supportsPlugins = useSupportsPluginsSurface();
  const assistantId = useActiveAssistantId();

  if (version === null) {
    return null;
  }

  if (!supportsPlugins) {
    return <Navigate to={routes.identity} replace />;
  }

  // `PluginsTab` reads the `?plugin=` deep-link itself (it owns the open-detail
  // URL state), so nothing extra to thread through here.
  return <PluginsTab assistantId={assistantId} />;
}
