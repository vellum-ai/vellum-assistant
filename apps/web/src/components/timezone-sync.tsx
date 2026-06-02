/**
 * Headless background sync of the client's timezone into the assistant
 * daemon config, writing both cascade tiers separately:
 *
 * - `ui.userTimezone`  ← the manual `device:timezone` override (trimmed),
 *   or `""` to CLEAR it when in auto mode. A deliberate override must
 *   live in this tier so it outranks another client's per-turn
 *   `clientTimezone`; storing it in `detectedTimezone` (the weakest
 *   relevant tier) would let a transient per-turn zone win.
 * - `ui.detectedTimezone` ← the live auto browser zone, used for
 *   background grounding (memory retrospective, scheduling) that has no
 *   per-turn `clientTimezone`.
 *
 * This is the single point that mirrors `device:timezone` into config;
 * the settings picker only writes localStorage. `useEffectiveTimezone()`
 * is used purely as a reactivity trigger (focus / app.resume / device
 * watcher) so the sync re-runs when either the browser zone or the
 * override changes.
 *
 * A sync only advances `lastSyncedRef` once the PATCH *succeeds*, so a
 * failed sync (e.g. resumed-after-offline) leaves the key "unsynced" and
 * is retried on the next `app.resume` or focus — even when the values
 * are unchanged. A successful prior sync makes those triggers a no-op.
 *
 * iOS fires `app.resume`+`focus` back-to-back, so PATCHes can overlap. A
 * monotonic request token guarantees last-writer-wins: a slow older
 * request's success is ignored once a newer request has been issued, so
 * a stale zone can never be persisted.
 *
 * Mounted once in `RootLayout` (behind `authMiddleware`). Renders `null`
 * and is silent on error — a failed background sync must never toast.
 */
import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { client } from "@/generated/api/client.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { captureError } from "@/lib/sentry/capture-error";
import { getBrowserTimezone } from "@/utils/browser-timezone";
import { getDeviceSetting } from "@/utils/device-settings";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export function TimezoneSync(): null {
  // Reactivity trigger only: this value changes whenever the browser zone
  // or the override changes, re-running the effect below. The actual
  // detected/override values are re-read imperatively inside `trySync`.
  const effectiveTz = useEffectiveTimezone();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  const { mutateAsync: patchTimezone } = useMutation({
    mutationFn: async (vars: {
      assistantId: string;
      detectedTimezone: string;
      userTimezone: string;
    }) => {
      const { data } = await client.patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: vars.assistantId },
        body: {
          ui: {
            detectedTimezone: vars.detectedTimezone,
            userTimezone: vars.userTimezone,
          },
        },
        throwOnError: true,
      });
      return data;
    },
  });

  // Dedupe key of the last *successful* sync, covering both values plus
  // the assistant (so switching assistants re-syncs even when unchanged).
  // Only advanced on success, so a failed sync stays "unsynced".
  const lastSyncedRef = useRef<string | null>(null);

  // Monotonic token: incremented per issued PATCH. A request only records
  // its key if it is still the latest issued, so a slow older completion
  // cannot overwrite a newer zone (last-writer-wins).
  const requestSeqRef = useRef(0);

  // Hold the live assistant id so resume/focus handlers (which capture
  // `trySync` once) always target the current assistant.
  const assistantIdRef = useRef(assistantId);
  assistantIdRef.current = assistantId;

  const trySync = useCallback(() => {
    const currentAssistantId = assistantIdRef.current;
    const detectedTimezone = getBrowserTimezone();
    const userTimezone = getDeviceSetting("timezone", "").trim();
    if (!currentAssistantId || !detectedTimezone) return;

    const key = `${currentAssistantId}:${detectedTimezone}:${userTimezone}`;
    if (lastSyncedRef.current === key) return;

    const seq = ++requestSeqRef.current;
    // Fire-and-forget: background sync, silent on error. Only record the
    // key on success, and only if no newer request has since been issued.
    patchTimezone({ assistantId: currentAssistantId, detectedTimezone, userTimezone })
      .then(() => {
        if (seq === requestSeqRef.current) {
          lastSyncedRef.current = key;
        }
      })
      .catch((error) => {
        captureError(error, { context: "timezone-sync" });
      });
  }, [patchTimezone]);

  // Reactive path: zone/override or assistant change.
  useEffect(() => {
    trySync();
  }, [effectiveTz, assistantId, trySync]);

  // Resume/focus path: retry a previously failed sync even when the
  // values are unchanged. A successful prior sync makes this a no-op.
  useBusSubscription("app.resume", trySync);
  useEffect(() => {
    window.addEventListener("focus", trySync);
    return () => window.removeEventListener("focus", trySync);
  }, [trySync]);

  return null;
}
