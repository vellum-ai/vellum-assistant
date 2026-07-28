import { Navigate, useParams } from "react-router";

import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

/**
 * Route handler for `/assistant/plugins/:name` that forwards into the in-tab
 * plugin detail: it redirects (replace) to the `?plugin=<name>` deep-link on
 * the My Superpowers page (see `superpowers-page.tsx` /
 * `components/superpowers/superpowers-tab.tsx`), so a link to a specific
 * plugin resolves to that plugin's detail.
 *
 * It gates on the backwards-compat plugins surface: it waits for the
 * assistant version to hydrate, then sends an assistant whose daemon lacks
 * the plugin routes to the (skills-only) list rather than a dead detail.
 */
export function PluginDetailPage() {
  const version = useAssistantIdentityStore.use.version();
  const supportsPlugins = useSupportsPluginsSurface();
  const { name } = useParams<{ name: string }>();

  // Wait for the assistant version to hydrate before deciding to redirect
  // so a deep-link on a supported assistant isn't bounced during the
  // initial identity fetch.
  if (version === null) {
    return null;
  }

  if (!supportsPlugins || !name) {
    return <Navigate to={routes.superpowers} replace />;
  }

  return (
    <Navigate
      to={`${routes.superpowers}?plugin=${encodeURIComponent(name)}`}
      replace
    />
  );
}
