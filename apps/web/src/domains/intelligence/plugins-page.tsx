import { Navigate } from "react-router";

import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import { routes } from "@/utils/routes.js";

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
 * The tab is also conditionally rendered by `IntelligenceLayout` so
 * users without the flag never see the entry point. This redirect
 * exists to handle direct URL access.
 */
export function PluginsPage() {
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();

  if (!externalPlugins) {
    return <Navigate to={routes.identity} replace />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-medium-default text-[var(--content-tertiary)]">
        External plugins installed under{" "}
        <code className="rounded bg-[var(--surface-secondary)] px-1 py-0.5 text-body-small-default">
          {"<workspaceDir>/plugins/"}
        </code>
        . Use the{" "}
        <code className="rounded bg-[var(--surface-secondary)] px-1 py-0.5 text-body-small-default">
          assistant plugins
        </code>{" "}
        CLI to install, list, search, and uninstall plugins.
      </p>
    </div>
  );
}
