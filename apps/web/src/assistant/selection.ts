/**
 * The single read/write path for the selected assistant, shared by platform
 * and local flows so the two stop diverging.
 *
 * Read: `resolveSelectedAssistantId` validates the one selected id for the
 * active org, falling back to the lockfile `activeAssistant` and finally the
 * first valid assistant.
 *
 * Write: `setSelectedAssistant` records the selection AND mirrors it into the
 * lockfile `activeAssistant`, so the macOS tray, the CLI, and the native
 * client agree.
 */

import {
  getActiveAssistant,
  setActiveLockfileAssistant,
} from "@/lib/local-mode";
import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";

/**
 * Resolve the selected assistant id for the active org. There is one selection;
 * the org is only a read-time filter.
 *
 * Order:
 *   1. The selected id, if valid for the org. An UNKNOWN id (no resolved entry)
 *      passes through only until the list is hydrated — pre-load the list may
 *      simply not have arrived yet. Once hydrated an unknown id is a ghost and
 *      falls through (the store also reconciles it away on lockfile load).
 *   2. Else the lockfile `activeAssistant`, if valid for the org.
 *   3. Else the first valid assistant for the org, or null.
 */
export function resolveSelectedAssistantId(
  activeOrgId: string | null,
): string | null {
  const { assistants, selectedAssistantId, assistantsHydrated } =
    useResolvedAssistantsStore.getState();
  const valid = assistantsValidForOrg(assistants, activeOrgId);
  const isValid = (id: string): boolean => valid.some((a) => a.id === id);

  if (selectedAssistantId !== null) {
    const known = assistants.some((a) => a.id === selectedAssistantId);
    if (isValid(selectedAssistantId)) return selectedAssistantId;
    // Unknown id: pass through only pre-hydration. Once the list is
    // authoritative, an id absent from it is a ghost — fall through.
    if (!known && !assistantsHydrated) return selectedAssistantId;
  }

  // Lockfile active, then first valid — both validated.
  const active = getActiveAssistant()?.assistantId ?? null;
  if (active !== null && isValid(active)) return active;

  return valid[0]?.id ?? null;
}

/**
 * The single write path for switching the selected assistant. Records the
 * selection (reactive slice + persisted key) and mirrors it into the lockfile
 * `activeAssistant` (a no-op in the browser, where there is no lockfile host).
 */
export async function setSelectedAssistant(id: string): Promise<void> {
  useResolvedAssistantsStore.getState().setSelectedAssistant(id);
  await setActiveLockfileAssistant(id);
}
