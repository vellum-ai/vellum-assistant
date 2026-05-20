/**
 * Auto-generate per-field selector hooks for a Zustand store.
 *
 * Wraps a store so every state key is available as `store.use.key()`,
 * each backed by an individual selector for minimal re-renders.
 *
 * **Which API to use:**
 *
 * - `store.use.field()` — React render bodies. Creates a subscription;
 *   the component re-renders when `field` changes.
 * - `store.getState().field` — Event handlers, callbacks, effects,
 *   middleware, and anywhere outside the React render cycle. Reads the
 *   latest value without creating a subscription.
 *
 * Zustand's `set()` is synchronous, so `getState()` after an action
 * returns the already-mutated values. Read state *before* calling an
 * action when the caller needs pre-mutation values.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 * @see {@link https://zustand.docs.pmnd.rs/guides/updating-state}
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
