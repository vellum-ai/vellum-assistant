/**
 * Resolved assistants store — the single source of truth for:
 *
 *  1. **What assistants exist** — `assistants: ResolvedAssistant[]`
 *  2. **Which is active** — `activeAssistantId` (output of the lifecycle
 *     state machine, written exclusively by `lifecycle-service.ts`)
 *  3. **Which assistant the user selected** — `selectedAssistantId` (input to
 *     the lifecycle, persisted to a single localStorage key). The active org is
 *     a read-time *filter* (see `resolveSelectedAssistantId`), never a storage
 *     key — there is one selection, validated for whichever org is active.
 *
 * Population:
 *  - Local mode: assistant list auto-syncs with the lockfile store via
 *    subscription, so every hatch / sync / retire is reflected.
 *  - Platform mode: populated from the `listAssistants` API by
 *    `reloadPlatformAssistants` (assistant/platform-assistants-sync.ts),
 *    which runs whenever the platform session becomes present.
 *
 * Do NOT confuse with `lockfile-store.ts`, which is the raw on-disk
 * lockfile cache used internally by `lib/local-mode.ts` for host IPC.
 *
 * @see lockfile-store.ts — raw lockfile cache (internal to local-mode)
 * @see lib/navigation/build-state.ts — derives `hasAssistants` from here
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { isAvatarSuperseded } from "@/lib/avatar-supersede";
import {
  isLocalClient,
  isLocalAssistant,
  isPairedAssistant,
  isPlatformAssistant,
} from "@/lib/local-mode";
import {
  SELECTED_ASSISTANT_STORAGE_KEY,
  clearSelectedAssistantId,
  readSelectedAssistantId,
  writeSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";
import { useLockfileStore } from "@/stores/lockfile-store";
import type { Lockfile } from "@/runtime/local-mode-host";
import type { Assistant, ReleaseChannelEnum } from "@/generated/api/types.gen";

export interface ResolvedAssistant {
  id: string;
  name?: string;
  hatchedAt?: string;
  cloud?: string;
  runtimeVersion?: string;
  currentReleaseVersion?: string | null;
  releaseChannel?: ReleaseChannelEnum;
  isActiveLockfileAssistant?: boolean;
  isLocal: boolean;
  isPlatformHosted: boolean;
  isPaired: boolean;
  /** Remote gateway URL for paired entries; only the lockfile carries it. */
  runtimeUrl?: string;
  /** Public ingress registered with the platform for self-hosted local
   *  entries; only the API carries it. Null/undefined means the platform has
   *  no route to this assistant. */
  ingressUrl?: string | null;
  /** Synced avatar thumbnail served by the platform; only the API carries
   *  it. Null means the platform holds no avatar for this assistant. */
  avatarUrl?: string | null;
  /** Owning org for platform entries; only the lockfile carries it, so
   *  API-sourced entries leave this undefined. */
  organizationId?: string;
  /** Platform UUID for a locally hatched entry whose `id` is the instance
   *  name; only the lockfile carries it. API rows are already keyed by UUID. */
  platformAssistantId?: string;
}

/**
 * A list that lands inside the supersede window may still carry the URL a
 * local read just outranked; keep the row on its live/cache sources until
 * the platform copy can have caught up.
 */
function apiAvatarUrl(a: Assistant): string | null | undefined {
  return isAvatarSuperseded(a.id) ? null : a.avatar_url;
}

/** The id the platform knows `a` by: the lockfile's registration for a local instance, else `a.id`. */
export function platformIdFor(a: ResolvedAssistant): string {
  return a.platformAssistantId ?? a.id;
}

/** {@link platformIdFor} by row id; an id not in the store is its own platform id. */
export function resolvePlatformAssistantId(assistantId: string): string {
  const row = useResolvedAssistantsStoreBase
    .getState()
    .assistants.find((a) => a.id === assistantId);
  return row ? platformIdFor(row) : assistantId;
}

/**
 * Whether this device has some transport to the assistant: the platform proxy
 * (cloud and paired entries), a lockfile entry (`cloud` is only ever set from
 * the lockfile, so its presence means a local/paired transport exists here),
 * or a platform-registered public ingress (`ingressUrl`, the phone-to-Mac
 * self-hosted path). A local API entry with none of these is unreachable from
 * this client (the platform proxy 404s), so list surfaces should not offer
 * it.
 */
