import { Navigate, useParams } from "react-router";

import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

/**
 * Redirect shim for the retired standalone plugin detail route.
 *
 * Plugin detail now renders in-tab via the `?plugin=<name>` deep-link on
 * the Plugins tab (see `plugins-page.tsx` / `components/plugins/plugins-tab.tsx`).
 * The old `/assistant/plugins/:name` URL is kept as a bookmark/deep-link
 * contract and forwarded here so saved links resolve into the in-tab detail.
 *
 * Mirrors `PluginsPage`'s backwards-compat gate: it waits for the assistant
 * version to hydrate, then redirects a flag-off (plugin-routes-absent)
 * assistant back to Identity exactly as the surface did before — so an old
 * deep-link never lands on a dead surface.
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

  if (!supportsPlugins) {
    return <Navigate to={routes.identity} replace />;
  }

  if (!name) {
    return <Navigate to={routes.plugins} replace />;
  }

  return (
    <Navigate
      to={`${routes.plugins}?plugin=${encodeURIComponent(name)}`}
      replace
    />
  );
}
