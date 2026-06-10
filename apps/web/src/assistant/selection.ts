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

  const candidate =
    (activeOrgId ? selectedPlatformAssistantByOrg[activeOrgId] : null) ??
    getTabLocalSelectedAssistantId() ??
    null;

  if (candidate !== null) {
    const entry = assistants.find((a) => a.id === candidate);
    // Unknown id (not resolved yet) passes through; the 404 net handles it.
    if (!entry || valid.some((a) => a.id === candidate)) return candidate;
  }

  const active = getActiveAssistant()?.assistantId ?? null;
  if (active !== null && valid.some((a) => a.id === active)) return active;

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
