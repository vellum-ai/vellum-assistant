import { publicAsset } from "@/utils/public-asset";

import type { McpPluginDefinition } from "../integration-items";

/**
 * Where a plugin definition's catalog logo actually lives.
 *
 * `definition.logo` is a bare file name (`"ashby.svg"`), not a URL. Put
 * straight into an `<img src>` it resolves against the page's own path, so the
 * same catalog entry draws on one route and 404s on a deeper one. Every
 * surface that shows the logo resolves it here instead, against Vite's `base`.
 */
export function pluginLogoUrl(definition: McpPluginDefinition): string | null {
  if (!definition.logo) {
    return null;
  }
  const url = publicAsset(`/images/integrations/${definition.logo}`);
  return definition.logoRevision
    ? `${url}?v=${encodeURIComponent(definition.logoRevision)}`
    : url;
}
