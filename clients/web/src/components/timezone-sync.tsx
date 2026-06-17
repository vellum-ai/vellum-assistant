/**
 * Headless background sync of the client's *auto* browser timezone into the
 * assistant daemon config. It writes ONLY `ui.detectedTimezone` — the live
 * auto browser zone, used for background grounding (memory retrospective,
 * scheduling) that has no per-turn `clientTimezone`.
 *
 * It deliberately NEVER writes `ui.userTimezone`. That tier is the
 * authoritative manual override and may be set from the CLI, the assistant,
 * or another client; a background auto-mode client clearing it would clobber
 * a global override. The settings picker owns writing `ui.userTimezone` for
 * explicit user actions.
 *
 * `useEffectiveTimezone()` is used purely as a reactivity trigger (focus /
 * app.resume / device watcher) so the sync re-runs when the browser zone
 * changes; the value persisted is always re-read from `getBrowserTimezone()`.
 *
 * A sync only advances `lastSyncedRef` once the PATCH *succeeds*, so a failed
 * sync (e.g. resumed-after-offline) leaves the zone "unsynced" and is retried
 * on the next `app.resume` or focus. A successful prior sync makes those
 * triggers a no-op.
 *
 * Writes are truly serialized (last-writer-wins): at most one PATCH is in
 * flight at a time. A trigger that fires while a PATCH is in flight only
 * records the latest desired zone; when the in-flight PATCH settles, the
 * queue drains to the latest target, so the final server write is always the
 * newest zone and writes can never overlap or land out of order.
 *
 * Mounted once in `RootLayout` (behind `authMiddleware`). Renders `null`
 * and is silent on error — a failed background sync must never toast.
 */
import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { client } from "@/generated/api/client.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getBrowserTimezone } from "@/utils/browser-timezone";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export function TimezoneSync(): null {
  // Reactivity trigger only: this value changes whenever the browser zone
  // changes, re-running the effect below. The detected value is re-read
  // imperatively inside `trySync` from `getBrowserTimezone()`.
  const effectiveTz = useEffectiveTimezone();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const { mutateAsync: patchTimezone } = useMutation({
    mutationFn: async (vars: { assistantId: string; detectedTimezone: string }) => {
      const { data } = await client.patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: vars.assistantId },
        body: { ui: { detectedTimezone: vars.detectedTimezone } },
        throwOnError: true,
      });
      return data;
    },
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
  });

  // Dedupe key of the last *successful* sync (`${assistantId}:${detectedTimezone}`,
  // so switching assistants re-syncs even when the zone is unchanged). Only
  // advanced on success, so a failed sync stays "unsynced".
  const lastSyncedRef = useRef<string | null>(null);

  // Write serialization: at most one PATCH in flight. `inFlightRef` guards
  // overlap; `pendingKeyRef` holds the latest desired key while a PATCH is in
  // flight so the queue can drain to it on settle.
  const inFlightRef = useRef(false);
  const pendingKeyRef = useRef<string | null>(null);

  // Hold the live assistant id so resume/focus handlers (which capture
  // `trySync` once) always target the current assistant. Assigned in an
  // effect (never during render) to avoid mutating a ref while rendering.
  const assistantIdRef = useRef(assistantId);
  useEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  // Stable indirection so `trySync`'s `.finally` drain can call the latest
  // `trySync` without referencing `const trySync` inside its own initializer
  // (which would be a temporal-dead-zone access).
  const trySyncRef = useRef<() => void>(() => {});

  const trySync = useCallback(() => {
    const currentAssistantId = assistantIdRef.current;
    const detectedTimezone = getBrowserTimezone();
    if (!currentAssistantId || !detectedTimezone) return;

    const key = `${currentAssistantId}:${detectedTimezone}`;
    if (lastSyncedRef.current === key) return;

    // A PATCH is already running: just record the latest desired target so
    // the in-flight PATCH drains to it on settle (no overlapping writes).
    if (inFlightRef.current) {
      pendingKeyRef.current = key;
      return;
    }

    inFlightRef.current = true;
    pendingKeyRef.current = null;

    // Fire-and-forget background sync, silent on error. Record the key only
    // on success; on settle, drain any newer target requested while in flight.
    patchTimezone({ assistantId: currentAssistantId, detectedTimezone })
      .then(() => {
        lastSyncedRef.current = key;
      })
      .catch(() => {
        // Best-effort sync — transient failures (e.g. 503 during daemon
        // startup) are retried by the mutation, and any remaining failures
        // are retried on the next app.resume or window focus.
      })
      .finally(() => {
        inFlightRef.current = false;
        const pending = pendingKeyRef.current;
        pendingKeyRef.current = null;
        if (pending && pending !== key) trySyncRef.current();
      });
  }, [patchTimezone]);

  // Keep the drain indirection pointed at the latest `trySync`. Assigned in an
  // effect (never during render) for the same "no refs during render" reason.
  useEffect(() => {
    trySyncRef.current = trySync;
  }, [trySync]);

  // Reactive path: zone or assistant change.
  useEffect(() => {
    trySync();
  }, [effectiveTz, assistantId, trySync]);

  // Resume/focus path: retry a previously failed sync even when the zone is
  // unchanged. A successful prior sync makes this a no-op.
  useBusSubscription("app.resume", trySync);
  useEffect(() => {
    window.addEventListener("focus", trySync);
    return () => window.removeEventListener("focus", trySync);
  }, [trySync]);

  return null;
}
