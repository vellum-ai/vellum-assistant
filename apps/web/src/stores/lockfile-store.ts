/**
 * Local-assistant lockfile cache — **internal to `lib/local-mode.ts`**.
 *
 * This is the raw in-memory mirror of the on-disk lockfile the Electron
 * host (or dev-server) exposes. It holds transport-level fields needed
 * by the local-mode read/write layer: `gatewayPort`, `runtimeUrl`,
 * `cloud`, `activeAssistant`, etc.
 *
 * **UI components should NOT read from this store.** Use
 * `useResolvedAssistantsStore` instead — it exposes a normalized
 * `ResolvedAssistant[]` list that works in both local and platform mode.
 * This store exists only so `lib/local-mode.ts` can cache and mutate the
 * lockfile without a host round-trip on every read.
 *
 * `null` means "not yet loaded from the host" — distinct from a
 * loaded-but-empty lockfile.
 *
 * @see resolved-assistants-store.ts — the UI-facing assistant list
 * @see lib/local-mode.ts — the sole writer of this store
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { Lockfile } from "@/runtime/local-mode-host";

interface LockfileState {
  lockfile: Lockfile | null;
  /**
   * Whether `lockfile` reflects authoritative data (a host read/write or its
   * persisted mirror) rather than a transient empty fallback written when
   * nothing has loaded. Subscribers that reconcile state away — e.g. the
   * resolved-assistants sync — must ignore non-committed writes.
   */
  committed: boolean;
}

interface LockfileActions {
  setLockfile: (lockfile: Lockfile, committed?: boolean) => void;
}

type LockfileStore = LockfileState & LockfileActions;

const useLockfileStoreBase = create<LockfileStore>((set) => ({
  lockfile: null,
  committed: false,
  setLockfile: (lockfile, committed = true) => set({ lockfile, committed }),
}));

export const useLockfileStore = createSelectors(useLockfileStoreBase);
