/**
 * Decouples the embedding runtime manager from the embedding backend.
 *
 * When a background embedding-runtime download finishes, the runtime manager
 * must clear the backend's sticky "local is broken" state so `auto` mode
 * retries local embeddings. Importing the backend directly would close the
 * cycle embedding-backend → embedding-local → embedding-runtime-manager →
 * embedding-backend, so instead the backend registers a reset hook here at
 * module-load time and the runtime manager invokes it through this leaf.
 *
 * A null hook means the backend module was never loaded — in which case no
 * local backend can have failed and there is nothing to reset, so the request
 * is a safe no-op.
 */
type LocalEmbeddingRetryHook = () => void;

let retryHook: LocalEmbeddingRetryHook | null = null;

export function registerLocalEmbeddingRetryHook(
  hook: LocalEmbeddingRetryHook,
): void {
  retryHook = hook;
}

/** Ask the embedding backend to reset its sticky local-failure state. */
export function requestLocalEmbeddingRetry(): void {
  retryHook?.();
}
