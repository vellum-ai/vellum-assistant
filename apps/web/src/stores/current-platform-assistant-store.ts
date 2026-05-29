/**
 * Zustand store for the per-organization "current platform assistant"
 * selection. Persists the selected assistant ID for each org to
 * localStorage so a reload or new tab restores the prior selection.
 *
 * **Storage model — one localStorage key per org:**
 *
 * Each org's selection is stored under
 * `vellum:currentAssistantId:{orgId}`. A custom `StateStorage`
 * adapter wired into the `persist` middleware reads/writes those keys
 * directly, so the on-disk format stays compatible with the prior
 * hand-rolled implementation.
 *
 * **Multi-tab safety:**
 *
 * The persist middleware hands us the *full* in-memory state on every
 * write, but the in-memory snapshot is only as fresh as the last
 * rehydrate. Treating it as authoritative — and removing localStorage
 * keys not present in it — would let a stale tab clobber another
 * tab's writes for an unrelated org. Instead the storage adapter
 * writes per-org keys additively (only when the value differs), and
 * deletions are issued imperatively by `setAssistantId` against the
 * specific affected key.
 *
 * **Cross-tab sync:**
 *
 * The persist middleware doesn't subscribe to `storage` events on its
 * own. We listen for any `storage` event whose key carries the
 * per-org prefix and trigger `persist.rehydrate()` so the store
 * picks up writes from other tabs.
 *
 * References:
 * - {@link https://zustand.docs.pmnd.rs/}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import { createSelectors } from "@/utils/create-selectors";

export const PLATFORM_ASSISTANT_STORAGE_PREFIX =
  "vellum:currentAssistantId:";

export interface CurrentPlatformAssistantState {
  /** orgId → selected assistant ID. Absent entries mean "no selection yet". */
  byOrg: Record<string, string>;
}

export interface CurrentPlatformAssistantActions {
  setAssistantId: (orgId: string, id: string | null) => void;
}

export type CurrentPlatformAssistantStore = CurrentPlatformAssistantState &
  CurrentPlatformAssistantActions;

function readByOrgFromLocalStorage(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const byOrg: Record<string, string> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PLATFORM_ASSISTANT_STORAGE_PREFIX)) {
        const orgId = key.slice(PLATFORM_ASSISTANT_STORAGE_PREFIX.length);
        const value = window.localStorage.getItem(key);
        if (value != null) byOrg[orgId] = value;
      }
    }
  } catch {
    // ignore storage failures
  }
  return byOrg;
}

function storageKeyForOrg(orgId: string): string {
  return `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
}

function removeStoredAssistantId(orgId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKeyForOrg(orgId));
  } catch {
    // ignore storage failures
  }
}

/**
 * Translates the single-name view that `persist` expects into per-org
 * reads and writes against the existing
 * `vellum:currentAssistantId:{orgId}` localStorage keys. Writes are
 * additive — see the file header for why deletions are not handled
 * here.
 */
const perOrgStorage: StateStorage = {
  getItem: () => {
    const byOrg = readByOrgFromLocalStorage();
    return JSON.stringify({ state: { byOrg }, version: 0 });
  },
  setItem: (_name, value) => {
    if (typeof window === "undefined") return;
    let parsed: { state?: { byOrg?: Record<string, string> } };
    try {
      parsed = JSON.parse(value) as typeof parsed;
    } catch {
      return;
    }
    const byOrg = parsed.state?.byOrg ?? {};
    try {
      for (const [orgId, id] of Object.entries(byOrg)) {
        const key = storageKeyForOrg(orgId);
        if (window.localStorage.getItem(key) !== id) {
          window.localStorage.setItem(key, id);
        }
      }
    } catch {
      // ignore storage failures
    }
  },
  removeItem: () => {
    // No-op. The store doesn't expose `clearStorage()`, and deletions
    // for a single org are handled directly by the action.
  },
};

const CURRENT_PLATFORM_ASSISTANT_STORE_NAME =
  "vellum:current-platform-assistant";

const useCurrentPlatformAssistantStoreBase = create<CurrentPlatformAssistantStore>()(
  persist(
    (set) => ({
      byOrg: readByOrgFromLocalStorage(),

      setAssistantId: (orgId, id) => {
        if (id == null) {
          // Drop the specific key directly — the persist setItem path
          // is additive only and will not remove it for us.
          removeStoredAssistantId(orgId);
        }
        set((state) => {
          const next = { ...state.byOrg };
          if (id == null) {
            delete next[orgId];
          } else {
            next[orgId] = id;
          }
          return { byOrg: next };
        });
      },
    }),
    {
      name: CURRENT_PLATFORM_ASSISTANT_STORE_NAME,
      storage: createJSONStorage(() => perOrgStorage),
      partialize: (state) => ({ byOrg: state.byOrg }),
    },
  ),
);

export const useCurrentPlatformAssistantStore = createSelectors(
  useCurrentPlatformAssistantStoreBase,
);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      void useCurrentPlatformAssistantStoreBase.persist.rehydrate();
      return;
    }
    if (event.key.startsWith(PLATFORM_ASSISTANT_STORAGE_PREFIX)) {
      void useCurrentPlatformAssistantStoreBase.persist.rehydrate();
    }
  });
}
