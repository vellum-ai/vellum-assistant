import { isCancelledError } from "@tanstack/react-query";

/**
 * Detects errors that mean "this operation was cancelled on purpose",
 * not "this operation failed":
 *
 * - TanStack Query's `CancelledError`, thrown to whoever awaits a query
 *   fetch that gets cancelled (observer unmount mid-fetch, `cancelQueries`,
 *   `invalidateQueries` restarting an in-flight refetch via its default
 *   `cancelRefetch: true`).
 * - The browser's `AbortError`, the rejection value of any `fetch` (or
 *   other abortable API) whose `AbortSignal` fires. TanStack Query aborts
 *   its per-fetch controller on every cancellation, so an aborted queryFn
 *   rejects with this before TanStack replaces it with `CancelledError`.
 *
 * Cancellation is normal control flow in this app: mutations invalidate
 * conversation caches while refetches are in flight, SSE reconnects
 * trigger resource-refresh bursts, and route changes unmount observers
 * mid-fetch. TanStack's maintainers consider the resulting rejections
 * working-as-designed (TanStack/query#9877), so callers must classify
 * them as non-errors rather than report them.
 *
 * Matched on `.name` rather than `instanceof DOMException`: iOS WKWebView
 * surfaces fetch aborts as plain objects that carry the name but are not
 * `DOMException` instances (see the same check in
 * `domains/chat/voice/stt-api.ts`).
 *
 * Reference: https://github.com/TanStack/query/issues/9877
 * Reference: https://developer.mozilla.org/en-US/docs/Web/API/DOMException#aborterror
 */
export function isCancellationError(error: unknown): boolean {
  if (isCancelledError(error)) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
