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
import { subscribe } from "@/lib/event-bus";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { captureError } from "@/lib/sentry/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { hasLivePlatformSession } from "@/stores/session-status";

// Monotonic id stamped on each reload. The load is fire-and-forget and awaits
// two network hops, so a logout or account switch can land while it's in
// flight; only the newest reload for the still-present same-user session is
// allowed to write the resolved store, mirroring the auth store's own
// `latestPlatformProbe` guard.
let latestReload = 0;

// Stale-refresh bookkeeping, mirroring setupOrganizationStore: resume and
// chooser-mount refreshes only refetch when the last completed attempt is
// older than this, so rapid signals on fresh data stay cheap.
const STALE_TIME_MS = 10_000;
let lastLoadedAt = 0;

// The reload currently in flight, if any. Stale-gated refreshes coalesce onto
// it rather than starting a duplicate whose failure would supersede (and so
// discard) the first reload's successful write.
let inflightReload: Promise<void> | null = null;

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
export function reloadPlatformAssistants(): Promise<void> {
  if (isLocalClient() || isRemoteGatewayMode() || isGatewayAuthEnabled()) {
    return Promise.resolve();
  }
  const run = runReload();
  inflightReload = run;
  void run.finally(() => {
    if (inflightReload === run) {
      inflightReload = null;
    }
  });
  return run;
}

async function runReload(): Promise<void> {
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
  } finally {
    lastLoadedAt = Date.now();
  }
}

/**
 * Reload the platform assistants list unless the last attempt is fresh.
 *
 * Covers the post-hatch window where a self-hosted registration exists but its
 * `ingress_url` has not been provisioned yet: `setFromApi` drops the
 * unreachable entry and nothing else refetches, so the assistant would stay
 * absent until a reload or re-auth. Called on app resume and on chooser mount,
 * the moments a user would look for the new assistant. Session and mode guards
 * live here and in `reloadPlatformAssistants`, so this is a no-op for
 * logged-out hubs and non-platform modes. A reload already in flight is
 * awaited instead of duplicated; direct `reloadPlatformAssistants` callers
 * (auth transitions, account switches) keep their latest-wins start.
 */
export async function refreshPlatformAssistantsIfStale(): Promise<void> {
  if (!hasLivePlatformSession(useAuthStore.getState().platformSession)) {
    return;
  }
  if (inflightReload) {
    await inflightReload;
    return;
  }
  if (Date.now() - lastLoadedAt <= STALE_TIME_MS) {
    return;
  }
  await reloadPlatformAssistants();
}

/**
 * Subscribe to the auth store and reload the platform assistants list whenever
 * the platform session transitions to `"present"`. Register once at startup,
 * before `initSession`, so the boot `unknown → present` transition is caught.
 * Also refreshes on `app.resume` when the list is stale, since a self-hosted
 * assistant hatched elsewhere only becomes listable once its ingress
 * provisions. Returns an unsubscribe cleanup covering both subscriptions.
 */
export function setupPlatformAssistantsSync(): () => void {
  const unsubAuth = useAuthStore.subscribe((state, prevState) => {
    if (
      prevState.platformSession !== "present" &&
      state.platformSession === "present"
    ) {
      void reloadPlatformAssistants();
    }
  });
  const unsubResume = subscribe("app.resume", () => {
    void refreshPlatformAssistantsIfStale();
  });
  return () => {
    unsubAuth();
    unsubResume();
  };
}
