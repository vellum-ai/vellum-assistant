/**
 * Backwards-compat gate: workspace theme overrides.
 *
 * Vellum Assistant 0.10.8 added `GET /v1/workspace/theme`, which serves
 * validated design-token overrides authored in the workspace
 * `ui/theme.json`. Older assistants 404 the route, so the web app skips
 * the theme query and applies no overrides — the built-in light/dark/velvet
 * themes render exactly as they did before the feature.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.8";

export function useSupportsWorkspaceTheme(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
