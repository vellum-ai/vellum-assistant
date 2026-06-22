/**
 * TanStack Query wrapper for the assistant lifecycle resource.
 *
 * `useAssistantQuery` is the canonical read path for the `/assistant/`
 * status response. It owns:
 *
 *   - The fetch (`getAssistant`)
 *   - The cache (`["assistant", "current"]`)
 *   - The poll cadence (`refetchInterval`, only while the assistant is
 *     in a transient lifecycle state like `initializing` / `to_be_deleted`)
 *   - The "should this even fire" gate (`enabled`)
 *
 * Everything that derives an `AssistantState` from the response — the
 * authoritative client-side state machine in
 * `use-assistant-lifecycle.ts` — reads via this query instead of issuing
 * its own ad-hoc fetch.
 *
 * Retry policy: this query DOES NOT retry on failure (`retry: false`).
 * The owning hook has a richer retry budget (`MAX_HATCH_RETRIES`,
 * `MAX_INITIALIZING_RECOVERIES`) that distinguishes recoverable 5xx
 * from terminal errors like capacity kill-switches. Letting TanStack
 * Query retry on top of that would burn the hook's budget twice as
 * fast and double-log to Sentry.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults}
 */

import { useQuery } from "@tanstack/react-query";

import { getAssistant, type GetAssistantResult } from "@/assistant/api";
import {
  resolveAssistantLifecycleState,
  type ResolvedAssistantLifecycleState,
} from "@/assistant/lifecycle";

export const ASSISTANT_QUERY_KEY = ["assistant", "current"] as const;

/**
 * Polling cadence while the assistant is in a transient lifecycle
 * phase. The daemon's startup is sub-second on healthy machines, so
 * 3 seconds gives margin on slow disks while keeping mobile data
 * costs reasonable.
 */
export const POLL_INTERVAL_MS = 3000;

/**
 * Lifecycle phases where we expect the assistant to transition soon
 * (typically within a few poll cycles). Other phases are stable; we
 * stop polling once we land in one of them so the tab isn't fetching
 * forever in the background.
 *
 * These are **lifecycle kinds** (the discriminator on
 * `ResolvedAssistantLifecycleState`), not raw server status strings.
 * Raw → kind mappings happen in `resolveAssistantLifecycleState`:
 *   - server `status: "initializing"`  → kind `initializing`
 *   - server `status: "to_be_deleted"` → kind `cleaning_up`
 *   - server `status: "active"`        → kind `active` / `self_hosted`
 *   - 404                              → kind `auto_hatch`
 *   - other non-OK                     → kind `error`
 */
const TRANSIENT_PHASES: ReadonlySet<ResolvedAssistantLifecycleState["kind"]> =
  new Set(["initializing", "cleaning_up"]);

/**
 * The query's `refetchInterval` decision in a form callers can test
 * directly. Returns the cadence (ms) to poll at, or `false` to stop
 * polling. Lives at module scope so the unit tests can exercise the
 * same code path the runtime uses — duplicating the logic in a test
 * helper would let `TRANSIENT_PHASES` drift silently when a new
 * transient phase is added.
 */
export function pollIntervalFor(
  result: GetAssistantResult | undefined,
): number | false {
  if (!result) return false;
  const phase = resolveAssistantLifecycleState(result);
  return TRANSIENT_PHASES.has(phase.kind) ? POLL_INTERVAL_MS : false;
}

/**
 * Cache key for the `/assistant/` resolution.
 *
 * When no platform assistant is explicitly selected (single-assistant
 * accounts, or the `multi-platform-assistant` flag off) this is exactly
 * `ASSISTANT_QUERY_KEY` — so every existing `setQueryData` / `invalidate`
 * site keeps matching and the resolution path is byte-identical to before
 * multi-assistant. When an id is selected the key is suffixed with it, so
 * switching assistants is a key change that triggers a fresh resolve.
 */
export function assistantQueryKey(
  selectedPlatformAssistantId?: string | null,
): readonly unknown[] {
  return selectedPlatformAssistantId
    ? [...ASSISTANT_QUERY_KEY, selectedPlatformAssistantId]
    : ASSISTANT_QUERY_KEY;
}

export interface UseAssistantQueryOptions {
  /**
   * Disables the query when false. Used to short-circuit the fetch
   * during auth handshake / local-mode boot before the platform
   * session is actually available.
   */
  enabled: boolean;
  /**
   * The platform assistant the user has selected, when multi-assistant
   * is active. `null`/absent resolves the default (first listed) assistant —
   * the pre-multi-assistant behavior.
   */
  selectedPlatformAssistantId?: string | null;
}

export function useAssistantQuery(options: UseAssistantQueryOptions) {
  const selectedId = options.selectedPlatformAssistantId ?? null;
  return useQuery<GetAssistantResult>({
    queryKey: assistantQueryKey(selectedId),
    queryFn: () => getAssistant(selectedId ?? undefined),
    enabled: options.enabled,
    retry: false,
    refetchInterval: (query) => pollIntervalFor(query.state.data),
    refetchOnWindowFocus: false,
  });
}
