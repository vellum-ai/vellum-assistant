/**
 * The single read/write path for the selected assistant, shared by platform
 * and local flows so the two stop diverging.
 *
 * Read: `resolveSelectedAssistantId` validates the one selected id for the
 * active org, falling back to the lockfile `activeAssistant` and finally the
 * first valid assistant. `useGatedSelectedAssistantId` is the reactive,
 * flag-gated wrapper every React consumer goes through.
 *
 * Write: `setSelectedAssistant` records the selection AND mirrors it into the
 * lockfile `activeAssistant`, so the macOS tray, the CLI, and the native
 * client agree.
 */

import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import {
  getActiveAssistant,
  isLocalClient,
  setActiveLockfileAssistant,
} from "@/lib/local-mode";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useRequestOrganizationId } from "@/stores/organization-store";
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
    if (isValid(selectedAssistantId)) {
      return selectedAssistantId;
    }
    // Unknown id: pass through only pre-hydration. Once the list is
    // authoritative, an id absent from it is a ghost — fall through.
    if (!known && !assistantsHydrated) {
      return selectedAssistantId;
    }
  }

  // Lockfile active, then first valid — both validated.
  const active = getActiveAssistant()?.assistantId ?? null;
  if (active !== null && isValid(active)) {
    return active;
  }

  return valid[0]?.id ?? null;
}

/**
 * Reactive, flag-gated read of the selection, shared by every consumer that
 * must agree with the lifecycle on which assistant is selected. Honors the
 * stored selection when the multi-platform-assistant flag is on, or when the
 * assistant-switcher flag is on for a local client (its Switch Assistant
 * chooser stores the same selection, and the switcher is local-client-only).
 * Gateway-auth mode and a missing org id return null, as does a closed gate:
 * callers apply their own fallback. The org id comes from the same derivation
 * the `Vellum-Organization-Id` header uses (the resolved selection, or the
 * persisted id standing in for it), so a failed organization fetch cannot
 * drop the user's choice. Subscribes to the flags, the org, the selection,
 * the resolved list, and its hydration marker so consumers re-render when
 * any resolution input changes (hydration alone flips an unknown selected id
 * from pass-through to ghost, even when the list itself is unchanged).
 */
export function useGatedSelectedAssistantId(): string | null {
  const organizationId = useRequestOrganizationId();
  const multiAssistantEnabled =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  const assistantSwitcherEnabled =
    useClientFeatureFlagStore.use.assistantSwitcher();
  useResolvedAssistantsStore.use.selectedAssistantId();
  useResolvedAssistantsStore.use.assistants();
  useResolvedAssistantsStore.use.assistantsHydrated();
  const gateOpen =
    (multiAssistantEnabled || (assistantSwitcherEnabled && isLocalClient())) &&
    !isGatewayAuthMode();
  return gateOpen && organizationId
    ? resolveSelectedAssistantId(organizationId)
    : null;
}

/**
 * The single public write path for switching the selected assistant. Records
 * the selection (reactive slice + persisted key) and mirrors it into the
 * lockfile `activeAssistant` (a no-op in the browser, where there is no
 * lockfile host). The store action it wraps is internal plumbing — every
 * other caller goes through here.
 *
 * `null` clears the selection but skips the lockfile mirror: the host API has
 * no clear operation, and `activeAssistant` is machine-level tray/CLI state,
 * not session state.
 *
 * Selecting a LOCAL assistant must go through `connectLocalAssistant`, which
 * primes a gateway token for the new gateway — the bare write would leave the
 * lifecycle pointing at it with a token minted for a different gateway.
 */
export async function setSelectedAssistant(id: string | null): Promise<void> {
  useResolvedAssistantsStore.getState().setSelectedAssistant(id);
  if (id !== null) {
    await setActiveLockfileAssistant(id);
  }
}