export function isConnectableFromThisDevice(a: ResolvedAssistant): boolean {
  return !a.isLocal || a.cloud != null || a.ingressUrl != null;
}

/**
 * Assistants usable under the active org: local entries (no org), legacy
 * entries with no org (`organizationId == null`), and platform entries owned
 * by the active org. Cross-org platform entries are dropped.
 */
export function assistantsValidForOrg(
  assistants: ResolvedAssistant[],
  activeOrgId: string | null,
): ResolvedAssistant[] {
  return assistants.filter(
    (a) =>
      a.isLocal || a.organizationId == null || a.organizationId === activeOrgId,
  );
}

// ---------------------------------------------------------------------------
// Store definition
// ---------------------------------------------------------------------------

interface ResolvedAssistantsState {
  assistants: ResolvedAssistant[];
  activeAssistantId: string | null;
  selectedAssistantId: string | null;
  /**
   * Whether the resolved list reflects at least one authoritative load
   * (`setFromApi` / `setFromLockfile`). Until then an unknown selection is
   * passed through on read (the list may simply not have loaded yet); once
   * hydrated, an unknown id is a ghost and is reconciled away.
   */
  assistantsHydrated: boolean;
}

interface ResolvedAssistantsActions {
  setFromLockfile: (lockfile: Lockfile) => void;
  setFromApi: (assistants: Assistant[]) => void;
  /**
   * Mark the list hydrated without replacing it. For load paths that settle
   * with no authoritative data (a failed platform assistants fetch), so guards
   * awaiting hydration don't wait forever on a list that isn't coming.
   */
  markHydrated: () => void;
  upsertFromApi: (assistant: Assistant) => void;
  /**
   * Forget the synced thumbnail for one row. The platform copy lags a live
   * avatar change, so callers drop it and let the live/cache paths render
   * until the next API load carries the new URL.
   */
  clearAvatarUrl: (assistantId: string) => void;
  remove: (assistantId: string) => void;
  clear: () => void;
  setActiveAssistantId: (assistantId: string | null) => void;
  setSelectedAssistant: (id: string | null) => void;
}

type ResolvedAssistantsStore = ResolvedAssistantsState &
  ResolvedAssistantsActions;

