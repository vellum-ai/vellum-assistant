/**
 * Creates an AbortController that auto-aborts after `timeoutMs`, optionally
 * linked to an external AbortSignal so cancellation propagates both ways.
 *
 * Returns a `signal` to pass to the provider SDK and a `cleanup` function
 * that MUST be called in a finally block to clear the timer and detach
 * the external signal listener.
 */
export function createStreamTimeout(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const handle = setTimeout(() => {
    controller.abort(new Error(`Provider stream timed out after ${timeoutMs / 1000}s`));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(externalSignal!.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(handle);
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(handle);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  };

  return { signal: controller.signal, cleanup };
}
