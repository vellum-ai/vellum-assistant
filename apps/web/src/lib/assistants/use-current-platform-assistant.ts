
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/generated/api/types.gen.js";
import {
  getActiveOrganizationIdForRequests,
  subscribeToActiveOrganizationIdForRequests,
} from "@/lib/organization/organization-state.js";

export const PLATFORM_ASSISTANT_STORAGE_PREFIX = "vellum_current_assistant_id__";

const PLATFORM_LIST_OPTIONS = assistantsListOptions({
  query: { hosting: "platform" },
});

function storageKeyForOrg(orgId: string | null): string | null {
  if (!orgId) return null;
  return `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
}

// ---------------------------------------------------------------------------
// Module-scope store for the org-scoped current assistant ID.
//
// Why a singleton store: writing to `localStorage` does NOT fire `storage`
// events in the same tab — only in other tabs. Without an in-tab broadcast,
// sibling `useCurrentPlatformAssistant()` consumers (chat page, settings,
// retire panel, etc.) would not re-render when the picker calls
// `setAssistantId`, defeating the "switching is reactive" contract.
//
// All hook instances subscribe to the same listener set; `setStoredId` writes
// localStorage AND notifies subscribers, so every active consumer re-runs its
// snapshot read on the next render. Cross-tab updates flow through the
// single module-scope `storage` event handler below.
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Single module-scope cross-tab listener. Without this, every `subscribe()`
// call would attach its own redundant `storage` listener to `window` (one per
// hook instance), and each cross-tab event would fan out N times. We attach
// once at module load and route the event through `notify()`, which already
// wakes every active subscriber.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    // localStorage.clear() fires with key === null — propagate it too so
    // consumers re-read and discover the cleared snapshot.
    if (event.key === null) {
      notify();
      return;
    }
    if (event.key.startsWith(PLATFORM_ASSISTANT_STORAGE_PREFIX)) {
      notify();
    }
  });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(orgId: string | null): string | null {
  const key = storageKeyForOrg(orgId);
  if (!key || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredId(orgId: string | null, id: string | null): void {
  const key = storageKeyForOrg(orgId);
  if (!key || typeof window === "undefined") return;
  try {
    if (id == null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, id);
    }
  } catch {
    // ignore storage failures
  }
  // Always notify even if the storage write failed — in-memory consumers
  // shouldn't be desynced from a caller's intent just because Safari's
  // private mode rejected the write.
  notify();
}

export interface UseCurrentPlatformAssistantResult {
  /** Resolved platform assistant ID, or null when no platform assistant exists. */
  assistantId: string | null;
  /** Resolved Assistant object from the platform list, or null. */
  assistant: Assistant | null;
  /**
   * Persist a new selection. Pass an ID present in the platform list to switch
   * the current assistant, or `null` to clear the org-scoped storage entry
   * (used after retire so a stale ID does not linger in localStorage).
   */
  setAssistantId: (id: string | null) => void;
  /** True while the platform list is loading or before org context resolves. */
  isLoading: boolean;
  /** Has the platform list query completed (success or error)? */
  isListLoaded: boolean;
  /** Platform assistants visible to the current org. */
  platformAssistants: Assistant[];
}

/**
 * Resolves the current platform assistant for the active org.
 *
 * Per-org scoping: the localStorage key is namespaced as
 * `vellum_current_assistant_id__<orgId>`. The wrapping
 * `RequestScopedQueryClientProvider` keys its QueryClient on the active org,
 * so this hook (and the platform-list cache it reads) remount per-org -
 * there is no in-hook invalidation needed when the org changes.
 *
 * Resolution: if the list is empty, the stored ID is surfaced as-is (no
 * persistence); otherwise the stored ID wins if it matches a list entry, and
 * the first platform assistant is selected and persisted as a fallback when
 * the stored ID is missing or stale. The "empty list never clears the stored
 * ID" rule defends against a hatch/refetch race where the list cache lags
 * behind a freshly-stored ID.
 *
 * Same-tab broadcast: every `setAssistantId` notifies a shared module-scope
 * listener set, so all `useCurrentPlatformAssistant()` consumers re-render
 * on the next tick. Cross-tab updates still work via the `storage` event.
 */
export function useCurrentPlatformAssistant(): UseCurrentPlatformAssistantResult {
  // Subscribe to org-id changes: the OrganizationProvider's bridge effect runs
  // *after* this hook commits on first login, so a one-shot read can capture a
  // stale singleton. SSR snapshot is null - client mounts pick up the real
  // value on hydration.
  const orgId = useSyncExternalStore(
    subscribeToActiveOrganizationIdForRequests,
    getActiveOrganizationIdForRequests,
    () => null,
  );

  // Subscribe to the shared store. Snapshot reads `localStorage[<orgKey>]`.
  const storedId = useSyncExternalStore(
    subscribe,
    useCallback(() => getSnapshot(orgId), [orgId]),
    () => null,
  );

  const listQuery = useQuery(PLATFORM_LIST_OPTIONS);

  const platformAssistants = (listQuery.data?.results ?? []) as Assistant[];
  const isListLoaded = !listQuery.isPending;

  // Resolution rules — see Codex P1 race against `hatchAndCheck`:
  //   1. Empty list (loading OR genuinely-empty OR stale post-hatch): treat
  //      `storedId` as presumed-valid. Returning a "no candidates" answer is
  //      better than overwriting a freshly-stored ID with `null`, which would
  //      broadcast `null` to all consumers and re-arm the chat page's
  //      auto-hatch synthesizer (duplicate hatch / lost selection).
  //   2. Non-empty list + storedId in list → storedId wins.
  //   3. Non-empty list + (no storedId OR storedId stale) → fall back to
  //      `list[0]` and persist so reloads are stable.
  let resolvedAssistant: Assistant | null = null;
  let resolvedId: string | null;
  if (platformAssistants.length === 0) {
    // Empty list: never clear a stored ID. Surface the storedId verbatim so
    // consumers don't see a transient `null` between hatch and refetch.
    resolvedId = storedId;
  } else {
    if (storedId) {
      resolvedAssistant =
        platformAssistants.find((a) => a.id === storedId) ?? null;
    }
    if (!resolvedAssistant) {
      resolvedAssistant = platformAssistants[0]!;
    }
    resolvedId = resolvedAssistant.id;
  }

  // Persist the fallback choice so reloads are stable. We only write when the
  // resolved ID differs from what's stored — avoids redundant writes that
  // would re-trigger the storage event in other tabs. Run from an effect so
  // `notify()` happens after commit, never during render.
  //
  // Critical: skip persistence entirely when the list is empty. We never want
  // to clear a stored ID against an empty list (see resolution rules above).
  useEffect(() => {
    if (!isListLoaded) return;
    if (platformAssistants.length === 0) return;
    if (resolvedId === storedId) return;
    if (resolvedId != null) {
      writeStoredId(orgId, resolvedId);
    }
  }, [isListLoaded, platformAssistants.length, resolvedId, storedId, orgId]);

  const setAssistantId = useCallback(
    (id: string | null) => {
      writeStoredId(orgId, id);
    },
    [orgId],
  );

  return {
    assistantId: resolvedId,
    assistant: resolvedAssistant,
    setAssistantId,
    isLoading: listQuery.isPending,
    isListLoaded,
    platformAssistants,
  };
}

// ---------------------------------------------------------------------------
// Test-only exports — these surface the module-scope store so the same-tab
// broadcast contract can be exercised directly via `useSyncExternalStore`
// without booting React Query. NOT for production use.
// ---------------------------------------------------------------------------
export const __subscribeForTesting = subscribe;
export const __getSnapshotForTesting = getSnapshot;
export function __setStoredIdForTesting(
  orgId: string | null,
  id: string | null,
): void {
  writeStoredId(orgId, id);
}
