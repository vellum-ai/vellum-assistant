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
 *  - Platform mode: populated from the `listAssistants` API during
 *    `initSession` in the auth store.
 *
 * Do NOT confuse with `lockfile-store.ts`, which is the raw on-disk
 * lockfile cache used internally by `lib/local-mode.ts` for host IPC.
 *
 * @see lockfile-store.ts — raw lockfile cache (internal to local-mode)
 * @see lib/navigation/build-state.ts — derives `hasAssistants` from here
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  isLocalMode,
  isLocalAssistant,
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
  /** Owning org for platform entries; only the lockfile carries it, so
   *  API-sourced entries leave this undefined. */
  organizationId?: string;
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
      const activeLockfileAssistantId = getEffectiveActiveLockfileAssistantId(
        lockfile,
      );
      const existingById = new Map(
        get().assistants.map((assistant) => [assistant.id, assistant]),
      );
      const assistants = lockfile.assistants.map((a) => ({
        id: a.assistantId,
        name: a.name,
        hatchedAt: a.hatchedAt,
        cloud: a.cloud,
        runtimeVersion: a.resources?.runtimeVersion,
        currentReleaseVersion: existingById.get(a.assistantId)
          ?.currentReleaseVersion,
        releaseChannel: existingById.get(a.assistantId)?.releaseChannel,
        isActiveLockfileAssistant: activeLockfileAssistantId === a.assistantId,
        isLocal: isLocalAssistant(a),
        isPlatformHosted: isPlatformAssistant(a),
        organizationId: a.organizationId,
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
    setFromApi: (assistants) =>
      set({
        assistantsHydrated: true,
        assistants: assistants.map((a) => {
          const lockfileFields = getLockfileFields(a.id);
          return {
            id: a.id,
            name: a.name,
            hatchedAt: a.created,
            cloud: lockfileFields.cloud,
            runtimeVersion: lockfileFields.runtimeVersion,
            currentReleaseVersion: a.current_release_version,
            releaseChannel: a.release_channel,
            isActiveLockfileAssistant:
              lockfileFields.isActiveLockfileAssistant,
            isLocal: a.is_local,
            isPlatformHosted: !a.is_local,
          };
        }),
      }),

    markHydrated: () => set({ assistantsHydrated: true }),

    upsertFromApi: (assistant) =>
      set((state) => {
        const entry: ResolvedAssistant = {
          id: assistant.id,
          name: assistant.name,
          hatchedAt: assistant.created,
          currentReleaseVersion: assistant.current_release_version,
          releaseChannel: assistant.release_channel,
          isLocal: assistant.is_local,
          isPlatformHosted: !assistant.is_local,
        };
        const idx = state.assistants.findIndex((a) => a.id === assistant.id);
        if (idx >= 0) {
          const next = [...state.assistants];
          const lockfileFields = getLockfileFields(assistant.id);
          // The API payload omits lockfile-sourced fields; preserve them across
          // lifecycle refreshes.
          next[idx] = {
            ...entry,
            cloud: lockfileFields.cloud ?? next[idx]!.cloud,
            organizationId: next[idx]!.organizationId,
            runtimeVersion:
              lockfileFields.runtimeVersion ?? next[idx]!.runtimeVersion,
            isActiveLockfileAssistant:
              lockfileFields.isActiveLockfileAssistant ??
              next[idx]!.isActiveLockfileAssistant,
          };
          return { assistants: next };
        }
        // New entry: the API payload omits lockfile-sourced fields, but the
        // lockfile may already know them.
        const lockfileFields = getLockfileFields(assistant.id);
        return {
          assistants: [
            ...state.assistants,
            {
              ...entry,
              cloud: lockfileFields.cloud,
              organizationId: lockfileFields.organizationId,
              runtimeVersion: lockfileFields.runtimeVersion,
              isActiveLockfileAssistant:
                lockfileFields.isActiveLockfileAssistant,
            },
          ],
        };
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
  if (!assistantsHydrated || selectedAssistantId == null) return;
  if (assistants.some((a) => a.id === selectedAssistantId)) return;
  clearSelectedAssistantId();
  set({ selectedAssistantId: null });
}

export const useResolvedAssistantsStore = createSelectors(
  useResolvedAssistantsStoreBase,
);

function getLockfileFields(assistantId: string): {
  cloud?: string;
  organizationId?: string;
  runtimeVersion?: string;
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
if (isLocalMode()) {
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
