/**
 * Auto-generate per-field selector hooks for a Zustand store.
 *
 * Wraps a store so every state key is available as `store.use.key()`,
 * each backed by an individual selector for minimal re-renders.
 *
 * Reference: https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors
 */
import type { StoreApi, UseBoundStore } from "zustand";

type WithSelectors<S> = S extends { getState: () => infer T }
  ? S & { use: { [K in keyof T]: () => T[K] } }
  : never;

export function createSelectors<
  S extends UseBoundStore<StoreApi<object>>,
>(_store: S) {
  const store = _store as WithSelectors<typeof _store>;
  store.use = {} as typeof store.use;
  for (const k of Object.keys(store.getState())) {
    (store.use as Record<string, () => unknown>)[k] = () =>
      store((s) => s[k as keyof typeof s]);
  }
  return store;
}