const useResolvedAssistantsStoreBase = create<ResolvedAssistantsStore>(
  (set, get) => ({
    assistants: [],
    activeAssistantId: null,
    selectedAssistantId: readSelectedAssistantId(),
    assistantsHydrated: false,

    setFromLockfile: (lockfile) => {
      const activeLockfileAssistantId =
        getEffectiveActiveLockfileAssistantId(lockfile);
      const existingById = new Map(
        get().assistants.map((assistant) => [assistant.id, assistant]),
      );
      // The lockfile carries no platform metadata; keep what the API seeded.
      const assistants = lockfile.assistants.map((a) => ({
        id: a.assistantId,
        name: a.name,
        hatchedAt: a.hatchedAt,
        cloud: a.cloud,
        runtimeVersion: a.resources?.runtimeVersion,
        avatarUrl: existingById.get(a.assistantId)?.avatarUrl,
        currentReleaseVersion: existingById.get(a.assistantId)
          ?.currentReleaseVersion,
        releaseChannel: existingById.get(a.assistantId)?.releaseChannel,
        isActiveLockfileAssistant: activeLockfileAssistantId === a.assistantId,
        isLocal: isLocalAssistant(a),
        isPlatformHosted: isPlatformAssistant(a),
        isPaired: isPairedAssistant(a),
        runtimeUrl: a.runtimeUrl,
        organizationId: a.organizationId,
        platformAssistantId: a.platformAssistantId,
      }));
      set({ assistants, assistantsHydrated: true });
      // The lockfile carries every org's entries, so an id absent from it is
      // genuinely gone — safe to prune. (The API list is org-scoped, so
      // `setFromApi` deliberately does NOT reconcile; a cross-org selection
      // there is filtered out on read, not deleted.)
      reconcileSelection(get, set);
    },

    // The platform `Assistant` API carries no org field, so API-sourced
    // entries intentionally leave `organizationId` undefined (unlike
    // `setFromLockfile`). Don't "fix" this by inventing an org here.
    //
    // Unreachable local registrations are dropped: `hosting=all` returns
    // every local assistant ever registered, and one this device cannot
    // reach must not count toward `hasAssistants` or render as a dead card.
    setFromApi: (assistants) =>
      set({
        assistantsHydrated: true,
        assistants: assistants
          .map((a): ResolvedAssistant => {
            const lockfileFields = getLockfileFields(a.id);
            return {
              id: a.id,
              name: a.name,
              hatchedAt: a.created,
              cloud: lockfileFields.cloud,
              runtimeVersion: lockfileFields.runtimeVersion,
              runtimeUrl: lockfileFields.runtimeUrl,
              platformAssistantId: lockfileFields.platformAssistantId,
              ingressUrl: a.ingress_url,
              avatarUrl: apiAvatarUrl(a),
              currentReleaseVersion: a.current_release_version,
              releaseChannel: a.release_channel,
              isActiveLockfileAssistant:
                lockfileFields.isActiveLockfileAssistant,
              ...classifyApiEntry(a.is_local, lockfileFields.isPaired),
            };
          })
          .filter(isConnectableFromThisDevice),
      }),

    markHydrated: () => set({ assistantsHydrated: true }),

    upsertFromApi: (assistant) =>
      set((state) => {
        const idx = state.assistants.findIndex((a) => a.id === assistant.id);
        const prior = idx >= 0 ? state.assistants[idx] : undefined;
        const lockfileFields = getLockfileFields(assistant.id);
        // The API payload omits lockfile-sourced fields; preserve them across
        // lifecycle refreshes.
        const entry: ResolvedAssistant = {
          id: assistant.id,
          name: assistant.name,
          hatchedAt: assistant.created,
          ingressUrl: assistant.ingress_url,
          avatarUrl: apiAvatarUrl(assistant),
          currentReleaseVersion: assistant.current_release_version,
          releaseChannel: assistant.release_channel,
          ...classifyApiEntry(
            assistant.is_local,
            lockfileFields.isPaired,
            prior?.isPaired,
          ),
        };
        if (prior) {
          const next = [...state.assistants];
          next[idx] = {
            ...entry,
            cloud: lockfileFields.cloud ?? prior.cloud,
            organizationId: prior.organizationId,
            runtimeVersion:
              lockfileFields.runtimeVersion ?? prior.runtimeVersion,
            runtimeUrl: lockfileFields.runtimeUrl ?? prior.runtimeUrl,
            platformAssistantId:
              lockfileFields.platformAssistantId ?? prior.platformAssistantId,
            isActiveLockfileAssistant:
              lockfileFields.isActiveLockfileAssistant ??
              prior.isActiveLockfileAssistant,
          };
          return { assistants: next };
        }
        // New entry: the API payload omits lockfile-sourced fields, but the
        // lockfile may already know them.
        return {
          assistants: [
            ...state.assistants,
            {
              ...entry,
              cloud: lockfileFields.cloud,
              organizationId: lockfileFields.organizationId,
              runtimeVersion: lockfileFields.runtimeVersion,
              runtimeUrl: lockfileFields.runtimeUrl,
              platformAssistantId: lockfileFields.platformAssistantId,
              isActiveLockfileAssistant:
                lockfileFields.isActiveLockfileAssistant,
            },
          ],
        };
      }),

    clearAvatarUrl: (assistantId) =>
      set((state) => {
        const idx = state.assistants.findIndex((a) => a.id === assistantId);
        if (idx < 0 || state.assistants[idx].avatarUrl == null) {
          return state;
        }
        const next = [...state.assistants];
        next[idx] = { ...next[idx], avatarUrl: null };
        return { assistants: next };
      }),

    remove: (assistantId) =>
      set((state) => ({
        assistants: state.assistants.filter((a) => a.id !== assistantId),
      })),

    clear: () => set({ assistants: [] }),

    setActiveAssistantId: (assistantId) =>
      set({ activeAssistantId: assistantId }),

    // Internal plumbing for the selected id: the reactive slice and the
    // persisted key move together. Callers go through the public wrapper in
    // selection.ts (which adds the lockfile mirror); only that wrapper and
    // the lifecycle 404 net call this directly. The lifecycle service
    // subscribes to the slice, so every write republishes in gateway mode.
    setSelectedAssistant: (id) => {
      if (id == null) {
        clearSelectedAssistantId();
      } else {
        writeSelectedAssistantId(id);
      }
      set({ selectedAssistantId: id });
    },
  }),
);

