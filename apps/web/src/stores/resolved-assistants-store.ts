/**
 * Resolved assistants store — **the UI-facing assistant list**.
 *
 * Holds a normalized `ResolvedAssistant[]` that merges local and
 * platform assistants into a single list. This is what UI components
 * (the select-assistant screen, the login page, etc.) and
 * `buildNavigationState` should read from.
 *
 * Population:
 *  - Local mode: auto-syncs with the lockfile store via subscription,
 *    so every hatch / sync / retire is reflected automatically.
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

interface ResolvedAssistantsState {
  assistants: ResolvedAssistant[];
}

interface ResolvedAssistantsActions {
  setFromLockfile: (lockfile: Lockfile) => void;
  setFromApi: (assistants: Assistant[]) => void;
  clear: () => void;
}

type ResolvedAssistantsStore = ResolvedAssistantsState &
  ResolvedAssistantsActions;

const useResolvedAssistantsStoreBase = create<ResolvedAssistantsStore>(
  (set) => ({
    assistants: [],

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

    clear: () => set({ assistants: [] }),
  }),
);

export const useResolvedAssistantsStore = createSelectors(
  useResolvedAssistantsStoreBase,
);

// In local mode, keep the resolved list in sync with the lockfile.
// Every lockfile commit flows through `useLockfileStore.setState`,
// so a single subscription covers all mutation paths (hatch, sync,
// retire) without touching any of them.
if (isLocalMode()) {
  useLockfileStore.subscribe((state) => {
    if (state.lockfile) {
      useResolvedAssistantsStoreBase.getState().setFromLockfile(state.lockfile);
    }
  });
}
