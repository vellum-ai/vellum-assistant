/**
 * The single read/write path for the selected assistant, shared by platform
 * and local flows so the two stop diverging.
 *
 * Read: `resolveSelectedAssistantId` resolves a per-org cache hit (or a
 * tab-local pick) down to a valid id for the active org, falling back to the
 * lockfile `activeAssistant` and finally the first valid assistant.
 *
 * Write: `setSelectedAssistant` records the per-org cache selection AND mirrors
 * it into the lockfile `activeAssistant`, so the macOS tray, the CLI, and the
 * native client agree.
 */

import {
  getActiveAssistant,
  getTabLocalSelectedAssistantId,
  setActiveLockfileAssistant,
} from "@/lib/local-mode";
import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * Resolve the selected assistant id for the active org.
 *
 * Order:
 *   1. Candidate from the cache — the per-org platform selection, or the raw
 *      tab-local pick. NOT the lockfile `activeAssistant`: that is only reached
 *      via the validated fallback (step 3), so a stale active id can't slip
 *      through the unknown-id pass-through and 404-loop forever.
 *   2. Keep the candidate only if it is valid for the org. An unknown id (no
 *      resolved entry yet) passes through unchanged — the lifecycle 404 net
 *      covers ids the client can't see.
 *   3. Else the lockfile `activeAssistant`, if valid for the org.
 *   4. Else the first valid assistant for the org, or null.
 */
export function resolveSelectedAssistantId(
  activeOrgId: string | null,
): string | null {
  const { assistants, selectedPlatformAssistantByOrg } =
    useResolvedAssistantsStore.getState();
  const valid = assistantsValidForOrg(assistants, activeOrgId);
  const isValid = (id: string): boolean => valid.some((a) => a.id === id);

  // Per-org platform selection: an unknown id passes through — the lifecycle
  // 404 net clears `selectedPlatformAssistantByOrg`, so a stale one self-heals.
  const perOrg = activeOrgId
    ? (selectedPlatformAssistantByOrg[activeOrgId] ?? null)
    : null;
  if (perOrg !== null) {
    const known = assistants.some((a) => a.id === perOrg);
    if (!known || isValid(perOrg)) return perOrg;
  }

  // Tab-local pick: only when it resolves to a VALID assistant. No unknown
  // pass-through here — the 404 net doesn't clear the tab-local key, so a stale
  // id would loop (reconcileSelectedAssistant clears it on lockfile commit).
  const tabLocal = getTabLocalSelectedAssistantId();
  if (tabLocal !== null && isValid(tabLocal)) return tabLocal;

  // Lockfile active, then first valid — both validated.
  const active = getActiveAssistant()?.assistantId ?? null;
  if (active !== null && isValid(active)) return active;

  return valid[0]?.id ?? null;
}

/**
 * The single write path for switching the selected assistant. Records the
 * per-org cache selection and mirrors it into the lockfile `activeAssistant`
 * (a no-op in the browser, where there is no lockfile host).
 */
export async function setSelectedAssistant(id: string): Promise<void> {
  const orgId = useOrganizationStore.getState().currentOrganizationId;
  if (orgId) {
    useResolvedAssistantsStore.getState().setSelectedPlatformAssistant(orgId, id);
  }
  await setActiveLockfileAssistant(id);
}
