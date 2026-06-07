/**
 * Resolved assistants store.
 *
 * Unified list of all known assistants (local + platform) populated
 * during session initialization. In local mode the list stays in sync
 * with the lockfile store automatically; in platform mode it is
 * populated from the `listAssistants` API during `initSession`.
 *
 * The select-assistant onboarding screen and `buildNavigationState`
 * read from this store so assistant resolution is done once, at boot.
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