/**
 * Drop the selected id once it's provably a ghost: hydrated AND not present in
 * the resolved list. Only `setFromLockfile` calls this (the lockfile is the
 * cross-org universe); the org-scoped API list must not delete a valid
 * cross-org selection.
 */
function reconcileSelection(
  get: () => ResolvedAssistantsStore,
  set: (partial: Partial<ResolvedAssistantsState>) => void,
): void {
  const { assistants, selectedAssistantId, assistantsHydrated } = get();
  if (!assistantsHydrated || selectedAssistantId == null) {
    return;
  }
  if (assistants.some((a) => a.id === selectedAssistantId)) {
    return;
  }
  clearSelectedAssistantId();
  set({ selectedAssistantId: null });
}

export const useResolvedAssistantsStore = createSelectors(
  useResolvedAssistantsStoreBase,
);

/**
 * Classification triplet for an API-shaped entry, honoring the lockfile: a
 * paired entry is neither local nor platform-hosted, whatever the API's
 * `is_local` claims. `priorIsPaired` carries an already-resolved entry's
 * classification through refreshes where the lockfile is unavailable.
 */
function classifyApiEntry(
  isLocalFromApi: boolean,
  lockfileIsPaired: boolean | undefined,
  priorIsPaired?: boolean,
): Pick<ResolvedAssistant, "isLocal" | "isPlatformHosted" | "isPaired"> {
  const isPaired = lockfileIsPaired ?? priorIsPaired ?? false;
  return {
    isPaired,
    isLocal: isPaired ? false : isLocalFromApi,
    isPlatformHosted: isPaired ? false : !isLocalFromApi,
  };
}

function getLockfileFields(assistantId: string): {
  cloud?: string;
  organizationId?: string;
  runtimeVersion?: string;
  runtimeUrl?: string;
  platformAssistantId?: string;
  isPaired?: boolean;
  isActiveLockfileAssistant?: boolean;
} {
  const lockfile = useLockfileStore.getState().lockfile;
  const entry = lockfile?.assistants.find((a) => a.assistantId === assistantId);
  const activeLockfileAssistantId = lockfile
    ? getEffectiveActiveLockfileAssistantId(lockfile)
    : null;
  return {
    cloud: entry?.cloud,
    organizationId: entry?.organizationId,
    runtimeVersion: entry?.resources?.runtimeVersion,
    runtimeUrl: entry?.runtimeUrl,
    platformAssistantId: entry?.platformAssistantId,
    isPaired: entry ? isPairedAssistant(entry) : undefined,
    isActiveLockfileAssistant: lockfile
      ? activeLockfileAssistantId === assistantId
      : undefined,
  };
}

function getEffectiveActiveLockfileAssistantId(
  lockfile: Lockfile,
): string | null {
  if (
    lockfile.activeAssistant &&
    lockfile.assistants.some(
      (assistant) => assistant.assistantId === lockfile.activeAssistant,
    )
  ) {
    return lockfile.activeAssistant;
  }
  return lockfile.assistants.length === 1
    ? (lockfile.assistants[0]?.assistantId ?? null)
    : null;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

// In local mode, keep the resolved list in sync with the lockfile. Only
// committed lockfiles count: the empty placeholder written when nothing has
// loaded (e.g. a failed host read at boot) must not mark the list hydrated
// and reconcile away a still-valid selection.
if (isLocalClient()) {
  useLockfileStore.subscribe((state) => {
    if (state.lockfile && state.committed) {
      useResolvedAssistantsStoreBase.getState().setFromLockfile(state.lockfile);
    }
  });
}

// Cross-tab sync: pick up selection changes from other tabs. The native
// `storage` event only fires in *other* tabs; same-tab writes update the slice
// directly via `setSelectedAssistant`. `event.key === null` covers `clear()`.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === SELECTED_ASSISTANT_STORAGE_KEY) {
      useResolvedAssistantsStoreBase.setState({
        selectedAssistantId: readSelectedAssistantId(),
      });
    }
  });
}
