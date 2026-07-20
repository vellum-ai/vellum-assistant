/**
 * Platform assistants sync.
 *
 * Loads the platform assistants list into the resolved-assistants store as a
 * reaction to the platform session becoming present, rather than baking the
 * load into a single session action. Every path that confirms a platform
 * session — cold `initSession`, the OAuth provider callback's `refreshSession`,
 * app-resume revalidation — flips `platformSession` to `"present"`, so one
 * subscription repopulates the list on all of them. This is the fix for the
 * re-login case (ATL-1100): after logout and a fresh sign-in the provider
 * callback's refresh repopulates the list, so an established user is no longer
 * routed into create-an-assistant onboarding.
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

/**
 * Load the platform assistants list into the resolved-assistants store.
 *
 * No-ops outside pure platform/cloud mode: local mode's list is lockfile-driven
 * and the gateway modes have none, so writing the resolved store there would
 * clobber correct state. On failure it still marks the list hydrated so the
 * route guard's hydration wait can't stall navigation forever.
 */
export async function reloadPlatformAssistants(): Promise<void> {
  if (isLocalMode() || isRemoteGatewayMode() || isGatewayAuthEnabled()) {
    return;
  }
  try {
    await useOrganizationStore.getState().fetchOrganizations();
    const apiAssistants = await listAssistants();
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
