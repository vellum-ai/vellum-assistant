/**
 * Backwards-compat gate: bulk feed item status update
 * (`POST /v1/home/feed/mark-all`).
 *
 * The bulk status endpoint lets the web client flip all matching feed
 * items to a single target status in one request. Ships in assistant
 * version 0.10.5. On older assistants the route does not exist, so the
 * web client must hide the "Mark all as read" and "Clear all" controls
 * until the connected assistant supports it.
 */
import { useAssistantSupports } from "./utils";

const MIN_VERSION = "0.10.5";

/**
 * Hook that returns `true` when the active assistant exposes the
 * `POST /v1/home/feed/mark-all` endpoint. Subscribes to the identity
 * store so consumers re-render when the assistant version resolves or
 * flips.
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION`. Callers
 * must hide the bulk action controls on the `false` branch.
 */
export function useSupportsBulkFeedStatus(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
