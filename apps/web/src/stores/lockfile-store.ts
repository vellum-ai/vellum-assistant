/**
 * Local-assistant lockfile cache.
 *
 * Single source of truth for the on-disk lockfile the host exposes
 * (assistants + active selection). The lockfile is host state, not
 * server state, so it lives in Zustand rather than TanStack Query —
 * `lib/local-mode.ts` owns the read/write transport and pushes every
 * load and mutation here; React consumers read via the atomic
 * selector (`useLockfileStore.use.lockfile()`) so each subscriber
 * re-renders only when the lockfile actually changes, and imperative
 * callers read `getState().lockfile` without subscribing.
 *
 * `null` means "not yet loaded from the host" — distinct from a
 * loaded-but-empty lockfile — so the first read can hydrate from
 * persisted storage before falling back to empty.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { Lockfile } from "@/runtime/local-mode-host";

interface LockfileState {
  lockfile: Lockfile | null;
}

interface LockfileActions {
  setLockfile: (lockfile: Lockfile) => void;
}

type LockfileStore = LockfileState & LockfileActions;

const useLockfileStoreBase = create<LockfileStore>((set) => ({
  lockfile: null,
  setLockfile: (lockfile) => set({ lockfile }),
}));

export const useLockfileStore = createSelectors(useLockfileStoreBase);
