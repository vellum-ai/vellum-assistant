import { captureError } from "@/lib/sentry/capture-error";
import { batchExecute } from "@/utils/batch-execute";

/**
 * Execute a bulk API call with automatic 404 fallback to per-item requests.
 *
 * Handles the version-skew scenario where the web client is newer than
 * the daemon: if the bulk endpoint returns 404, falls back to calling
 * each item individually via `batchExecute` (bounded concurrency).
 *
 * On bulk error (non-404), rolls back all items and captures to Sentry.
 * On fallback per-item error, rolls back just that item and aborts the
 * batch.
 */
export async function executeBulkWithFallback<T>(opts: {
  items: readonly T[];
  bulkCall: () => Promise<{ response?: { status: number }; error?: unknown }>;
  fallbackFn: (item: T) => Promise<unknown>;
  rollbackItem: (item: T) => void;
  context: string;
}): Promise<void> {
  const { items, bulkCall, fallbackFn, rollbackItem, context } = opts;

  const bulkRes = await bulkCall();

  if (bulkRes.response?.status === 404) {
    const { abortedAt, succeeded } = await batchExecute(
      items,
      async (item) => {
        try {
          await fallbackFn(item);
        } catch (err) {
          rollbackItem(item);
          throw err;
        }
      },
    );
    if (abortedAt !== null) {
      captureError(
        new Error(
          `${context}: aborted at batch ${abortedAt}, ${succeeded}/${items.length} succeeded`,
        ),
        { context, bestEffort: true },
      );
    }
  } else if (bulkRes.error) {
    for (const item of items) {
      rollbackItem(item);
    }
    captureError(bulkRes.error, { context: `${context}:bulk`, bestEffort: true });
  }
}
