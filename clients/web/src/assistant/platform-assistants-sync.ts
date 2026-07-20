/**
 * Platform assistants sync.
 *
 * Loads the platform assistants list into the resolved-assistants store as a
 * reaction to the platform session becoming present. `initSession`,
 * `refreshSession`, and app-resume revalidation all flip `platformSession` to
 * `"present"` when they confirm a session, so one subscription repopulates the
 * list on every path.
 *
 * Pure platform/cloud only. Local mode drives the resolved store from the
 * lockfile subscription (see resolved-assistants-store.ts), and the gateway /
 * remote-gateway modes have no platform assistants list, so the load
 * early-returns in those modes and never overwrites the lockfile-driven list.
 */
import { listAssistants } from "@/assistant/api";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import { isLocalMode, isRemoteGatewayMode } from "@/lib/local-mode";
import { captureError } from "@/lib/sentry/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

// Monotonic id stamped on each reload. The load is fire-and-forget and awaits
// two network hops, so a logout or account switch can land while it's in
// flight; only the newest reload for the still-present same-user session is
// allowed to write the resolved store, mirroring the auth store's own
// `latestPlatformProbe` guard.
let latestReload = 0;

/**
 * Load the platform assistants list into the resolved-assistants store.
 *
 * No-ops outside pure platform/cloud mode: local mode's list is lockfile-driven
 * and the gateway modes have none, so writing the resolved store there would
 * clobber correct state. On failure it marks the list hydrated so the route
 * guard's hydration wait can't stall navigation forever.
 *
 * Every write to the resolved store is gated on the reload still being current:
 * the same session (`platformSession` still `"present"`, same `user.id`) and
 * not superseded by a newer reload. A stale reload writes nothing — a
 * signed-out session's route guard doesn't wait on `assistantsHydrated`, so
 * skipping the write there is correct.
 */
export async function reloadPlatformAssistants(): Promise<void> {
  if (isLocalMode() || isRemoteGatewayMode() || isGatewayAuthEnabled()) {
    return;
  }
  const gen = ++latestReload;
  const startUserId = useAuthStore.getState().user?.id ?? null;
  const isStale = (): boolean =>
    gen !== latestReload ||
    useAuthStore.getState().platformSession !== "present" ||
    (useAuthStore.getState().user?.id ?? null) !== startUserId;

  try {
    await useOrganizationStore.getState().fetchOrganizations();
    const apiAssistants = await listAssistants();
    if (isStale()) {
      return;
    }
    if (apiAssistants.ok) {
      useResolvedAssistantsStore.getState().setFromApi(apiAssistants.data);
    } else {
      useResolvedAssistantsStore.getState().markHydrated();
    }
  } catch (err) {
    captureError(err, {
      context: "reloadPlatformAssistants",
      bestEffort: true,
    });
    if (isStale()) {
      return;
    }
    useResolvedAssistantsStore.getState().markHydrated();
  }
}

/**
 * Subscribe to the auth store and reload the platform assistants list whenever
 * the platform session transitions to `"present"`. Register once at startup,
 * before `initSession`, so the boot `unknown → present` transition is caught.
 * Returns an unsubscribe cleanup.
 */
export function setupPlatformAssistantsSync(): () => void {
  return useAuthStore.subscribe((state, prevState) => {
    if (
      prevState.platformSession !== "present" &&
      state.platformSession === "present"
    ) {
      void reloadPlatformAssistants();
    }
  });
}
