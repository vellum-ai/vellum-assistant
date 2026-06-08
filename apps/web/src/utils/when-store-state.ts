/**
 * Await a Zustand store reaching a desired state.
 *
 * Imperative consumers outside the React render cycle (router middleware,
 * async event handlers, request builders) sometimes need to block until a
 * store field settles — a session probe resolves, a version hydrates, a
 * loading flag clears. Reading the field too early collapses "not yet known"
 * into whatever the initial value happens to be, which is how ambiguous-`false`
 * races slip in. This resolves only once `predicate` holds, so the caller reads
 * a settled value.
 *
 * Returns immediately when the predicate already holds. Otherwise subscribes
 * and resolves on the first state change that satisfies it. Pass `timeoutMs`
 * to cap the wait when the awaited state may never arrive (an unreachable
 * endpoint, a probe that can hang) — without it the promise waits forever,
 * which is a latent hang anywhere it gates user-facing flow.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components}
 */
interface ReadableStore<T> {
  getState: () => T;
  subscribe: (listener: (state: T) => void) => () => void;
}

export function whenStoreState<T>(
  store: ReadableStore<T>,
  predicate: (state: T) => boolean,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (predicate(store.getState())) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = store.subscribe((state) => {
      if (predicate(state)) finish();
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(finish, options.timeoutMs);
    }
  });
}
