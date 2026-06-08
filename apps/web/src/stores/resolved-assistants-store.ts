/**
 * Resolved assistants store — the single source of truth for:
 *
 *  1. **What assistants exist** — `assistants: ResolvedAssistant[]`
 *  2. **Which is active** — `activeAssistantId` (output of the lifecycle
 *     state machine, written exclusively by `lifecycle-service.ts`)
 *  3. **Which platform assistant the user selected** —
 *     `selectedPlatformAssistantByOrg` (per-org input to the lifecycle,
 *     persisted to localStorage)
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
import { isLocalMode, isLocalAssistant } from "@/lib/local-mode";
import { useLockfileStore } from "@/stores/lockfile-store";
import type { Lockfile } from "@/runtime/local-mode-host";
import type { Assistant } from "@/generated/api/types.gen";

export interface ResolvedAssistant {
  id: string;
  name?: string;
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// Per-org platform selection persistence (localStorage)
// ---------------------------------------------------------------------------

export const PLATFORM_ASSISTANT_STORAGE_PREFIX =
  "vellum:currentAssistantId:";

function storageKeyForOrg(orgId: string): string {
  return `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
}

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

function persistByOrgToLocalStorage(byOrg: Record<string, string>): void {
  if (typeof window === "undefined") return;
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
}

function removeStoredAssistantId(orgId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKeyForOrg(orgId));
  } catch {
    // ignore storage failures
  }
}

// ---------------------------------------------------------------------------
// Store definition
// ---------------------------------------------------------------------------

interface ResolvedAssistantsState {
  assistants: ResolvedAssistant[];
  activeAssistantId: string | null;
  selectedPlatformAssistantByOrg: Record<string, string>;
}

interface ResolvedAssistantsActions {
  setFromLockfile: (lockfile: Lockfile) => void;
  setFromApi: (assistants: Assistant[]) => void;
  remove: (assistantId: string) => void;
  clear: () => void;
  setActiveAssistantId: (assistantId: string | null) => void;
  setSelectedPlatformAssistant: (orgId: string, id: string | null) => void;
}

type ResolvedAssistantsStore = ResolvedAssistantsState &
  ResolvedAssistantsActions;

const useResolvedAssistantsStoreBase = create<ResolvedAssistantsStore>(
  (set) => ({
    assistants: [],
    activeAssistantId: null,
    selectedPlatformAssistantByOrg: readByOrgFromLocalStorage(),

    setFromLockfile: (lockfile) =>
      set({
        assistants: lockfile.assistants.map((a) => ({
          id: a.assistantId,
          name: a.name,
          isLocal: isLocalAssistant(a),
        })),
      }),

    setFromApi: (assistants) =>
      set({
        assistants: assistants.map((a) => ({
          id: a.id,
          name: a.name,
          isLocal: a.is_local,
        })),
      }),

    remove: (assistantId) =>
      set((state) => ({
        assistants: state.assistants.filter((a) => a.id !== assistantId),
      })),

    clear: () => set({ assistants: [] }),

    setActiveAssistantId: (assistantId) =>
      set({ activeAssistantId: assistantId }),

    setSelectedPlatformAssistant: (orgId, id) => {
      if (id == null) {
        removeStoredAssistantId(orgId);
      }
      set((state) => {
        const next = { ...state.selectedPlatformAssistantByOrg };
        if (id == null) {
          delete next[orgId];
        } else {
          next[orgId] = id;
        }
        persistByOrgToLocalStorage(next);
        return { selectedPlatformAssistantByOrg: next };
      });
    },
  }),
);

export const useResolvedAssistantsStore = createSelectors(
  useResolvedAssistantsStoreBase,
);

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

// In local mode, keep the resolved list in sync with the lockfile.
if (isLocalMode()) {
  useLockfileStore.subscribe((state) => {
    if (state.lockfile) {
      useResolvedAssistantsStoreBase.getState().setFromLockfile(state.lockfile);
    }
  });
}

// Cross-tab sync: pick up per-org selection changes from other tabs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key === null ||
      event.key.startsWith(PLATFORM_ASSISTANT_STORAGE_PREFIX)
    ) {
      useResolvedAssistantsStoreBase.setState({
        selectedPlatformAssistantByOrg: readByOrgFromLocalStorage(),
      });
    }
  });
}
