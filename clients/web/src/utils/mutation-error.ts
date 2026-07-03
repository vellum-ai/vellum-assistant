import { toast } from "@vellumai/design-library/components/toast";

/**
 * Build a TanStack Query `onError` handler that surfaces a failed mutation
 * as an error toast, preferring the thrown error's message (an `ApiError` or
 * the daemon SDK carries the server message) and falling back to an action
 * label.
 *
 * Pair this with `.mutate()` rather than awaiting `.mutateAsync()` at the
 * call site: `.mutate()` never returns a rejecting promise, so a failed
 * request is reported here instead of escalating to an unhandled promise
 * rejection (`window.onunhandledrejection`, which Sentry logs as a crash).
 */
export function toastOnError(fallback: string) {
  return (err: unknown) => {
    toast.error(err instanceof Error ? err.message : fallback);
  };
}
