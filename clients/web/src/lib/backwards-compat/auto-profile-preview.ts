/**
 * Backwards-compat gate: Auto profile draft preview.
 *
 * Assistants from this dev floor on serve `POST /v1/auto-profile/preview`,
 * which routes a composer draft the way the turn will and lets the pill read
 * "Auto · <profile>" while the user types. Older assistants have no such
 * route, so the composer must not ask: every paused draft would 404.
 *
 * The floor is the version `dev-release.yaml` stamped on the first preview
 * build that carries the route. Same-base builds compare by that stamp, so
 * every later preview build lights up and every earlier one stays dark.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.12.4-dev.202609232047.847daa9";

export function useSupportsAutoProfilePreview(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
