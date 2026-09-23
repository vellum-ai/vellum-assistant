/**
 * Backwards-compat gate: Auto profile draft preview.
 *
 * Assistants from this dev floor on serve `POST /v1/auto-profile/preview`,
 * which routes a composer draft the way the turn will and lets the pill read
 * "Auto · <profile>" while the user types. Older assistants have no such
 * route, so the composer must not ask: every paused draft would 404.
 *
 * The floor is the dev stamp of the change that adds the route rather than
 * a predicted release number, so preview builds carrying it light up and
 * nothing earlier does.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.12.3-dev.202609230022.f2df2fb";

export function useSupportsAutoProfilePreview(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
